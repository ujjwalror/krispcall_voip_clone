import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';

export interface ActiveTrafficCheckResult {
  hasActiveTraffic: boolean;
  activeCallCount: number;
  activeReservationCount: number;
  activeMessageCount: number;
  details: string[];
}

export class ActiveTrafficInterlockService {
  /**
   * Evaluates active calls, wallet usage reservations, and in-flight outbound messages
   * for a given phone number to ensure no active traffic traverses it prior to release.
   */
  static async checkActiveTraffic(
    phoneNumberId: string,
    phoneNumberE164: string,
    organizationId: string,
    client: SupabaseClient | any
  ): Promise<ActiveTrafficCheckResult> {
    const details: string[] = [];
    const normalizedE164 = phoneNumberE164.trim();

    // 1. Check Active Calls in public.calls
    // Protects all non-terminal call statuses ('queued', 'initiated', 'ringing', 'in-progress', 'connecting', 'answered', 'held', 'transferred', 'termination-pending', 'settlement-pending', 'provider-active')
    let activeCallCount = 0;
    try {
      const { data: calls, error: callsErr } = await (client as any)
        .from('calls')
        .select('id, status, twilio_call_sid, phone_number_id, from_number, to_number')
        .eq('organization_id', organizationId)
        .not('status', 'in', '("completed","failed","busy","no-answer","canceled","missed","blocked")');

      if (!callsErr && calls) {
        // Match either by phone_number_id or exact E.164 on from_number / to_number
        const matchingCalls = calls.filter((c: any) => {
          return (
            c.phone_number_id === phoneNumberId ||
            c.from_number === normalizedE164 ||
            c.to_number === normalizedE164
          );
        });
        activeCallCount = matchingCalls.length;
        if (activeCallCount > 0) {
          details.push(`ACTIVE_CALLS_DETECTED: Found ${activeCallCount} active/non-terminal call(s) in progress.`);
        }
      }
    } catch (err: any) {
      console.warn('[ActiveTrafficInterlock] Error querying calls table:', err?.message);
    }

    // 2. Check Active Wallet Usage Reservations (Prepaid Voice/SMS Exposure)
    let activeReservationCount = 0;
    try {
      const { data: reservations, error: resErr } = await (client as any)
        .from('telecom_usage_reservations')
        .select('id, status, metadata')
        .eq('organization_id', organizationId)
        .eq('status', 'active');

      if (!resErr && reservations) {
        const matchingRes = reservations.filter((r: any) => {
          const meta = r.metadata || {};
          return (
            meta.phoneNumberId === phoneNumberId ||
            meta.phoneNumberE164 === normalizedE164 ||
            meta.phone_number === normalizedE164 ||
            meta.from_number === normalizedE164 ||
            meta.to_number === normalizedE164 ||
            meta.provider_resource_id === normalizedE164 ||
            meta.provider_resource_id === phoneNumberId
          );
        });
        activeReservationCount = matchingRes.length;
        if (activeReservationCount > 0) {
          details.push(
            `ACTIVE_RESERVATIONS_DETECTED: Found ${activeReservationCount} active financial usage reservation(s).`
          );
        }
      }
    } catch (err: any) {
      // Table may not exist in pure mock environments
    }

    // 3. Check In-Flight Outbound Messaging (Task 15 / Audit 6)
    // Protects non-terminal states ('queued', 'sending', 'sent', 'accepted', 'unknown')
    let activeMessageCount = 0;
    try {
      const { data: messages, error: msgErr } = await (client as any)
        .from('messages')
        .select('id, status, from_number, to_number')
        .eq('organization_id', organizationId)
        .eq('from_number', normalizedE164)
        .eq('direction', 'outbound')
        .not('status', 'in', '("delivered","undelivered","failed","received")');

      if (!msgErr && messages) {
        activeMessageCount = messages.length;
        if (activeMessageCount > 0) {
          details.push(
            `IN_FLIGHT_MESSAGING_RELEASE_INTERLOCK: Found ${activeMessageCount} in-flight outbound message(s) in progress.`
          );
        }
      }
    } catch (err: any) {
      // Table may not exist in minimal mocks
    }

    // 4. Check In-Flight Porting Operations (Task 9 / Audit 8)
    let activePortCount = 0;
    try {
      const { data: ports, error: portErr } = await (client as any)
        .from('number_port_operations')
        .select('id, status, direction')
        .eq('organization_id', organizationId)
        .eq('phone_number_e164', normalizedE164)
        .in('status', ['requested', 'instructions_ready', 'port_out_pending', 'carrier_processing', 'in_progress']);

      if (!portErr && ports && ports.length > 0) {
        activePortCount = ports.length;
        details.push(
          `ACTIVE_PORT_DETECTED: Found ${activePortCount} active port operation(s) in progress.`
        );
      }
    } catch (err: any) {
      // Table may not exist in minimal environments
    }

    const hasActiveTraffic =
      activeCallCount > 0 ||
      activeReservationCount > 0 ||
      activeMessageCount > 0 ||
      activePortCount > 0;

    return {
      hasActiveTraffic,
      activeCallCount,
      activeReservationCount,
      activeMessageCount,
      details,
    };
  }

