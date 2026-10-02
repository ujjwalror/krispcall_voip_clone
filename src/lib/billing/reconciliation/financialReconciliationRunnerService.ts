import { SupabaseClient } from '@supabase/supabase-js';
import { FinancialReconciliationEngine, ExecuteReconciliationOptions } from './financialReconciliationEngine';
import {
  generateCanonicalScopeKey,
  getScopeLeaseTtlSeconds,
  getScopeHeartbeatIntervalMs,
} from './reconciliationScopeUtils';
import {
  ReconciliationRunStatus,
  RunSummaryCounts,
  RunModuleCoverage,
} from './reconciliationTypes';

export interface ReconciliationRunnerResult {
  runId: string | null;
  status: ReconciliationRunStatus | 'skipped';
  reason?: string;
  summaryCounts: RunSummaryCounts;
  moduleCoverage?: RunModuleCoverage;
}

export class FinancialReconciliationRunnerService {
  private engine: FinancialReconciliationEngine;

  constructor(engine: FinancialReconciliationEngine = new FinancialReconciliationEngine()) {
    this.engine = engine;
  }

  /**
   * Executes a durable, lease-fenced reconciliation run.
   * Host-independent runner suitable for serverless HTTP triggers, background daemons, or CLI execution.
   */
  async run(
    supabase: SupabaseClient,
    options: ExecuteReconciliationOptions & { workerId?: string }
  ): Promise<ReconciliationRunnerResult> {
    const {
      runType,
      organizationId,
      providerAccountId,
      targetedEntityType,
      targetedEntityId,
      workerId = 'runner_service_default',
    } = options;

    const canonicalScopeKey = generateCanonicalScopeKey(options);
    const ttlSeconds = getScopeLeaseTtlSeconds(runType);
    const heartbeatIntervalMs = getScopeHeartbeatIntervalMs(runType);

    // 1. Claim run via atomic RPC (atomic scope serialization + empty-set race protection)
    let claimResult: any;
    try {
      const { data, error } = await (supabase as any).rpc('claim_reconciliation_run_atomic', {
        p_run_type: runType,
        p_organization_id: organizationId || null,
        p_provider_account_id: providerAccountId || null,
        p_targeted_entity_type: targetedEntityType || null,
        p_targeted_entity_id: targetedEntityId || null,
        p_worker_id: workerId,
        p_lease_ttl_seconds: ttlSeconds,
        p_scope_metadata: { environment: options.environment || 'test' },
      });

      if (error) {
        throw new Error(`RPC error claiming run: ${error.message}`);
      }

      claimResult = data;
    } catch (claimErr: any) {
      console.error('[FinancialReconciliationRunnerService] Claim RPC exception:', claimErr.message);
      return {
        runId: null,
        status: 'failed',
        reason: claimErr.message,
        summaryCounts: { totalInspected: 0, findingsOpen: 0, findingsResolved: 0 },
      };
    }

    if (!claimResult || !claimResult.claimed) {
      console.log(`[FinancialReconciliationRunnerService] Run claim skipped for scope ${canonicalScopeKey}: ${claimResult?.reason}`);
      return {
        runId: claimResult?.active_run_id || null,
        status: 'skipped',
        reason: claimResult?.reason || 'ACTIVE_LEASE_EXISTS',
        summaryCounts: { totalInspected: 0, findingsOpen: 0, findingsResolved: 0 },
      };
    }

    const runId: string = claimResult.run_id;
    const leaseToken: string = claimResult.lease_token;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let isFencedOut = false;

    // 2. Start Background Lease Heartbeat Timer
    heartbeatTimer = setInterval(async () => {
      if (isFencedOut) return;

      try {
        const { data: renewData, error: renewErr } = await (supabase as any).rpc(
          'renew_reconciliation_lease_atomic',
          {
            p_run_id: runId,
            p_lease_token: leaseToken,
            p_lease_ttl_seconds: ttlSeconds,
          }
        );

        if (renewErr || !renewData?.renewed) {
          console.warn(
            `[FinancialReconciliationRunnerService] Lease heartbeat failed for run ${runId}:`,
            renewData?.reason || renewErr?.message
          );
          isFencedOut = true;
          if (heartbeatTimer) clearInterval(heartbeatTimer);
        }
      } catch (hbErr: any) {
        console.warn(`[FinancialReconciliationRunnerService] Lease heartbeat exception for run ${runId}:`, hbErr.message);
      }
    }, heartbeatIntervalMs);

    // 3. Execute Engine Modules with Pre-Claimed Run & Fencing Token
    try {
      const runResult = await this.engine.executeRun(supabase, {
        ...options,
        runId,
        leaseToken,
      });

      return {
        runId: runResult.runId,
        status: runResult.status,
        summaryCounts: runResult.summaryCounts,
        moduleCoverage: runResult.moduleCoverage,
      };
    } catch (engineErr: any) {
      console.error(`[FinancialReconciliationRunnerService] Run ${runId} execution error:`, engineErr.message);

      // Transition run to failed if not already completed
      await (supabase as any)
        .from('billing_reconciliation_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_info: { message: engineErr.message, stack: engineErr.stack },
        })
        .eq('id', runId);

      return {
        runId,
        status: 'failed',
        reason: engineErr.message,
        summaryCounts: { totalInspected: 0, findingsOpen: 0, findingsResolved: 0 },
      };
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
    }
  }
}
