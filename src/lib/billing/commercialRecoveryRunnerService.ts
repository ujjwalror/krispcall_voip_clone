import { SupabaseClient } from '@supabase/supabase-js';
import { CommercialCaptureReconciliationService } from './commercialCaptureReconciliationService';

export interface RecoveryRunnerOptions {
  batchSize?: number;
  timeBudgetMs?: number;
  staleThresholdMinutes?: number;
  expectedMode?: 'test' | 'live';
}

export interface RecoveryRunnerSummary {
  discovered: number;
  claimed: number;
  recovered: number;
  deferred: number;
  manualReview: number;
  skipped: number;
  errors: number;
  stoppedByTimeBudget: boolean;
  executionDurationMs: number;
}

export class CommercialRecoveryRunnerService {
  /**
   * Executes the Phase 13.3.4 Production Recovery Runner.
   * 
   * INVARIANTS:
   * 1. Strictly reconciliation-only via CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga().
   * 2. ZERO executable paymentIntents.capture() POST requests.
   * 3. ZERO Twilio/telecom provider mutations.
   * 4. Fenced atomic lease acquisition via claim_commercial_saga_recovery() RPC.
   * 5. Fenced recovery outcome recording via record_commercial_saga_recovery_outcome() RPC.
   * 6. Hosting-independent execution time-budget protection.
   */
  static async runRecoveryPass(
    supabase: SupabaseClient,
    options: RecoveryRunnerOptions = {}
  ): Promise<RecoveryRunnerSummary> {
    const startTime = Date.now();
    const batchSize = Math.min(Math.max(options.batchSize || 15, 1), 15);
    const timeBudgetMs = options.timeBudgetMs || 20000; // 20 seconds default budget
    const staleThresholdMinutes = options.staleThresholdMinutes || 5;
    const expectedMode = options.expectedMode || 'test';

    const summary: RecoveryRunnerSummary = {
      discovered: 0,
      claimed: 0,
      recovered: 0,
      deferred: 0,
      manualReview: 0,
      skipped: 0,
      errors: 0,
      stoppedByTimeBudget: false,
      executionDurationMs: 0,
    };

    const nowIso = new Date().toISOString();
    const cutoffDate = new Date(Date.now() - staleThresholdMinutes * 60 * 1000).toISOString();

    // 1. Discover eligible stale sagas
    const { data: eligibleSagas, error: discoverErr } = await (supabase as any)
      .from('commercial_number_purchase_sagas')
      .select('*')
      .in('state', ['capture_pending', 'financial_reconciliation_required'])
      .or(`next_recovery_retry_at.is.null,next_recovery_retry_at.lte.${nowIso}`)
      .or(`recovery_lease_until.is.null,recovery_lease_until.lte.${nowIso}`)
      .lt('updated_at', cutoffDate)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(batchSize);

    if (discoverErr || !eligibleSagas) {
      console.error('[CommercialRecoveryRunnerService] Discovery query failed:', discoverErr?.message);
      summary.executionDurationMs = Date.now() - startTime;
      return summary;
    }

    summary.discovered = eligibleSagas.length;

    // 2. Sequential processing loop under time budget
    for (const saga of eligibleSagas) {
      if (Date.now() - startTime > timeBudgetMs) {
        console.warn('[CommercialRecoveryRunnerService] Time budget reached. Gracefully stopping recovery batch pass.');
        summary.stoppedByTimeBudget = true;
        break;
      }

      const orgId = saga.organization_id || saga.organizationId;
      if (!orgId) {
        summary.skipped++;
        continue;
      }

      // 3. Attempt Atomic Lease Claim RPC
      let claimedSaga: any = null;
      try {
        const { data: claimResult, error: claimErr } = await (supabase as any).rpc('claim_commercial_saga_recovery', {
          p_saga_id: saga.id,
          p_organization_id: orgId,
          p_lease_seconds: 60,
        });

        if (claimErr || !claimResult) {
          // Lease lost or active lease exists
          summary.skipped++;
          continue;
        }
        claimedSaga = claimResult;
      } catch (ex: any) {
        console.error(`[CommercialRecoveryRunnerService] Lease claim failed for saga ${saga.id}:`, ex.message);
        summary.errors++;
        continue;
      }

      const leaseToken = claimedSaga.recovery_lease_token || claimedSaga.recoveryLeaseToken;
      if (!leaseToken) {
        summary.skipped++;
        continue;
      }

      summary.claimed++;
      const currentAttempts = claimedSaga.recovery_attempt_count ?? claimedSaga.recoveryAttemptCount ?? 1;
      const recoveryStartedAt = claimedSaga.recovery_started_at ?? claimedSaga.recoveryStartedAt ?? null;

      // 4. Pre-Execution Wall-Clock & Global Attempt Cap Checks (Attempt 13+ or Age >= 48h)
      const nowMs = Date.now();
      const isOverMaxAge = recoveryStartedAt && (nowMs >= new Date(recoveryStartedAt).getTime() + 48 * 60 * 60 * 1000);
      const isOverMaxAttempts = currentAttempts > 12;

      if (isOverMaxAttempts || isOverMaxAge) {
        const reason = isOverMaxAttempts
          ? `Recovery attempt limit exceeded (${currentAttempts} > 12)`
          : `Recovery wall-clock age limit exceeded (started at ${recoveryStartedAt})`;

        try {
          await (supabase as any).rpc('mark_commercial_saga_manual_review', {
            p_saga_id: saga.id,
            p_organization_id: orgId,
            p_reason: reason,
          });
        } catch (e) {}

        await (supabase as any).rpc('record_commercial_saga_recovery_outcome', {
          p_saga_id: saga.id,
          p_organization_id: orgId,
          p_lease_token: leaseToken,
          p_classification: 'RECOVERY_EXHAUSTED',
          p_stripe_status: 'failed_exhausted',
          p_next_retry_at: null,
        });
        summary.manualReview++;
        continue;
      }

      // 5. Execute Reconciliation-Only Pathway (Attempts 1-12)
      let reconResult: any;
      try {
        reconResult = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase, {
          sagaId: saga.id,
          expectedMode,
        });
      } catch (reconEx: any) {
        console.error(`[CommercialRecoveryRunnerService] Reconciliation exception for saga ${saga.id}:`, reconEx.message);
        summary.errors++;
        if (currentAttempts >= 12) {
          await this.safeMarkManualReview(supabase, saga.id, orgId, `Recovery exception on final attempt (${currentAttempts}/12): ${reconEx.message}`);
          await this.safeRecordOutcome(supabase, saga.id, orgId, leaseToken, 'STRIPE_RETRIEVAL_FAILED', 'unknown', null);
          summary.manualReview++;
        } else {
          await this.safeRecordOutcome(supabase, saga.id, orgId, leaseToken, 'STRIPE_RETRIEVAL_FAILED', 'unknown', this.calculateNextRetry(currentAttempts, 'STRIPE_RETRIEVAL_FAILED'));
          summary.deferred++;
        }
        continue;
      }

      const classification = reconResult.classification || 'UNKNOWN';

      // 6. Interpret Reconciliation Result & Execute Fenced Outcome RPC
      if (reconResult.success || reconResult.saga?.state === 'completed') {
        // Recovery Completed!
        await (supabase as any).rpc('record_commercial_saga_recovery_outcome', {
          p_saga_id: saga.id,
          p_organization_id: orgId,
          p_lease_token: leaseToken,
          p_classification: classification,
          p_stripe_status: 'succeeded',
          p_next_retry_at: null,
        });
        summary.recovered++;
      } else if (
        classification === 'AMOUNT_MISMATCH' ||
        classification === 'CURRENCY_MISMATCH' ||
        classification === 'MODE_MISMATCH' ||
        classification === 'PROVIDER_ID_MISMATCH' ||
        classification === 'MANUAL_REVIEW_REQUIRED' ||
        classification === 'DISPATCH_NOT_CLAIMED_RECONCILIATION_REQUIRED' ||
        classification === 'INVARIANT_MISMATCH' ||
        classification === 'TELECOM_CLAIM_FAILED' ||
        classification === 'TELECOM_SELECTION_MISMATCH' ||
        classification === 'PAYMENT_FAILED'
      ) {
        // Immediate Escalation to Manual Review
        await this.safeMarkManualReview(supabase, saga.id, orgId, reconResult.message || `Recovery runner classified as ${classification}`);
        await (supabase as any).rpc('record_commercial_saga_recovery_outcome', {
          p_saga_id: saga.id,
          p_organization_id: orgId,
          p_lease_token: leaseToken,
          p_classification: classification,
          p_stripe_status: 'unknown',
          p_next_retry_at: null,
        });
        summary.manualReview++;
      } else {
        // Transient Retryable Case (STRIPE_RETRIEVAL_FAILED, PAYMENT_PROCESSING, DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED, or financial reconciliation retry)
        if (currentAttempts >= 12) {
          await this.safeMarkManualReview(supabase, saga.id, orgId, `Recovery retries exhausted (${currentAttempts}/12) for classification ${classification}`);
          await (supabase as any).rpc('record_commercial_saga_recovery_outcome', {
            p_saga_id: saga.id,
            p_organization_id: orgId,
            p_lease_token: leaseToken,
            p_classification: classification,
            p_stripe_status: 'failed_exhausted',
            p_next_retry_at: null,
          });
          summary.manualReview++;
        } else {
          const nextRetryAt = this.calculateNextRetry(currentAttempts, classification);
          await (supabase as any).rpc('record_commercial_saga_recovery_outcome', {
            p_saga_id: saga.id,
            p_organization_id: orgId,
            p_lease_token: leaseToken,
            p_classification: classification,
            p_stripe_status: classification === 'PAYMENT_PROCESSING' ? 'processing' : 'pending',
            p_next_retry_at: nextRetryAt,
          });
          summary.deferred++;
        }
      }
    }

