import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  CanonicalReleaseOperationState,
  ProviderOutcomeCertainty,
} from '../domain/types';
import { ReleaseSagaStateMachine } from './releaseSagaStateMachine';
import { ActiveTrafficInterlockService } from './activeTrafficInterlockService';
import { CarrierReleaseBridge } from '../carrier/carrierReleaseBridge';
import { ProviderContext } from '../provider/types';

export interface RequestNumberReleaseParams {
  organizationId: string;
  phoneNumberId: string;
  confirmPhoneNumber: string;
  actorId: string;
  idempotencyKey?: string;
  faultInjectionHook?: (hookName: string) => Promise<void> | void;
  releaseSource?: string;
  initiatedByUserId?: string;
}

export interface CustomerReleaseDTO {
  operationId: string;
  organizationId: string;
  phoneNumberId: string;
  phoneNumberE164: string;
  status: string;
  canonicalState: CanonicalReleaseOperationState;
  customerSafeStatus: string;
  customerMessage: string;
  isIdempotentReplay?: boolean;
  createdAt: string;
  completedAt?: string | null;
}

export class NumberReleaseSagaCoordinator {
  constructor(private readonly clientOverride?: any) {}

  /**
   * Instance method wrapper for NumberReleaseSagaCoordinator.requestNumberRelease.
   */
  async requestNumberRelease(params: RequestNumberReleaseParams): Promise<CustomerReleaseDTO> {
    return NumberReleaseSagaCoordinator.requestNumberRelease(params, this.clientOverride);
  }

  /**
   * Alias for requestNumberRelease.
   */
  async initiateRelease(params: RequestNumberReleaseParams): Promise<CustomerReleaseDTO> {
    return NumberReleaseSagaCoordinator.requestNumberRelease(params, this.clientOverride);
  }

