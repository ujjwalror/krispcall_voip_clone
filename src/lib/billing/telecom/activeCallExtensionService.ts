import { SupabaseClient } from '@supabase/supabase-js';
import { TelecomWalletService } from '../telecomWalletService';
import {
  TwilioCallControlAdapter,
  MockTwilioCallControlAdapter,
  ActiveCallAllowanceResult,
} from '../../telephony/twilioCallControlAdapter';

export interface CalculateCumulativeExtensionCostOptions {
  snapshot: any;
  currentBoundarySeconds: number;
  nextBoundarySeconds: number;
  currentReservationMinor: number;
}

export function calculateCumulativeExtensionCost(options: CalculateCumulativeExtensionCostOptions) {
  const { snapshot, currentBoundarySeconds, nextBoundarySeconds, currentReservationMinor } = options;
  const initialMinSec = snapshot?.initial_minimum_seconds || 60;
  const initialMinCents = snapshot?.initial_minimum_cents || 10;
  const intervalSec = snapshot?.billing_interval_seconds || 60;
  const ratePerIntervalCents = snapshot?.rate_per_interval_cents || snapshot?.initial_minimum_cents || 10;

  let nextCumulativeCostMinor = 0;
  if (nextBoundarySeconds <= initialMinSec) {
    nextCumulativeCostMinor = initialMinCents;
  } else {
    const extraSec = nextBoundarySeconds - initialMinSec;
    const extraIntervals = Math.ceil(extraSec / intervalSec);
    nextCumulativeCostMinor = initialMinCents + extraIntervals * ratePerIntervalCents;
  }

  const incrementalAmountMinor = Math.max(0, nextCumulativeCostMinor - currentReservationMinor);
  return {
    nextCumulativeCostMinor,
    incrementalAmountMinor,
    nextBoundarySeconds,
  };
}

export interface ActiveCallExtensionOptions {
  dueBeforeTimestamp?: string;
  leaseDurationSeconds?: number;
  /** Explicitly marked EXPERIMENT_PROVISIONAL (Configurable, non-production default) */
  extensionBlockSeconds?: number;
  providerAdapter?: TwilioCallControlAdapter;
  workerId?: string;
}

export interface ActiveCallExtensionProcessResult {
  processed: boolean;
  reason?: string;
  status?: string;
  opStatus?: string;
  targetCallSid?: string;
  organizationId?: string;
  internalUsageId?: string;
  sessionId?: string;
  operationId?: string;
  sequenceNumber?: number;
  amountReservedMinor?: number;
  additionalReservedMinor?: number;
  newExpiresAt?: string;
  providerResourceSid?: string;
  isReclaim?: boolean;
  errorDetails?: string;
}

