import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Webhook endpoint triggered when a Preferred Agent attempt completes or times out without an answer.
 * If the preferred agent did not answer, releases the reservation and seamlessly transitions
 * the caller to the organization's default routing strategy (Ring All or Round Robin).
 */
export async function POST(request: Request) {
  try {
    const postParams: Record<string, string> = {};

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

    const isValidSignature = await validateTwilioRequest(request, postParams);
    if (!isValidSignature) {
      console.error('[TWILIO FALLBACK ERROR] Unauthorized signature validation failure');
      const errRes = new twilio.twiml.VoiceResponse();
      errRes.say('Unauthorized request.');
      errRes.reject();
      return new NextResponse(errRes.toString(), {
        status: 403,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    const params: Record<string, string> = { ...postParams };
    const { searchParams } = new URL(request.url);
    searchParams.forEach((val, key) => {
      if (!params[key]) params[key] = val;
    });

    const callSid = params.CallSid || params.callSid || '';
    const dbCallId = params.dbCallId || params.db_call_id || searchParams.get('dbCallId') || '';
    const dialCallStatus = (params.DialCallStatus || params.dialCallStatus || '').toLowerCase();
    const customerFrom = params.From || params.from || 'Unknown Caller';
    const companyTo = params.To || params.to || process.env.TWILIO_PHONE_NUMBER || '';

    console.log('[TWILIO PREFERRED AGENT FALLBACK CALLBACK]', {
      CallSid: callSid,
      dbCallId: dbCallId,
      DialCallStatus: dialCallStatus,
    });

    // If preferred agent answered, no fallback needed
    if (dialCallStatus === 'completed' || dialCallStatus === 'answered') {
      return new NextResponse('<Response/>', {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    const adminSupabase = createAdminClient();

    // 1. Fetch current call record
    let callRecord: { id: string; organization_id: string; status: string; answered_at: string | null; record_call: boolean } | null = null;
    if (dbCallId) {
      const { data } = await (adminSupabase as any)
        .from('calls')
        .select('id, organization_id, status, answered_at, record_call')
        .eq('id', dbCallId)
        .maybeSingle();
      callRecord = data;
    } else if (callSid) {
      const { data } = await (adminSupabase as any)
        .from('calls')
        .select('id, organization_id, status, answered_at, record_call')
        .eq('twilio_call_sid', callSid)
        .maybeSingle();
      callRecord = data;
    }

    if (!callRecord) {
      console.error('[TWILIO FALLBACK ERROR] Could not find call record for fallback');
      const errRes = new twilio.twiml.VoiceResponse();
      errRes.say('Thank you for calling. All of our agents are currently busy. Please call back shortly.');
      errRes.hangup();
      return new NextResponse(errRes.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // If call was already answered, return empty response
    if (callRecord.answered_at) {
      return new NextResponse('<Response/>', {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    const organizationId = callRecord.organization_id;

    // 2. Release preferred agent reservation for this call
    await (adminSupabase as any)
      .from('agent_call_reservations')
      .delete()
      .eq('call_id', callRecord.id);

    // 3. Fetch organization default routing strategy
    let routingStrategy: 'ring_all' | 'round_robin' = 'ring_all';
    let autoRecordingEnabled = callRecord.record_call !== false;

    const { data: orgInfo } = await (adminSupabase as any)
      .from('organizations')
      .select('routing_strategy, auto_recording_enabled')
      .eq('id', organizationId)
      .single();

    if (orgInfo) {
      routingStrategy = orgInfo.routing_strategy || 'ring_all';
      autoRecordingEnabled = orgInfo.auto_recording_enabled !== false;
    }

    // 4. Execute default routing strategy reservation for fallback agents
    let reservedAgents: { id: string; full_name: string; twilio_identity: string }[] = [];

    if (routingStrategy === 'round_robin') {
      const { data: rpcAgent, error: rpcErr } = await (adminSupabase as any).rpc(
        'reserve_next_round_robin_agent',
        {
          p_organization_id: organizationId,
          p_call_id: callRecord.id,
          p_ttl_seconds: 45,
        }
      );

      if (!rpcErr && rpcAgent && rpcAgent.length > 0) {
        reservedAgents = rpcAgent;
      }
    } else {
      const { data: rpcAgents, error: rpcErr } = await (adminSupabase as any).rpc(
        'reserve_ring_all_agents',
        {
          p_organization_id: organizationId,
          p_call_id: callRecord.id,
          p_ttl_seconds: 45,
        }
      );

      if (!rpcErr && rpcAgents) {
        reservedAgents = rpcAgents;
      }
    }

    console.log(
      `[TWILIO PREFERRED FALLBACK ENGINE] Preferred agent unanswered. Fallback to org default strategy (${routingStrategy}). Reserved ${reservedAgents.length} fallback agent(s).`
    );

    const voiceResponse = new twilio.twiml.VoiceResponse();
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://krispcall-voip-clone-udlg.vercel.app';

    if (reservedAgents.length === 0) {
      console.log('[TWILIO PREFERRED FALLBACK ENGINE] No free fallback agents available. Playing busy message and ending call.');

      // Mark call record as no-answer
      await (adminSupabase as any)
        .from('calls')
        .update({
          status: 'no-answer',
          ended_at: new Date().toISOString(),
          duration_seconds: 0,
          updated_at: new Date().toISOString(),
        })
        .eq('id', callRecord.id);

      voiceResponse.say('Thank you for calling. All of our agents are currently busy or unavailable. Please leave a message or call back shortly.');
      voiceResponse.hangup();

      return new NextResponse(voiceResponse.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    let targetIdentities: string[] = reservedAgents
      .map((a) => a.twilio_identity || `agent_${a.id.replace(/-/g, '')}`)
      .filter((id) => Boolean(id && id.trim()));

    const isValidE164 = (num: string) => /^\+[1-9]\d{1,14}$/.test(num);
    const dialCallerId = isValidE164(customerFrom) ? customerFrom : (isValidE164(companyTo) ? companyTo : process.env.TWILIO_PHONE_NUMBER || companyTo);

    const dialStatusActionUrl = `${baseUrl}/api/twilio/status?source=dial-action&dbCallId=${encodeURIComponent(callRecord.id)}`;

    const dialOptions: Record<string, any> = {
      callerId: dialCallerId,
      timeout: 30,
      action: dialStatusActionUrl,
      method: 'POST',
    };

    if (autoRecordingEnabled) {
      const recordingStatusCallbackUrl = `${baseUrl}/api/twilio/recording?dbCallId=${encodeURIComponent(callRecord.id)}`;
      dialOptions.record = 'record-from-answer';
      dialOptions.recordingStatusCallback = recordingStatusCallbackUrl;
      dialOptions.recordingStatusCallbackEvent = 'completed';
      dialOptions.recordingStatusCallbackMethod = 'POST';
    }

    const dial = voiceResponse.dial(dialOptions);

    targetIdentities.forEach((identity) => {
      const client = dial.client(identity);
      client.parameter({ name: 'dbCallId', value: callRecord!.id });
    });

    const twimlOutput = voiceResponse.toString();

    console.log('[TWILIO FALLBACK DIAL RESPONSE]', {
      dbCallId: callRecord.id,
      strategy: routingStrategy,
      targetsCount: targetIdentities.length,
      twiml: twimlOutput,
    });

    return new NextResponse(twimlOutput, {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  } catch (error: any) {
    console.error('[TWILIO FALLBACK WEBHOOK ERROR]', error.message || error);
    const errRes = new twilio.twiml.VoiceResponse();
    errRes.say('An error occurred while connecting your call.');
    errRes.hangup();
    return new NextResponse(errRes.toString(), {
      status: 500,
      headers: { 'Content-Type': 'text/xml' },
    });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
