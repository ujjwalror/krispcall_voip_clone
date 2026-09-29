import { NextResponse } from 'next/server';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { createAdminClient } from '@/lib/supabase/admin';
import { TelecomDomainService } from '@/lib/billing/telecom/telecomDomainService';
import { VoiceSettlementService } from '@/lib/billing/telecom/voiceSettlementService';
import { InboundVoiceSettlementService } from '@/lib/billing/telecom/inboundVoiceSettlementService';

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

    const adminSupabase = createAdminClient();

    // Ingest provider status event into telecom_provider_event_log (durable deduplication)
    try {
      const resourceId = rawDialCallSid || callSid;
      const seqStr = params.SequenceNumber || params.sequenceNumber || null;
      const seqNum = seqStr !== null ? parseInt(seqStr, 10) : null;

      await TelecomDomainService.logProviderEvent(adminSupabase, {
        provider: 'twilio',
        eventId: params.EventSid || null,
        providerResourceId: resourceId,
        eventType: `call_status_${rawCallStatus || 'unknown'}`,
        sequenceNumber: Number.isNaN(seqNum) ? null : seqNum,
        payload: params,
      });
    } catch (evtErr: any) {
      console.warn('[Twilio Status Callback] Non-fatal event log error:', evtErr.message || evtErr);
    }

    // 4. Fetch existing call record to check direction, status & answered_at status
    let existingCall: { id: string; organization_id: string; direction: string; status: string; answered_at: string | null } | null = null;

    if (callSid) {
      const { data } = await (adminSupabase as any)
        .from('calls')
        .select('id, organization_id, direction, status, answered_at')
        .eq('twilio_call_sid', callSid)
        .maybeSingle();
      existingCall = data;
    }
    if (!existingCall && dbCallId) {
      const { data } = await (adminSupabase as any)
        .from('calls')
        .select('id, organization_id, direction, status, answered_at')
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
          } else if (searchParams.get('attempt') === 'preferred') {
            // Preferred agent attempt timed out; preserve ringing status while fallback engine routes call
            dbStatus = 'ringing';
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

    // Release legacy agent call reservations when call reaches terminal status
    if (['completed', 'no-answer', 'busy', 'canceled', 'failed', 'missed'].includes(dbStatus)) {
      const targetCallId = dbCallId || existingCall?.id;
      if (targetCallId) {
        await (adminSupabase as any)
          .from('agent_call_reservations')
          .delete()
          .eq('call_id', targetCallId);
      }
    }

    // Authoritative Prepaid Telecom Usage Settlement / Release for Outbound Calls
    if (!isRecordInbound && ['completed', 'no-answer', 'busy', 'canceled', 'failed'].includes(dbStatus)) {
      const targetCallId = dbCallId || existingCall?.id;
      const targetOrgId = existingCall?.organization_id;

      if (targetCallId && targetOrgId) {
        try {
          const settlementRes = await VoiceSettlementService.processChildStatusCallback(adminSupabase, {
            organizationId: targetOrgId,
            dbCallId: targetCallId,
            callSid,
            parentCallSid,
            callStatus: dbStatus,
            callDurationStr: dialCallDurationStr || callDurationStr,
            payload: params,
          });

          console.log('[Twilio Status Callback] Outbound voice usage settlement result:', settlementRes);
        } catch (settleErr: any) {
          console.error('[Twilio Status Callback] Error executing outbound usage settlement:', settleErr.message || settleErr);
        }
      } else {
        console.warn('[Twilio Status Callback] Could not resolve targetCallId or organization_id for settlement:', { targetCallId, targetOrgId });
      }
    }

    // Authoritative Prepaid Telecom Usage Settlement / Release for Inbound Calls
    if (isRecordInbound && ['completed', 'no-answer', 'busy', 'canceled', 'failed'].includes(dbStatus)) {
      if (callSid) {
        try {
          const inboundSettlementRes = await InboundVoiceSettlementService.processInboundCallStatusCallback(adminSupabase, {
            callSid,
            parentCallSid,
            dialCallSid: rawDialCallSid,
            callStatus: dbStatus,
            dialCallStatus: rawDialCallStatus,
            callDuration: dialCallDurationStr || callDurationStr,
            dialCallDuration: dialCallDurationStr,
            sequenceNumber: params.SequenceNumber || params.sequenceNumber,
            providerPrice: params.Price || params.price,
          });
          console.log('[Twilio Status Callback] Inbound voice usage settlement result:', inboundSettlementRes);
        } catch (inboundSettleErr: any) {
          console.error('[Twilio Status Callback] Error executing inbound usage settlement:', inboundSettleErr.message || inboundSettleErr);
        }
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
