/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  BackfillDryRunSummary,
  BackfillPlanItem,
} from './types';
import { BackfillClassifier, RawLegacyRecordContext } from './backfillClassifier';

export interface BackfillEngineOptions {
  batchSize?: number;
  faultInjectionCrashPercent?: number; // 25, 50, 75
  workerToken?: string;
}

export class CanonicalBackfillEngine {
  constructor(private readonly clientOverride?: SupabaseClient | any) {}

  private getClient(): SupabaseClient | any {
    return this.clientOverride || createAdminClient();
  }

  /**
   * TASK 17: DRY RUN MODE
   * Discovers all legacy phone records, classifies them, and produces a complete
   * dry-run summary with ZERO mutations to canonical or provider tables.
   */
  async executeDryRun(organizationId?: string): Promise<BackfillDryRunSummary> {
    const supabase = this.getClient();

    let query = (supabase as any).from('phone_numbers').select('*');
    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const { data: phoneRows, error } = await query;
    if (error) {
      throw new Error(`Failed to query phone_numbers for dry run: ${error.message}`);
    }

    const items: BackfillPlanItem[] = [];
    let plannedInserts = 0;
    let plannedUpdates = 0;
    let noOps = 0;
    let manualReviewRequired = 0;
    let providerReconcileRequired = 0;
    let protectedResources = 0;
    let conflicts = 0;

    for (const phone of phoneRows || []) {
      const e164 = phone.phone_number || phone.phone_number_e164;

      // 1. Fetch lifecycle state row
      const { data: lifecycleState } = await (supabase as any)
        .from('phone_number_lifecycle_states')
        .select('*')
        .eq('phone_number_id', phone.id)
        .maybeSingle();

      // 2. Fetch provider mapping
      const { data: providerMapping } = await (supabase as any)
        .from('number_provider_mappings')
        .select('*')
        .eq('phone_number_id', phone.id)
        .maybeSingle();

      // 3. Fetch provider resource record
      const { data: providerResource } = await (supabase as any)
        .from('telecom_provider_resource_records')
        .select('*')
        .eq('phone_number_e164', e164)
        .maybeSingle();

      // 4. Fetch provider account
      const accountId = providerResource?.provider_account_id || phone.provider_account_id;
      let providerAccount: any = null;
      if (accountId) {
        const { data: acc } = await (supabase as any)
          .from('telecom_provider_accounts')
          .select('*')
          .eq('id', accountId)
          .maybeSingle();
        providerAccount = acc;
      }

      // 5. Fetch user assignments
      const { data: assignments } = await (supabase as any)
        .from('user_phone_assignments')
        .select('*')
        .eq('phone_number_id', phone.id);

      // Check user existence if assignment exists
      let userExists: boolean | undefined = undefined;
      let userOrgId: string | undefined = undefined;
      if (assignments && assignments.length === 1) {
        const { data: profile } = await (supabase as any)
          .from('profiles')
          .select('id, organization_id, active')
          .eq('id', assignments[0].user_id)
          .maybeSingle();
        userExists = Boolean(profile);
        userOrgId = profile?.organization_id;
      }

      // 6. Check IVR existence if routing is IVR
      let ivrExists: boolean | undefined = undefined;
      if (phone.inbound_routing_type === 'ivr' && phone.inbound_routing_destination_id) {
        const { data: ivr } = await (supabase as any)
          .from('ivr_menus')
          .select('id')
          .eq('id', phone.inbound_routing_destination_id)
          .maybeSingle();
        ivrExists = Boolean(ivr);
      }

      // 7. Check for duplicate active E.164s
      const { data: sameE164 } = await (supabase as any)
        .from('phone_numbers')
        .select('id, phone_number, status, active')
        .eq('phone_number', e164)
        .eq('status', 'active');

      // 8. Check for duplicate carrier SIDs
      let sameSid: any[] | null = null;
      const sid = providerResource?.remote_resource_id || providerMapping?.provider_phone_number_sid;
      if (sid) {
        const { data: sidMatches } = await (supabase as any)
          .from('number_provider_mappings')
          .select('id, phone_number_id, provider_phone_number_sid')
          .eq('provider_phone_number_sid', sid);
        sameSid = sidMatches;
      }

      // 9. Check in-flight port operations
      const { data: activePort } = await (supabase as any)
        .from('number_port_operations')
        .select('*')
        .eq('phone_number_e164', e164)
        .in('status', ['requested', 'submitted', 'foc_received'])
        .maybeSingle();

      const ctx: RawLegacyRecordContext = {
        phoneNumberRow: phone,
        lifecycleStateRow: lifecycleState,
        providerMappingRow: providerMapping,
        providerResourceRow: providerResource,
        providerAccountRow: providerAccount,
        userAssignments: assignments || [],
        allActiveNumbersWithSameE164: sameE164 || [],
        allActiveNumbersWithSameSid: sameSid || [],
        ivrExists,
        userExists,
        userOrgId,
        activePortOp: activePort,
      };

      const planItem = BackfillClassifier.classifyRecord(ctx);
      items.push(planItem);

      if (planItem.plannedAction === 'INSERT_CANONICAL') plannedInserts++;
      else if (planItem.plannedAction === 'UPDATE_CANONICAL') plannedUpdates++;
      else if (planItem.plannedAction === 'NO_OP') noOps++;
      else if (planItem.plannedAction === 'QUARANTINE_NO_OP') {
        protectedResources++;
        noOps++;
      } else if (planItem.plannedAction === 'MANUAL_REVIEW') {
        manualReviewRequired++;
        conflicts++;
      } else if (planItem.plannedAction === 'PROVIDER_RECONCILE') {
        providerReconcileRequired++;
      }
    }

    return {
      totalDiscovered: items.length,
      plannedInserts,
      plannedUpdates,
      noOps,
      manualReviewRequired,
      providerReconcileRequired,
      protectedResources,
      conflicts,
      items,
    };
  }

