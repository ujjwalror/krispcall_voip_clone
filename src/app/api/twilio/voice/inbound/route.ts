import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Inbound Voice TwiML Webhook Endpoint for Twilio Programmable Voice.
 * Configured in Twilio Console as the Voice Request URL for incoming calls to the company number.
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

    // Validate signature if auth token is configured
    const isValidSignature = await validateTwilioRequest(request, params);
    if (!isValidSignature) {
      const errorResponse = new twilio.twiml.VoiceResponse();
      errorResponse.say('Unauthorized webhook request.');
      errorResponse.reject();
      return new NextResponse(errorResponse.toString(), {
        status: 403,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    const callSid = params.CallSid || params.callSid || '';
    const customerFrom = params.From || params.from || 'Unknown Caller';
    const companyTo = params.To || params.to || process.env.TWILIO_PHONE_NUMBER || '';

    console.log(`[Twilio Inbound Webhook] Received call from "${customerFrom}" to "${companyTo}" (CallSid: ${callSid})`);

    const adminSupabase = createAdminClient();

    // 1. Locate organization associated with phone number or default organization
    let organizationId = '';
    let routingStrategy: 'ring_all' | 'round_robin' = 'ring_all';
    let autoRecordingEnabled = true;
    let lastRoutedUserId: string | null = null;

    const { data: phoneRecord } = await (adminSupabase as any)
      .from('phone_numbers')
      .select('organization_id')
      .eq('phone_number', companyTo)
      .single();

    if (phoneRecord && phoneRecord.organization_id) {
      organizationId = phoneRecord.organization_id;
    } else {
      // Fallback: pick first organization in workspace
      const { data: firstOrg } = await (adminSupabase as any)
        .from('organizations')
        .select('id, routing_strategy, auto_recording_enabled, last_routed_user_id')
        .limit(1)
        .single();

      if (firstOrg) {
        organizationId = firstOrg.id;
        routingStrategy = firstOrg.routing_strategy || 'ring_all';
        autoRecordingEnabled = firstOrg.auto_recording_enabled !== false;
        lastRoutedUserId = firstOrg.last_routed_user_id || null;
      }
    }

    if (!organizationId) {
      console.error('[Twilio Inbound Webhook] No organization found to route incoming call.');
      const errRes = new twilio.twiml.VoiceResponse();
      errRes.say('No active organization found to handle this call.');
      errRes.hangup();
      return new NextResponse(errRes.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // 2. Fetch organization settings if not loaded
    if (!lastRoutedUserId) {
      const { data: orgInfo } = await (adminSupabase as any)
        .from('organizations')
        .select('routing_strategy, auto_recording_enabled, last_routed_user_id')
        .eq('id', organizationId)
        .single();
      if (orgInfo) {
        routingStrategy = orgInfo.routing_strategy || 'ring_all';
        autoRecordingEnabled = orgInfo.auto_recording_enabled !== false;
        lastRoutedUserId = orgInfo.last_routed_user_id || null;
      }
    }

    // 3. Find available, active agents in workspace with fresh heartbeat (last 2 minutes)
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    const { data: availableAgents } = await (adminSupabase as any)
      .from('profiles')
      .select('id, full_name, twilio_identity, last_seen_at')
      .eq('organization_id', organizationId)
      .eq('active', true)
      .eq('availability_status', 'available')
      .gte('last_seen_at', twoMinutesAgo)
      .order('id', { ascending: true });

    const agents = (availableAgents || []) as { id: string; full_name: string; twilio_identity: string }[];

    // Fallback: if heartbeat index is not updated yet, select active, available profiles
    let targetAgents = agents;
    if (targetAgents.length === 0) {
      const { data: fallbackAgents } = await (adminSupabase as any)
        .from('profiles')
        .select('id, full_name, twilio_identity')
        .eq('organization_id', organizationId)
        .eq('active', true)
        .eq('availability_status', 'available')
        .order('id', { ascending: true });
      targetAgents = (fallbackAgents || []) as any;
    }

    console.log(`[Twilio Inbound Webhook] Found ${targetAgents.length} available agents for org ${organizationId}`);

    // 4. Insert inbound call record into public.calls (status = 'ringing')
    let dbCallId = '';
    const { data: newCall, error: insertErr } = await (adminSupabase as any)
      .from('calls')
      .insert({
        organization_id: organizationId,
        twilio_call_sid: callSid,
        direction: 'inbound',
        from_number: customerFrom,
        to_number: companyTo,
        status: 'ringing',
        record_call: autoRecordingEnabled,
      })
      .select('id')
      .single();

    if (newCall) {
      dbCallId = newCall.id;
    }
    if (insertErr) {
      console.error('[Twilio Inbound Webhook] Error creating inbound call record:', insertErr);
    }

    const voiceResponse = new twilio.twiml.VoiceResponse();
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://krispcall-voip-clone-udlg.vercel.app';

    if (targetAgents.length === 0) {
      console.log('[Twilio Inbound Webhook] No agents available. Playing busy message.');
      voiceResponse.say('Thank you for calling. All of our agents are currently busy or unavailable. Please leave a message or call back shortly.');
      voiceResponse.hangup();
      return new NextResponse(voiceResponse.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // Determine target client identities based on routing strategy
    let targetIdentities: string[] = [];

    if (routingStrategy === 'round_robin') {
      // Find index of last routed user and pick next
      let nextIndex = 0;
      if (lastRoutedUserId) {
        const lastIdx = targetAgents.findIndex((a) => a.id === lastRoutedUserId);
        if (lastIdx !== -1) {
          nextIndex = (lastIdx + 1) % targetAgents.length;
        }
      }
      const selectedAgent = targetAgents[nextIndex];
      targetIdentities = [selectedAgent.twilio_identity || `agent_${selectedAgent.id.replace(/-/g, '')}`];

      // Update last_routed_user_id
      await (adminSupabase as any)
        .from('organizations')
        .update({ last_routed_user_id: selectedAgent.id })
        .eq('id', organizationId);
    } else {
      // Ring All strategy: ring all available agent identities
      targetIdentities = targetAgents.map(
        (a) => a.twilio_identity || `agent_${a.id.replace(/-/g, '')}`
      );
    }

    // Build TwiML <Dial> options
    const dialOptions: Record<string, any> = {
      callerId: companyTo,
      timeout: 30,
    };

    if (autoRecordingEnabled) {
      const recordingStatusCallbackUrl = dbCallId
        ? `${baseUrl}/api/twilio/recording?dbCallId=${encodeURIComponent(dbCallId)}`
        : `${baseUrl}/api/twilio/recording`;

      dialOptions.record = 'record-from-answer';
      dialOptions.recordingStatusCallback = recordingStatusCallbackUrl;
      dialOptions.recordingStatusCallbackEvent = 'completed';
      dialOptions.recordingStatusCallbackMethod = 'POST';
    }

    const dial = voiceResponse.dial(dialOptions);

    // Attach target <Client> identities to <Dial>
    targetIdentities.forEach((identity) => {
      const statusCallbackUrl = dbCallId
        ? `${baseUrl}/api/twilio/status?dbCallId=${encodeURIComponent(dbCallId)}`
        : `${baseUrl}/api/twilio/status`;

      dial.client(
        {
          statusCallback: statusCallbackUrl,
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
          statusCallbackMethod: 'POST',
        },
        identity
      );
    });

    return new NextResponse(voiceResponse.toString(), {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  } catch (error: any) {
    console.error('[Twilio Inbound Webhook] Exception processing inbound call:', error.message || error);
    const errorResponse = new twilio.twiml.VoiceResponse();
    errorResponse.say('An error occurred while connecting your call.');
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
