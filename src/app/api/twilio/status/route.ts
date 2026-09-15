import { NextResponse } from 'next/server';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Twilio Call Status Callback Webhook Endpoint.
 * Receives lifecycle events for calls (initiated, ringing, answered/in-progress, completed, no-answer, busy, failed, canceled).
 */
export async function POST(request: Request) {
  try {
    const postParams: Record<string, string> = {};

    // 1. Parse incoming body parameters ONLY (Twilio sends application/x-www-form-urlencoded)
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      formData.forEach((value, key) => {
        if (typeof value === 'string') {
          postParams[key] = value;
        }
      });
    } else if (contentType.includes('application/json')) {
      const json = await request.json().catch(() => ({}));
      Object.assign(postParams, json);
    }

    // 2. Validate webhook signature using POST body parameters ONLY (before merging URL searchParams)
    const isValidSignature = await validateTwilioRequest(request, postParams);

    // 3. Now merge URL searchParams into params for application business logic
    const params: Record<string, string> = { ...postParams };
    const parsedUrl = new URL(request.url);
    const searchParams = parsedUrl.searchParams;
    searchParams.forEach((val, key) => {
      if (!params[key]) params[key] = val;
    });

    // Extract status parameters
    const callSid = params.CallSid || params.callSid || '';
    const parentCallSid = params.ParentCallSid || params.parentCallSid || '';
    const rawCallStatus = (params.CallStatus || params.callStatus || '').toLowerCase();
    const rawDialCallSid = params.DialCallSid || params.dialCallSid || '';
    const rawDialCallStatus = (params.DialCallStatus || params.dialCallStatus || '').toLowerCase();
    const dialCallDurationStr = params.DialCallDuration || params.dialCallDuration || '';
    const callDurationStr = params.CallDuration || params.callDuration || '0';
    const direction = params.Direction || params.direction || '';
    const dbCallId = params.dbCallId || params.db_call_id || searchParams.get('dbCallId') || '';

    const sourceParam = searchParams.get('source') || (params.DialCallStatus ? 'dial-action' : (parentCallSid ? 'child-status' : 'parent-status'));
    const xForwardedHost = request.headers.get('x-forwarded-host') || '';
    const xForwardedProto = request.headers.get('x-forwarded-proto') || '';

    // Step 3 & 4: Log detailed callback debug info for EVERY request BEFORE returning 403 or processing
    console.log('[TWILIO CALLBACK DEBUG]', {
      source: sourceParam,
      pathname: parsedUrl.pathname,
      search: parsedUrl.search,
      dbCallId: dbCallId,
      CallSid: callSid,
      ParentCallSid: parentCallSid,
      CallStatus: rawCallStatus,
      DialCallSid: rawDialCallSid,
      DialCallStatus: rawDialCallStatus,
      DialCallDuration: dialCallDurationStr,
      CallDuration: callDurationStr,
      Direction: direction,
      SequenceNumber: params.SequenceNumber || params.sequenceNumber || '',
      'x-forwarded-host': xForwardedHost,
      'x-forwarded-proto': xForwardedProto,
      signatureValidationResult: isValidSignature,
    });

    if (!isValidSignature) {
      console.warn('[Twilio Status Callback] Unauthorized status callback request.');
      return new NextResponse('<Response><Say>Unauthorized</Say></Response>', {
        status: 403,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    if (!callSid && !dbCallId) {
      console.warn('[Twilio Status Callback] Missing both CallSid and dbCallId. Ignoring callback.');
      return new NextResponse('<Response/>', {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // 4. Fetch existing call record to check direction, status & answered_at status
    const adminSupabase = createAdminClient();
    let existingCall: { id: string; direction: string; status: string; answered_at: string | null } | null = null;

    if (callSid) {
      const { data } = await (adminSupabase as any)
        .from('calls')
        .select('id, direction, status, answered_at')
        .eq('twilio_call_sid', callSid)
        .maybeSingle();
      existingCall = data;
    }
    if (!existingCall && dbCallId) {
      const { data } = await (adminSupabase as any)
        .from('calls')
        .select('id, direction, status, answered_at')
        .eq('id', dbCallId)
        .maybeSingle();
      existingCall = data;
    }

    const recordDirection = existingCall?.direction || (direction.toLowerCase() === 'inbound' ? 'inbound' : 'outbound');
    const isRecordInbound = recordDirection === 'inbound';
    const existingAnsweredAt = existingCall?.answered_at || null;
    const existingStatus = existingCall?.status || 'unknown';

    // 5. Native status decision logic
    let dbStatus = rawCallStatus;
    let shouldSetAnsweredAt = false;

    const terminalOutcomes = ['completed', 'no-answer', 'busy', 'canceled', 'failed'];

    // 5. Inbound and Outbound Call Status Determination
    const wasExplicitlyAnswered = existingAnsweredAt !== null;

    if (isRecordInbound) {
      const isDialStatusPresent = Boolean(rawDialCallStatus);
      const isDialAnswered = rawDialCallStatus === 'completed' || rawDialCallStatus === 'answered';

      if (isDialStatusPresent) {
        // Authoritative <Dial action> callback for browser-agent leg
        if (isDialAnswered) {
          dbStatus = (rawCallStatus === 'in-progress' || rawCallStatus === 'answered') ? 'in-progress' : 'completed';
          shouldSetAnsweredAt = true;
        } else if (['no-answer', 'busy', 'canceled', 'failed'].includes(rawDialCallStatus)) {
          if (wasExplicitlyAnswered) {
            // Agent previously answered via browser endpoint -> call completed normally
            dbStatus = 'completed';
          } else {
            // Agent never answered -> no-answer outcome
            dbStatus = rawDialCallStatus;
          }
        } else {
          dbStatus = rawDialCallStatus;
        }
      } else {
        // Generic parent lifecycle callback (no DialCallStatus present)
        if (rawCallStatus === 'in-progress') {
          // Parent PSTN connection in-progress MUST NOT mark inbound call as answered
          if (wasExplicitlyAnswered || existingStatus === 'in-progress' || existingStatus === 'answered') {
            dbStatus = 'in-progress';
          } else if (terminalOutcomes.includes(existingStatus)) {
            dbStatus = existingStatus;
          } else {
            dbStatus = 'ringing';
          }
        } else if (rawCallStatus === 'completed') {
          if (wasExplicitlyAnswered || existingStatus === 'completed') {
            dbStatus = 'completed';
          } else if (['no-answer', 'busy', 'canceled', 'failed'].includes(existingStatus)) {
            dbStatus = existingStatus;
          } else {
            // Parent completed with no answered_at -> no-answer
            dbStatus = 'no-answer';
          }
        } else if (['initiated', 'ringing'].includes(rawCallStatus)) {
          dbStatus = terminalOutcomes.includes(existingStatus) ? existingStatus : 'ringing';
        } else if (['no-answer', 'busy', 'canceled', 'failed'].includes(rawCallStatus)) {
          dbStatus = wasExplicitlyAnswered ? 'completed' : rawCallStatus;
        } else {
          dbStatus = existingStatus !== 'unknown' ? existingStatus : (rawCallStatus || 'no-answer');
        }
      }
    } else {
      // Outbound call lifecycle
      const effectiveStatus = rawDialCallStatus || rawCallStatus;
      if (['no-answer', 'busy', 'canceled', 'failed'].includes(effectiveStatus)) {
        dbStatus = effectiveStatus;
      } else if (rawCallStatus === 'completed' || rawDialCallStatus === 'completed') {
        dbStatus = 'completed';
        shouldSetAnsweredAt = true;
      } else if (['in-progress', 'answered'].includes(rawCallStatus)) {
        dbStatus = 'in-progress';
        shouldSetAnsweredAt = true;
      } else {
        dbStatus = rawCallStatus || 'completed';
      }
    }

    // 6. Calculate Talk Duration vs Ringing Duration
    const nowIso = new Date().toISOString();
    let finalDurationSeconds = 0;

    if (isRecordInbound) {
      if (wasExplicitlyAnswered || shouldSetAnsweredAt) {
        const parsedDuration = parseInt(dialCallDurationStr || callDurationStr, 10) || 0;
        if (parsedDuration > 0) {
          finalDurationSeconds = parsedDuration;
        } else if (existingAnsweredAt) {
          const ansMs = new Date(existingAnsweredAt).getTime();
          finalDurationSeconds = Math.max(0, Math.floor((Date.now() - ansMs) / 1000));
        } else {
          finalDurationSeconds = 0;
        }
      } else {
        // Force 0 for unanswered calls (override 35s PSTN ringing time)
        finalDurationSeconds = 0;
      }
    } else {
      finalDurationSeconds = parseInt(dialCallDurationStr || callDurationStr, 10) || 0;
    }

    // 7. Structured Diagnostic Logging for Twilio Status Callback
    console.log('[TWILIO DIAL STATUS CALLBACK]', {
      CallSid: callSid,
      ParentCallSid: parentCallSid,
      CallStatus: rawCallStatus,
      DialCallSid: rawDialCallSid,
      DialCallStatus: rawDialCallStatus || '(none)',
      DialCallDuration: dialCallDurationStr || '(none)',
      dbCallId: dbCallId || existingCall?.id || '',
      'existing database status': existingStatus,
      'existing answered_at': existingAnsweredAt || 'NULL',
      'final database status': dbStatus,
      'final talk duration_seconds': finalDurationSeconds,
    });

    const updatePayload: Record<string, any> = {
      status: dbStatus,
      updated_at: nowIso,
    };

    // Extract answering agent identity if available from Twilio client call
    const calledTarget = params.Called || params.DialCallTarget || params.To || '';
    if (calledTarget.includes('client:')) {
      const twilioIdentity = calledTarget.split('client:')[1] || '';
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

    if (dbStatus === 'answered' || dbStatus === 'in-progress') {
      if (shouldSetAnsweredAt && !existingAnsweredAt) {
        updatePayload.answered_at = nowIso;
      }
    } else if (dbStatus === 'completed') {
      updatePayload.ended_at = nowIso;
      updatePayload.duration_seconds = finalDurationSeconds;
      if (shouldSetAnsweredAt && !existingAnsweredAt) {
        updatePayload.answered_at = nowIso;
      }
    } else if (['no-answer', 'busy', 'canceled', 'failed', 'missed'].includes(dbStatus)) {
      updatePayload.ended_at = nowIso;
      updatePayload.duration_seconds = 0;
      if (!existingAnsweredAt) {
        updatePayload.answered_at = null;
      }
    }

    // 7. Update database call record using Admin client (bypassing RLS for server callback)
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

    // Release reservations when call reaches terminal status
    if (['completed', 'no-answer', 'busy', 'canceled', 'failed', 'missed'].includes(dbStatus)) {
      const targetCallId = dbCallId || existingCall?.id;
      if (targetCallId) {
        await (adminSupabase as any)
          .from('agent_call_reservations')
          .delete()
          .eq('call_id', targetCallId);
      }
    }

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
