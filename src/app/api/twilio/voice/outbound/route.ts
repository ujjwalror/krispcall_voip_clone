import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { normalizeE164PhoneNumber } from '@/lib/utils';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { createAdminClient } from '@/lib/supabase/admin';
import { VoiceAuthorizationService } from '@/lib/billing/telecom/voiceAuthorizationService';

/**
 * Outbound Voice TwiML Webhook Endpoint for Twilio Programmable Voice.
 * Performs authoritative pre-exposure financial authorization before issuing TwiML <Dial>.
 */
export async function POST(request: Request) {
  let createdReservationId: string | undefined = undefined;
  let targetOrgId: string | undefined = undefined;
  let targetInternalUsageId: string | undefined = undefined;

  try {
    const params: Record<string, string> = {};

    // 1. Parse incoming request parameters (Twilio sends application/x-www-form-urlencoded)
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

    // 2. Verify webhook signature (if TWILIO_AUTH_TOKEN is configured)
    const isValidSignature = await validateTwilioRequest(request, params);
    if (!isValidSignature) {
      console.warn('[Twilio Outbound Webhook] Signature validation failed.');
      const errorResponse = new twilio.twiml.VoiceResponse();
      errorResponse.say({ voice: 'alice' }, 'Unauthorized Twilio webhook request.');
      errorResponse.hangup();
      return new NextResponse(errorResponse.toString(), {
        status: 403,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // Extract CallSid and database call ID
    const callSid = params.CallSid || params.callSid || '';
    const dbCallId = params.dbCallId || params.db_call_id || searchParams.get('dbCallId') || '';

    let shouldRecord = params.recordCall === 'true' || params.record_call === 'true';

    console.log(`[Twilio Outbound Webhook] Processing CallSid: "${callSid}", dbCallId: "${dbCallId}"`);

    if (!dbCallId) {
      console.warn('[Twilio Outbound Webhook] Missing dbCallId parameter.');
      const errResp = new twilio.twiml.VoiceResponse();
      errResp.say({ voice: 'alice' }, 'We are unable to connect your call at this time. Please contact support.');
      errResp.hangup();
      return new NextResponse(errResp.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    const adminSupabase = createAdminClient();

    // 3. Re-establish server-authoritative call record from database (must be in 'initiated' pre-authorization state)
    const { data: dbCallRec, error: fetchErr } = await (adminSupabase as any)
      .from('calls')
      .select('id, organization_id, user_id, from_number, to_number, record_call, status')
      .eq('id', dbCallId)
      .eq('status', 'initiated')
      .maybeSingle();

    if (fetchErr || !dbCallRec || !dbCallRec.organization_id || dbCallRec.status !== 'initiated') {
      console.error('[Twilio Outbound Webhook] Could not resolve valid initiated call record:', fetchErr || `status: ${dbCallRec?.status}`);
      const errResp = new twilio.twiml.VoiceResponse();
      errResp.say({ voice: 'alice' }, 'We are unable to connect your call at this time. Please contact support.');
      errResp.hangup();
      return new NextResponse(errResp.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    targetOrgId = dbCallRec.organization_id;
    targetInternalUsageId = `call:outbound:${dbCallRec.id}`;

    if (!shouldRecord && dbCallRec.record_call) {
      shouldRecord = true;
    }

    // Destination phone number
    const rawDestination = params.To || params.to || dbCallRec.to_number || '';
    const validation = normalizeE164PhoneNumber(rawDestination);

    if (!validation.isValid || !validation.normalized) {
      console.warn('[Twilio Outbound Webhook] Invalid destination phone number:', rawDestination);
      const errResp = new twilio.twiml.VoiceResponse();
      errResp.say({ voice: 'alice' }, 'Invalid destination phone number specified.');
      errResp.hangup();
      return new NextResponse(errResp.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    const callerId = dbCallRec.from_number || '';
    if (!callerId) {
      console.warn('[Twilio Outbound Webhook] Missing from_number on DB call record.');
      const errResp = new twilio.twiml.VoiceResponse();
      errResp.say({ voice: 'alice' }, 'No business number is assigned to this workspace.');
      errResp.hangup();
      return new NextResponse(errResp.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // 4. AUTHORITATIVE PRE-EXPOSURE FINANCIAL AUTHORIZATION
    const authResult = await VoiceAuthorizationService.authorizeOutboundVoice(adminSupabase, {
      organizationId: dbCallRec.organization_id,
      dbCallId: dbCallRec.id,
      userId: dbCallRec.user_id,
      fromNumber: callerId,
      toNumber: validation.normalized,
    });

    createdReservationId = authResult.reservationId;

    // Financial Invariant: AUTHORIZATION FAILURE -> ZERO <Dial> -> ZERO PSTN exposure
    if (!authResult.authorized) {
      console.warn('[Twilio Outbound Webhook] Authorization failed:', authResult.failureReason);

      // Update call record status to failed
      await (adminSupabase as any)
        .from('calls')
        .update({
          status: 'failed',
          ended_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', dbCallId);

      const failResponse = new twilio.twiml.VoiceResponse();
      failResponse.say(
        { voice: 'alice' },
        authResult.customerMessage || 'We are unable to connect your call at this time. Please check your account balance or contact support.'
      );
      failResponse.hangup();

      return new NextResponse(failResponse.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // 5. AUTHORIZATION SUCCESS -> Link CallSid to DB call record
    if (callSid) {
      await (adminSupabase as any)
        .from('calls')
        .update({ twilio_call_sid: callSid, updated_at: new Date().toISOString() })
        .eq('id', dbCallId);
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://krispcall-voip-clone-udlg.vercel.app';
    const voiceResponse = new twilio.twiml.VoiceResponse();

    const dialOptions: Record<string, any> = {
      callerId,
      timeLimit: authResult.timeLimitSeconds || 300, // Bounded by authoritatively calculated duration N
    };

    if (shouldRecord) {
      const recordingStatusCallbackUrl = `${baseUrl}/api/twilio/recording?dbCallId=${encodeURIComponent(dbCallId)}`;
      dialOptions.record = 'record-from-answer';
      dialOptions.recordingStatusCallback = recordingStatusCallbackUrl;
      dialOptions.recordingStatusCallbackEvent = 'completed';
      dialOptions.recordingStatusCallbackMethod = 'POST';
    }

    const dial = voiceResponse.dial(dialOptions);

    const statusCallbackUrl = `${baseUrl}/api/twilio/status?dbCallId=${encodeURIComponent(dbCallId)}`;
    const numberOptions: Record<string, any> = {
      statusCallback: statusCallbackUrl,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    };

    dial.number(numberOptions, validation.normalized);

    return new NextResponse(voiceResponse.toString(), {
      status: 200,
      headers: {
        'Content-Type': 'text/xml',
      },
    });
  } catch (error: any) {
    console.error('[Twilio Outbound Webhook] Exception processing outbound call webhook:', error.message || error);

    // Safe pre-dispatch failure compensation: If reservation succeeded but local response setup crashed
    if (createdReservationId && targetOrgId && targetInternalUsageId) {
      try {
        const adminSupabase = createAdminClient();
        await VoiceAuthorizationService.compensatePreDispatchFailure(
          adminSupabase,
          targetOrgId,
          targetInternalUsageId,
          targetInternalUsageId.replace('call:outbound:', '')
        );
      } catch (compErr) {
        console.error('[Twilio Outbound Webhook] Downstream compensation error:', compErr);
      }
    }

    const errorResponse = new twilio.twiml.VoiceResponse();
    errorResponse.say({ voice: 'alice' }, 'An error occurred while processing the outbound call. Please try again.');
    errorResponse.hangup();
    return new NextResponse(errorResponse.toString(), {
      status: 500,
      headers: { 'Content-Type': 'text/xml' },
    });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
