import { SupabaseClient } from '@supabase/supabase-js';
import {
  TwilioCallControlAdapter,
  MockTwilioCallControlAdapter,
  ActiveCallFetchResult,
} from '../../telephony/twilioCallControlAdapter';

export interface ReconcileOperationOptions {
  operationId?: string;
  organizationId?: string;
  internalUsageId?: string;
  workerId?: string;
  providerAdapter?: TwilioCallControlAdapter;
  maxAttempts?: number;
}

export interface ReconcileOperationResult {
  reconciled: boolean;
  outcome: 'APPLIED' | 'NOT_APPLIED' | 'STILL_UNKNOWN' | 'CALL_ALREADY_COMPLETED' | 'NO_WORK';
  opStatus?: string;
  operationId?: string;
  organizationId?: string;
  internalUsageId?: string;
  targetCallSid?: string;
  errorDetails?: string;
  escalateToTermination?: boolean;
}

export class TelecomReconciliationService {
  /**
   * Authoritative, server-only reconciliation of ambiguous telecom provider operations.
   * Core Invariant: UNKNOWN != FAILED.
   * Reads back provider call state before performing any financial rollback or status finalization.
   */
  public static async processNextReconciliationItem(
    client: SupabaseClient,
    options: ReconcileOperationOptions = {}
  ): Promise<ReconcileOperationResult> {
    const workerId = options.workerId || `reconciler_${Date.now()}`;
    const adapter = options.providerAdapter || new MockTwilioCallControlAdapter();
    const maxAttempts = options.maxAttempts || 3;

    // 1. Fetch oldest pending / reconciliation_required provider operation for call_duration_update
    let query = client
      .from('telecom_provider_operations')
      .select('*')
      .eq('operation_type', 'call_duration_update')
      .in('status', ['reconciliation_required', 'prepared', 'dispatch_claimed'])
      .order('created_at', { ascending: true })
      .limit(1);

    if (options.organizationId) {
      query = query.eq('organization_id', options.organizationId);
    }
    if (options.operationId) {
      query = query.eq('id', options.operationId);
    }

    const { data: ops, error: fetchErr } = await query;

    if (fetchErr) {
      console.error(`[TelecomReconciliationService] Query error: ${fetchErr.message}`);
      throw new Error(`RECONCILIATION_QUERY_FAILED: ${fetchErr.message}`);
    }

    if (!ops || ops.length === 0) {
      return { reconciled: false, outcome: 'NO_WORK' };
    }

    const op = ops[0];
    const {
      id: operationId,
      organization_id: organizationId,
      internal_usage_id: internalUsageId,
      provider_resource_id: providerResourceSid,
      child_provider_resource_id: childResourceSid,
      parent_provider_resource_id: parentResourceSid,
      idempotency_key: idempotencyKey,
      sequence_number: sequenceNumber,
      dispatch_token: dispatchToken,
      request_payload: reqPayload,
      metadata,
    } = op;

    // Determine target CallSid
    const targetCallSid = childResourceSid || providerResourceSid || parentResourceSid || metadata?.targetCallSid;

    if (!targetCallSid) {
      console.error(`[TelecomReconciliationService] Missing target CallSid for operation ${operationId}`);
      return {
        reconciled: true,
        outcome: 'NOT_APPLIED',
        opStatus: 'failed',
        operationId,
        organizationId,
        internalUsageId,
        errorDetails: 'MISSING_TARGET_CALL_SID',
      };
    }

    const expectedTimeLimitSeconds = reqPayload?.newTimeLimitSeconds || reqPayload?.timeLimit || 90;
    const currentAttemptCount = (metadata?.reconciliation_attempts || 0) + 1;

    console.log(`[TelecomReconciliationService] Reconciling operation ${operationId} for ${targetCallSid} (attempt ${currentAttemptCount})...`);

    // 2. READBACK PROVIDER CALL STATE (Zero blind mutation retries!)
    let fetchResult: ActiveCallFetchResult;
    try {
      fetchResult = await adapter.fetchActiveCallState({
        callSid: targetCallSid,
        expectedTimeLimitSeconds,
      });
    } catch (readErr: any) {
      console.warn(`[TelecomReconciliationService] Provider readback exception for ${targetCallSid}: ${readErr.message}`);
      fetchResult = {
        callSid: targetCallSid,
        status: 'unknown',
        statusClassification: 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH',
        isMock: true,
        errorDetails: readErr.message,
      };
    }

    const { statusClassification, status: callStatus } = fetchResult;

    // SCENARIO 1: CALL ALREADY COMPLETED
    if (callStatus === 'completed' || callStatus === 'canceled') {
      console.log(`[TelecomReconciliationService] Call ${targetCallSid} is already completed. Finalizing operation.`);

      // Finalize operation as call_completed
      await client.rpc('finalize_telecom_provider_operation_atomic', {
        p_organization_id: organizationId,
        p_operation_id: operationId,
        p_dispatch_token: dispatchToken,
        p_final_status: 'completed',
      });

      return {
        reconciled: true,
        outcome: 'CALL_ALREADY_COMPLETED',
        opStatus: 'completed',
        operationId,
        organizationId,
        internalUsageId,
        targetCallSid,
      };
    }

    // SCENARIO 2: READBACK CONFIRMED MUTATION WAS APPLIED
    if (statusClassification === 'READBACK_CONFIRMED_SUCCESS') {
      console.log(`[TelecomReconciliationService] Readback confirmed mutation APPLIED for ${targetCallSid}. Finalizing completed.`);

      await client.rpc('finalize_telecom_provider_operation_atomic', {
        p_organization_id: organizationId,
        p_operation_id: operationId,
        p_dispatch_token: dispatchToken,
        p_final_status: 'completed',
      });

      return {
        reconciled: true,
        outcome: 'APPLIED',
        opStatus: 'completed',
        operationId,
        organizationId,
        internalUsageId,
        targetCallSid,
      };
    }

    // SCENARIO 3: READBACK CONFIRMED MUTATION WAS NOT APPLIED
    if (statusClassification === 'READBACK_CONFIRMED_ABSENT_OR_UNCHANGED') {
      console.warn(`[TelecomReconciliationService] Readback confirmed mutation NOT APPLIED for ${targetCallSid}. Executing partial rollback.`);

      const incrementalAmountMinor = reqPayload?.incrementalAmountMinor || 6;

      // Database-derived fenced rollback of unapplied 6c extension hold
      const { error: rbErr } = await client.rpc('rollback_telecom_usage_reservation_extension_atomic', {
        p_organization_id: organizationId,
        p_operation_id: operationId,
        p_dispatch_token: dispatchToken,
        p_internal_usage_id: internalUsageId,
        p_sequence_number: sequenceNumber || 1,
        p_rollback_amount_minor: incrementalAmountMinor,
        p_extension_idempotency_key: idempotencyKey,
      });

      if (rbErr) {
        console.error(`[TelecomReconciliationService] Fenced rollback error: ${rbErr.message}`);
      }

      await client.rpc('finalize_telecom_provider_operation_atomic', {
        p_organization_id: organizationId,
        p_operation_id: operationId,
        p_dispatch_token: dispatchToken,
        p_final_status: 'confirmed_absent',
      });

      return {
        reconciled: true,
        outcome: 'NOT_APPLIED',
        opStatus: 'confirmed_absent',
        operationId,
        organizationId,
        internalUsageId,
        targetCallSid,
        escalateToTermination: true,
      };
    }

    // SCENARIO 4: READBACK STILL UNKNOWN / TIMEOUT
    console.warn(`[TelecomReconciliationService] Provider readback STILL UNKNOWN for ${targetCallSid} (attempt ${currentAttemptCount}/${maxAttempts}).`);

    const shouldEscalate = currentAttemptCount >= maxAttempts;

    // Update reconciliation attempt count in metadata
    await client
      .from('telecom_provider_operations')
      .update({
        metadata: {
          ...(metadata || {}),
          reconciliation_attempts: currentAttemptCount,
          last_reconciliation_at: new Date().toISOString(),
          escalated_to_termination: shouldEscalate,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', operationId);

    return {
      reconciled: false,
      outcome: 'STILL_UNKNOWN',
      opStatus: 'reconciliation_required',
      operationId,
      organizationId,
      internalUsageId,
      targetCallSid,
      escalateToTermination: shouldEscalate,
    };
  }
}
