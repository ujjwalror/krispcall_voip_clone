import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeE164PhoneNumber } from '@/lib/utils';

export interface CreateOutboundCallParams {
  userId: string;
  organizationId: string;
  destination: string;
  fromNumber?: string;
  recordCall?: boolean;
}

export interface CreateOutboundCallResult {
  success: boolean;
  callId: string;
  call: any;
}

export class OutboundCallError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = 'OutboundCallError';
    this.statusCode = statusCode;
  }
}

/**
 * Authoritative Server-Only Outbound Call Setup Business Logic.
 * Shared across web API (/api/twilio/calls/create) and Chrome Extension API (/api/extension/calls/create).
 */
export async function executeOutboundCallSetup(
  params: CreateOutboundCallParams
): Promise<CreateOutboundCallResult> {
  const { userId, organizationId, destination, fromNumber: rawFromNumber, recordCall = false } = params;

  if (!userId || !organizationId) {
    throw new OutboundCallError('Forbidden. User profile or organization unconfigured.', 403);
  }

  const adminSupabase = createAdminClient();

  // 1. Clean up expired agent reservations
  await (adminSupabase as any)
    .from('agent_call_reservations')
    .delete()
    .lte('expires_at', new Date().toISOString());

  // 2. Atomic outbound reservation lock: Guarantee only 1 call setup per user at a time
  const expiresAt = new Date(Date.now() + 45 * 1000).toISOString();
  const { data: resRow, error: resErr } = await (adminSupabase as any)
    .from('agent_call_reservations')
    .insert({
      organization_id: organizationId,
      user_id: userId,
      reservation_type: 'outbound',
      expires_at: expiresAt,
    })
    .select('id')
    .maybeSingle();

  if (resErr || !resRow) {
    throw new OutboundCallError(
      'You already have an active call or pending call setup. Finish your current call before starting another.',
      409
    );
  }

  const reservationId = resRow.id;

  try {
    // 3. Check if agent already owns an active call row in database (with stale 'initiated' safety net)
    const { data: existingActiveCalls } = await (adminSupabase as any)
      .from('calls')
      .select('id, status, started_at, created_at')
      .eq('organization_id', organizationId)
      .in('status', ['initiated', 'ringing', 'in-progress', 'queued'])
      .eq('user_id', userId);

    if (existingActiveCalls && existingActiveCalls.length > 0) {
      const nowMs = Date.now();
      const STALE_INITIATED_THRESHOLD_MS = 60 * 1000; // 60s threshold (exceeds 45s reservation TTL)

      let hasGenuineActiveCall = false;

      for (const callRow of existingActiveCalls) {
        if (callRow.status === 'initiated') {
          const startTimeStr = callRow.started_at || callRow.created_at;
          const startTimeMs = startTimeStr ? new Date(startTimeStr).getTime() : 0;
          const ageMs = nowMs - startTimeMs;

          if (ageMs > STALE_INITIATED_THRESHOLD_MS) {
            console.log(`[Outbound Call Setup] Found stale initiated call "${callRow.id}" (age: ${Math.round(ageMs / 1000)}s). Terminalizing as failed.`);
            const nowIso = new Date().toISOString();
            await (adminSupabase as any)
              .from('calls')
              .update({
                status: 'failed',
                ended_at: nowIso,
                updated_at: nowIso,
              })
              .eq('id', callRow.id);

            await (adminSupabase as any)
              .from('agent_call_reservations')
              .delete()
              .eq('call_id', callRow.id);
          } else {
            hasGenuineActiveCall = true;
          }
        } else {
          // 'ringing', 'in-progress', or 'queued' calls are genuine active calls
          hasGenuineActiveCall = true;
        }
      }

      if (hasGenuineActiveCall) {
        throw new OutboundCallError(
          'You already have an active call. Finish your current call before starting another.',
          409
        );
      }
    }

    // 4. Extract & validate destination E.164 phone number
    const validation = normalizeE164PhoneNumber(destination || '');
    if (!validation.isValid || !validation.normalized) {
      throw new OutboundCallError(validation.error || 'Invalid destination phone number.', 400);
    }

    const normalizedDestination = validation.normalized;

    // 5. Blocked-number check for organization
    const { data: blockedRecord } = await (adminSupabase as any)
      .from('blocked_numbers')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('normalized_phone', normalizedDestination)
      .maybeSingle();

    if (blockedRecord) {
      throw new OutboundCallError('This number is blocked. Unblock it before calling.', 403);
    }

    const { data: blockedContact } = await (adminSupabase as any)
      .from('contacts')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('phone', normalizedDestination)
      .eq('is_blocked', true)
      .is('archived_at', null)
      .maybeSingle();

    if (blockedContact) {
      throw new OutboundCallError('This number is blocked. Unblock it before calling.', 403);
    }

    // 6. Resolve caller ID Business Number
    let callerId = (rawFromNumber || '').trim();
    if (!callerId) {
      const { data: primaryPhone } = await (adminSupabase as any)
        .from('phone_numbers')
        .select('phone_number')
        .eq('organization_id', organizationId)
        .eq('active', true)
        .order('is_primary', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (primaryPhone?.phone_number) {
        callerId = primaryPhone.phone_number;
      } else {
        callerId = process.env.TWILIO_PHONE_NUMBER || '+61348328472';
      }
    } else {
      // Validate caller ID belongs to organization
      const { data: validOrgPhone } = await (adminSupabase as any)
        .from('phone_numbers')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('phone_number', callerId)
        .eq('active', true)
        .maybeSingle();

      if (!validOrgPhone && callerId !== process.env.TWILIO_PHONE_NUMBER) {
        // Fallback to primary if unverified custom number requested
        const { data: fallbackPhone } = await (adminSupabase as any)
          .from('phone_numbers')
          .select('phone_number')
          .eq('organization_id', organizationId)
          .eq('active', true)
          .order('is_primary', { ascending: false })
          .limit(1)
          .maybeSingle();

        callerId = fallbackPhone?.phone_number || process.env.TWILIO_PHONE_NUMBER || '+61348328472';
      }
    }

    // 7. Insert database call record into public.calls
    const { data: callRecord, error: insertError } = await (adminSupabase as any)
      .from('calls')
      .insert({
        organization_id: organizationId,
        user_id: userId,
        direction: 'outbound',
        from_number: callerId,
        to_number: normalizedDestination,
        status: 'initiated',
        record_call: Boolean(recordCall),
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError || !callRecord) {
      console.error('Error creating database call record:', insertError);
      throw new OutboundCallError('Failed to create database call log.', 500);
    }

    // 8. Update reservation to link call_id
    await (adminSupabase as any)
      .from('agent_call_reservations')
      .update({ call_id: callRecord.id })
      .eq('id', reservationId);

    return {
      success: true,
      callId: callRecord.id,
      call: callRecord,
    };
  } catch (error: any) {
    // Outbound failure cleanup: Release reservation immediately if any validation or DB step failed
    await (adminSupabase as any)
      .from('agent_call_reservations')
      .delete()
      .eq('id', reservationId);

    if (error instanceof OutboundCallError) {
      throw error;
    }
    const errorMessage = error.message || 'Failed to initiate call.';
    const status = errorMessage.includes('blocked') ? 403 : errorMessage.includes('active call') ? 409 : 400;
    throw new OutboundCallError(errorMessage, status);
  }
}
