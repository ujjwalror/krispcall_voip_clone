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

    // Validate signature using POST body parameters ONLY
    const isValidSignature = await validateTwilioRequest(request, postParams);
    if (!isValidSignature) {
      console.error('[TWILIO WEBHOOK ERROR]', {
        route: '/api/twilio/voice/inbound',
        status: 403,
        error: 'Unauthorized signature validation failure',
      });
      const errorResponse = new twilio.twiml.VoiceResponse();
      errorResponse.say('Unauthorized webhook request.');
      errorResponse.reject();
      return new NextResponse(errorResponse.toString(), {
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
    const customerFrom = params.From || params.from || 'Unknown Caller';
    const companyTo = params.To || params.to || process.env.TWILIO_PHONE_NUMBER || '';

    console.log('[TWILIO INBOUND REQUEST]', {
      CallSid: callSid,
      From: customerFrom,
      To: companyTo,
    });

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
      console.error('[TWILIO WEBHOOK ERROR]', {
        route: '/api/twilio/voice/inbound',
        status: 200,
        error: 'No active organization found to handle this call',
      });
      const errRes = new twilio.twiml.VoiceResponse();
      errRes.say('No active organization found to handle this call.');
      errRes.hangup();
      return new NextResponse(errRes.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // Check if caller is BLOCKED in organization contacts directory
    if (organizationId && customerFrom && customerFrom !== 'Unknown Caller') {
      const { data: blockedContact } = await (adminSupabase as any)
        .from('contacts')
        .select('id, full_name, is_blocked')
        .eq('organization_id', organizationId)
        .eq('phone', customerFrom)
        .eq('is_blocked', true)
        .is('archived_at', null)
        .maybeSingle();

      if (blockedContact) {
        console.log(`[Twilio Inbound Webhook] Caller ${customerFrom} (${blockedContact.full_name}) is BLOCKED in org ${organizationId}. Rejecting inbound call.`);
        const rejectTwiml = new twilio.twiml.VoiceResponse();
        rejectTwiml.say('Your call cannot be completed as your number has been blocked by the recipient.');
        rejectTwiml.reject();
        return new NextResponse(rejectTwiml.toString(), {
          status: 200,
          headers: { 'Content-Type': 'text/xml' },
        });
      }
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

    // 3. Find available, active agents in workspace
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    const { data: availableAgents } = await (adminSupabase as any)
      .from('profiles')
      .select('id, full_name, twilio_identity, last_seen_at')
      .eq('organization_id', organizationId)
      .eq('active', true)
      .eq('availability_status', 'available')
      .gte('last_seen_at', twoMinutesAgo)
      .order('id', { ascending: true });

    let targetAgents = (availableAgents || []) as { id: string; full_name: string; twilio_identity: string }[];

    // Fallback 1: select active, available profiles without strict 2-min heartbeat
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

    // Fallback 2: select active profiles in organization regardless of availability_status string
    if (targetAgents.length === 0) {
      const { data: orgActiveAgents } = await (adminSupabase as any)
        .from('profiles')
        .select('id, full_name, twilio_identity')
        .eq('organization_id', organizationId)
        .eq('active', true)
        .order('id', { ascending: true });
      targetAgents = (orgActiveAgents || []) as any;
    }

    // Fallback 3: select any active profiles in entire database
    if (targetAgents.length === 0) {
      const { data: allActiveAgents } = await (adminSupabase as any)
        .from('profiles')
        .select('id, full_name, twilio_identity')
        .eq('active', true)
        .order('id', { ascending: true });
      targetAgents = (allActiveAgents || []) as any;
    }

    console.log(`[Twilio Inbound Webhook] Found ${targetAgents.length} target agents for org ${organizationId}`);

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

    console.log('[TWILIO INBOUND CALL CREATE]', {
      'call SID': callSid,
      dbCallId: dbCallId,
      'initial status': 'ringing',
      direction: 'inbound',
    });

    const voiceResponse = new twilio.twiml.VoiceResponse();
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://krispcall-voip-clone-udlg.vercel.app';

    if (targetAgents.length === 0) {
      console.log('[Twilio Inbound Webhook] No agents available. Playing busy message.');
      voiceResponse.say('Thank you for calling. All of our agents are currently busy or unavailable. Please leave a message or call back shortly.');
      voiceResponse.hangup();
      const busyTwiml = voiceResponse.toString();
      console.log('[TWILIO INBOUND RESPONSE]', {
        'HTTP status': 200,
        'Exact TwiML returned': busyTwiml,
      });
      return new NextResponse(busyTwiml, {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // Determine target client identities based on routing strategy
    let targetIdentities: string[] = [];

    if (routingStrategy === 'round_robin') {
      let nextIndex = 0;
      if (lastRoutedUserId) {
        const lastIdx = targetAgents.findIndex((a) => a.id === lastRoutedUserId);
        if (lastIdx !== -1) {
          nextIndex = (lastIdx + 1) % targetAgents.length;
        }
      }
      const selectedAgent = targetAgents[nextIndex];
      targetIdentities = [selectedAgent.twilio_identity || `agent_${selectedAgent.id.replace(/-/g, '')}`];

      await (adminSupabase as any)
        .from('organizations')
        .update({ last_routed_user_id: selectedAgent.id })
        .eq('id', organizationId);
    } else {
      targetIdentities = targetAgents.map(
        (a) => a.twilio_identity || `agent_${a.id.replace(/-/g, '')}`
      );
    }

    // Filter out empty client identities
    targetIdentities = targetIdentities.filter((id) => Boolean(id && id.trim()));

    // Log target details with exact requested label [TWILIO CLIENT TARGETS]
    console.log('[TWILIO CLIENT TARGETS]', targetAgents.map((a) => ({
      identity: a.twilio_identity || `agent_${a.id.replace(/-/g, '')}`,
      'profile id': a.id,
      availability: (a as any).availability_status || 'available',
      last_seen_at: (a as any).last_seen_at || 'now',
    })));

    // Ensure valid callerId for Twilio <Dial>
    const isValidE164 = (num: string) => /^\+[1-9]\d{1,14}$/.test(num);
    const dialCallerId = isValidE164(customerFrom) ? customerFrom : (isValidE164(companyTo) ? companyTo : process.env.TWILIO_PHONE_NUMBER || companyTo);

    // Build TwiML <Dial> options with explicit source=dial-action
    const dialStatusActionUrl = dbCallId
      ? `${baseUrl}/api/twilio/status?source=dial-action&dbCallId=${encodeURIComponent(dbCallId)}`
      : `${baseUrl}/api/twilio/status?source=dial-action`;

    const dialOptions: Record<string, any> = {
      callerId: dialCallerId,
      timeout: 30,
      action: dialStatusActionUrl,
      method: 'POST',
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

    // Attach target <Client> identities to <Dial> using clean TwiML <Client> identity syntax and pass dbCallId parameter
    targetIdentities.forEach((identity) => {
      const client = dial.client(identity);
      if (dbCallId) {
        client.parameter({ name: 'dbCallId', value: dbCallId });
      }
    });

    const twimlOutput = voiceResponse.toString();

    // Log with exact requested label [TWILIO INBOUND DEBUG]
    console.log('[TWILIO INBOUND DEBUG]', {
      CallSid: callSid,
      From: customerFrom,
      To: companyTo,
      'HTTP response': 200,
      'Generated TwiML': twimlOutput,
    });

    return new NextResponse(twimlOutput, {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  } catch (error: any) {
    console.error('[TWILIO WEBHOOK ERROR]', {
      route: '/api/twilio/voice/inbound',
      status: 500,
      error: error.message || error,
    });
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
