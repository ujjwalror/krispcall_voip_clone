import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { PortOutStateMachine } from './portOutStateMachine';
import { PortLifecycleInterlock } from './interlocks/portLifecycleInterlock';
import { PortOutSecurityService } from './portOutSecurityService';
import {
  StepUpAuthContract,
  PortOutCanonicalState,
  PortSecurityPolicy,
} from './types';

const PROTECTED_PILOT_E164 = '+61348328472';
const PROTECTED_PILOT_UUID = '03edd0bc-b025-49e6-8171-a0c2fcd6cb78';

export class PortOutCoordinator {
  /**
   * Initiates a customer-requested Port-Out preparation workflow.
   * STRICT SECURITY:
   * - Quarantined pilot number blocked immediately.
   * - Number cannot be in RELEASE_PENDING or already PORTED_OUT.
   * - Default Port Freeze is enabled (PORT_OUT_LOCKED_BY_DEFAULT).
   */
  static async initiatePortOutRequest(
    params: {
      organizationId: string;
      phoneNumberId: string;
      phoneNumberE164: string;
      idempotencyKey?: string;
    },
    client?: SupabaseClient | any
  ): Promise<any> {
    const canonicalE164 = params.phoneNumberE164.trim();
    const db = client || createAdminClient();

    // 1. Phase 24B: Local Parent-Protection Control Plane & Porting Mutation Circuit Breaker
    const { TelecomControlPlaneService } = await import('@/lib/telecom/controlPlane');
    const controlEval = await TelecomControlPlaneService.evaluate(
      {
        organizationId: params.organizationId,
        operation: 'PORTING_MUTATION',
        context: { type: 'PORT_OUT', phoneNumber: canonicalE164, phoneNumberId: params.phoneNumberId },
      },
      db
    );
    if (!controlEval.allowed) {
      throw new Error(`PORTING_MUTATION_BLOCKED: ${controlEval.reason} (${controlEval.reasonCode})`);
    }

    // 2. Interlock and pilot quarantine check
    await PortLifecycleInterlock.assertCanInitiatePortOut(
      params.phoneNumberId,
      canonicalE164,
      params.organizationId,
      db
    );

    // 2. Check idempotency
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

    // 3. Default security policy: Locked by default
    const securityPolicy: PortSecurityPolicy = {
      portOutLocked: true,
      stepUpAuthRequired: true,
      securityNotificationRequired: true,
      riskReviewRequired: false,
      cooldownSeconds: 0,
    };

    // 4. Create operation in REQUESTED state
    const { data: phoneRow } = await (db as any)
      .from('phone_numbers')
      .select('id, provider_account_id')
      .eq('id', params.phoneNumberId)
      .eq('organization_id', params.organizationId)
      .maybeSingle();

    const insertPayload = {
      organization_id: params.organizationId,
      phone_number_id: params.phoneNumberId,
      phone_number_e164: canonicalE164,
      provider_account_id: phoneRow?.provider_account_id || null,
      direction: 'port_out',
      canonical_state: 'REQUESTED',
      status: 'requested',
      idempotency_key: params.idempotencyKey || null,
      port_security_policy: securityPolicy,
      customer_message: 'Port-out request initialized. Step-up authorization required to unlock credentials.',
      outcome_certainty: 'DEFINITIVE',
    };

    const { data: opRow, error: opErr } = await (db as any)
      .from('number_port_operations')
      .insert(insertPayload)
      .select('*')
      .single();

    if (opErr || !opRow) {
      throw new Error(`PORT_OUT_INITIATION_FAILED: Failed to create port-out operation: ${opErr?.message}`);
    }

    // 5. Update phone_numbers porting_state (keeps OWNED & ACTIVE)
    await (db as any)
      .from('phone_numbers')
      .update({
        porting_state: 'PORT_OUT_REQUESTED',
        updated_at: new Date().toISOString(),
      })
      .eq('id', params.phoneNumberId);

    return opRow;
  }

