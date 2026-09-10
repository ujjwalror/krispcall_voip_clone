import { NextResponse } from 'next/server';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Twilio Recording Status Callback Webhook Endpoint.
 * Executed by Twilio when a call recording completes.
 * Saves recording metadata to Supabase public.recordings table.
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

    const { searchParams } = new URL(request.url);
    searchParams.forEach((val, key) => {
      if (!params[key]) params[key] = val;
    });

    // Validate webhook signature if TWILIO_AUTH_TOKEN is configured
    const isValidSignature = await validateTwilioRequest(request, params);
    if (!isValidSignature) {
      console.warn('[Twilio Recording Callback] Unauthorized recording status callback request.');
      return new NextResponse('<Response><Say>Unauthorized</Say></Response>', {
        status: 403,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    const recordingSid = params.RecordingSid || params.recordingSid || '';
    let rawRecordingUrl = params.RecordingUrl || params.recordingUrl || '';
    const durationStr = params.RecordingDuration || params.recordingDuration || '0';
    const durationSeconds = parseInt(durationStr, 10) || 0;
    const callSid = params.CallSid || params.callSid || '';
    const dbCallId = params.dbCallId || params.db_call_id || searchParams.get('dbCallId') || '';
    const recordingStatus = (params.RecordingStatus || params.recordingStatus || 'completed').toLowerCase();

    console.log(
      `[Twilio Recording Callback] Received RecordingSid: "${recordingSid}", CallSid: "${callSid}", dbCallId: "${dbCallId}", Duration: ${durationSeconds}s`
    );

    if (!recordingSid || (!callSid && !dbCallId)) {
      console.warn('[Twilio Recording Callback] Missing RecordingSid or CallSid/dbCallId. Ignoring callback.');
      return new NextResponse('<Response/>', {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // Append .mp3 extension to Twilio RecordingUrl for HTML5 audio player playback compatibility
    let recordingUrl = rawRecordingUrl;
    if (recordingUrl && !recordingUrl.endsWith('.mp3') && !recordingUrl.endsWith('.wav')) {
      recordingUrl = `${recordingUrl}.mp3`;
    }

    const adminSupabase = createAdminClient();

    // 1. Fetch matching call record from database to obtain organization_id and call_id
    let callRecord: any = null;

    if (callSid) {
      const { data } = await (adminSupabase as any)
        .from('calls')
        .select('id, organization_id')
        .eq('twilio_call_sid', callSid)
        .single();
      callRecord = data;
    }

    if (!callRecord && dbCallId) {
      const { data } = await (adminSupabase as any)
        .from('calls')
        .select('id, organization_id')
        .eq('id', dbCallId)
        .single();
      callRecord = data;
    }

    if (!callRecord) {
      console.error(
        `[Twilio Recording Callback] Failed to locate database call record for CallSid "${callSid}" / dbCallId "${dbCallId}".`
      );
      return new NextResponse('<Response/>', {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // 2. Insert recording record into public.recordings
    const { data: recData, error: recError } = await (adminSupabase as any)
      .from('recordings')
      .insert({
        organization_id: callRecord.organization_id,
        call_id: callRecord.id,
        twilio_recording_sid: recordingSid,
        recording_url: recordingUrl,
        duration_seconds: durationSeconds,
        status: recordingStatus,
      })
      .select()
      .single();

    if (recError) {
      console.error('[Twilio Recording Callback] Error inserting recording metadata:', recError);
    } else {
      console.log(
        `[Twilio Recording Callback] Successfully saved recording metadata (ID: ${recData?.id}) for Call ID: ${callRecord.id}`
      );
    }

    return new NextResponse('<Response/>', {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  } catch (error: any) {
    console.error('[Twilio Recording Callback] Exception processing recording callback:', error.message || error);
    return new NextResponse('<Response/>', {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
