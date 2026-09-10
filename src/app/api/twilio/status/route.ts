import { NextResponse } from 'next/server';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Twilio Call Status Callback Webhook Endpoint.
 * Receives lifecycle events for calls (initiated, ringing, answered/in-progress, completed, no-answer, busy, failed, canceled).
 */
export async function POST(request: Request) {
  try {
    const params: Record<string, string> = {};

    // 1. Parse incoming parameters (Twilio sends application/x-www-form-urlencoded)
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

    // 2. Validate webhook signature if TWILIO_AUTH_TOKEN is configured
    const isValidSignature = await validateTwilioRequest(request, params);
    if (!isValidSignature) {
      console.warn('[Twilio Status Callback] Unauthorized status callback request.');
      return new NextResponse('<Response><Say>Unauthorized</Say></Response>', {
        status: 403,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // 3. Extract Twilio status parameters
    const callSid = params.CallSid || params.callSid || '';
    const rawStatus = (params.CallStatus || params.callStatus || '').toLowerCase();
    const durationStr = params.CallDuration || params.callDuration || '0';
    const durationSeconds = parseInt(durationStr, 10) || 0;
    const dbCallId = params.dbCallId || params.db_call_id || searchParams.get('dbCallId') || '';

    console.log(
      `[Twilio Status Callback] Received CallSid: "${callSid}", CallStatus: "${rawStatus}", dbCallId: "${dbCallId}", Duration: ${durationSeconds}s`
    );

    if (!callSid && !dbCallId) {
      console.warn('[Twilio Status Callback] Missing both CallSid and dbCallId. Ignoring callback.');
      return new NextResponse('<Response/>', {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // 4. Map Twilio CallStatus to database status values
    let dbStatus = rawStatus;
    if (rawStatus === 'in-progress') {
      dbStatus = 'answered';
    } else if (['no-answer', 'busy', 'canceled', 'failed'].includes(rawStatus)) {
      dbStatus = 'missed';
    }

    const updatePayload: Record<string, any> = {
      status: dbStatus,
      updated_at: new Date().toISOString(),
    };

    // Extract answering agent identity if available from Twilio client call
    const calledTarget = params.Called || params.DialCallTarget || params.To || '';
    if (calledTarget.includes('client:')) {
      const twilioIdentity = calledTarget.split('client:')[1] || '';
      const adminSupabase = createAdminClient();
      const { data: profileMatch } = await (adminSupabase as any)
        .from('profiles')
        .select('id')
        .eq('twilio_identity', twilioIdentity)
        .single();
      if (profileMatch && profileMatch.id) {
        updatePayload.user_id = profileMatch.id;
      }
    }

    if (callSid) {
      updatePayload.twilio_call_sid = callSid;
    }

    const nowIso = new Date().toISOString();

    if (dbStatus === 'answered') {
      updatePayload.answered_at = nowIso;
    } else if (
      dbStatus === 'completed' ||
      dbStatus === 'missed'
    ) {
      updatePayload.ended_at = nowIso;
      updatePayload.duration_seconds = durationSeconds;
    }

    // 5. Update database call record using Admin client (bypassing RLS for server callback)
    const adminSupabase = createAdminClient();
    let matchedRows = 0;

    // Try matching by twilio_call_sid first
    if (callSid) {
      const { data, error: err1 } = await (adminSupabase as any)
        .from('calls')
        .update(updatePayload)
        .eq('twilio_call_sid', callSid)
        .select();

      if (err1) {
        console.error('[Twilio Status Callback] DB Error updating by twilio_call_sid:', err1);
      }
      matchedRows = Array.isArray(data) ? data.length : 0;
    }

    // Fallback: If no row matched by callSid, update by dbCallId
    if (matchedRows === 0 && dbCallId) {
      const { data: data2, error: err2 } = await (adminSupabase as any)
        .from('calls')
        .update(updatePayload)
        .eq('id', dbCallId)
        .select();

      if (err2) {
        console.error('[Twilio Status Callback] DB Error updating by dbCallId:', err2);
      }
      matchedRows = Array.isArray(data2) ? data2.length : 0;
    }

    console.log(
      `[Twilio Status Callback] Database update complete for CallSid "${callSid}" / dbCallId "${dbCallId}". Matched ${matchedRows} row(s). Updated status to "${dbStatus}".`
    );

    return new NextResponse('<Response/>', {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  } catch (error: any) {
    console.error('[Twilio Status Callback] Error handling status callback:', error.message || error);
    return new NextResponse('<Response/>', {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