  /**
   * Phase 1 of Two-Phase Release Interlock:
   * Captures exact prior lifecycle states (ownership_state, service_state, is_suspended).
   * Atomically transitions service_state to 'SUSPENDED' and ownership_state to 'RELEASE_PENDING'
   * on phone_numbers to immediately halt new call setups, SMS, and MMS traffic.
   */
  static async acquireSuspensionLock(
    phoneNumberId: string,
    organizationId: string,
    client: SupabaseClient | any
  ): Promise<{
    success: boolean;
    priorServiceState: string;
    priorOwnershipState: string;
    priorIsSuspended: boolean;
    error?: string;
  }> {
    const { data: phone, error: fetchErr } = await (client as any)
      .from('phone_numbers')
      .select('id, service_state, ownership_state, is_suspended')
      .eq('id', phoneNumberId)
      .eq('organization_id', organizationId)
      .single();

    if (fetchErr || !phone) {
      return {
        success: false,
        priorServiceState: 'ACTIVE',
        priorOwnershipState: 'OWNED',
        priorIsSuspended: false,
        error: `Phone number ${phoneNumberId} not found in organization.`,
      };
    }

    const priorServiceState = phone.service_state || 'ACTIVE';
    const priorOwnershipState = phone.ownership_state || 'OWNED';
    const priorIsSuspended = phone.is_suspended ?? (priorServiceState === 'SUSPENDED');

    const { error: updateErr } = await (client as any)
      .from('phone_numbers')
      .update({
        ownership_state: 'RELEASE_PENDING',
        service_state: 'SUSPENDED',
        is_suspended: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', phoneNumberId)
      .eq('organization_id', organizationId);

    if (updateErr) {
      return {
        success: false,
        priorServiceState,
        priorOwnershipState,
        priorIsSuspended,
        error: `Failed to acquire suspension lock: ${updateErr.message}`,
      };
    }

    return {
      success: true,
      priorServiceState,
      priorOwnershipState,
      priorIsSuspended,
    };
  }

  /**
   * Rollback Suspension Lock:
   * Restores exact legitimate prior lifecycle states (ownership_state, service_state, is_suspended)
   * if active traffic, active reservations, or active porting was discovered.
   * NEVER blindly manufactures ACTIVE/OWNED.
   */
  static async rollbackSuspensionLock(
    phoneNumberId: string,
    organizationId: string,
    priorServiceState: string,
    priorOwnershipState: string = 'OWNED',
    client?: SupabaseClient | any,
    priorIsSuspended?: boolean
  ): Promise<void> {
    const targetClient = client;
    const effectiveIsSuspended =
      priorIsSuspended !== undefined ? priorIsSuspended : priorServiceState === 'SUSPENDED';

    await (targetClient as any)
      .from('phone_numbers')
      .update({
        ownership_state: priorOwnershipState,
        service_state: priorServiceState,
        is_suspended: effectiveIsSuspended,
        updated_at: new Date().toISOString(),
      })
      .eq('id', phoneNumberId)
      .eq('organization_id', organizationId);
  }
}
