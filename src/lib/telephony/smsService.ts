import 'server-only';
import twilio from 'twilio';
import { createAdminClient } from '@/lib/supabase/admin';
import { MessageStatus } from '@/lib/types/database.types';
import { SmsAuthorizationService, SmsAuthorizationError } from '@/lib/billing/telecom/smsAuthorizationService';

export interface SendOutboundSmsParams {
  userId: string;
  organizationId: string;
  clientSendId?: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  mediaUrls?: string[];
  defaultCountry?: string;
}

export interface SendOutboundSmsResult {
  success: boolean;
  messageId: string;
  twilioMessageSid: string;
  status: string;
  message: any;
}

export class SmsServiceError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = 'SmsServiceError';
    this.statusCode = statusCode;
  }
}

/**
 * Message status transition precedence matrix to prevent out-of-order webhook delivery regressions.
 * Terminal states (delivered, undelivered, failed, received) cannot be downgraded by transient callbacks (queued, sending).
 */
export const MESSAGE_STATUS_PRECEDENCE: Record<string, number> = {
  queued: 10,
  sending: 20,
  sent: 30,
  received: 30,
  delivered: 40,
  undelivered: 40,
  failed: 40,
};

export function shouldUpdateMessageStatus(currentStatus: string, newStatus: string): boolean {
  const currentRank = MESSAGE_STATUS_PRECEDENCE[currentStatus.toLowerCase()] || 0;
  const newRank = MESSAGE_STATUS_PRECEDENCE[newStatus.toLowerCase()] || 0;
  return newRank >= currentRank;
}

/**
 * Normalizes provider Twilio status strings into internal MessageStatus values.
 */
export function normalizeTwilioMessageStatus(providerStatus: string): MessageStatus {
  const lower = (providerStatus || '').toLowerCase();
  switch (lower) {
    case 'queued':
      return 'queued';
    case 'sending':
      return 'sending';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'undelivered':
      return 'undelivered';
    case 'failed':
      return 'failed';
    case 'received':
      return 'received';
    default:
      return (lower as MessageStatus) || 'sent';
  }
}

/**
 * Authoritative Server-Only SMS/MMS Domain Logic Service.
 * Integrates pre-send prepaid authorization, provider execution, atomic MessageSid linkage, and persistence.
 */
export async function sendOutboundSms(
  params: SendOutboundSmsParams
): Promise<SendOutboundSmsResult> {
  const adminSupabase = createAdminClient();
  const effectiveSendId = params.clientSendId || `send_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  // 1. Authoritative Pre-Send Prepaid Authorization
  let authResult;
  try {
    authResult = await SmsAuthorizationService.authorizeOutboundMessage(adminSupabase, {
      userId: params.userId,
      organizationId: params.organizationId,
      clientSendId: effectiveSendId,
      fromNumber: params.fromNumber,
      toNumber: params.toNumber,
      body: params.body,
      mediaUrls: params.mediaUrls,
      defaultCountry: params.defaultCountry,
    });
  } catch (err: any) {
    if (err instanceof SmsAuthorizationError) {
      throw new SmsServiceError(err.message, err.statusCode);
    }
    throw err;
  }

  const {
    normalizedFrom,
    normalizedTo,
    cleanBody,
    cleanMediaUrls,
    sessionId,
    componentId,
    serviceType,
  } = authResult;

  // 2. Saved contact lookup for E.164 match
  let contactId: string | null = null;
  const { data: matchedContact } = await (adminSupabase as any)
    .from('contacts')
    .select('id')
    .eq('organization_id', params.organizationId)
    .eq('phone', normalizedTo)
    .is('archived_at', null)
    .maybeSingle();

  if (matchedContact) {
    contactId = matchedContact.id;
  }

  // 3. Resolve Telephony Provider Credentials & Callback URL
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    throw new SmsServiceError('Server telephony provider credentials are unconfigured.', 500);
  }

  const twilioClient = twilio(accountSid, authToken);
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://krispcall-voip-clone-udlg.vercel.app').replace(/\/$/, '');
  const statusCallback = `${baseUrl}/api/twilio/messaging/status?organizationId=${encodeURIComponent(params.organizationId)}&clientSendId=${encodeURIComponent(effectiveSendId)}`;

  // 4. Execute Twilio REST API SMS/MMS Send
  let twilioRes: any = null;
  try {
    const sendPayload: any = {
      from: normalizedFrom,
      to: normalizedTo,
      statusCallback,
    };

    if (cleanBody) sendPayload.body = cleanBody;
    if (cleanMediaUrls && cleanMediaUrls.length > 0) {
      sendPayload.mediaUrl = cleanMediaUrls;
    }

    twilioRes = await twilioClient.messages.create(sendPayload);
  } catch (providerError: any) {
    console.error('[SMS Service Provider Definite Rejection Error]:', providerError.message || providerError);
    throw new SmsServiceError(providerError.message || 'Twilio provider failed to transmit message.', 400);
  }

  const twilioMessageSid = twilioRes.sid;
  const initialStatus = normalizeTwilioMessageStatus(twilioRes.status || 'queued');

  // 5. ATOMIC MESSAGESID LINKAGE AT DATABASE LEVEL
  try {
    await (adminSupabase as any).rpc('link_telecom_message_provider_resource_atomic', {
      p_organization_id: params.organizationId,
      p_session_id: sessionId,
      p_component_id: componentId,
      p_provider_message_sid: twilioMessageSid,
    });
  } catch (linkErr: any) {
    console.warn('[SMS Service] Non-fatal atomic MessageSid linkage RPC call:', linkErr.message || linkErr);
  }

  // 6. Persist Outbound Message into public.messages
  try {
    const { data: messageRecord, error: insertError } = await (adminSupabase as any)
      .from('messages')
      .insert({
        organization_id: params.organizationId,
        user_id: params.userId,
        contact_id: contactId,
        from_number: normalizedFrom,
        to_number: normalizedTo,
        body: cleanBody || '[Media Attachment]',
        direction: 'outbound',
        status: initialStatus,
        twilio_message_sid: twilioMessageSid,
        sent_at: new Date().toISOString(),
        is_read: true,
        media_urls: cleanMediaUrls.length > 0 ? cleanMediaUrls : null,
      })
      .select()
      .single();

    if (insertError || !messageRecord) {
      console.error('[SMS Service Persistence Failure] Twilio SID transmitted:', twilioMessageSid, 'Insert Error:', insertError);
      throw new SmsServiceError('Message was transmitted via provider, but recording message log failed.', 500);
    }

    return {
      success: true,
      messageId: messageRecord.id,
      twilioMessageSid,
      status: initialStatus,
      message: messageRecord,
    };
  } catch (persistenceError: any) {
    if (persistenceError instanceof SmsServiceError) throw persistenceError;
    console.error('[SMS Service Critical Persistence Error] Twilio SID transmitted:', twilioMessageSid, persistenceError);
    throw new SmsServiceError('Message transmitted, but failed to persist message database record.', 500);
  }
}
