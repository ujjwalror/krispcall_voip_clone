import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { normalizeE164PhoneNumber } from '@/lib/utils';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Outbound Voice TwiML Webhook Endpoint for Twilio Programmable Voice.
 * Configured in Twilio Console as the Voice Request URL for the TwiML App.
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

    // Verify webhook signature (if TWILIO_AUTH_TOKEN is configured)
    const isValidSignature = await validateTwilioRequest(request, params);
    if (!isValidSignature) {
      const errorResponse = new twilio.twiml.VoiceResponse();
      errorResponse.say('Unauthorized Twilio webhook request.');
      errorResponse.reject();
      return new NextResponse(errorResponse.toString(), {
        status: 403,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // Extract CallSid and database call ID if available
    const callSid = params.CallSid || params.callSid || '';
    const dbCallId = params.dbCallId || params.db_call_id || searchParams.get('dbCallId') || '';

    // Check recordCall preference from parameters or DB
    let shouldRecord = params.recordCall === 'true' || params.record_call === 'true';

    console.log(`[Twilio Outbound Webhook] Received CallSid: "${callSid}", dbCallId: "${dbCallId}", RecordCallParam: "${params.recordCall}"`);

    // If dbCallId is present, query DB record or link CallSid
    if (dbCallId) {
      try {
        const adminSupabase = createAdminClient();

        // Query database call record to verify record_call setting if not explicitly set
        if (!shouldRecord) {
          const { data: dbCall } = await (adminSupabase as any)
            .from('calls')
            .select('record_call')
            .eq('id', dbCallId)
            .single();
          if (dbCall && dbCall.record_call) {
            shouldRecord = true;
          }
        }

        if (callSid) {
          const { data, error: linkErr } = await (adminSupabase as any)
            .from('calls')
            .update({ twilio_call_sid: callSid, updated_at: new Date().toISOString() })
            .eq('id', dbCallId)
            .select();

          const matchedRows = Array.isArray(data) ? data.length : 0;
          console.log(`[Twilio Outbound Webhook] Linked CallSid "${callSid}" to dbCallId "${dbCallId}". Matched rows: ${matchedRows}`);
          if (linkErr) {
            console.error('[Twilio Outbound Webhook] Link error:', linkErr);
          }
        }
      } catch (dbErr) {
        console.error('[Twilio Outbound Webhook] Exception linking CallSid to DB record:', dbErr);
      }
    }

    // Extract destination number passed from browser device.connect({ params: { To: ... } })
    const rawDestination = params.To || params.to || params.PhoneNumber || '';
    const validation = normalizeE164PhoneNumber(rawDestination);

    const voiceResponse = new twilio.twiml.VoiceResponse();

    if (!validation.isValid || !validation.normalized) {
      voiceResponse.say('Invalid or unconfigured destination phone number specified.');
      voiceResponse.reject();
      return new NextResponse(voiceResponse.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // Base application URL for absolute callbacks
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://krispcall-voip-clone-udlg.vercel.app';

    // Dial destination using approved server-side TWILIO_PHONE_NUMBER caller ID
    const callerId = process.env.TWILIO_PHONE_NUMBER || '+18005550199';

    const dialOptions: Record<string, any> = {
      callerId,
    };

    // If recording is enabled for this call, attach record="record-from-answer" and recordingStatusCallback to <Dial>
    if (shouldRecord) {
      console.log(`[Twilio Recording] Enabled for dbCallId: ${dbCallId || callSid}`);
      const recordingStatusCallbackUrl = dbCallId
        ? `${baseUrl}/api/twilio/recording?dbCallId=${encodeURIComponent(dbCallId)}`
        : `${baseUrl}/api/twilio/recording`;

      dialOptions.record = 'record-from-answer'; // Twilio records ONLY when answered
      dialOptions.recordingStatusCallback = recordingStatusCallbackUrl;
      dialOptions.recordingStatusCallbackEvent = 'completed';
      dialOptions.recordingStatusCallbackMethod = 'POST';
    } else {
      console.log(`[Twilio Outbound Webhook] Call recording is DISABLED for call ${dbCallId || callSid}.`);
    }

    const dial = voiceResponse.dial(dialOptions);

    // Call leg status callbacks attached to <Number>
    const statusCallbackUrl = dbCallId
      ? `${baseUrl}/api/twilio/status?dbCallId=${encodeURIComponent(dbCallId)}`
      : `${baseUrl}/api/twilio/status`;

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
    console.error('Error generating outbound TwiML:', error.message || error);
    const errorResponse = new twilio.twiml.VoiceResponse();
    errorResponse.say('An error occurred while processing the outbound call.');
    errorResponse.reject();
    return new NextResponse(errorResponse.toString(), {
      status: 500,
      headers: { 'Content-Type': 'text/xml' },
    });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
