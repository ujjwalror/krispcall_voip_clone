import 'server-only';
import twilio from 'twilio';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeE164PhoneNumber } from '@/lib/utils';
import { MessageStatus } from '@/lib/types/database.types';

export interface SendOutboundSmsParams {
  userId: string;
  organizationId: string;
  fromNumber: string;
  toNumber: string;
  body: string;
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
      return lower as MessageStatus || 'sent';
  }
}

/**
 * Authoritative Server-Only SMS Domain Logic Service.
 * Handles validation, provider execution, persistence, and error safety.
 */
export async function sendOutboundSms(
  params: SendOutboundSmsParams
): Promise<SendOutboundSmsResult> {
  const { userId, organizationId, fromNumber, toNumber, body, defaultCountry } = params;

  if (!userId || !organizationId) {
    throw new SmsServiceError('Forbidden. Authenticated user profile or organization unconfigured.', 403);
  }

  // 1. Validate & sanitize message body
  const cleanBody = (body || '').trim();
  if (!cleanBody) {
    throw new SmsServiceError('Message body cannot be empty.', 400);
  }

  const MAX_SMS_BODY_LENGTH = 1600;
  if (cleanBody.length > MAX_SMS_BODY_LENGTH) {
    throw new SmsServiceError(`Message body exceeds maximum limit of ${MAX_SMS_BODY_LENGTH} characters.`, 400);
  }

  // 2. Validate & normalize destination E.164 phone number
  const destValidation = normalizeE164PhoneNumber(toNumber || '', defaultCountry);
  if (!destValidation.isValid || !destValidation.normalized) {
    throw new SmsServiceError(destValidation.error || 'Invalid destination phone number.', 400);
  }

  const normalizedTo = destValidation.normalized;
  const adminSupabase = createAdminClient();

  // 3. Verify sender business phone number exists, is active, belongs to org, and has capabilities_sms = TRUE
  const normalizedFromInput = (fromNumber || '').trim();
  const fromValidation = normalizeE164PhoneNumber(normalizedFromInput, defaultCountry);
  const normalizedFrom = fromValidation.normalized || normalizedFromInput;

  const { data: phoneRow, error: phoneErr } = await (adminSupabase as any)
    .from('phone_numbers')
    .select('id, phone_number, active, organization_id, capabilities_sms, status')
    .eq('organization_id', organizationId)
    .eq('phone_number', normalizedFrom)
    .eq('active', true)
    .maybeSingle();

  const isOperational = phoneRow && phoneRow.active === true && phoneRow.status === 'active';
  if (phoneErr || !phoneRow || !isOperational) {
    throw new SmsServiceError(
      'The selected business phone number is not active or unconfigured for your organization.',
      400
    );
  }

  // Enforce SMS capability check
  if (phoneRow.capabilities_sms === false) {
    throw new SmsServiceError(
      'The selected business phone number does not have SMS messaging capability enabled.',
      400
    );
  }

  // Phase 7.4 Role-Based Assignment Check for Manager / Agent
  const { data: userProfile } = await (adminSupabase as any)
    .from('profiles')
    .select('role, active')
    .eq('id', userId)
    .maybeSingle();

  if (!userProfile || userProfile.active === false) {
    throw new SmsServiceError('Forbidden. Active user profile required.', 403);
  }

  const isOwnerOrAdmin = ['owner', 'admin'].includes(userProfile.role || '');
  if (!isOwnerOrAdmin) {
    const { data: assignment } = await (adminSupabase as any)
      .from('user_phone_assignments')
      .select('id')
      .eq('phone_number_id', phoneRow.id)
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!assignment) {
      throw new SmsServiceError('No business number assigned to your user account.', 403);
    }
  }

  // 4. Blocked-number check for organization
  const { data: blockedRecord } = await (adminSupabase as any)
    .from('blocked_numbers')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('normalized_phone', normalizedTo)
    .maybeSingle();

  if (blockedRecord) {
    throw new SmsServiceError('This recipient phone number is blocked. Unblock it before sending messages.', 403);
  }

  const { data: blockedContact } = await (adminSupabase as any)
    .from('contacts')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('phone', normalizedTo)
    .eq('is_blocked', true)
    .is('archived_at', null)
    .maybeSingle();

  if (blockedContact) {
    throw new SmsServiceError('This recipient phone number is blocked. Unblock it before sending messages.', 403);
  }

  // 5. Saved contact lookup for exact E.164 match
  let contactId: string | null = null;
  const { data: matchedContact } = await (adminSupabase as any)
    .from('contacts')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('phone', normalizedTo)
    .is('archived_at', null)
    .maybeSingle();

  if (matchedContact) {
    contactId = matchedContact.id;
  }

  // 6. Resolve Twilio Server Credentials & Callback URL
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    throw new SmsServiceError('Server telephony provider credentials are unconfigured.', 500);
  }

  const twilioClient = twilio(accountSid, authToken);
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://krispcall-voip-clone-udlg.vercel.app').replace(/\/$/, '');
  const statusCallback = `${baseUrl}/api/twilio/messaging/status`;

  // 7. Execute Twilio REST API SMS Send
  let twilioRes: any = null;
  try {
    twilioRes = await twilioClient.messages.create({
      from: normalizedFrom,
      to: normalizedTo,
      body: cleanBody,
      statusCallback,
    });
  } catch (providerError: any) {
    console.error('[SMS Service Provider Error]:', providerError.message || providerError);
    throw new SmsServiceError(providerError.message || 'Twilio provider failed to transmit SMS.', 400);
  }

  const twilioMessageSid = twilioRes.sid;
  const initialStatus = normalizeTwilioMessageStatus(twilioRes.status || 'queued');

  // 8. Persist Outbound Message into public.messages
  try {
    const { data: messageRecord, error: insertError } = await (adminSupabase as any)
      .from('messages')
      .insert({
        organization_id: organizationId,
        user_id: userId,
        contact_id: contactId,
        from_number: normalizedFrom,
        to_number: normalizedTo,
        body: cleanBody,
        direction: 'outbound',
        status: initialStatus,
        twilio_message_sid: twilioMessageSid,
        sent_at: new Date().toISOString(),
        is_read: true,
      })
      .select()
      .single();

    if (insertError || !messageRecord) {
      console.error('[SMS Service Persistence Failure] Twilio SID transmitted:', twilioMessageSid, 'Insert Error:', insertError);
      throw new SmsServiceError('SMS was transmitted via provider, but recording message log failed.', 500);
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
    throw new SmsServiceError('SMS transmitted, but failed to persist message database record.', 500);
  }
}
