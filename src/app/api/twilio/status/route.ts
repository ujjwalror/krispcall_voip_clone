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
      console.warn('Unauthorized Twilio status callback request.');
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
    const dbCallId = params.dbCallId || searchParams.get('dbCallId') || '';

    if (!callSid && !dbCallId) {
      return new NextResponse('<Response/>', {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // 4. Map Twilio CallStatus to database status values
    let dbStatus = rawStatus;
    if (rawStatus === 'in-progress') {
      dbStatus = 'answered';
    }

    const updatePayload: Record<string, any> = {
      status: dbStatus,
      updated_at: new Date().toISOString(),
    };

    if (callSid) {
      updatePayload.twilio_call_sid = callSid;
    }

    const nowIso = new Date().toISOString();

    if (dbStatus === 'answered') {
      updatePayload.answered_at = nowIso;
    } else if (
      dbStatus === 'completed' ||
      dbStatus === 'no-answer' ||
      dbStatus === 'busy' ||
      dbStatus === 'failed' ||
      dbStatus === 'canceled'
    ) {
      updatePayload.ended_at = nowIso;
      updatePayload.duration_seconds = durationSeconds;
    }

    // 5. Update database call record using Admin client (bypassing RLS for server callback)
    const adminSupabase = createAdminClient();

    let query = (adminSupabase as any).from('calls').update(updatePayload);

    if (callSid) {
      query = query.eq('twilio_call_sid', callSid);
    } else if (dbCallId) {
      query = query.eq('id', dbCallId);
    }

    const { error: updateError, count } = await query;

    // If matching by callSid returned no rows and dbCallId exists, try matching by dbCallId
    if (dbCallId && callSid && (!count || count === 0)) {
      await (adminSupabase as any)
        .from('calls')
        .update(updatePayload)
        .eq('id', dbCallId);
    }

    if (updateError) {
      console.error('Error updating call record from Twilio status callback:', updateError);
    }

    return new NextResponse('<Response/>', {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  } catch (error: any) {
    console.error('Error handling Twilio status callback:', error.message || error);
    return new NextResponse('<Response/>', {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