  /**
   * TASK 16 & 18: PERSIST BACKFILL PLAN
   * Stores the dry-run plan items into `telecom_number_backfill_plans` for subsequent
   * atomic worker processing and operator inspection.
   */
  async persistPlan(items: BackfillPlanItem[]): Promise<{ insertedCount: number }> {
    const supabase = this.getClient();
    let inserted = 0;

    for (const item of items) {
      const { error } = await (supabase as any)
        .from('telecom_number_backfill_plans')
        .upsert(
          {
            organization_id: item.organizationId,
            phone_number_id: item.phoneNumberId || null,
            phone_number_e164: item.phoneNumberE164,
            source_evidence: item.sourceEvidence,
            target_canonical_state: item.targetCanonicalState,
            classification: item.classification,
            confidence_score: item.confidenceScore,
            evidence_reason: item.evidenceReason,
            planned_action: item.plannedAction,
            status: 'PLANNED',
            source_version_hash: item.sourceVersionHash,
          },
          { onConflict: 'organization_id, phone_number_e164, source_version_hash' }
        );

      if (!error) {
        inserted++;
      }
    }

    return { insertedCount: inserted };
  }

  /**
   * TASK 19, 20, 21, 22: ATOMIC BATCH APPLY WITH CONCURRENCY & FAULT INJECTION
   * Claims and applies planned items. Safe against concurrent workers and crash recovery.
   */
  async applyPlannedBatch(options?: BackfillEngineOptions): Promise<{
    processedCount: number;
    appliedCount: number;
    staleCount: number;
    skippedCount: number;
    crashedEarly: boolean;
  }> {
    const supabase = this.getClient();
    const batchSize = options?.batchSize || 10;
    const workerToken = options?.workerToken || `worker_${crypto.randomUUID()}`;
    const crashPercent = options?.faultInjectionCrashPercent;

    // 1. Claim batch atomically using Postgres SKIP LOCKED function
    const { data: claimedRows, error: claimErr } = await (supabase as any).rpc(
      'claim_backfill_plan_batch',
      {
        p_worker_token: workerToken,
        p_batch_size: batchSize,
      }
    );

    if (claimErr) {
      throw new Error(`Failed to claim backfill plan batch: ${claimErr.message}`);
    }

    const items = claimedRows || [];
    let appliedCount = 0;
    let staleCount = 0;
    let skippedCount = 0;
    let crashedEarly = false;

    const crashThreshold = crashPercent
      ? Math.max(1, Math.floor((items.length * crashPercent) / 100))
      : null;

    let processedSoFar = 0;
    for (const item of items) {
      if (crashThreshold !== null && processedSoFar >= crashThreshold) {
        crashedEarly = true;
        // Release remaining unapplied claims from this batch so resumed worker can claim them immediately
        for (let idx = processedSoFar; idx < items.length; idx++) {
          const rem = items[idx];
          await (supabase as any)
            .from('telecom_number_backfill_plans')
            .update({ status: 'PLANNED', claim_token: null })
            .eq('id', rem.plan_id || rem.id);
        }
        break; // Simulate process crash
      }

      const { data: applyResult, error: applyErr } = await (supabase as any).rpc(
        'apply_canonical_number_backfill_atomic',
        {
          p_plan_id: item.plan_id || item.id,
          p_worker_token: workerToken,
        }
      );

      processedSoFar++;

      if (applyErr) {
        continue;
      }

      if (applyResult?.success) {
        if (applyResult.action === 'MANUAL_REVIEW' || applyResult.action === 'PROVIDER_RECONCILE') {
          skippedCount++;
        } else {
          appliedCount++;
        }
      } else if (applyResult?.error === 'SOURCE_CHANGED_SINCE_PLAN') {
        staleCount++;
      }
    }

    return {
      processedCount: processedSoFar,
      appliedCount,
      staleCount,
      skippedCount,
      crashedEarly,
    };
  }
}
