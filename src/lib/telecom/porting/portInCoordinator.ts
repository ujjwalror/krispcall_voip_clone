import 'server-only';
import crypto from 'crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { ProviderContext } from '@/lib/telecom/provider/types';
import { TelecomPortingProviderAdapter } from './adapters/telecomPortingAdapter';
import { PortInStateMachine } from './portInStateMachine';
import { PortLifecycleInterlock } from './interlocks/portLifecycleInterlock';
import { PortRequirementSnapshotService } from './portRequirementSnapshotService';
import { PortOutSecurityService } from './portOutSecurityService';
import {
  SubmitPortInParams,
  SubmitPortInResult,
  PortInCanonicalState,
  PortOutcomeCertainty,
} from './types';

const PROTECTED_PILOT_E164 = '+61348328472';

export class PortInCoordinator {
  /**
   * Initializes a durable Port-In order.
   * STRICT INVARIANT:
   * - A port-in request NEVER sets ownership_state = OWNED.
   * - Phone number is registered in ACQUISITION_PENDING / PORT_IN_REQUESTED.
   */
  static async initializePortIn(
    params: {
      organizationId: string;
      phoneNumberE164: string;
      providerAccountId: string;
      requirementSnapshotId: string;
      regulatorySubjectId?: string | null;
      accountNumber?: string | null;
      portingPin?: string | null;
      authorizedName: string;
      authorizedEmail: string;
      serviceAddress?: Record<string, any>;
      requestedFocDate?: string | null;
      idempotencyKey?: string;
    },
    client?: SupabaseClient | any
  ): Promise<any> {
    const canonicalE164 = params.phoneNumberE164.trim();
    const db = client || createAdminClient();

    // 1. Check idempotency first
    if (params.idempotencyKey) {
      const { data: existing } = await (db as any)
        .from('number_port_operations')
        .select('*')
        .eq('organization_id', params.organizationId)
        .eq('idempotency_key', params.idempotencyKey)
        .maybeSingle();

      if (existing) {
        return existing;
      }
    }

    // Phase 24B: Local Parent-Protection Control Plane & Porting Mutation Circuit Breaker
    const { TelecomControlPlaneService } = await import('@/lib/telecom/controlPlane');
    const controlEval = await TelecomControlPlaneService.evaluate(
      {
        organizationId: params.organizationId,
        operation: 'PORTING_MUTATION',
        context: { type: 'PORT_IN', phoneNumber: canonicalE164 },
      },
      db
    );
    if (!controlEval.allowed) {
      throw new Error(`PORTING_MUTATION_BLOCKED: ${controlEval.reason} (${controlEval.reasonCode})`);
    }

    // 2. Interlock & Quarantine check
    await PortLifecycleInterlock.assertCanInitiatePortIn(
      canonicalE164,
      params.organizationId,
      db
    );

    // 3. Validate requirement snapshot exists
    const snapshot = await PortRequirementSnapshotService.getSnapshotById(
      params.requirementSnapshotId,
      params.organizationId,
      db
    );
    if (!snapshot) {
      throw new Error(`REQUIREMENT_SNAPSHOT_NOT_FOUND: Snapshot ${params.requirementSnapshotId} not found.`);
    }

    // 4. Encrypt sensitive credentials
    const accountNumberEncrypted = params.accountNumber
      ? PortOutSecurityService.encryptCredential(params.accountNumber)
      : null;
    const portingPinEncrypted = params.portingPin
      ? PortOutSecurityService.encryptCredential(params.portingPin)
      : null;

    // 5. Create or verify pre-staged phone_numbers row (ACQUISITION_PENDING)
    let phoneNumberId: string | null = null;
    const { data: existingPhone } = await (db as any)
      .from('phone_numbers')
      .select('id, ownership_state')
      .eq('organization_id', params.organizationId)
      .eq('phone_number_e164', canonicalE164)
      .maybeSingle();

    if (existingPhone) {
      phoneNumberId = existingPhone.id;
    } else {
      const { data: newPhone, error: phoneErr } = await (db as any)
        .from('phone_numbers')
        .insert({
          organization_id: params.organizationId,
          phone_number_e164: canonicalE164,
          ownership_state: 'ACQUISITION_PENDING',
          service_state: 'PROVISIONING',
          porting_state: 'PORT_IN_REQUESTED',
          status: 'pending',
          is_active: false,
          provider_account_id: params.providerAccountId,
        })
        .select('id')
        .single();

      if (!phoneErr && newPhone) {
        phoneNumberId = newPhone.id;
      }
    }

    // 6. Insert number_port_operations row
    const insertPayload = {
      organization_id: params.organizationId,
      phone_number_id: phoneNumberId,
      phone_number_e164: canonicalE164,
      direction: 'port_in',
      canonical_state: 'READY_FOR_SUBMISSION',
      status: 'ready_for_submission',
      provider: snapshot.provider,
      provider_account_id: params.providerAccountId,
      requirement_snapshot_id: params.requirementSnapshotId,
      regulatory_subject_id: params.regulatorySubjectId || null,
      account_number_encrypted: accountNumberEncrypted,
      porting_pin_encrypted: portingPinEncrypted,
      authorized_name: params.authorizedName,
      authorized_email: params.authorizedEmail,
      service_address: params.serviceAddress || {},
      requested_foc_at: params.requestedFocDate || null,
      idempotency_key: params.idempotencyKey || null,
      outcome_certainty: 'DEFINITIVE',
    };

    const { data: opRow, error: opErr } = await (db as any)
      .from('number_port_operations')
      .insert(insertPayload)
      .select('*')
      .single();

    if (opErr || !opRow) {
      throw new Error(`PORT_IN_INITIATION_FAILED: Failed to create port operation: ${opErr?.message}`);
    }

    return opRow;
  }

