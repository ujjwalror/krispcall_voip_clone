import 'server-only';
import { PreRenewalPolicyConfig } from '../renewal/types';
import { PolicySimulationEngine, SimulationResult } from '../renewal/policySimulationEngine';
import { PreRenewalPolicyService } from '../renewal/preRenewalPolicyService';

export interface ShadowEvaluationRecord {
  phoneNumberId: string;
  phoneNumberE164: string;
  organizationId: string;
  policyVersion: number;
  policyId: string;
  providerNextExposureAt: string | null;
  customerFundedThroughAt: string | null;
  currentStage: string;
  nextStage: string;
  nextActionTimestamp: string | null;

  // Shadow Hypothetical Outcomes
  wouldNotify: boolean;
  wouldAttemptPayment: boolean;
  wouldBecomeReleaseEligible: boolean;

  // Actual Executed Mutations (ALWAYS FALSE IN SHADOW MODE)
  actualPaymentAttempted: false;
  actualNotificationSent: false;
  actualProviderMutation: false;

  releaseBlockers: string[];
  isUnfundedCarrierExposure: boolean;
  isFirstCycleEnrollment: boolean;
  catchUpRequired: boolean;
}

export interface ShadowBatchOptions {
  batchSize?: number;
  asOfDate?: string | Date;
  policyOverride?: PreRenewalPolicyConfig;
  enforceFirstCycleProtection?: boolean;
}

export class RenewalShadowEngine {
  /**
   * Safe SHADOW Evaluation for a single phone number record.
   * Evaluates policy stages without modifying payments, sending communications, or calling provider APIs.
   */
  static evaluateShadowRecord(
    input: {
      phoneNumberId: string;
      phoneNumberE164: string;
      organizationId: string;
      cycleAnchorAt: string | Date;
      customerFundedThroughAt: string | Date;
      providerNextExposureAt?: string | Date | null;
      boundPolicy?: PreRenewalPolicyConfig;
      autopayEnabled?: boolean;
      hasActivePortOut?: boolean;
      reconciliationBlocked?: boolean;
      providerCycleStatus?: 'verified' | 'unknown_requires_reconciliation';
      isFirstCycleEnrollment?: boolean;
      historicalStagesPassed?: boolean;
    },
    options: ShadowBatchOptions = {}
  ): ShadowEvaluationRecord {
    const {
      phoneNumberId,
      phoneNumberE164,
      organizationId,
      cycleAnchorAt,
      customerFundedThroughAt,
      providerNextExposureAt,
      boundPolicy,
      autopayEnabled = false,
      hasActivePortOut = false,
      reconciliationBlocked = false,
      providerCycleStatus = 'verified',
      isFirstCycleEnrollment = false,
      historicalStagesPassed = false,
    } = input;

    const policy = boundPolicy || options.policyOverride || PreRenewalPolicyService.getApprovedPolicyV1();
    const asOfMs = options.asOfDate ? new Date(options.asOfDate).getTime() : Date.now();

    // First-cycle protection check: unknown carrier cycle fails closed
    const isUnknownCycle = providerCycleStatus === 'unknown_requires_reconciliation' || !providerNextExposureAt;

    // Run core simulation engine
    const simResult: SimulationResult = PolicySimulationEngine.simulateTimeline({
      phoneNumberId,
      phoneNumberE164,
      cycleAnchorAt,
      customerFundedThroughAt,
      providerNextExposureAt,
      policy,
      autopayEnabled,
      hasActivePortOut,
      reconciliationBlocked,
      providerCycleStatus,
      asOfDate: options.asOfDate,
    });

    // Evaluate release blockers
    const releaseBlockers: string[] = [...simResult.blockers];
    if (isUnknownCycle) releaseBlockers.push('UNKNOWN_CARRIER_EXPOSURE_DATE');

    // First-cycle protection: newly enrolled existing production numbers CANNOT jump directly to T0 release eligibility
    if (isFirstCycleEnrollment && simResult.releaseEligible) {
      releaseBlockers.push('FIRST_CYCLE_SAFETY_HOLD_RECONCILIATION_REQUIRED');
    }

    // Determine hypothetical 'would' flags
    const currentStageItem = simResult.timeline.find((t) => t.status === 'completed') || simResult.timeline[0];
    const nextStageItem = simResult.timeline.find((t) => t.status === 'pending');

    const wouldNotify =
      !isUnknownCycle &&
      (simResult.finalOutcome === 'PAYMENT_REQUIRED_WARNING' ||
        simResult.finalOutcome === 'RETRY_RECOVERY');

    const wouldAttemptPayment =
      autopayEnabled &&
      !isUnknownCycle &&
      !hasActivePortOut &&
      !reconciliationBlocked;

    const wouldBecomeReleaseEligible =
      simResult.releaseEligible &&
      !isFirstCycleEnrollment &&
      releaseBlockers.length === 0;

    // Catch-up / Backlog storm protection: historical stages are NOT blindly replayed
    const catchUpRequired = historicalStagesPassed && !wouldBecomeReleaseEligible;

    return {
      phoneNumberId,
      phoneNumberE164,
      organizationId,
      policyVersion: policy.policyVersion,
      policyId: policy.policyId,
      providerNextExposureAt: simResult.providerNextExposureAt,
      customerFundedThroughAt: simResult.customerFundedThroughAt,
      currentStage: currentStageItem ? currentStageItem.stage : 'INITIAL',
      nextStage: nextStageItem ? nextStageItem.stage : 'NONE',
      nextActionTimestamp: nextStageItem ? nextStageItem.timestamp : null,
      wouldNotify,
      wouldAttemptPayment,
      wouldBecomeReleaseEligible,
      actualPaymentAttempted: false,
      actualNotificationSent: false,
      actualProviderMutation: false,
      releaseBlockers,
      isUnfundedCarrierExposure: simResult.isUnfundedLiability,
      isFirstCycleEnrollment,
      catchUpRequired,
    };
  }