    summary.executionDurationMs = Date.now() - startTime;
    return summary;
  }

  public static isRecoveryExhausted(params: {
    recoveryAttemptCount: number;
    recoveryStartedAt?: string | null;
    nowMs?: number;
  }): { exhausted: boolean; reason?: 'ATTEMPTS_EXHAUSTED' | 'AGE_EXHAUSTED' } {
    const count = params.recoveryAttemptCount;
    if (count > 12) {
      return { exhausted: true, reason: 'ATTEMPTS_EXHAUSTED' };
    }

    if (params.recoveryStartedAt) {
      const startedAtMs = new Date(params.recoveryStartedAt).getTime();
      const nowMs = params.nowMs ?? Date.now();
      const maxAgeMs = 48 * 60 * 60 * 1000; // 48 hours
      if (nowMs >= startedAtMs + maxAgeMs) {
        return { exhausted: true, reason: 'AGE_EXHAUSTED' };
      }
    }

    return { exhausted: false };
  }

  public static calculateNextRetry(attemptCount: number, classification: string): string {
    let delaySeconds = 300; // default 5m

    if (classification === 'STRIPE_RETRIEVAL_FAILED') {
      const delays = [60, 300, 900, 3600, 14400]; // 1m, 5m, 15m, 1h, 4h
      delaySeconds = delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)];
    } else if (classification === 'PAYMENT_PROCESSING') {
      const delays = [900, 1800, 3600, 7200, 14400]; // 15m, 30m, 1h, 2h, 4h
      delaySeconds = delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)];
    } else if (classification === 'DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED') {
      const delays = [120, 300, 900]; // 2m, 5m, 15m
      delaySeconds = delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)];
    } else {
      const delays = [300, 900, 3600, 21600]; // 5m, 15m, 1h, 6h
      delaySeconds = delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)];
    }

    return new Date(Date.now() + delaySeconds * 1000).toISOString();
  }

  private static async safeMarkManualReview(
    supabase: SupabaseClient,
    sagaId: string,
    orgId: string,
    reason: string
  ) {
    try {
      await (supabase as any).rpc('mark_commercial_saga_manual_review', {
        p_saga_id: sagaId,
        p_organization_id: orgId,
        p_reason: reason,
      });
    } catch (e) {}
  }

  private static async safeRecordOutcome(
    supabase: SupabaseClient,
    sagaId: string,
    orgId: string,
    leaseToken: string,
    classification: string,
    status: string,
    nextRetryAt: string | null
  ) {
    try {
      await (supabase as any).rpc('record_commercial_saga_recovery_outcome', {
        p_saga_id: sagaId,
        p_organization_id: orgId,
        p_lease_token: leaseToken,
        p_classification: classification,
        p_stripe_status: status,
        p_next_retry_at: nextRetryAt,
      });
    } catch (e) {}
  }
}