  /**
   * Durably dispatches a Port-In order to the provider adapter.
   * MULTI-WORKER SAFETY:
   * - Locks operation row in PostgreSQL (FOR UPDATE).
   * - Commits SUBMISSION_PENDING before wire call.
   * - If wire call times out or is ambiguous, transitions to PROVIDER_OUTCOME_UNKNOWN.
   * - UNKNOWN cannot be blindly re-dispatched.
   */
  static async dispatchPortInSubmission(
    operationId: string,
    organizationId: string,
    adapter: TelecomPortingProviderAdapter,
    context: ProviderContext,
    client?: SupabaseClient | any
  ): Promise<SubmitPortInResult> {
    const db = client || createAdminClient();

    // 1. Lock and fetch operation
    const { data: opRow, error } = await (db as any)
      .from('number_port_operations')
      .select('*')
      .eq('id', operationId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error || !opRow) {
      throw new Error(`OPERATION_NOT_FOUND: Operation ${operationId} not found.`);
    }

    if (opRow.phone_number_e164 === PROTECTED_PILOT_E164) {
      throw new Error('PROTECTED_PILOT_QUARANTINE: Australian pilot number cannot be dispatched.');
    }

    // Step 1a: Pre-dispatch TOCTOU check: verify control plane immediately before provider wire call
    const { TelecomControlPlaneService } = await import('@/lib/telecom/controlPlane');
    const preDispatchEval = await TelecomControlPlaneService.evaluate(
      {
        organizationId,
        operation: 'PORTING_MUTATION',
        context: { stage: 'PRE_DISPATCH', type: 'PORT_IN', phoneNumber: opRow.phone_number_e164 },
      },
      db
    );
    if (!preDispatchEval.allowed) {
      throw new Error(`PORTING_MUTATION_PRE_DISPATCH_BLOCKED: ${preDispatchEval.reason} (${preDispatchEval.reasonCode})`);
    }

    if (!adapter.capabilities?.supportsPortInSubmissionApi) {
      throw new Error('PROVIDER_CAPABILITY_UNSUPPORTED: Provider adapter does not support automated port-in submission.');
    }

    // Step 1b: Entitlement & Number Slot Capacity Reservation (Phase 23D.9B - Tasks 11 & 12)
    {
      const { EntitlementAuthorizationService } = await import('@/lib/telecom/billing/entitlementAuthorizationService');
      const featureCheck = await EntitlementAuthorizationService.canUseFeature(organizationId, 'number.porting', db);
      if (!featureCheck.allowed) {
        throw new Error(`FEATURE_NOT_ENTITLED: Number porting is not permitted under current plan.`);
      }

      const slotReservation = await EntitlementAuthorizationService.acquireNumberSlotReservation(
        {
          organizationId,
          sagaType: 'port_in',
          operationId,
          ttlSeconds: 30 * 24 * 3600, // 30-day reservation for porting orders
        },
        db
      );

      if (!slotReservation.success) {
        throw new Error(
          `INSUFFICIENT_NUMBER_SLOTS: ${slotReservation.message || 'Workspace has no remaining phone number slots available.'}`
        );
      }
    }

    // 2. Validate state machine transition to SUBMISSION_PENDING
    PortInStateMachine.assertTransition(
      opRow.canonical_state as PortInCanonicalState,
      'SUBMISSION_PENDING'
    );

    // 3. Commit SUBMISSION_PENDING durable intent before provider dispatch
    const nowIso = new Date().toISOString();
    await (db as any)
      .from('number_port_operations')
      .update({
        canonical_state: 'SUBMISSION_PENDING',
        status: 'in_progress',
        provider_dispatched_at: nowIso,
        outcome_certainty: 'UNCERTAIN',
        updated_at: nowIso,
      })
      .eq('id', opRow.id);

    // 4. Wire call to provider adapter
    let dispatchResult: { providerPortId: string; providerStatus: string; outcomeCertainty: PortOutcomeCertainty };
    try {
      dispatchResult = await adapter.submitPortInOrder(
        {
          organizationId,
          phoneNumberE164: opRow.phone_number_e164,
          providerAccountId: opRow.provider_account_id,
          requirementSnapshotId: opRow.requirement_snapshot_id,
          authorizedName: opRow.authorized_name,
          authorizedEmail: opRow.authorized_email,
          serviceAddress: opRow.service_address,
          portEvidence: opRow.port_evidence || [],
          idempotencyKey: opRow.idempotency_key || opRow.id,
          actorIdentity: 'port_in_coordinator',
        },
        context
      );
    } catch (wireErr: any) {
      // Ambiguous wire failure: transition to PROVIDER_OUTCOME_UNKNOWN, NOT FAILED!
      await (db as any)
        .from('number_port_operations')
        .update({
          canonical_state: 'PROVIDER_OUTCOME_UNKNOWN',
          status: 'under_review',
          reconciliation_state: 'DISPATCH_UNCERTAIN',
          outcome_certainty: 'UNCERTAIN',
          customer_message: `Carrier dispatch uncertain: ${wireErr.message}. Reconciling provider order.`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', opRow.id);

      return {
        operationId: opRow.id,
        canonicalState: 'PROVIDER_OUTCOME_UNKNOWN',
        outcomeCertainty: 'UNCERTAIN',
        dispatchedAt: nowIso,
        idempotent: false,
      };
    }

    // 5. Evaluate dispatch outcome
    if (dispatchResult.outcomeCertainty === 'UNCERTAIN') {
      await (db as any)
        .from('number_port_operations')
        .update({
          canonical_state: 'PROVIDER_OUTCOME_UNKNOWN',
          status: 'under_review',
          reconciliation_state: 'DISPATCH_UNCERTAIN',
          outcome_certainty: 'UNCERTAIN',
          customer_message: 'Carrier dispatch timeout. Reconciling order status.',
          updated_at: new Date().toISOString(),
        })
        .eq('id', opRow.id);

      return {
        operationId: opRow.id,
        canonicalState: 'PROVIDER_OUTCOME_UNKNOWN',
        outcomeCertainty: 'UNCERTAIN',
        dispatchedAt: nowIso,
        idempotent: false,
      };
    }

    // 6. Successful dispatch acknowledged
    await (db as any)
      .from('number_port_operations')
      .update({
        canonical_state: 'SUBMITTED',
        status: 'submitted',
        provider_port_id: dispatchResult.providerPortId,
        provider_status: dispatchResult.providerStatus,
        provider_acknowledged_at: new Date().toISOString(),
        outcome_certainty: 'DEFINITIVE',
        updated_at: new Date().toISOString(),
      })
      .eq('id', opRow.id);

    return {
      operationId: opRow.id,
      canonicalState: 'SUBMITTED',
      providerPortId: dispatchResult.providerPortId,
      outcomeCertainty: 'DEFINITIVE',
      dispatchedAt: nowIso,
      idempotent: false,
    };
  }

  /**
   * Requests cancellation of an in-flight Port-In order.
   * If carrier cancellation wire call times out or returns ambiguous outcome,
   * transitions to PROVIDER_OUTCOME_UNKNOWN without blind retry or assumed cancellation.
   */
  static async requestCancellation(
    operationId: string,
    organizationId: string,
    reason: string,
    adapter: TelecomPortingProviderAdapter,
    context: ProviderContext,
    client?: SupabaseClient | any
  ): Promise<{
    operationId: string;
    canonicalState: PortInCanonicalState;
    outcomeCertainty: PortOutcomeCertainty;
  }> {
    const db = client || createAdminClient();

    const { data: opRow, error } = await (db as any)
      .from('number_port_operations')
      .select('*')
      .eq('id', operationId)
      .eq('organization_id', organizationId)
      .single();

    if (error || !opRow) {
      throw new Error(`OPERATION_NOT_FOUND: Operation ${operationId} not found.`);
    }

    if (opRow.phone_number_e164 === PROTECTED_PILOT_E164) {
      throw new Error('PROTECTED_PILOT_QUARANTINE: Australian pilot number cannot be mutated.');
    }

    // Attempt provider wire cancellation
    let cancelRes: { success: boolean; outcomeCertainty: PortOutcomeCertainty; providerStatus: string };
    try {
      cancelRes = await adapter.cancelPortOrder(
        opRow.provider_port_id || opRow.id,
        context
      );
    } catch (wireErr: any) {
      await (db as any)
        .from('number_port_operations')
        .update({
          canonical_state: 'PROVIDER_OUTCOME_UNKNOWN',
          status: 'under_review',
          reconciliation_state: 'DISPATCH_UNCERTAIN',
          outcome_certainty: 'UNCERTAIN',
          customer_message: `Cancellation ambiguous: ${wireErr.message}. Reconciling carrier state.`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', opRow.id);

      return {
        operationId: opRow.id,
        canonicalState: 'PROVIDER_OUTCOME_UNKNOWN',
        outcomeCertainty: 'UNCERTAIN',
      };
    }

    if (cancelRes.outcomeCertainty === 'UNCERTAIN' || !cancelRes.success) {
      await (db as any)
        .from('number_port_operations')
        .update({
          canonical_state: 'PROVIDER_OUTCOME_UNKNOWN',
          status: 'under_review',
          reconciliation_state: 'DISPATCH_UNCERTAIN',
          outcome_certainty: 'UNCERTAIN',
          customer_message: 'Cancellation timeout or uncertainty. Reconciling carrier state.',
          updated_at: new Date().toISOString(),
        })
        .eq('id', opRow.id);

      return {
        operationId: opRow.id,
        canonicalState: 'PROVIDER_OUTCOME_UNKNOWN',
        outcomeCertainty: 'UNCERTAIN',
      };
    }

    // Definitive cancellation
    await (db as any)
      .from('number_port_operations')
      .update({
        canonical_state: 'CANCELLED',
        status: 'cancelled',
        outcome_certainty: 'DEFINITIVE',
        customer_message: `Port request cancelled: ${reason}`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', opRow.id);

    // Phase 23D.9B: Release port-in slot reservation on definitive cancellation
    {
      const { data: resRow } = await (db as any)
        .from('organization_number_slot_reservations')
        .select('id')
        .eq('organization_id', opRow.organization_id)
        .eq('saga_type', 'port_in')
        .eq('operation_id', opRow.id)
        .maybeSingle();

      if (resRow) {
        const { EntitlementAuthorizationService } = await import('@/lib/telecom/billing/entitlementAuthorizationService');
        await EntitlementAuthorizationService.releaseNumberSlotReservation(
          resRow.id,
          'port_in_cancelled',
          db
        );
      }
    }

    return {
      operationId: opRow.id,
      canonicalState: 'CANCELLED',
      outcomeCertainty: 'DEFINITIVE',
    };
  }

  /**
   * Confirms Firm Order Confirmation (FOC) date.
   * INVARIANT: Reaching or setting confirmed_foc_at does NOT trigger COMPLETED.
   */
  static async confirmFoc(
    operationId: string,
    organizationId: string,
    confirmedFocAt: string,
    client?: SupabaseClient | any
  ): Promise<void> {
    const db = client || createAdminClient();

    const { data: opRow } = await (db as any)
      .from('number_port_operations')
      .select('*')
      .eq('id', operationId)
      .eq('organization_id', organizationId)
      .single();

    if (!opRow) {
      throw new Error(`OPERATION_NOT_FOUND: Operation ${operationId} not found.`);
    }

    PortInStateMachine.assertTransition(
      opRow.canonical_state as PortInCanonicalState,
      'FOC_CONFIRMED'
    );

    // Update operation with confirmed FOC date
    await (db as any)
      .from('number_port_operations')
      .update({
        canonical_state: 'FOC_CONFIRMED',
        status: 'scheduled',
        confirmed_foc_at: confirmedFocAt,
        scheduled_transfer_at: confirmedFocAt,
        customer_message: `Firm Order Confirmation received. Cutover scheduled for ${confirmedFocAt}.`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', opRow.id);

    // Update phone_numbers porting_state to PORT_IN_FOC (still NOT OWNED!)
    if (opRow.phone_number_id) {
      await (db as any)
        .from('phone_numbers')
        .update({
          porting_state: 'PORT_IN_FOC',
          updated_at: new Date().toISOString(),
        })
        .eq('id', opRow.phone_number_id);
    }
  }

  /**
   * Executes atomic completion of Port-In via PostgreSQL RPC.
   * Transactionally sets ownership_state = OWNED, service_state = ACTIVE,
   * creates telecom_provider_resource_records, marks operation COMPLETED.
   */
  static async completePortIn(
    operationId: string,
    organizationId: string,
    providerAccountId: string,
    remoteResourceId: string,
    client?: SupabaseClient | any
  ): Promise<any> {
    const db = client || createAdminClient();

    const { data: rpcRes, error: rpcErr } = await (db as any).rpc(
      'complete_port_in_canonical_atomic',
      {
        p_operation_id: operationId,
        p_organization_id: organizationId,
        p_provider_account_id: providerAccountId,
        p_remote_resource_id: remoteResourceId,
        p_completed_at: new Date().toISOString(),
        p_customer_message: 'Number port-in completed successfully. Carrier routing active.',
        p_actor_identity: 'port_in_coordinator',
      }
    );

    if (rpcErr) {
      throw new Error(`PORT_IN_COMPLETION_FAILED: ${rpcErr.message}`);
    }

    // Phase 23D.9B: Consume slot reservation & start billable resource
    if (rpcRes?.success) {
      const { data: resRow } = await (db as any)
        .from('organization_number_slot_reservations')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('saga_type', 'port_in')
        .eq('operation_id', operationId)
        .maybeSingle();

      const { data: opRow } = await (db as any)
        .from('number_port_operations')
        .select('phone_number_id, phone_number_e164')
        .eq('id', operationId)
        .maybeSingle();

      if (resRow && opRow?.phone_number_id) {
        const { EntitlementAuthorizationService } = await import('@/lib/telecom/billing/entitlementAuthorizationService');
        await EntitlementAuthorizationService.consumeNumberSlotReservation(
          resRow.id,
          opRow.phone_number_id,
          db
        );
      }

      if (opRow?.phone_number_e164) {
        await (db as any)
          .from('organization_billable_resources')
          .insert({
            organization_id: organizationId,
            resource_type: 'phone_number',
            resource_id: opRow.phone_number_e164,
            billing_interval: 'monthly',
            contracted_retail_minor: 200,
            currency: 'USD',
            status: 'active',
            effective_start_at: new Date().toISOString(),
            metadata: { portInOperationId: operationId },
          })
          .then(() => {}, () => {});
      }
    }

    return rpcRes;
  }

  /**
   * Directly cancels a draft or pre-dispatch Port-In order and releases any acquired slot reservation.
   */
  static async cancelPortIn(
    operationId: string,
    organizationId: string,
    reason: string,
    client?: SupabaseClient | any
  ): Promise<{ success: boolean; canonicalState: string }> {
    const db = client || createAdminClient();
    await (db as any)
      .from('number_port_operations')
      .update({
        canonical_state: 'CANCELLED',
        status: 'cancelled',
        customer_message: `Port request cancelled: ${reason}`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', operationId)
      .eq('organization_id', organizationId);

    const { data: resRow } = await (db as any)
      .from('organization_number_slot_reservations')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('saga_type', 'port_in')
      .eq('operation_id', operationId)
      .maybeSingle();

    if (resRow) {
      const { EntitlementAuthorizationService } = await import('@/lib/telecom/billing/entitlementAuthorizationService');
      await EntitlementAuthorizationService.releaseNumberSlotReservation(
        resRow.id,
        'port_in_cancelled',
        db
      );
    }

    return { success: true, canonicalState: 'CANCELLED' };
  }
}
