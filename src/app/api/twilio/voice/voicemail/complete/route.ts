import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { createAdminClient } from '@/lib/supabase/admin';
import { VoicemailService } from '@/lib/telephony/voicemailService';

/**
 * Twilio Voicemail Recording Completion Callback Endpoint.
 * Executed by Twilio when a voicemail <Record> verb finishes.
 * Validates request signature, enforces idempotency, checks duration > 0,
 * creates public.voicemails record, updates public.calls status, and returns hangup TwiML.
 */
export async function POST(request: Request) {
  try {
    const params: Record<string, string> = {};

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

    const { searchParams } = new URL(request.url);
    searchParams.forEach((val, key) => {
      if (!params[key]) params[key] = val;
    });

    // Validate webhook signature if TWILIO_AUTH_TOKEN is configured
    const isValidSignature = await validateTwilioRequest(request, params);
    if (!isValidSignature) {
      console.warn('[TWILIO VOICEMAIL COMPLETE ERROR] Signature validation failure.');
      const errRes = new twilio.twiml.VoiceResponse();
      errRes.say('Unauthorized callback request.');
      errRes.reject();
      return new NextResponse(errRes.toString(), {
        status: 403,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    const recordingSid = params.RecordingSid || params.recordingSid || '';
    const recordingUrl = params.RecordingUrl || params.recordingUrl || '';
    const durationStr = params.RecordingDuration || params.recordingDuration || '0';
    const durationSeconds = parseInt(durationStr, 10) || 0;
    const callSid = params.CallSid || params.callSid || '';
    const callerFrom = params.From || params.from || 'Unknown';
    const companyTo = params.To || params.to || '';

    const queryCallId = searchParams.get('callId') || params.callId || '';
    const queryPhoneId = searchParams.get('phoneId') || params.phoneId || '';
    const queryOrgId = searchParams.get('orgId') || params.orgId || '';

    console.log('[TWILIO VOICEMAIL RECORDING COMPLETE]', {
      RecordingSid: recordingSid,
      CallSid: callSid,
      Duration: durationSeconds,
      Caller: callerFrom,
      To: companyTo,
      queryOrgId,
    });

    const twiml = new twilio.twiml.VoiceResponse();

    if (!recordingSid || durationSeconds <= 0) {
      console.log(`[Twilio Voicemail Complete] Zero-length or missing recording (${recordingSid}, ${durationSeconds}s). Hanging up.`);
      twiml.say('Thank you. Goodbye.');
      twiml.hangup();
      return new NextResponse(twiml.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    const adminSupabase = createAdminClient();

    let organizationId = queryOrgId;
    let dbCallId = queryCallId;
    let phoneNumberId = queryPhoneId;

    // If organizationId missing, derive from call record or destination phone number
    if (!organizationId && callSid) {
      const { data: callData } = await (adminSupabase as any)
        .from('calls')
        .select('id, organization_id')
        .eq('twilio_call_sid', callSid)
        .maybeSingle();

      if (callData) {
        organizationId = callData.organization_id;
        dbCallId = callData.id;
      }
    }

    if (!organizationId && companyTo) {
      const { data: phoneData } = await (adminSupabase as any)
        .from('phone_numbers')
        .select('id, organization_id')
        .eq('phone_number', companyTo)
        .maybeSingle();

      if (phoneData) {
        organizationId = phoneData.organization_id;
        phoneNumberId = phoneData.id;
      }
    }

    if (!organizationId) {
      console.error('[TWILIO VOICEMAIL ERROR] Failed to resolve organization identity for voicemail persistence.');
      twiml.say('Thank you for your message. Goodbye.');
      twiml.hangup();
      return new NextResponse(twiml.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // Persist voicemail idempotently using VoicemailService
    const recResult = await VoicemailService.recordVoicemail(
      {
        organizationId,
        phoneNumberId: phoneNumberId || null,
        callId: dbCallId || null,
        providerCallSid: callSid,
        providerRecordingSid: recordingSid,
        callerNumber: callerFrom,
        calledNumber: companyTo,
        recordingUrl,
        durationSeconds,
      },
      adminSupabase
    );

    if (recResult.success) {
      console.log('[TWILIO VOICEMAIL RECORDED SUCCESSFULLY]', recResult.voicemailId);

      // Update call record status to 'completed' if dbCallId exists
      if (dbCallId) {
        await (adminSupabase as any)
          .from('calls')
          .update({
            status: 'completed',
            ended_at: new Date().toISOString(),
          })
          .eq('id', dbCallId);
      }
    } else {
      console.warn('[TWILIO VOICEMAIL RECORDING WARN]', recResult.message);
    }

    twiml.say('Thank you for leaving a message. Goodbye.');
    twiml.hangup();

    return new NextResponse(twiml.toString(), {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  } catch (error: any) {
    console.error('[TWILIO VOICEMAIL COMPLETE EXCEPTION]', error.message || error);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('An error occurred processing your voicemail. Goodbye.');
    twiml.hangup();
    return new NextResponse(twiml.toString(), {
      status: 500,
      headers: { 'Content-Type': 'text/xml' },
    });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
