import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeE164PhoneNumber } from '@/lib/utils';

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
    let preferAssignedAgentEnabled = false;
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
        .select('id, routing_strategy, prefer_assigned_agent, auto_recording_enabled, last_routed_user_id')
        .limit(1)
        .single();

      if (firstOrg) {
        organizationId = firstOrg.id;
        routingStrategy = firstOrg.routing_strategy || 'ring_all';
        preferAssignedAgentEnabled = Boolean(firstOrg.prefer_assigned_agent);
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

    // Check if caller is BLOCKED in organization block list or contacts directory
    if (organizationId && customerFrom && customerFrom !== 'Unknown Caller') {
      const fromValidation = normalizeE164PhoneNumber(customerFrom);
      const normalizedFrom = fromValidation.normalized || customerFrom;

      const { data: blockedNumber } = await (adminSupabase as any)
        .from('blocked_numbers')
        .select('id, phone_number, contact_id')
        .eq('organization_id', organizationId)
        .eq('normalized_phone', normalizedFrom)
        .maybeSingle();

      const { data: blockedContact } = await (adminSupabase as any)
        .from('contacts')
        .select('id, full_name, is_blocked')
        .eq('organization_id', organizationId)
        .eq('phone', normalizedFrom)
        .eq('is_blocked', true)
        .is('archived_at', null)
        .maybeSingle();

      if (blockedNumber || blockedContact) {
        console.log(`[Twilio Inbound Webhook] Caller ${customerFrom} (${normalizedFrom}) is BLOCKED in org ${organizationId}. Terminating call cleanly.`);

        // Log auditable call attempt with status = 'blocked'
        try {
          await (adminSupabase as any).from('calls').insert({
            organization_id: organizationId,
            twilio_call_sid: callSid,
            direction: 'inbound',
            from_number: customerFrom,
            to_number: companyTo,
            status: 'blocked',
            contact_id: blockedContact?.id || blockedNumber?.contact_id || null,
            started_at: new Date().toISOString(),
            ended_at: new Date().toISOString(),
          });
        } catch (logErr) {
          console.warn('[Twilio Inbound Webhook] Exception logging blocked call attempt:', logErr);
        }

        const rejectTwiml = new twilio.twiml.VoiceResponse();
        rejectTwiml.say('The number you are trying to reach is unavailable.');
        rejectTwiml.hangup();
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
        .select('routing_strategy, prefer_assigned_agent, auto_recording_enabled, last_routed_user_id')
        .eq('id', organizationId)
        .single();
      if (orgInfo) {
        routingStrategy = orgInfo.routing_strategy || 'ring_all';
        preferAssignedAgentEnabled = Boolean(orgInfo.prefer_assigned_agent);
        autoRecordingEnabled = orgInfo.auto_recording_enabled !== false;
        lastRoutedUserId = orgInfo.last_routed_user_id || null;
      }
    }

    // 3. Insert inbound call record into public.calls (status = 'ringing') first to obtain dbCallId
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

    // 4. Reserve target agents using atomic database RPC functions
    let reservedAgents: { id: string; full_name: string; twilio_identity: string }[] = [];
    let isPreferredAttempt = false;

    // A. Check Preferred Agent Routing Layer FIRST if enabled
    if (preferAssignedAgentEnabled && customerFrom && customerFrom !== 'Unknown Caller') {
      const fromVal = normalizeE164PhoneNumber(customerFrom);
      const normalizedFrom = fromVal.normalized || customerFrom;

      const { data: matchedContact } = await (adminSupabase as any)
        .from('contacts')
        .select('id, assigned_user_id')
        .eq('organization_id', organizationId)
        .eq('phone', normalizedFrom)
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let preferredUserId: string | null = null;

      if (matchedContact) {
        if (dbCallId) {
          await (adminSupabase as any)
            .from('calls')
            .update({ contact_id: matchedContact.id })
            .eq('id', dbCallId);
        }
        if (matchedContact.assigned_user_id) {
          preferredUserId = matchedContact.assigned_user_id;
        }
      }

      // If no saved contact or contact has no assigned_user_id, check caller_assignments
      if (!preferredUserId) {
        const { data: callerAssignment } = await (adminSupabase as any)
          .from('caller_assignments')
          .select('assigned_user_id')
          .eq('organization_id', organizationId)
          .eq('phone_number', normalizedFrom)
          .maybeSingle();

        if (callerAssignment && callerAssignment.assigned_user_id) {
          preferredUserId = callerAssignment.assigned_user_id;
        }
      }

      if (preferredUserId) {
        const { data: rpcPrefAgent, error: prefErr } = await (adminSupabase as any).rpc(
          'reserve_preferred_agent',
          {
            p_organization_id: organizationId,
            p_call_id: dbCallId || null,
            p_preferred_user_id: preferredUserId,
            p_ttl_seconds: 45,
          }
        );

        if (!prefErr && rpcPrefAgent && rpcPrefAgent.length > 0) {
          reservedAgents = rpcPrefAgent;
          isPreferredAttempt = true;
          console.log('[Twilio Inbound Webhook] PREFERRED AGENT RESERVED:', {
            matchedContactId: matchedContact?.id || null,
            preferredUserId,
            agent_name: rpcPrefAgent[0].full_name,
          });
        } else {
          console.log('[Twilio Inbound Webhook] Preferred agent unavailable/occupied/offline/Admin. Falling back to default strategy.');
        }
      }
    }

    // B. Fallback / Default Routing Strategy (Round Robin or Ring All)
    if (!isPreferredAttempt) {
      if (routingStrategy === 'round_robin') {
        const { data: rpcAgent, error: rpcErr } = await (adminSupabase as any).rpc(
          'reserve_next_round_robin_agent',
          {
            p_organization_id: organizationId,
            p_call_id: dbCallId || null,
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
            p_call_id: dbCallId || null,
            p_ttl_seconds: 45,
          }
        );

        if (!rpcErr && rpcAgents) {
          reservedAgents = rpcAgents;
        }
      }

      // Fallback: If RPC function is not yet created in database, perform clean application-level reservation
      if (reservedAgents.length === 0) {
        await (adminSupabase as any)
          .from('agent_call_reservations')
          .delete()
          .lte('expires_at', new Date().toISOString());

        const { data: activeCalls } = await (adminSupabase as any)
          .from('calls')
          .select('user_id, status, created_at')
          .eq('organization_id', organizationId)
          .is('ended_at', null)
          .in('status', ['initiated', 'ringing', 'in-progress', 'queued'])
          .not('user_id', 'is', null);

        const { data: activeRes } = await (adminSupabase as any)
          .from('agent_call_reservations')
          .select('user_id')
          .eq('organization_id', organizationId)
          .gt('expires_at', new Date().toISOString());

        const cutoffMs = Date.now() - 15 * 60 * 1000;
        const unavailableUserIds = new Set<string>();

        if (activeCalls) {
          for (const c of activeCalls) {
            if (!c.user_id) continue;
            const isConnected = c.status === 'in-progress';
            const isRecentSetup = ['initiated', 'ringing', 'queued'].includes(c.status) &&
              c.created_at && new Date(c.created_at).getTime() > cutoffMs;

            if (isConnected || isRecentSetup) {
              unavailableUserIds.add(c.user_id);
            }
          }
        }
        if (activeRes) {
          for (const r of activeRes) {
            if (r.user_id) unavailableUserIds.add(r.user_id);
          }
        }

        const { data: availableAgents } = await (adminSupabase as any)
          .from('profiles')
          .select('id, full_name, twilio_identity')
          .eq('organization_id', organizationId)
          .eq('active', true)
          .eq('availability_status', 'available')
          .in('role', ['agent', 'manager'])
          .order('id', { ascending: true });

        const eligible = ((availableAgents || []) as { id: string; full_name: string; twilio_identity: string }[]).filter(
          (a) => !unavailableUserIds.has(a.id)
        );

        if (eligible.length > 0) {
          if (routingStrategy === 'round_robin') {
            let nextIndex = 0;
            if (lastRoutedUserId) {
              const lastIdx = eligible.findIndex((a) => a.id === lastRoutedUserId);
              if (lastIdx !== -1) {
                nextIndex = (lastIdx + 1) % eligible.length;
              }
            }
            const chosen = eligible[nextIndex];
            reservedAgents = [chosen];
            await (adminSupabase as any)
              .from('organizations')
              .update({ last_routed_user_id: chosen.id, updated_at: new Date().toISOString() })
              .eq('id', organizationId);
          } else {
            reservedAgents = eligible;
          }

          const expiresAt = new Date(Date.now() + 45 * 1000).toISOString();
          const reservationRows = reservedAgents.map((a) => ({
            organization_id: organizationId,
            user_id: a.id,
            call_id: dbCallId || null,
            reservation_type: routingStrategy,
            expires_at: expiresAt,
          }));

          await (adminSupabase as any).from('agent_call_reservations').insert(reservationRows);
        }
      }
    }

    console.log(`[Twilio Inbound Webhook] Reserved ${reservedAgents.length} agents for org ${organizationId} (Preferred: ${isPreferredAttempt}, Strategy: ${routingStrategy})`);

    const voiceResponse = new twilio.twiml.VoiceResponse();
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://krispcall-voip-clone-udlg.vercel.app';

    if (reservedAgents.length === 0) {
      console.log('[Twilio Inbound Webhook] No free, unreserved agents available in organization. Playing busy message.');
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

    let targetIdentities: string[] = reservedAgents
      .map((a) => a.twilio_identity || `agent_${a.id.replace(/-/g, '')}`)
      .filter((id) => Boolean(id && id.trim()));

    console.log('[TWILIO CLIENT TARGETS]', reservedAgents.map((a) => ({
      identity: a.twilio_identity || `agent_${a.id.replace(/-/g, '')}`,
      'profile id': a.id,
      availability: (a as any).availability_status || 'available',
      isPreferred: isPreferredAttempt,
    })));

    const isValidE164 = (num: string) => /^\+[1-9]\d{1,14}$/.test(num);
    const dialCallerId = isValidE164(customerFrom) ? customerFrom : (isValidE164(companyTo) ? companyTo : process.env.TWILIO_PHONE_NUMBER || companyTo);

    // If preferred attempt, set action to preferred fallback route with 18s timeout; else status route with 30s timeout
    const dialStatusActionUrl = isPreferredAttempt
      ? `${baseUrl}/api/twilio/voice/fallback?dbCallId=${encodeURIComponent(dbCallId)}&attempt=preferred`
      : (dbCallId
          ? `${baseUrl}/api/twilio/status?source=dial-action&dbCallId=${encodeURIComponent(dbCallId)}`
          : `${baseUrl}/api/twilio/status?source=dial-action`);

    const dialOptions: Record<string, any> = {
      callerId: dialCallerId,
      timeout: isPreferredAttempt ? 18 : 30,
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
