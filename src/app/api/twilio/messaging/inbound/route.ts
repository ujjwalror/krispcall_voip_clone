import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeE164PhoneNumber } from '@/lib/utils';

/**
 * Inbound SMS Webhook Endpoint for Twilio Messaging.
 * Configured in Twilio Console under Phone Number / Messaging Service Inbound Request URL.
 */
export async function POST(request: Request) {
  try {
    const params: Record<string, string> = {};

    // Parse incoming request parameters (Twilio sends application/x-www-form-urlencoded)
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      formData.forEach((value, key) => {
        if (typeof value === 'string') {
          params[key] = value;
        }
      });
    } else if (contentType.includes('application/json')) {
      const json = await request.json().catch(() => ({}));
      Object.assign(params, json);
    }

    // Fallback query parameters
    const { searchParams } = new URL(request.url);
    searchParams.forEach((val, key) => {
      if (!params[key]) params[key] = val;
    });

    // 1. Verify Twilio Webhook Signature
    const isValidSignature = await validateTwilioRequest(request, params);
    if (!isValidSignature) {
      console.warn('[Twilio Inbound SMS Webhook] Rejected request with invalid HTTP signature.');
      const errorResponse = new twilio.twiml.MessagingResponse();
      return new NextResponse(errorResponse.toString(), {
        status: 403,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // 2. Extract Twilio Message Parameters
    const messageSid = params.MessageSid || params.SmsSid || '';
    const rawFrom = params.From || '';
    const rawTo = params.To || '';
    const bodyText = params.Body || '';

    if (!messageSid) {
      console.warn('[Twilio Inbound SMS Webhook] Missing MessageSid in payload.');
      const response = new twilio.twiml.MessagingResponse();
      return new NextResponse(response.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    const adminSupabase = createAdminClient();

    // 3. Idempotency Check: Verify if MessageSid was already processed
    const { data: existingMsg } = await (adminSupabase as any)
      .from('messages')
      .select('id')
      .eq('twilio_message_sid', messageSid)
      .maybeSingle();

    if (existingMsg) {
      console.log(`[Twilio Inbound SMS Webhook] Idempotent hit: MessageSid "${messageSid}" already processed. Returning 200 OK.`);
      const response = new twilio.twiml.MessagingResponse();
      return new NextResponse(response.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // 4. Normalize phone numbers
    const normToResult = normalizeE164PhoneNumber(rawTo);
    const normalizedTo = normToResult.normalized || rawTo;

    const normFromResult = normalizeE164PhoneNumber(rawFrom);
    const normalizedFrom = normFromResult.normalized || rawFrom;

    // 5. Match destination "To" number to an active organization business line
    const { data: phoneRow } = await (adminSupabase as any)
      .from('phone_numbers')
      .select('id, organization_id, active')
      .eq('phone_number', normalizedTo)
      .eq('active', true)
      .maybeSingle();

    if (!phoneRow || !phoneRow.organization_id) {
      console.warn(`[Twilio Inbound SMS Webhook] Destination business line "${normalizedTo}" is unconfigured or inactive in VoIP Hub.`);
      const response = new twilio.twiml.MessagingResponse();
      return new NextResponse(response.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    const organizationId = phoneRow.organization_id;

    // Canonical Capability Authorization (Task 15: Inbound SMS/MMS USABLE stage enforcement)
    const { CapabilityAuthorizationService } = await import('@/lib/telecom/capability');
    const numMedia = parseInt(params.NumMedia || '0', 10);
    const requiredCap = numMedia > 0 ? 'MMS_INBOUND' : 'SMS_INBOUND';
    const msgAuth = await CapabilityAuthorizationService.canUseCapability(
      phoneRow.id,
      requiredCap,
      organizationId,
      undefined,
      adminSupabase
    );

    if (!msgAuth.allowed) {
      console.warn(`[Twilio Inbound SMS Webhook] Inbound message rejected for ${normalizedTo} on ${requiredCap}: ${msgAuth.code} (${msgAuth.reason})`);
      const response = new twilio.twiml.MessagingResponse();
      return new NextResponse(response.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // Offboarding Telecom Eligibility Interlock
    const { TelecomEligibilityService } = await import('@/lib/telephony/lifecycle/telecomEligibilityService');
    const eligibility = await TelecomEligibilityService.canUseTelecom({
      organizationId,
      phoneNumberE164: normalizedTo,
    });

    if (!eligibility.allowed) {
      console.warn(`[Twilio Inbound SMS Webhook] Inbound SMS rejected for ${normalizedTo}: ${eligibility.reason}`);
      const response = new twilio.twiml.MessagingResponse();
      return new NextResponse(response.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // 6. Block-list check for inbound sender
    const { data: blockedRecord } = await (adminSupabase as any)
      .from('blocked_numbers')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('normalized_phone', normalizedFrom)
      .maybeSingle();

    if (blockedRecord) {
      console.log(`[Twilio Inbound SMS Webhook] Blocked sender "${normalizedFrom}". Ignoring inbound SMS without auto-reply.`);
      const response = new twilio.twiml.MessagingResponse();
      return new NextResponse(response.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // 7. Match sender "From" number against contacts table for exact E.164 match & blocked status
    let contactId: string | null = null;
    const { data: matchedContact } = await (adminSupabase as any)
      .from('contacts')
      .select('id, is_blocked')
      .eq('organization_id', organizationId)
      .eq('phone', normalizedFrom)
      .is('archived_at', null)
      .maybeSingle();

    if (matchedContact) {
      if (matchedContact.is_blocked) {
        console.log(`[Twilio Inbound SMS Webhook] Inbound sender "${normalizedFrom}" is a blocked contact. Ignoring inbound SMS.`);
        const response = new twilio.twiml.MessagingResponse();
        return new NextResponse(response.toString(), {
          status: 200,
          headers: { 'Content-Type': 'text/xml' },
        });
      }
      contactId = matchedContact.id;
    }

    // 7. Resolve Inbound Message Destination via Canonical RoutingResolutionService (Phase 23D.5)
    const { RoutingResolutionService } = await import('@/lib/telecom/assignment');
    const routeRes = await RoutingResolutionService.resolveInboundRoute(
      {
        organizationId,
        phoneNumberId: phoneRow.id,
        channel: numMedia > 0 ? 'MMS' : 'SMS',
      },
      adminSupabase
    );

    let assignedUserId: string | null = null;
    if (routeRes.resolved && routeRes.targetType === 'USER' && routeRes.targetId) {
      assignedUserId = routeRes.targetId;
    }

    // 7b. Persist Inbound Message into public.messages
    const { error: insertError } = await (adminSupabase as any)
      .from('messages')
      .insert({
        organization_id: organizationId,
        user_id: assignedUserId,
        contact_id: contactId,
        from_number: normalizedFrom,
        to_number: normalizedTo,
        body: bodyText,
        direction: 'inbound',
        status: 'received',
        is_read: false,
        twilio_message_sid: messageSid,
        sent_at: new Date().toISOString(),
      });

    if (insertError) {
      console.error('[Twilio Inbound SMS Webhook] Database insert failure:', insertError);
    } else {
      console.log(`[Twilio Inbound SMS Webhook] Successfully recorded inbound message from "${normalizedFrom}" to "${normalizedTo}".`);

      // Record provider resource mapping for MESSAGE
      try {
        const { ProviderResourceManager } = await import('@/lib/telecom/provider/providerResourceManager');
        const { ProviderAccountResolver } = await import('@/lib/telecom/provider/providerAccountResolver');
        const provRes = await ProviderAccountResolver.resolveAccount({
          organizationId,
          service: 'SMS',
        }, adminSupabase);
        const providerAccountId = provRes.context?.providerAccountId || 'default';
        await ProviderResourceManager.recordResource({
          organizationId,
          providerAccountId,
          resourceType: 'MESSAGE',
          localResourceId: messageSid,
          remoteResourceId: messageSid,
          provider: 'TWILIO',
          status: 'received',
        }, adminSupabase);
      } catch (mapErr) {
        console.warn('[Twilio Inbound SMS Webhook] Non-fatal provider resource mapping error:', mapErr);
      }
    }

    // Process Messaging Consent & Opt-Out Keywords (Provider-Neutral Foundation)
    try {
      const { MessagingConsentService } = await import('@/lib/telecom/fraud/messagingConsentService');
      const keywordAction = MessagingConsentService.parseInboundKeyword(bodyText);
      if (keywordAction === 'opt_out') {
        await MessagingConsentService.recordConsentAction(adminSupabase, {
          organizationId,
          recipientPhone: normalizedFrom,
          action: 'opt_out',
          keyword: bodyText.trim(),
        });
        console.log(`[Twilio Inbound SMS] Opt-out keyword recorded for ${normalizedFrom} in org ${organizationId}`);
      } else if (keywordAction === 'opt_in') {
        await MessagingConsentService.recordConsentAction(adminSupabase, {
          organizationId,
          recipientPhone: normalizedFrom,
          action: 'opt_in',
          keyword: bodyText.trim(),
        });
        console.log(`[Twilio Inbound SMS] Opt-in keyword recorded for ${normalizedFrom} in org ${organizationId}`);
      }
    } catch (consentErr) {
      console.warn('[Twilio Inbound SMS] Error recording consent state:', consentErr);
    }

    // 8. Return empty TwiML response to indicate success without sending auto-reply SMS
    const response = new twilio.twiml.MessagingResponse();
    return new NextResponse(response.toString(), {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  } catch (error: any) {
    console.error('Error in POST /api/twilio/messaging/inbound:', error.message || error);
    const response = new twilio.twiml.MessagingResponse();
    return new NextResponse(response.toString(), {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
