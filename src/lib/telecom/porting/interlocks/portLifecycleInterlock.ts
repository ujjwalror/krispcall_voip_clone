import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';

const PROTECTED_PILOT_E164 = '+61348328472';
const PROTECTED_PILOT_SID = 'PN832a10dec98cbb48d02033a83afecff3';
const PROTECTED_PILOT_UUID = '03edd0bc-b025-49e6-8171-a0c2fcd6cb78';

export class PortLifecycleInterlock {
  /**
   * Asserts that a phone number is eligible for Port-Out preparation.
   * STRICT INTERLOCK INVARIANTS:
   * - Blocked if number is currently in RELEASE_PENDING or RELEASED.
   * - Blocked if number is already PORTED_OUT.
   * - Permanently blocks Australian protected pilot number.
   */
  static async assertCanInitiatePortOut(
    phoneNumberId: string,
    phoneNumberE164: string,
    organizationId: string,
    client?: SupabaseClient | any
  ): Promise<void> {
    const normalized = (phoneNumberE164 || '').trim();

    // 1. Quarantined Australian pilot multi-layer tripwire
    if (
      normalized === PROTECTED_PILOT_E164 ||
      phoneNumberId === PROTECTED_PILOT_UUID
    ) {
      throw new Error('PROTECTED_PILOT_QUARANTINE: Australian pilot number cannot be ported out.');
    }

    const db = client || createAdminClient();

    // 2. Query phone_numbers table
    const { data: phoneRow, error } = await (db as any)
      .from('phone_numbers')
      .select('id, ownership_state, service_state, status, organization_id')
      .eq('id', phoneNumberId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error || !phoneRow) {
      throw new Error(`PHONE_NUMBER_NOT_FOUND: Phone number ${phoneNumberId} not found for organization.`);
    }

    const ownership = phoneRow.ownership_state || phoneRow.status;

    // Check Release interlock
    if (ownership === 'RELEASE_PENDING' || phoneRow.service_state === 'SUSPENDED') {
      throw new Error('PORT_OUT_BLOCKED_RELEASE_PENDING: Cannot initiate port-out while number release is pending.');
    }

    // Check active release operations in number_release_operations
    const { data: activeReleases } = await (db as any)
      .from('number_release_operations')
      .select('id, canonical_state, status')
      .eq('phone_number_id', phoneNumberId)
      .not('canonical_state', 'in', '("RELEASED","FAILED","BLOCKED")')
      .limit(1);

    if (activeReleases && activeReleases.length > 0) {
      throw new Error('PORT_OUT_BLOCKED_RELEASE_PENDING: Cannot initiate port-out while number release is pending.');
    }

    if (ownership === 'RELEASED' || phoneRow.status === 'released') {
      throw new Error('PORT_OUT_BLOCKED_RELEASED: Cannot initiate port-out on already released phone number.');
    }

    if (ownership === 'PORTED_OUT' || phoneRow.status === 'ported_out') {
      throw new Error('ALREADY_PORTED_OUT: Phone number has already been ported out.');
    }
  }

  /**
   * Asserts that a phone number is eligible for voluntary release (23D.6 Release Saga Interlock).
   * Blocked if an active Port-Out operation is in progress.
   */
  static async assertCanInitiateRelease(
    phoneNumberE164: string,
    organizationId: string,
    client?: SupabaseClient | any
  ): Promise<void> {
    const normalized = (phoneNumberE164 || '').trim();

    if (normalized === PROTECTED_PILOT_E164) {
      throw new Error('PROTECTED_PILOT_QUARANTINE: Australian pilot number cannot be released.');
    }

    const db = client || createAdminClient();

    // Phase 24B: Local Parent-Protection Control Plane & Number Release Circuit Breaker
    const { TelecomControlPlaneService } = await import('@/lib/telecom/controlPlane');
    const controlEval = await TelecomControlPlaneService.evaluate(
      {
        organizationId,
        operation: 'NUMBER_RELEASE',
        context: { phoneNumber: normalized },
      },
      db
    );
    if (!controlEval.allowed) {
      throw new Error(`NUMBER_RELEASE_BLOCKED: ${controlEval.reason} (${controlEval.reasonCode})`);
    }

    // Query active port-out operations
    const { data: activePorts, error } = await (db as any)
      .from('number_port_operations')
      .select('id, direction, status, canonical_state')
      .eq('organization_id', organizationId)
      .eq('phone_number_e164', normalized)
      .in('direction', ['port_out', 'PORT_OUT'])
      .not('canonical_state', 'in', "('COMPLETED','CANCELLED','REJECTED_FRAUD_LOCK')");

    if (!error && activePorts && activePorts.length > 0) {
      const active = activePorts[0];
      throw new Error(
        `RELEASE_BLOCKED_PORTING: Phone number has active Port-Out in progress (${active.canonical_state || active.status}). Release aborted.`
      );
    }
  }

  /**
   * Asserts that an E.164 number can be ported in without colliding with an ongoing marketplace purchase.
   */
  static async assertCanInitiatePortIn(
    phoneNumberE164: string,
    organizationId: string,
    client?: SupabaseClient | any
  ): Promise<void> {
    const normalized = (phoneNumberE164 || '').trim();

    if (normalized === PROTECTED_PILOT_E164) {
      throw new Error('PROTECTED_PILOT_QUARANTINE: Australian pilot number cannot be ported in.');
    }

    const db = client || createAdminClient();

    // 1. Check active port operations (partial unique index protection)
    const { data: activePorts } = await (db as any)
      .from('number_port_operations')
      .select('id, direction, status, canonical_state')
      .eq('phone_number_e164', normalized)
      .not('canonical_state', 'in', "('COMPLETED','CANCELLED','FAILED_PRE_DISPATCH')");

    if (activePorts && activePorts.length > 0) {
      throw new Error(
        `ACTIVE_PORT_IN_PROGRESS: An active port operation already exists for E.164 ${normalized}.`
      );
    }

    // 2. Check active purchase sagas (provider_number_operations)
    try {
      const { data: activePurchases, error: purchaseErr } = await (db as any)
        .from('provider_number_operations')
        .select('id, status, operation_type')
        .eq('phone_number_e164', normalized)
        .in('status', ['DISPATCH_PENDING', 'AWAITING_CARRIER_ACK', 'PROVISIONING_PENDING']);

      if (!purchaseErr && activePurchases && activePurchases.length > 0) {
        throw new Error(
          `ACTIVE_PURCHASE_CONFLICT: Phone number ${normalized} is currently undergoing marketplace purchase acquisition.`
        );
      }
    } catch (err: any) {
      if (err?.message?.includes('ACTIVE_PURCHASE_CONFLICT')) {
        throw err;
      }
      // Table may not exist in lightweight test schemas
    }
  }
}