  /**
   * Unlocks Port Freeze and issues porting instructions and credentials.
   * Requires privileged Step-Up Authentication (Owner role + MFA).
   */
  static async authorizeAndIssueInstructions(
    params: {
      operationId: string;
      organizationId: string;
      stepUpAuth: StepUpAuthContract;
      cooldownSeconds?: number;
      accountIdentifier: string;
      portingPin: string;
    },
    client?: SupabaseClient | any
  ): Promise<any> {
    const db = client || createAdminClient();

    const { data: opRow } = await (db as any)
      .from('number_port_operations')
      .select('*')
      .eq('id', params.operationId)
      .eq('organization_id', params.organizationId)
      .single();

    if (!opRow) {
      throw new Error(`OPERATION_NOT_FOUND: Operation ${params.operationId} not found.`);
    }

    // 1. Verify and execute security unlock
    const unlockResult = await PortOutSecurityService.unlockPortOut(
      {
        organizationId: params.organizationId,
        phoneNumberId: opRow.phone_number_id,
        phoneNumberE164: opRow.phone_number_e164,
        cooldownSeconds: params.cooldownSeconds || 0,
        actorIdentity: params.stepUpAuth.actorIdentity,
        actorRole: params.stepUpAuth.actorRole,
        mfaVerified: params.stepUpAuth.mfaVerified,
        reauthTimestamp: params.stepUpAuth.reauthTimestamp,
      },
      db
    );

    // 2. Encrypt credentials at rest
    const encryptedPin = PortOutSecurityService.encryptCredential(params.portingPin);
    const encryptedAccount = PortOutSecurityService.encryptCredential(params.accountIdentifier);

    // 3. State transition: AUTHORIZED -> INSTRUCTIONS_ISSUED
    PortOutStateMachine.assertTransition(
      opRow.canonical_state as PortOutCanonicalState,
      'AUTHORIZED'
    );
    PortOutStateMachine.assertTransition('AUTHORIZED', 'INSTRUCTIONS_ISSUED');

    const updatedPolicy: PortSecurityPolicy = {
      portOutLocked: false,
      stepUpAuthRequired: true,
      securityNotificationRequired: true,
      riskReviewRequired: unlockResult.requiresManualReview,
      cooldownSeconds: params.cooldownSeconds || 0,
      unlockedAt: new Date().toISOString(),
      cooldownExpiresAt: unlockResult.cooldownExpiresAt,
      unlockedByActor: params.stepUpAuth.actorIdentity,
    };

    const targetState: PortOutCanonicalState = unlockResult.requiresManualReview
      ? 'SECURITY_REVIEW'
      : 'INSTRUCTIONS_ISSUED';

    await (db as any)
      .from('number_port_operations')
      .update({
        canonical_state: targetState,
        status: targetState === 'INSTRUCTIONS_ISSUED' ? 'instructions_ready' : 'under_review',
        port_security_policy: updatedPolicy,
        account_number_encrypted: encryptedAccount,
        porting_pin_encrypted: encryptedPin,
        customer_message: 'Port-out authorized. Transfer instructions and PIN issued.',
        updated_at: new Date().toISOString(),
      })
      .eq('id', opRow.id);

    // Update phone_numbers porting_state
    if (opRow.phone_number_id) {
      await (db as any)
        .from('phone_numbers')
        .update({
          porting_state: 'PORT_OUT_AUTHORIZED',
          updated_at: new Date().toISOString(),
        })
        .eq('id', opRow.phone_number_id);
    }

    return {
      operationId: opRow.id,
      canonicalState: targetState,
      portOutLocked: false,
      cooldownExpiresAt: unlockResult.cooldownExpiresAt,
      requiresManualReview: unlockResult.requiresManualReview,
      accountIdentifier: params.accountIdentifier,
      portingPin: params.portingPin, // Returned in memory to authenticated owner session only
    };
  }

  /**
   * Completes Port-Out using atomic PostgreSQL transaction.
   * Sets ownership_state = PORTED_OUT, tombstones carrier resource, marks operation COMPLETED.
   * INVARIANT: Never calls release mutation!
   */
  static async completePortOut(
    operationId: string,
    organizationId: string,
    actorIdentity: string = 'provider_webhook',
    client?: SupabaseClient | any
  ): Promise<any> {
    const db = client || createAdminClient();

    const { data: rpcRes, error: rpcErr } = await (db as any).rpc(
      'complete_port_out_canonical_atomic',
      {
        p_operation_id: operationId,
        p_organization_id: organizationId,
        p_completed_at: new Date().toISOString(),
        p_customer_message: 'Number transfer completed successfully to gaining carrier.',
        p_actor_identity: actorIdentity,
      }
    );

    if (rpcErr) {
      throw new Error(`PORT_OUT_COMPLETION_FAILED: ${rpcErr.message}`);
    }

    // Phase 23D.9B/9C: Commercial finalization on Port-Out completion
    if (rpcRes?.success && rpcRes.phone_number_e164) {
      // 1. Deactivate billable resource for this ported out number
      await (db as any)
        .from('organization_billable_resources')
        .update({
          status: 'inactive',
          effective_end_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('organization_id', organizationId)
        .eq('resource_type', 'phone_number')
        .eq('resource_id', rpcRes.phone_number_e164)
        .eq('status', 'active');

      // 2. Query phone number row to retrieve phone_number_id for slot release
      const { data: phoneRow } = await (db as any)
        .from('phone_numbers')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('phone_number_e164', rpcRes.phone_number_e164)
        .maybeSingle();

      if (phoneRow?.id) {
        // 3. Release linked CONSUMED slot reservation
        const { data: linkedRes } = await (db as any)
          .from('organization_number_slot_reservations')
          .select('id')
          .eq('organization_id', organizationId)
          .eq('phone_number_id', phoneRow.id)
          .eq('status', 'CONSUMED')
          .maybeSingle();

        if (linkedRes) {
          const { EntitlementAuthorizationService } = await import('../billing/entitlementAuthorizationService');
          await EntitlementAuthorizationService.releaseNumberSlotReservation(
            linkedRes.id,
            'number_ported_out',
            db
          );
        }
      }
    }

    return rpcRes;
  }
}
