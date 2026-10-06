import 'server-only';
import { RenewalShadowEngine, ShadowEvaluationRecord, ShadowBatchOptions } from './renewalShadowEngine';
import { ActivationControlPlane } from './activationControlPlane';

export interface ShadowWorkerIterationResult {
  workerRunId: string;
  startedAt: string;
  completedAt: string;
  evaluatedCount: number;
  batchSize: number;
  conceptualState: string;
  isAutonomousExecutionEnabled: false;
  summary: {
    wouldAttemptPaymentCount: number;
    wouldNotifyCount: number;
    wouldBecomeReleaseEligibleCount: number;
    blockedByPortOutCount: number;
    blockedByReconciliationCount: number;
    unfundedCarrierExposureCount: number;
  };
  shadowRecords: ShadowEvaluationRecord[];
}

export class ShadowWorker {
  private static isRunning = false;
  private static lastRunTimestamp: string | null = null;

  /**
   * Runs a single bounded shadow renewal iteration.
   * Concurrency-locked, idempotent, and completely non-mutating.
   * Runnable from standard Node.js / VPS environments without Vercel cron dependency.
   */
  static async runShadowIteration(
    candidateRecords: Array<{
      phoneNumberId: string;
      phoneNumberE164: string;
      organizationId: string;
      cycleAnchorAt: string | Date;
      customerFundedThroughAt: string | Date;
      providerNextExposureAt?: string | Date | null;
      autopayEnabled?: boolean;
      hasActivePortOut?: boolean;
      reconciliationBlocked?: boolean;
      providerCycleStatus?: 'verified' | 'unknown_requires_reconciliation';
      isFirstCycleEnrollment?: boolean;
      historicalStagesPassed?: boolean;
    }> = [],
    options: ShadowBatchOptions = {}
  ): Promise<ShadowWorkerIterationResult> {
    const runId = `shadow_run_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const startedAt = new Date().toISOString();

    // Concurrency Lock: prevent overlapping duplicate runs
    if (this.isRunning) {
      console.warn('[ShadowWorker] Iteration skipped — previous shadow run still in progress.');
      return {
        workerRunId: runId,
        startedAt,
        completedAt: new Date().toISOString(),
        evaluatedCount: 0,
        batchSize: options.batchSize || 50,
        conceptualState: 'SKIPPED_CONCURRENCY_LOCK',
        isAutonomousExecutionEnabled: false,
        summary: {
          wouldAttemptPaymentCount: 0,
          wouldNotifyCount: 0,
          wouldBecomeReleaseEligibleCount: 0,
          blockedByPortOutCount: 0,
          blockedByReconciliationCount: 0,
          unfundedCarrierExposureCount: 0,
        },
        shadowRecords: [],
      };
    }

    try {
      this.isRunning = true;
      const gates = await ActivationControlPlane.auditGates();

      const batchResult = RenewalShadowEngine.evaluateShadowBatch(candidateRecords, options);
      this.lastRunTimestamp = new Date().toISOString();

      return {
        workerRunId: runId,
        startedAt,
        completedAt: this.lastRunTimestamp,
        evaluatedCount: batchResult.evaluatedCount,
        batchSize: batchResult.batchLimit,
        conceptualState: gates.conceptualState,
        isAutonomousExecutionEnabled: false,
        summary: batchResult.summary,
        shadowRecords: batchResult.shadowRecords,
      };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Returns worker operational state for observability.
   */
  static getWorkerStatus(): { isRunning: boolean; lastRunTimestamp: string | null } {
    return {
      isRunning: this.isRunning,
      lastRunTimestamp: this.lastRunTimestamp,
    };
  }
}