  /**
   * Safe SHADOW Batch Evaluator with Backlog / Activation Storm Protection.
   * Processes a bounded batch with deterministic ordering and idempotency.
   */
  static evaluateShadowBatch(
    records: Array<{
      phoneNumberId: string;
      phoneNumberE164: string;
      organizationId: string;
      cycleAnchorAt: string | Date;
      customerFundedThroughAt: string | Date;
      providerNextExposureAt?: string | Date | null;
      boundPolicy?: PreRenewalPolicyConfig;
      autopayEnabled?: boolean;
      hasActivePortOut?: boolean;
      reconciliationBlocked?: boolean;
      providerCycleStatus?: 'verified' | 'unknown_requires_reconciliation';
      isFirstCycleEnrollment?: boolean;
      historicalStagesPassed?: boolean;
    }>,
    options: ShadowBatchOptions = {}
  ): {
    evaluatedCount: number;
    batchLimit: number;
    shadowRecords: ShadowEvaluationRecord[];
    summary: {
      wouldAttemptPaymentCount: number;
      wouldNotifyCount: number;
      wouldBecomeReleaseEligibleCount: number;
      blockedByPortOutCount: number;
      blockedByReconciliationCount: number;
      unfundedCarrierExposureCount: number;
    };
  } {
    const batchLimit = Math.min(options.batchSize || 50, 100);

    // Deterministic ordering by providerNextExposureAt ASC
    const sortedRecords = [...records].sort((a, b) => {
      const tA = a.providerNextExposureAt ? new Date(a.providerNextExposureAt).getTime() : 0;
      const tB = b.providerNextExposureAt ? new Date(b.providerNextExposureAt).getTime() : 0;
      return tA - tB;
    });

    const boundedBatch = sortedRecords.slice(0, batchLimit);
    const shadowRecords: ShadowEvaluationRecord[] = boundedBatch.map((rec) =>
      this.evaluateShadowRecord(rec, options)
    );

    const summary = {
      wouldAttemptPaymentCount: shadowRecords.filter((r) => r.wouldAttemptPayment).length,
      wouldNotifyCount: shadowRecords.filter((r) => r.wouldNotify).length,
      wouldBecomeReleaseEligibleCount: shadowRecords.filter((r) => r.wouldBecomeReleaseEligible).length,
      blockedByPortOutCount: shadowRecords.filter((r) => r.releaseBlockers.includes('ACTIVE_PORT_OUT_IN_PROGRESS')).length,
      blockedByReconciliationCount: shadowRecords.filter((r) =>
        r.releaseBlockers.includes('PROVIDER_RECONCILIATION_REQUIRED') ||
        r.releaseBlockers.includes('FIRST_CYCLE_SAFETY_HOLD_RECONCILIATION_REQUIRED')
      ).length,
      unfundedCarrierExposureCount: shadowRecords.filter((r) => r.isUnfundedCarrierExposure).length,
    };

    return {
      evaluatedCount: shadowRecords.length,
      batchLimit,
      shadowRecords,
      summary,
    };
  }
}