export async function processNextDueVoiceExtension(
  client: SupabaseClient,
  options: ActiveCallExtensionOptions = {}
): Promise<ActiveCallExtensionProcessResult> {
  const workerId = options.workerId || 'worker_default';
  const dueBefore = options.dueBeforeTimestamp || new Date().toISOString();
  const leaseSec = options.leaseDurationSeconds || 30;
  const blockSec = options.extensionBlockSeconds || 60; // EXPERIMENT_PROVISIONAL
  const adapter = options.providerAdapter || new MockTwilioCallControlAdapter();

  // 1. DATABASE-AUTHORITATIVE CLAIM VIA RPC
  const { data: claimResponse, error: claimErr } = await client.rpc('claim_next_due_call_extension_atomic', {
    p_worker_id: workerId,
    p_due_before_timestamp: dueBefore,
    p_lease_duration_seconds: leaseSec,
  });

  if (claimErr) {
    console.error(`[ActiveCallExtensionService] Claim RPC error: ${claimErr.message}`);
    throw new Error(`CLAIM_RPC_FAILED: ${claimErr.message}`);
  }

  let claimItem: any = null;
  if (Array.isArray(claimResponse)) {
    claimItem = claimResponse.length > 0 ? claimResponse[0] : null;
  } else if (claimResponse && typeof claimResponse === 'object') {
    claimItem = claimResponse.claimed === false ? null : claimResponse;
  }

  if (!claimItem) {
    return { processed: false, reason: 'NO_DUE_CALLS' };
  }

  const {
    operation_id: operationId,
    organization_id: organizationId,
    internal_usage_id: internalUsageId,
    session_id: sessionId,
    component_id: componentId,
    service_type: serviceType,
    direction,
    provider_resource_id: defaultProviderResourceSid,
    parent_provider_resource_id: parentResourceSid,
    child_provider_resource_id: childResourceSid,
    current_amount_reserved_minor: currentAmountReservedMinor = 10,
    current_protected_boundary_seconds: currentProtectedBoundary = 60,
    sequence_number: sequenceNumber = 1,
    extension_sequence: extSequence = 1,
    idempotency_key: idempotencyKey,
    dispatch_token: dispatchToken,
    is_reclaim: isReclaim = false,
    billing_rate_snapshot: claimedRateSnapshot,
  } = claimItem;

  const seq = sequenceNumber || extSequence || 1;

  // Resolve target CallSid based on service direction
  let targetCallSid = defaultProviderResourceSid;
  if (serviceType === 'voice_inbound' || direction === 'inbound') {
    targetCallSid = parentResourceSid || defaultProviderResourceSid;
  } else if (serviceType === 'voice_outbound' || direction === 'outbound') {
    targetCallSid = childResourceSid || defaultProviderResourceSid;
  }

  console.log(`[ActiveCallExtensionService] Claimed work: org=${organizationId}, usage=${internalUsageId}, seq=${seq}, targetCallSid=${targetCallSid}`);

  // 2. DIRECTION-AWARE PROVIDER IDENTITY VALIDATION
  if (!targetCallSid || targetCallSid.trim().length === 0) {
    console.error(`[ActiveCallExtensionService] Missing provider resource SID for service ${serviceType}, usage ${internalUsageId}`);
    return {
      processed: true,
      status: 'FAILED',
      reason: 'MISSING_PROVIDER_RESOURCE_ID',
      errorDetails: 'MISSING_PROVIDER_RESOURCE_ID',
    };
  }

  // 3. CUMULATIVE-DIFFERENCE RATING CALCULATIONS
  const snapshot = claimedRateSnapshot || {
    initial_minimum_seconds: 60,
    initial_minimum_cents: 10,
    billing_interval_seconds: 60,
    rate_per_interval_cents: 10,
  };

  const nextBoundarySeconds = (currentProtectedBoundary || 60) + blockSec;
  const costCalculation = calculateCumulativeExtensionCost({
    snapshot,
    currentBoundarySeconds: currentProtectedBoundary || 60,
    nextBoundarySeconds,
    currentReservationMinor: currentAmountReservedMinor,
  });

  const additionalAmountReservedMinor = costCalculation.incrementalAmountMinor;

  // 4. ATOMIC FENCED WALLET EXTENSION (Wallet FIRST before provider allowance!)
  try {
    const { data: extData, error: extErr } = await client.rpc('extend_telecom_voice_reservation_fenced_atomic', {
      p_organization_id: organizationId,
      p_operation_id: operationId,
      p_dispatch_token: dispatchToken,
      p_internal_usage_id: internalUsageId,
      p_incremental_amount_minor: additionalAmountReservedMinor,
      p_idempotency_key: idempotencyKey,
      p_sequence_number: seq,
      p_new_expires_in_seconds: 1800,
    });

    if (extErr) {
      console.warn(`[ActiveCallExtensionService] Financial extension failed: ${extErr.message}`);
      if (extErr.message.includes('STALE_FENCING_TOKEN')) {
        return {
          processed: true,
          status: 'FAILED',
          reason: extErr.message,
          errorDetails: extErr.message,
        };
      }
      if (extErr.message.includes('INSUFFICIENT_FUNDED_CREDITS') || extErr.message.includes('INSUFFICIENT_AVAILABLE_BALANCE')) {
        return {
          processed: true,
          status: 'INSUFFICIENT_FUNDED_CREDITS',
          reason: 'INSUFFICIENT_FUNDED_CREDITS',
          organizationId,
          internalUsageId,
          operationId,
          sequenceNumber: seq,
        };
      }
      return {
        processed: true,
        status: 'FAILED',
        reason: extErr.message,
      };
    }
  } catch (e: any) {
    if (e.message.includes('STALE_FENCING_TOKEN')) {
      return {
        processed: true,
        status: 'FAILED',
        reason: e.message,
      };
    }
    throw e;
  }

  // 5. PROVIDER ALLOWANCE DISPATCH (MOCK BY DEFAULT)
  // Only after financial authorization succeeds do we proceed to provider dispatch!
  const providerResult: ActiveCallAllowanceResult = await adapter.extendActiveCallAllowance({
    callSid: targetCallSid,
    newTimeLimitSeconds: nextBoundarySeconds,
    idempotencyKey,
  });

  const classification = providerResult.statusClassification;
  console.log(`[ActiveCallExtensionService] Provider result for ${targetCallSid}: ${classification}`);

  // 6. PROVIDER RESULT CLASSIFICATION & FINALIZATION
  if (classification === 'DEFINITE_SUCCESS' || classification === 'READBACK_CONFIRMED_SUCCESS') {
    const finalStatus = classification === 'READBACK_CONFIRMED_SUCCESS' ? 'completed' : 'completed';
    await client.rpc('finalize_telecom_provider_operation_atomic', {
      p_organization_id: organizationId,
      p_operation_id: operationId,
      p_dispatch_token: dispatchToken,
      p_final_status: finalStatus,
    });

    return {
      processed: true,
      status: classification,
      opStatus: 'completed',
      targetCallSid,
      organizationId,
      internalUsageId,
      sessionId,
      operationId,
      sequenceNumber: seq,
      amountReservedMinor: currentAmountReservedMinor + additionalAmountReservedMinor,
      additionalReservedMinor: additionalAmountReservedMinor,
      providerResourceSid: targetCallSid,
      isReclaim,
    };
  }

  if (
    classification === 'DEFINITE_PRE_DISPATCH_FAILURE' ||
    classification === 'DEFINITE_PROVIDER_REJECTION' ||
    classification === 'READBACK_CONFIRMED_ABSENT_OR_UNCHANGED'
  ) {
    // DEFINITE FAILURE: Perform database-derived fenced partial compensation!
    const rollbackKey = `rb_${idempotencyKey}`;
    console.warn(`[ActiveCallExtensionService] Executing fenced partial rollback for operation ${operationId}`);

    const { data: rbData, error: rbErr } = await client.rpc('rollback_telecom_usage_reservation_extension_atomic', {
      p_organization_id: organizationId,
      p_operation_id: operationId,
      p_dispatch_token: dispatchToken,
      p_internal_usage_id: internalUsageId,
      p_sequence_number: seq,
      p_rollback_amount_minor: additionalAmountReservedMinor,
      p_extension_idempotency_key: idempotencyKey,
    });

    if (rbErr) {
      console.error(`[ActiveCallExtensionService] Rollback RPC failed: ${rbErr.message}`);
      return {
        processed: true,
        status: 'FAILED',
        reason: 'COMPENSATION_FAILED',
        errorDetails: rbErr.message,
      };
    }

    const finalStatus = classification === 'READBACK_CONFIRMED_ABSENT_OR_UNCHANGED' ? 'confirmed_absent' : 'failed';

    // Finalize operation as terminal failed ONLY AFTER compensation succeeded
    await client.rpc('finalize_telecom_provider_operation_atomic', {
      p_organization_id: organizationId,
      p_operation_id: operationId,
      p_dispatch_token: dispatchToken,
      p_final_status: finalStatus,
    });

    return {
      processed: true,
      status: classification,
      opStatus: finalStatus,
      targetCallSid,
      organizationId,
      internalUsageId,
      operationId,
      sequenceNumber: seq,
      errorDetails: providerResult.errorDetails,
    };
  }

  // AMBIGUOUS TIMEOUT AFTER DISPATCH
  // Do NOT rollback immediately. Flag reconciliation_required and retain financial hold.
  console.warn(`[ActiveCallExtensionService] Provider result ambiguous for ${targetCallSid}. Setting reconciliation_required.`);
  await client.rpc('finalize_telecom_provider_operation_atomic', {
    p_organization_id: organizationId,
    p_operation_id: operationId,
    p_dispatch_token: dispatchToken,
    p_final_status: 'reconciliation_required',
  });

  return {
    processed: true,
    status: 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH',
    opStatus: 'reconciliation_required',
    targetCallSid,
    organizationId,
    internalUsageId,
    operationId,
    sequenceNumber: seq,
    errorDetails: 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH',
  };
}

export class ActiveCallExtensionService {
  static processNextDueVoiceExtension = processNextDueVoiceExtension;
}