  /**
   * CANONICAL RELEASE SAGA ENTRY POINT (Phase 23D.6)
   * Executes the full two-phase suspension lock, active traffic checks,
   * durable operation logging, provider release choke point dispatch,
   * and safe post-release tombstoning.
   */
  static async requestNumberRelease(
    params: RequestNumberReleaseParams,
    clientOverride?: SupabaseClient
  ): Promise<CustomerReleaseDTO> {
    const supabase = clientOverride || createAdminClient();
    const {
      organizationId,
      phoneNumberId,
      confirmPhoneNumber,
      actorId,
      idempotencyKey,
      faultInjectionHook,
    } = params;

    // Fault Injection: R01 (Before release operation creation)
    if (faultInjectionHook) {
      await faultInjectionHook('R01');
    }

    // 1. Protected Australian Pilot Quarantine (Task 7)
    // Fail-closed at the outermost boundary before any actor or profile validation
    if (
      phoneNumberId === '03edd0bc-b025-49e6-8171-a0c2fcd6cb78' ||
      confirmPhoneNumber === '+61348328472' ||
      organizationId === '00000000-0000-0000-0000-000000000001'
    ) {
      throw new Error(
        'PROTECTED_PILOT_QUARANTINE_VIOLATION: Voluntary release of protected pilot number is strictly prohibited.'
      );
    }

    // 2. Authorization & Role Check (Task 8 & Task 11)
    const { data: actorProfile, error: profileErr } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id, role, active')
      .eq('id', actorId)
      .maybeSingle();

    if (profileErr || !actorProfile || actorProfile.active === false) {
      throw new Error('INSUFFICIENT_PERMISSIONS: Active user profile required.');
    }

    if (actorProfile.organization_id !== organizationId) {
      throw new Error('CROSS_ORGANIZATION_FORBIDDEN: User does not belong to organization.');
    }

    const role = (actorProfile.role || '').toLowerCase();
    if (!['owner', 'admin'].includes(role)) {
      throw new Error('INSUFFICIENT_PERMISSIONS: Only Owner or Admin can release a phone number.');
    }

    // 3. Idempotency Check (Task 4)
    if (idempotencyKey) {
      const { data: existingOp } = await (supabase as any)
        .from('number_release_operations')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();

      if (existingOp) {
        return this.toCustomerDTO(existingOp, true);
      }
    }

    // 4. Concurrency Guard: Check for Active Release Operation on Number
    const { data: activeOps } = await (supabase as any)
      .from('number_release_operations')
      .select('id, canonical_state')
      .eq('phone_number_id', phoneNumberId)
      .not('canonical_state', 'in', '("RELEASED","FAILED","BLOCKED")');

    if (activeOps && activeOps.length > 0) {
      throw new Error(
        `ACTIVE_RELEASE_IN_PROGRESS: A release operation is already in progress for this phone number (${activeOps[0].canonical_state}).`
      );
    }

    // 5. Fetch Phone Number & Verify Ownership (Task 5)
    const { data: phoneRow, error: phoneErr } = await (supabase as any)
      .from('phone_numbers')
      .select(`
        id,
        organization_id,
        phone_number,
        ownership_state,
        service_state,
        status,
        provider_account_id,
        provider_resource_record_id
      `)
      .eq('id', phoneNumberId)
      .maybeSingle();

    if (phoneErr || !phoneRow) {
      throw new Error('PHONE_NUMBER_NOT_FOUND: Phone number not found in workspace.');
    }

    if (phoneRow.organization_id !== organizationId) {
      throw new Error('CROSS_ORGANIZATION_FORBIDDEN: Phone number belongs to another organization.');
    }

    const phoneNumberE164 = phoneRow.phone_number;

    // Exact Typed Confirmation Validation (Task 8)
    if ((confirmPhoneNumber || '').trim() !== phoneNumberE164.trim()) {
      throw new Error(
        `TYPED_CONFIRMATION_MISMATCH: Input confirmation "${confirmPhoneNumber}" does not match exact E.164 phone number "${phoneNumberE164}".`
      );
    }

    // Lifecycle Status Checks (Task 5 & 19 / Audit 1)
    if (phoneRow.ownership_state === 'RELEASED' || phoneRow.status === 'released') {
      throw new Error('ALREADY_RELEASED: Phone number is already released.');
    }

    if (phoneRow.ownership_state === 'PORTED_OUT' || phoneRow.status === 'ported_out') {
      throw new Error('ALREADY_PORTED_OUT: Phone number is already ported out.');
    }

    if (phoneRow.ownership_state === 'RELEASE_PENDING') {
      throw new Error('RELEASE_ALREADY_PENDING: Phone number is already pending release.');
    }

    if (phoneRow.ownership_state === 'ACQUISITION_PENDING') {
      throw new Error('CANNOT_RELEASE_ACQUISITION_PENDING: Phone number carrier acquisition is still pending.');
    }

    if (phoneRow.ownership_state && phoneRow.ownership_state !== 'OWNED') {
      throw new Error(
        `NOT_ELIGIBLE_FOR_RELEASE: Number ownership state is "${phoneRow.ownership_state}". Only OWNED numbers can be released.`
      );
    }

    // 6. Active Porting Conflict Protection (Task 9)
    const { data: portOps } = await (supabase as any)
      .from('number_port_operations')
      .select('id, status, direction')
      .eq('organization_id', organizationId)
      .eq('phone_number_e164', phoneNumberE164)
      .in('status', ['requested', 'instructions_ready', 'port_out_pending', 'carrier_processing', 'in_progress']);

    if (portOps && portOps.length > 0) {
      const activePort = portOps[0];
      throw new Error(
        `ACTIVE_PORT_CONFLICT: Phone number has an active port operation in progress (${activePort.direction}: ${activePort.status}).`
      );
    }

    // 7. Verify Authoritative Provider Resource Bridge (Task 5, 6, 21)
    let providerResourceQuery = (supabase as any)
      .from('telecom_provider_resource_records')
      .select('id, organization_id, provider_account_id, remote_resource_id, status, released_at');

    if (phoneRow.provider_resource_record_id) {
      providerResourceQuery = providerResourceQuery.eq('id', phoneRow.provider_resource_record_id);
    } else {
      providerResourceQuery = providerResourceQuery.eq('domain_phone_number_id', phoneNumberId);
    }

    const { data: resourceRow, error: resErr } = await providerResourceQuery.maybeSingle();

    if (resErr || !resourceRow) {
      throw new Error(
        'PROVIDER_RESOURCE_MISSING: Authoritative carrier provider resource record not found for phone number.'
      );
    }

    if (resourceRow.organization_id !== organizationId) {
      throw new Error(
        'PROVIDER_RESOURCE_MISMATCH: Authoritative carrier resource belongs to a different organization.'
      );
    }

    if (resourceRow.remote_resource_id === 'PN832a10dec98cbb48d02033a83afecff3') {
      throw new Error(
        'PROTECTED_PILOT_QUARANTINE_VIOLATION: Carrier resource SID matches protected pilot number.'
      );
    }

    // Verify Provider Account & Customer Subaccount Isolation (Task 5 & 21)
    const { data: accountRow, error: accErr } = await (supabase as any)
      .from('telecom_provider_accounts')
      .select('id, organization_id, account_type, status, is_shared_parent')
      .eq('id', resourceRow.provider_account_id)
      .maybeSingle();

    if (accErr || !accountRow) {
      throw new Error('PROVIDER_ACCOUNT_MISSING: Carrier provider account not found.');
    }

    if (accountRow.account_type === 'SHARED_PARENT' || accountRow.is_shared_parent === true) {
      throw new Error(
        'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED: Cannot release customer phone number under SHARED_PARENT account.'
      );
    }

    if (accountRow.status !== 'active') {
      throw new Error(`PROVIDER_ACCOUNT_INACTIVE: Provider account is ${accountRow.status}.`);
    }

    // 8. Create Durable Release Operation Record (State: REQUESTED) (Task 2 & 19)
    const operationId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    const { data: insertedOp, error: insertErr } = await (supabase as any)
      .from('number_release_operations')
      .insert({
        id: operationId,
        organization_id: organizationId,
        phone_number_id: phoneNumberId,
        phone_number_e164: phoneNumberE164,
        release_source: 'voluntary',
        status: 'requested',
        canonical_state: 'REQUESTED',
        idempotency_key: idempotencyKey || null,
        actor_id: actorId,
        initiated_by_user_id: actorId,
        provider: 'TWILIO',
        provider_account_id: accountRow.id,
        provider_resource_record_id: resourceRow.id,
        customer_safe_status: 'Release requested',
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select('*')
      .single();

    if (insertErr || !insertedOp) {
      throw new Error(`RELEASE_OP_INSERT_FAILED: ${insertErr?.message || 'Failed to create operation record.'}`);
    }

    // Fault Injection: R02 (After operation creation)
    if (faultInjectionHook) {
      await faultInjectionHook('R02');
    }

    // 9. Transition to VALIDATING -> AUTHORIZED
    await (supabase as any)
      .from('number_release_operations')
      .update({
        canonical_state: 'VALIDATING',
        validated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', operationId);

    // Fault Injection: R03 (After authorization)
    if (faultInjectionHook) {
      await faultInjectionHook('R03');
    }

    await (supabase as any)
      .from('number_release_operations')
      .update({
        canonical_state: 'AUTHORIZED',
        updated_at: new Date().toISOString(),
      })
      .eq('id', operationId);

    // 10. TWO-PHASE ACTIVE-TRAFFIC INTERLOCK & SUSPENSION LOCK (Task 10, 11, 12, 13, 14, 15)
    // Step A: First active-traffic evaluation
    const preCheckTraffic = await ActiveTrafficInterlockService.checkActiveTraffic(
      phoneNumberId,
      phoneNumberE164,
      organizationId,
      supabase
    );

    if (preCheckTraffic.hasActiveTraffic) {
      await (supabase as any)
        .from('number_release_operations')
        .update({
          canonical_state: 'BLOCKED',
          status: 'failed',
          block_reason: 'ACTIVE_CALLS_IN_PROGRESS',
          error_category: 'ACTIVE_TRAFFIC_INTERLOCK',
          failed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', operationId);

      throw new Error(
        `RELEASE_BLOCKED_ACTIVE_TRAFFIC: Cannot release phone number while traffic is active: ${preCheckTraffic.details.join('; ')}`
      );
    }

    // Fault Injection: R04 (After temporary suspension/release lock)
    if (faultInjectionHook) {
      await faultInjectionHook('R04');
    }

    // Step B: Acquire Suspension Lock (service_state -> SUSPENDED, ownership_state -> RELEASE_PENDING)
    const lockResult = await ActiveTrafficInterlockService.acquireSuspensionLock(
      phoneNumberId,
      organizationId,
      supabase
    );

    if (!lockResult.success) {
      await (supabase as any)
        .from('number_release_operations')
        .update({
          canonical_state: 'FAILED',
          status: 'failed',
          error_category: 'LOCK_ACQUISITION_FAILED',
          failed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', operationId);

      throw new Error(`LOCK_ACQUISITION_FAILED: ${lockResult.error}`);
    }

    const priorServiceState = lockResult.priorServiceState;

    await (supabase as any)
      .from('number_release_operations')
      .update({
        suspended_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', operationId);

    // Fault Injection: R05 (After first active-traffic check)
    if (faultInjectionHook) {
      await faultInjectionHook('R05');
    }

    // Step C: Second Active-Traffic Evaluation (Under Suspension Lock to close race)
    const postLockTraffic = await ActiveTrafficInterlockService.checkActiveTraffic(
      phoneNumberId,
      phoneNumberE164,
      organizationId,
      supabase
    );

    if (postLockTraffic.hasActiveTraffic) {
      // Rollback suspension lock safely (Task 13)
      await ActiveTrafficInterlockService.rollbackSuspensionLock(
        phoneNumberId,
        organizationId,
        priorServiceState,
        lockResult.priorOwnershipState,
        supabase,
        lockResult.priorIsSuspended
      );

      await (supabase as any)
        .from('number_release_operations')
        .update({
          canonical_state: 'BLOCKED',
          status: 'failed',
          block_reason: 'ACTIVE_CALLS_IN_PROGRESS',
          error_category: 'ACTIVE_TRAFFIC_INTERLOCK_RACE',
          failed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', operationId);

      throw new Error(
        `RELEASE_BLOCKED_ACTIVE_TRAFFIC: Active traffic discovered during release lock acquisition: ${postLockTraffic.details.join('; ')}`
      );
    }

    // Fault Injection: R06 (After second active-traffic check)
    if (faultInjectionHook) {
      await faultInjectionHook('R06');
    }

    // 11. Transition to PROVIDER_RELEASE_PENDING (Durable Pre-Dispatch Commit with CAS, Task 19)
    const { data: claimData, error: claimErr } = await (supabase as any)
      .from('number_release_operations')
      .update({
        canonical_state: 'PROVIDER_RELEASE_PENDING',
        status: 'provider_release_pending',
        dispatched_at: new Date().toISOString(),
        provider_attempt_count: 1,
        customer_safe_status: 'Release request submitted to provider',
        updated_at: new Date().toISOString(),
      })
      .eq('id', operationId)
      .eq('canonical_state', 'AUTHORIZED')
      .select('id');

    if (claimErr || !claimData || claimData.length === 0) {
      throw new Error(
        `CONCURRENT_RELEASE_CLAIM_CONFLICT: Release operation ${operationId} could not be claimed for provider dispatch because it is no longer in AUTHORIZED state.`
      );
    }

    // 12. Dispatch to Single Provider Choke Point (Task 20 & 21)
    const providerContext: ProviderContext = {
      organizationId,
      provider: 'TWILIO',
      providerAccountId: accountRow.id,
      accountType: accountRow.account_type,
      accountReference: accountRow.account_reference || 'AC_mock_subaccount',
      credentialReference: 'cred_mock',
      serviceScope: 'NUMBER_MANAGEMENT',
      environment: 'development',
      capabilities: ['ALL'],
      isSharedParent: accountRow.is_shared_parent,
    };

    const carrierResult = await CarrierReleaseBridge.executeProviderRelease({
      releaseOperationId: operationId,
      organizationId,
      phoneNumberId,
      phoneNumberE164,
      providerContext,
      authoritativeProviderResource: {
        id: resourceRow.id,
        remoteResourceId: resourceRow.remote_resource_id,
        organizationId: resourceRow.organization_id,
        providerAccountId: resourceRow.provider_account_id,
        status: resourceRow.status,
      },
      interlockClearance: true,
      idempotencyKey,
      faultInjectionHook,
    });

    // 13. Process Carrier Result
    if (carrierResult.outcome === 'CONFIRMED_SUCCESS') {
      // Fault Injection: R09 (After provider success before local provider-resource update)
      if (faultInjectionHook) {
        await faultInjectionHook('R09');
      }

      // Step A: Tombstone telecom_provider_resource_records (Task 22 & 23)
      await (supabase as any)
        .from('telecom_provider_resource_records')
        .update({
          status: 'RELEASED',
          released_at: new Date().toISOString(),
        })
        .eq('id', resourceRow.id);

      // Fault Injection: R10 (After provider-resource update before phone-number lifecycle update)
      if (faultInjectionHook) {
        await faultInjectionHook('R10');
      }

      // Step B: Transition domain phone_numbers to RELEASED (Task 22)
      await (supabase as any)
        .from('phone_numbers')
        .update({
          ownership_state: 'RELEASED',
          service_state: 'UNAVAILABLE',
          status: 'released',
          active: false,
          is_suspended: true,
          released_at: new Date().toISOString(),
          assignment_target_type: 'UNASSIGNED_POOL',
          assignment_target_id: null,
          assigned_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', phoneNumberId)
        .eq('organization_id', organizationId);

      // Remove compatibility projection if present
      await (supabase as any)
        .from('user_phone_assignments')
        .delete()
        .eq('phone_number_id', phoneNumberId);

      // Fault Injection: R11 (After lifecycle update before assignment/capability finalization)
      if (faultInjectionHook) {
        await faultInjectionHook('R11');
      }

      // Record Audit Event in phone_number_lifecycle_events (Task 40)
      try {
        await (supabase as any)
          .from('phone_number_lifecycle_events')
          .insert({
            organization_id: organizationId,
            phone_number_id: phoneNumberId,
            event_type: 'NUMBER_RELEASE_CONFIRMED',
            actor_id: actorId,
            details: {
              releaseOperationId: operationId,
              remoteResourceId: resourceRow.remote_resource_id,
              e164: phoneNumberE164,
              confirmedAt: new Date().toISOString(),
            },
          });
      } catch (err: any) {
        console.warn('[ReleaseSaga] Warning logging lifecycle event:', err?.message);
      }

      // Step B2: Terminate Billable Resource & Release Slot Reservation (Phase 23D.9B)
      await (supabase as any)
        .from('organization_billable_resources')
        .update({
          status: 'inactive',
          effective_end_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('organization_id', organizationId)
        .eq('resource_type', 'phone_number')
        .eq('resource_id', phoneNumberE164)
        .eq('status', 'active');

      const { data: linkedRes } = await (supabase as any)
        .from('organization_number_slot_reservations')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('phone_number_id', phoneNumberId)
        .eq('status', 'CONSUMED')
        .maybeSingle();

      if (linkedRes) {
        const { EntitlementAuthorizationService } = await import('../billing/entitlementAuthorizationService');
        await EntitlementAuthorizationService.releaseNumberSlotReservation(
          linkedRes.id,
          'number_released',
          supabase
        );
      }

      // Step C: Complete Release Operation
      const { data: finalOp } = await (supabase as any)
        .from('number_release_operations')
        .update({
          canonical_state: 'RELEASED',
          status: 'released',
          outcome_certainty: 'CONFIRMED_SUCCESS',
          customer_safe_status: 'Phone number successfully released from workspace.',
          confirmed_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', operationId)
        .select('*')
        .single();

      // Fault Injection: R12 (After confirmed release before API response)
      if (faultInjectionHook) {
        await faultInjectionHook('R12');
      }

      return this.toCustomerDTO(finalOp || insertedOp);
    }

    if (carrierResult.outcome === 'AMBIGUOUS_TIMEOUT') {
      // Provider Outcome Unknown (Task 25 & 26)
      // UNKNOWN != FAILED. Binds number to UNAVAILABLE so traffic cannot traverse it.
      await (supabase as any)
        .from('phone_numbers')
        .update({
          service_state: 'UNAVAILABLE',
          is_suspended: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', phoneNumberId);

      const { data: unkOp } = await (supabase as any)
        .from('number_release_operations')
        .update({
          canonical_state: 'PROVIDER_OUTCOME_UNKNOWN',
          status: 'reconciliation_required',
          outcome_certainty: 'STILL_UNKNOWN',
          ambiguity_started_at: new Date().toISOString(),
          customer_safe_status: 'Release confirmation in progress.',
          error_category: 'PROVIDER_TIMEOUT_OR_5XX',
          updated_at: new Date().toISOString(),
        })
        .eq('id', operationId)
        .select('*')
        .single();

      return this.toCustomerDTO(unkOp);
    }

    if (carrierResult.outcome === 'MANUAL_REVIEW_REQUIRED') {
      const { data: manOp } = await (supabase as any)
        .from('number_release_operations')
        .update({
          canonical_state: 'PROVIDER_OUTCOME_UNKNOWN',
          status: 'manual_review_required',
          outcome_certainty: 'MANUAL_REVIEW_REQUIRED',
          customer_safe_status: 'Release requires administrative review.',
          error_category: 'MANUAL_REVIEW_REQUIRED',
          updated_at: new Date().toISOString(),
        })
        .eq('id', operationId)
        .select('*')
        .single();

      return this.toCustomerDTO(manOp);
    }

    // Default Definite Rejection: Rollback suspension lock
    await ActiveTrafficInterlockService.rollbackSuspensionLock(
      phoneNumberId,
      organizationId,
      priorServiceState,
      lockResult.priorOwnershipState,
      supabase,
      lockResult.priorIsSuspended
    );

    const { data: failedOp } = await (supabase as any)
      .from('number_release_operations')
      .update({
        canonical_state: 'FAILED',
        status: 'failed',
        outcome_certainty: 'CONFIRMED_FAILURE',
        customer_safe_status: carrierResult.sanitizedCustomerMessage || 'Provider rejected release request.',
        error_category: 'PROVIDER_REJECTION',
        failed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', operationId)
      .select('*')
      .single();

    return this.toCustomerDTO(failedOp);
  }

  /**
   * Maps internal database record to safe customer DTO.
   */
  private static toCustomerDTO(op: any, isIdempotentReplay?: boolean): CustomerReleaseDTO {
    const canonicalState = (op.canonical_state || 'REQUESTED') as CanonicalReleaseOperationState;
    const outcomeCertainty = op.outcome_certainty as ProviderOutcomeCertainty | null;
    const blockReason = op.block_reason;

    const safeMapping = ReleaseSagaStateMachine.mapToCustomerSafeStatus(
      canonicalState,
      outcomeCertainty,
      blockReason
    );

    return {
      operationId: op.id,
      organizationId: op.organization_id,
      phoneNumberId: op.phone_number_id,
      phoneNumberE164: op.phone_number_e164,
      status: op.status,
      canonicalState,
      customerSafeStatus: safeMapping.customerStatus,
      customerMessage: safeMapping.customerMessage,
      isIdempotentReplay: Boolean(isIdempotentReplay),
      createdAt: op.created_at,
      completedAt: op.completed_at || null,
    };
  }
}
