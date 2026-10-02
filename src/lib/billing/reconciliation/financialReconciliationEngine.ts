import { SupabaseClient } from '@supabase/supabase-js';
import { IStripeReconciliationAdapter, StripeReconciliationAdapter } from './stripeReconciliationAdapter';
import { generateFindingFingerprint, generateEvidenceHash } from './reconciliationFingerprint';
import { ReconciliationGraceWindowConfigurator } from './reconciliationGraceWindows';
import { ProviderAccountResolver } from '../providers/providerAccountResolver';
import {
  ReconciliationRunType,
  ReconciliationRunStatus,
  FindingCategory,
  FindingSeverity,
  TargetEntityType,
  RunModuleCoverage,
  RunSummaryCounts,
  ReconciliationFingerprintInput,
  StripePaymentIntentSnapshot,
  StripeRefundSnapshot,
  StripeDisputeSnapshot,
} from './reconciliationTypes';

export interface ExecuteReconciliationOptions {
  runType: ReconciliationRunType;
  organizationId?: string;
  providerAccountId?: string;
  targetedEntityType?: TargetEntityType;
  targetedEntityId?: string;
  customAdapter?: IStripeReconciliationAdapter;
  customGraceConfigurator?: ReconciliationGraceWindowConfigurator;
  environment?: 'test' | 'live';
  runId?: string;
  leaseToken?: string;
}

export interface DiscrepancyObservationDraft {
  category: FindingCategory;
  severity: FindingSeverity;
  organizationId: string;
  providerAccountId: string | null;
  targetEntityType: TargetEntityType;
  targetEntityId: string;
  stableDiscriminator?: string;
  evidenceJson: Record<string, any>;
}

export class FinancialReconciliationEngine {
  private adapter: IStripeReconciliationAdapter;
  private graceConfigurator: ReconciliationGraceWindowConfigurator;

  constructor(
    adapter: IStripeReconciliationAdapter = new StripeReconciliationAdapter(),
    graceConfigurator: ReconciliationGraceWindowConfigurator = new ReconciliationGraceWindowConfigurator()
  ) {
    this.adapter = adapter;
    this.graceConfigurator = graceConfigurator;
  }

  /**
   * Executes a safe, non-mutating financial reconciliation run.
   * WRITES ONLY TO: billing_reconciliation_runs, billing_reconciliation_findings, billing_reconciliation_finding_observations.
   * ZERO FINANCIAL BUSINESS STATE MUTATIONS.
   */
  async executeRun(
    supabase: SupabaseClient,
    options: ExecuteReconciliationOptions
  ): Promise<{
    runId: string;
    status: ReconciliationRunStatus;
    summaryCounts: RunSummaryCounts;
    moduleCoverage: RunModuleCoverage;
  }> {
    const {
      runType,
      organizationId,
      providerAccountId,
      targetedEntityType,
      targetedEntityId,
      environment = 'test',
    } = options;

    if (options.customAdapter) {
      this.adapter = options.customAdapter;
    }
    if (options.customGraceConfigurator) {
      this.graceConfigurator = options.customGraceConfigurator;
    }

    // 1. Scope Validation
    if (runType === 'organization' && (!organizationId || !organizationId.trim())) {
      throw new Error('RECON_ENGINE_ERROR: organizationId is required for organization-scoped run.');
    }
    if (runType === 'provider_account' && (!providerAccountId || !providerAccountId.trim())) {
      throw new Error('RECON_ENGINE_ERROR: providerAccountId is required for provider_account-scoped run.');
    }
    if (runType === 'targeted' && (!targetedEntityType || !targetedEntityId)) {
      throw new Error('RECON_ENGINE_ERROR: targetedEntityType and targetedEntityId are required for targeted run.');
    }

    const initialCoverage: RunModuleCoverage = {
      eligibleForResolution: true,
      modules: {
        payments: { inspected: false, status: 'skipped', itemsInspected: 0 },
        refunds: { inspected: false, status: 'skipped', itemsInspected: 0 },
        disputes: { inspected: false, status: 'skipped', itemsInspected: 0 },
        walletLedger: { inspected: false, status: 'skipped', itemsInspected: 0 },
      },
    };

    const initialCounts: RunSummaryCounts = {
      totalInspected: 0,
      findingsOpen: 0,
      findingsResolved: 0,
    };

    let runId: string;

    if (options.runId && options.runId.trim()) {
      runId = options.runId.trim();
    } else {
      // Create Run Record in billing_reconciliation_runs if not pre-claimed
      const scopeMetadata = {
        runType,
        organizationId: organizationId || null,
        providerAccountId: providerAccountId || null,
        targetedEntityType: targetedEntityType || null,
        targetedEntityId: targetedEntityId || null,
        environment,
      };

      const { data: runRecord, error: runErr } = await (supabase as any)
        .from('billing_reconciliation_runs')
        .insert({
          run_type: runType,
          organization_id: organizationId || null,
          provider_account_id: providerAccountId || null,
          status: 'running',
          module_coverage: initialCoverage,
          summary_counts: initialCounts,
          scope_metadata: scopeMetadata,
        })
        .select('id')
        .single();

      if (runErr || !runRecord) {
        console.error('[FinancialReconciliationEngine] Failed to create run record:', runErr?.message);
        throw new Error(`RECON_ENGINE_ERROR: Failed to create run record: ${runErr?.message}`);
      }

      runId = runRecord.id;
    }
    let runStatus: ReconciliationRunStatus = 'completed';
    const detectedDiscrepancies: DiscrepancyObservationDraft[] = [];
    const activeObservedFingerprints = new Set<string>();
    let overallInspectedCount = 0;
    let errorInfo: Record<string, any> = {};

    try {
      // 3. Execute Module 1: Payment Reconciliation
      const payRes = await this.reconcilePayments(supabase, options);
      initialCoverage.modules.payments = {
        inspected: payRes.inspected,
        status: payRes.status,
        itemsInspected: payRes.count,
        error: payRes.error,
      };
      overallInspectedCount += payRes.count;
      detectedDiscrepancies.push(...payRes.discrepancies);
      if (!payRes.eligibleForResolution) {
        initialCoverage.eligibleForResolution = false;
      }

      // 4. Execute Module 2: Refund Reconciliation
      const refRes = await this.reconcileRefunds(supabase, options);
      initialCoverage.modules.refunds = {
        inspected: refRes.inspected,
        status: refRes.status,
        itemsInspected: refRes.count,
        error: refRes.error,
      };
      overallInspectedCount += refRes.count;
      detectedDiscrepancies.push(...refRes.discrepancies);
      if (!refRes.eligibleForResolution) {
        initialCoverage.eligibleForResolution = false;
      }

      // 5. Execute Module 3: Dispute Reconciliation
      const disRes = await this.reconcileDisputes(supabase, options);
      initialCoverage.modules.disputes = {
        inspected: disRes.inspected,
        status: disRes.status,
        itemsInspected: disRes.count,
        error: disRes.error,
      };
      overallInspectedCount += disRes.count;
      detectedDiscrepancies.push(...disRes.discrepancies);
      if (!disRes.eligibleForResolution) {
        initialCoverage.eligibleForResolution = false;
      }

      // 6. Execute Module 4: Wallet & Ledger Conservation
      const walRes = await this.reconcileWalletLedger(supabase, options);
      initialCoverage.modules.walletLedger = {
        inspected: walRes.inspected,
        status: walRes.status,
        itemsInspected: walRes.count,
        error: walRes.error,
      };
      overallInspectedCount += walRes.count;
      detectedDiscrepancies.push(...walRes.discrepancies);
      if (!walRes.eligibleForResolution) {
        initialCoverage.eligibleForResolution = false;
      }

      // Check if any module failed
      const hasFailedModule = Object.values(initialCoverage.modules).some((m) => m?.status === 'failed');
      if (hasFailedModule) {
        runStatus = 'partial';
      }
    } catch (engineErr: any) {
      console.error('[FinancialReconciliationEngine] Fatal run exception:', engineErr.message);
      runStatus = 'failed';
      initialCoverage.eligibleForResolution = false;
      errorInfo = { message: engineErr.message, stack: engineErr.stack };
    }

    // 7. Record Discrepancies (Upsert Findings & Insert Immutable Observations)
    let openFindingsCount = 0;
    for (const draft of detectedDiscrepancies) {
      const fingerprint = generateFindingFingerprint({
        category: draft.category,
        organizationId: draft.organizationId,
        providerAccountId: draft.providerAccountId,
        targetEntityType: draft.targetEntityType,
        targetEntityId: draft.targetEntityId,
        stableDiscriminator: draft.stableDiscriminator || 'default',
      });

      activeObservedFingerprints.add(fingerprint);

      await this.recordFindingAndObservation(supabase, runId, draft, fingerprint);
      openFindingsCount++;
    }

    // 8. Safe Resolution Evaluation
    let resolvedFindingsCount = 0;
    if (initialCoverage.eligibleForResolution && runStatus === 'completed') {
      resolvedFindingsCount = await this.evaluateResolutions(
        supabase,
        options,
        activeObservedFingerprints
      );
    }

    // 9. Finalize Run Record
    const finalCounts: RunSummaryCounts = {
      totalInspected: overallInspectedCount,
      findingsOpen: openFindingsCount,
      findingsResolved: resolvedFindingsCount,
    };

    await (supabase as any)
      .from('billing_reconciliation_runs')
      .update({
        status: runStatus,
        completed_at: new Date().toISOString(),
        module_coverage: initialCoverage,
        summary_counts: finalCounts,
        error_info: errorInfo,
      })
      .eq('id', runId);

    return {
      runId,
      status: runStatus,
      summaryCounts: finalCounts,
      moduleCoverage: initialCoverage,
    };
  }

  /**
   * Payment Reconciliation Module
   */
  private async reconcilePayments(
    supabase: SupabaseClient,
    options: ExecuteReconciliationOptions
  ): Promise<{
    inspected: boolean;
    status: 'completed' | 'failed' | 'skipped';
    count: number;
    eligibleForResolution: boolean;
    discrepancies: DiscrepancyObservationDraft[];
    error?: string;
  }> {
    const discrepancies: DiscrepancyObservationDraft[] = [];
    let count = 0;
    let eligibleForResolution = true;

    try {
      let query = (supabase as any).from('billing_payment_operations').select('*');
      if (options.organizationId) {
        query = query.eq('organization_id', options.organizationId);
      }
      if (options.providerAccountId) {
        query = query.eq('provider_account_id', options.providerAccountId);
      }
      if (options.targetedEntityType === 'payment_operation' && options.targetedEntityId) {
        query = query.eq('id', options.targetedEntityId);
      }

      const { data: operations, error } = await query;
      if (error) {
        throw new Error(`DB error fetching payment operations: ${error.message}`);
      }

      const opsList = operations || [];
      count = opsList.length;

      for (const op of opsList) {
        // Grace window checks
        const isGracePending = this.graceConfigurator.isWithinGraceWindow('STALE_PENDING_PAYMENT', op.created_at);
        const isGracePaidNotCaptured = this.graceConfigurator.isWithinGraceWindow('PAID_NOT_CAPTURED', op.created_at);
        const isGracePaidNotFunded = this.graceConfigurator.isWithinGraceWindow('PAID_NOT_FUNDED', op.created_at);

        // Check Stale Pending
        if (op.status === 'pending' && !isGracePending) {
          discrepancies.push({
            category: 'STALE_PENDING_PAYMENT',
            severity: 'warning',
            organizationId: op.organization_id,
            providerAccountId: op.provider_account_id,
            targetEntityType: 'payment_operation',
            targetEntityId: op.id,
            evidenceJson: {
              operationId: op.id,
              status: op.status,
              createdAt: op.created_at,
              amountMinor: op.amount_minor,
              providerPaymentId: op.provider_payment_id,
            },
          });
        }

        // Query Stripe if provider_payment_id exists
        if (op.provider_payment_id) {
          try {
            const stripePi: StripePaymentIntentSnapshot | null = await this.adapter.getPaymentIntentState({
              supabase,
              providerAccountId: op.provider_account_id,
              environment: options.environment || 'test',
              paymentIntentId: op.provider_payment_id,
            });

            if (!stripePi) {
              // Provider payment 404
              discrepancies.push({
                category: 'PROVIDER_PAYMENT_NOT_FOUND',
                severity: 'warning',
                organizationId: op.organization_id,
                providerAccountId: op.provider_account_id,
                targetEntityType: 'payment_operation',
                targetEntityId: op.id,
                evidenceJson: {
                  operationId: op.id,
                  providerPaymentId: op.provider_payment_id,
                },
              });
            } else {
              // Check Paid Not Captured / Local Captured No Provider Success
              if (stripePi.status === 'succeeded' && op.status !== 'captured' && !isGracePaidNotCaptured) {
                discrepancies.push({
                  category: 'PAID_NOT_CAPTURED',
                  severity: 'warning',
                  organizationId: op.organization_id,
                  providerAccountId: op.provider_account_id,
                  targetEntityType: 'payment_operation',
                  targetEntityId: op.id,
                  evidenceJson: {
                    operationId: op.id,
                    localStatus: op.status,
                    providerStatus: stripePi.status,
                    providerPaymentId: op.provider_payment_id,
                  },
                });
              }

              if (op.status === 'captured' && stripePi.status !== 'succeeded') {
                discrepancies.push({
                  category: 'LOCAL_CAPTURED_NO_PROVIDER_SUCCESS',
                  severity: 'financial_risk',
                  organizationId: op.organization_id,
                  providerAccountId: op.provider_account_id,
                  targetEntityType: 'payment_operation',
                  targetEntityId: op.id,
                  evidenceJson: {
                    operationId: op.id,
                    localStatus: op.status,
                    providerStatus: stripePi.status,
                    providerPaymentId: op.provider_payment_id,
                  },
                });
              }

              // Amount / Currency Mismatches
              const expectedGross = op.gross_charge_minor ?? op.amount_minor;
              if (stripePi.status === 'succeeded' && stripePi.amountReceivedMinor !== expectedGross) {
                discrepancies.push({
                  category: 'PAYMENT_AMOUNT_MISMATCH',
                  severity: 'warning',
                  organizationId: op.organization_id,
                  providerAccountId: op.provider_account_id,
                  targetEntityType: 'payment_operation',
                  targetEntityId: op.id,
                  evidenceJson: {
                    operationId: op.id,
                    localGrossMinor: expectedGross,
                    providerReceivedMinor: stripePi.amountReceivedMinor,
                  },
                });
              }

              if (stripePi.currency !== op.currency) {
                discrepancies.push({
                  category: 'PAYMENT_CURRENCY_MISMATCH',
                  severity: 'warning',
                  organizationId: op.organization_id,
                  providerAccountId: op.provider_account_id,
                  targetEntityType: 'payment_operation',
                  targetEntityId: op.id,
                  evidenceJson: {
                    operationId: op.id,
                    localCurrency: op.currency,
                    providerCurrency: stripePi.currency,
                  },
                });
              }
            }
          } catch (stripeErr: any) {
            console.warn(`[ReconciliationEngine] Payment ${op.id} Stripe query exception:`, stripeErr.message);
            eligibleForResolution = false;
            if (stripeErr.message.includes('PROVIDER_CREDENTIALS_UNAVAILABLE')) {
              discrepancies.push({
                category: 'PROVIDER_CREDENTIALS_UNAVAILABLE',
                severity: 'warning',
                organizationId: op.organization_id,
                providerAccountId: op.provider_account_id,
                targetEntityType: 'provider_account',
                targetEntityId: op.provider_account_id,
                evidenceJson: { message: stripeErr.message },
              });
            } else {
              discrepancies.push({
                category: 'PROVIDER_STATE_UNKNOWN',
                severity: 'informational',
                organizationId: op.organization_id,
                providerAccountId: op.provider_account_id,
                targetEntityType: 'payment_operation',
                targetEntityId: op.id,
                evidenceJson: { message: stripeErr.message },
              });
            }
          }
        }

        // Check Credit Grant Invariant in billing_credit_ledger
        if (op.status === 'captured') {
          const { data: grants } = await (supabase as any)
            .from('billing_credit_ledger')
            .select('id, amount_minor')
            .eq('organization_id', op.organization_id)
            .eq('reference_type', 'payment_operation')
            .eq('reference_id', op.id)
            .eq('entry_type', 'grant');

          const grantList = grants || [];
          if (grantList.length === 0 && !isGracePaidNotFunded) {
            discrepancies.push({
              category: 'PAID_NOT_FUNDED',
              severity: 'financial_risk',
              organizationId: op.organization_id,
              providerAccountId: op.provider_account_id,
              targetEntityType: 'payment_operation',
              targetEntityId: op.id,
              evidenceJson: {
                operationId: op.id,
                status: op.status,
                creditValueMinor: op.credit_value_minor ?? op.amount_minor,
              },
            });
          } else if (grantList.length > 1) {
            discrepancies.push({
              category: 'DUPLICATE_CREDIT_GRANT',
              severity: 'critical',
              organizationId: op.organization_id,
              providerAccountId: op.provider_account_id,
              targetEntityType: 'payment_operation',
              targetEntityId: op.id,
              evidenceJson: {
                operationId: op.id,
                grantCount: grantList.length,
                grantIds: grantList.map((g: any) => g.id),
              },
            });
          }
        }
      }

      return {
        inspected: true,
        status: 'completed',
        count,
        eligibleForResolution,
        discrepancies,
      };
    } catch (err: any) {
      return {
        inspected: true,
        status: 'failed',
        count,
        eligibleForResolution: false,
        discrepancies,
        error: err.message,
      };
    }
  }

  /**
   * Refund Reconciliation Module
   */
  private async reconcileRefunds(
    supabase: SupabaseClient,
    options: ExecuteReconciliationOptions
  ): Promise<{
    inspected: boolean;
    status: 'completed' | 'failed' | 'skipped';
    count: number;
    eligibleForResolution: boolean;
    discrepancies: DiscrepancyObservationDraft[];
    error?: string;
  }> {
    const discrepancies: DiscrepancyObservationDraft[] = [];
    let count = 0;
    let eligibleForResolution = true;

    try {
      let query = (supabase as any).from('billing_payment_refunds').select('*');
      if (options.organizationId) {
        query = query.eq('organization_id', options.organizationId);
      }
      if (options.providerAccountId) {
        query = query.eq('provider_account_id', options.providerAccountId);
      }

      const { data: refunds, error } = await query;
      if (error) {
        throw new Error(`DB error fetching refunds: ${error.message}`);
      }

      const refList = refunds || [];
      count = refList.length;

      for (const ref of refList) {
        // Fetch payment operation economics
        const { data: op } = await (supabase as any)
          .from('billing_payment_operations')
          .select('*')
          .eq('id', ref.payment_operation_id)
          .single();

        if (op) {
          // Check cumulative cash refunds vs gross charge
          const { data: allRefunds } = await (supabase as any)
            .from('billing_payment_refunds')
            .select('amount_minor')
            .eq('payment_operation_id', op.id)
            .eq('status', 'succeeded');

          const totalCashRefundedMinor = (allRefunds || []).reduce((acc: number, r: any) => acc + Number(r.amount_minor), 0);
          const grossChargeMinor = Number(op.gross_charge_minor ?? op.amount_minor);

          if (totalCashRefundedMinor > grossChargeMinor) {
            discrepancies.push({
              category: 'REFUND_EXCEEDS_PAYMENT_GROSS',
              severity: 'critical',
              organizationId: ref.organization_id,
              providerAccountId: ref.provider_account_id,
              targetEntityType: 'payment_operation',
              targetEntityId: op.id,
              evidenceJson: {
                paymentOperationId: op.id,
                grossChargeMinor,
                totalCashRefundedMinor,
              },
            });
          }

          // Authoritative Cumulative Rounding Formula: target_cumulative_credit_reversal
          const creditValueMinor = Number(op.credit_value_minor ?? op.amount_minor);
          const targetCumulativeReversal = Number(
            (BigInt(totalCashRefundedMinor) * BigInt(creditValueMinor)) / BigInt(grossChargeMinor || 1)
          );

          // Fetch actual cumulative ledger reversals
          const { data: reversals } = await (supabase as any)
            .from('billing_credit_ledger')
            .select('amount_minor')
            .eq('organization_id', op.organization_id)
            .eq('reference_type', 'payment_operation')
            .eq('reference_id', op.id)
            .eq('entry_type', 'reversal');

          const actualCumulativeReversal = (reversals || []).reduce((acc: number, rev: any) => acc + Math.abs(Number(rev.amount_minor)), 0);

          if (ref.status === 'succeeded' && actualCumulativeReversal < targetCumulativeReversal) {
            discrepancies.push({
              category: 'REFUND_WITHOUT_CREDIT_REVERSAL',
              severity: 'financial_risk',
              organizationId: ref.organization_id,
              providerAccountId: ref.provider_account_id,
              targetEntityType: 'payment_refund',
              targetEntityId: ref.id,
              evidenceJson: {
                refundId: ref.id,
                totalCashRefundedMinor,
                targetCumulativeReversal,
                actualCumulativeReversal,
              },
            });
          }
        }
      }

      // Check for approved unexecuted refunds
      const { data: approvedReqs } = await (supabase as any)
        .from('billing_refund_requests')
        .select('*')
        .eq('status', 'approved');

      for (const req of approvedReqs || []) {
        if (!this.graceConfigurator.isWithinGraceWindow('APPROVED_REFUND_UNEXECUTED', req.updated_at || req.created_at)) {
          discrepancies.push({
            category: 'APPROVED_REFUND_UNEXECUTED',
            severity: 'financial_risk',
            organizationId: req.organization_id,
            providerAccountId: options.providerAccountId || ProviderAccountResolver.DEFAULT_TEST_ACCOUNT_ID,
            targetEntityType: 'refund_request',
            targetEntityId: req.id,
            evidenceJson: {
              requestId: req.id,
              status: req.status,
              approvedAmountMinor: req.approved_amount_minor,
              approvedAt: req.updated_at,
            },
          });
        }
      }

      return {
        inspected: true,
        status: 'completed',
        count,
        eligibleForResolution,
        discrepancies,
      };
    } catch (err: any) {
      return {
        inspected: true,
        status: 'failed',
        count,
        eligibleForResolution: false,
        discrepancies,
        error: err.message,
      };
    }
  }

  /**
   * Dispute Reconciliation Module
   */
  private async reconcileDisputes(
    supabase: SupabaseClient,
    options: ExecuteReconciliationOptions
  ): Promise<{
    inspected: boolean;
    status: 'completed' | 'failed' | 'skipped';
    count: number;
    eligibleForResolution: boolean;
    discrepancies: DiscrepancyObservationDraft[];
    error?: string;
  }> {
    const discrepancies: DiscrepancyObservationDraft[] = [];
    let count = 0;
    let eligibleForResolution = true;

    try {
      let query = (supabase as any).from('billing_payment_disputes').select('*');
      if (options.organizationId) {
        query = query.eq('organization_id', options.organizationId);
      }
      if (options.providerAccountId) {
        query = query.eq('provider_account_id', options.providerAccountId);
      }

      const { data: disputes, error } = await query;
      if (error) {
        throw new Error(`DB error fetching disputes: ${error.message}`);
      }

      const disList = disputes || [];
      count = disList.length;

      for (const dis of disList) {
        const isGraceHold = this.graceConfigurator.isWithinGraceWindow('DISPUTE_HOLD_MISSING', dis.created_at);

        // Check active financial hold
        const { data: holds } = await (supabase as any)
          .from('billing_financial_holds')
          .select('*')
          .eq('reference_id', dis.provider_dispute_id);

        const hold = (holds || [])[0];

        if (['needs_response', 'under_review'].includes(dis.status)) {
          if (!hold && !isGraceHold) {
            discrepancies.push({
              category: 'DISPUTE_HOLD_MISSING',
              severity: 'financial_risk',
              organizationId: dis.organization_id,
              providerAccountId: dis.provider_account_id,
              targetEntityType: 'payment_dispute',
              targetEntityId: dis.id,
              evidenceJson: {
                disputeId: dis.id,
                providerDisputeId: dis.provider_dispute_id,
                status: dis.status,
              },
            });
          }
        }

        if (dis.status === 'won' && hold && hold.status === 'active') {
          discrepancies.push({
            category: 'DISPUTE_WON_HOLD_UNRELEASED',
            severity: 'warning',
            organizationId: dis.organization_id,
            providerAccountId: dis.provider_account_id,
            targetEntityType: 'payment_dispute',
            targetEntityId: dis.id,
            evidenceJson: {
              disputeId: dis.id,
              holdId: hold.id,
              holdStatus: hold.status,
            },
          });
        }

        // Lost dispute invariant: dispute_amount_minor = ledger_reversal_minor + debt_created_minor
        if (dis.status === 'lost') {
          const disputeAmountMinor = Number(dis.amount_minor);

          // Find ledger reversal for this payment operation
          const { data: reversals } = await (supabase as any)
            .from('billing_credit_ledger')
            .select('amount_minor')
            .eq('organization_id', dis.organization_id)
            .eq('reference_type', 'payment_operation')
            .eq('reference_id', dis.payment_operation_id)
            .eq('entry_type', 'reversal');

          const ledgerReversalMinor = (reversals || []).reduce((acc: number, r: any) => acc + Math.abs(Number(r.amount_minor)), 0);

          // Find account debt created
          const { data: debts } = await (supabase as any)
            .from('billing_account_debts')
            .select('original_amount_minor')
            .eq('organization_id', dis.organization_id)
            .eq('reference_type', 'dispute_lost_uncovered')
            .eq('reference_id', dis.provider_dispute_id);

          const debtMinor = (debts || []).reduce((acc: number, d: any) => acc + Number(d.original_amount_minor), 0);

          const totalAccountedLostMinor = ledgerReversalMinor + debtMinor;

          if (totalAccountedLostMinor < disputeAmountMinor) {
            discrepancies.push({
              category: 'DISPUTE_LOST_HOLD_UNSETTLED',
              severity: 'critical',
              organizationId: dis.organization_id,
              providerAccountId: dis.provider_account_id,
              targetEntityType: 'payment_dispute',
              targetEntityId: dis.id,
              evidenceJson: {
                disputeId: dis.id,
                disputeAmountMinor,
                ledgerReversalMinor,
                debtMinor,
                totalAccountedLostMinor,
              },
            });
          }
        }
      }

      return {
        inspected: true,
        status: 'completed',
        count,
        eligibleForResolution,
        discrepancies,
      };
    } catch (err: any) {
      return {
        inspected: true,
        status: 'failed',
        count,
        eligibleForResolution: false,
        discrepancies,
        error: err.message,
      };
    }
  }

  /**
   * Wallet & Ledger Conservation Module
   * Provider-Neutral Organization Balance Invariant Check.
   */
  private async reconcileWalletLedger(
    supabase: SupabaseClient,
    options: ExecuteReconciliationOptions
  ): Promise<{
    inspected: boolean;
    status: 'completed' | 'failed' | 'skipped';
    count: number;
    eligibleForResolution: boolean;
    discrepancies: DiscrepancyObservationDraft[];
    error?: string;
  }> {
    const discrepancies: DiscrepancyObservationDraft[] = [];
    let count = 0;

    try {
      let query = (supabase as any).from('billing_wallets').select('*');
      if (options.organizationId) {
        query = query.eq('organization_id', options.organizationId);
      }

      const { data: wallets, error } = await query;
      if (error) {
        throw new Error(`DB error fetching wallets: ${error.message}`);
      }

      const walletList = wallets || [];
      count = walletList.length;

      for (const wallet of walletList) {
        // Fetch all credit ledger entries for organization
        const { data: ledgerEntries, error: ledgerErr } = await (supabase as any)
          .from('billing_credit_ledger')
          .select('entry_type, amount_minor')
          .eq('organization_id', wallet.organization_id);

        if (ledgerErr) {
          throw ledgerErr;
        }

        const entries = ledgerEntries || [];
        if (entries.length === 0 && Number(wallet.balance_minor) > 0) {
          // Unknown ledger provenance
          discrepancies.push({
            category: 'UNKNOWN_LEDGER_PROVENANCE',
            severity: 'critical',
            organizationId: wallet.organization_id,
            providerAccountId: null, // PROVIDER-NEUTRAL FINDING!
            targetEntityType: 'wallet_ledger',
            targetEntityId: wallet.organization_id,
            evidenceJson: {
              walletBalanceMinor: wallet.balance_minor,
              ledgerEntryCount: 0,
            },
          });
          continue;
        }

        // Calculate expected funded balance using actual persisted entry types & signed amounts
        let calculatedFundedBalance = BigInt(0);
        for (const entry of entries) {
          calculatedFundedBalance += BigInt(entry.amount_minor);
        }

        const walletBalanceMinor = BigInt(wallet.balance_minor || 0);

        if (calculatedFundedBalance !== walletBalanceMinor) {
          discrepancies.push({
            category: 'LEDGER_BALANCE_MISMATCH',
            severity: 'critical',
            organizationId: wallet.organization_id,
            providerAccountId: null, // PROVIDER-NEUTRAL FINDING!
            targetEntityType: 'wallet_ledger',
            targetEntityId: wallet.organization_id,
            evidenceJson: {
              walletBalanceMinor: Number(walletBalanceMinor),
              calculatedLedgerBalanceMinor: Number(calculatedFundedBalance),
              discrepancyMinor: Number(walletBalanceMinor - calculatedFundedBalance),
            },
          });
        }
      }

      return {
        inspected: true,
        status: 'completed',
        count,
        eligibleForResolution: true,
        discrepancies,
      };
    } catch (err: any) {
      return {
        inspected: true,
        status: 'failed',
        count,
        eligibleForResolution: false,
        discrepancies,
        error: err.message,
      };
    }
  }

  /**
   * Records Finding Upsert and Immutable Observation Snapshot.
   * NEVER ATTEMPTS UPDATE ON OBSERVATIONS!
   */
  private async recordFindingAndObservation(
    supabase: SupabaseClient,
    runId: string,
    draft: DiscrepancyObservationDraft,
    fingerprint: string
  ): Promise<void> {
    const nowIso = new Date().toISOString();

    // 1. Check existing finding by fingerprint
    const { data: existingFindings } = await (supabase as any)
      .from('billing_reconciliation_findings')
      .select('id, status, first_seen_at')
      .eq('fingerprint', fingerprint);

    let findingId: string;
    const existing = (existingFindings || [])[0];

    if (existing) {
      findingId = existing.id;
      // Update existing finding's last_seen_at
      await (supabase as any)
        .from('billing_reconciliation_findings')
        .update({
          last_seen_at: nowIso,
          updated_at: nowIso,
        })
        .eq('id', findingId);
    } else {
      // Insert new finding
      const { data: newFinding, error: insertErr } = await (supabase as any)
        .from('billing_reconciliation_findings')
        .insert({
          fingerprint,
          organization_id: draft.organizationId,
          provider_account_id: draft.providerAccountId,
          finding_category: draft.category,
          severity: draft.severity,
          status: 'open',
          target_entity_type: draft.targetEntityType,
          target_entity_id: draft.targetEntityId,
          stable_discriminator: draft.stableDiscriminator || 'default',
          first_seen_at: nowIso,
          last_seen_at: nowIso,
        })
        .select('id')
        .single();

      if (insertErr || !newFinding) {
        // Handle race condition gracefully if inserted concurrently
        const { data: raceFinding } = await (supabase as any)
          .from('billing_reconciliation_findings')
          .select('id')
          .eq('fingerprint', fingerprint)
          .single();

        if (raceFinding) {
          findingId = raceFinding.id;
        } else {
          throw new Error(`Failed to record finding: ${insertErr?.message}`);
        }
      } else {
        findingId = newFinding.id;
      }
    }

    // 2. Insert Immutable Observation Snapshot (SELECT + INSERT ONLY; UPDATE DENIED)
    const evidenceHash = generateEvidenceHash(draft.evidenceJson);

    const { error: obsErr } = await (supabase as any)
      .from('billing_reconciliation_finding_observations')
      .insert({
        run_id: runId,
        finding_id: findingId,
        observed_at: nowIso,
        evidence_json: draft.evidenceJson,
        evidence_hash: evidenceHash,
      });

    if (obsErr) {
      if (obsErr.code === '23505' || obsErr.message?.includes('duplicate key')) {
        // Already observed in this run, safe idempotent ignore
      } else {
        console.error('[ReconciliationEngine] Error inserting observation snapshot:', obsErr.message);
      }
    }
  }

  /**
   * Safely evaluates finding resolution.
   * Auto-resolves open findings ONLY if current run verified 0 discrepancy.
   */
  private async evaluateResolutions(
    supabase: SupabaseClient,
    options: ExecuteReconciliationOptions,
    activeFingerprints: Set<string>
  ): Promise<number> {
    let resolvedCount = 0;
    const nowIso = new Date().toISOString();

    let query = (supabase as any)
      .from('billing_reconciliation_findings')
      .select('id, fingerprint')
      .eq('status', 'open');

    if (options.organizationId) {
      query = query.eq('organization_id', options.organizationId);
    }
    if (options.providerAccountId) {
      query = query.eq('provider_account_id', options.providerAccountId);
    }

    const { data: openFindings } = await query;
    for (const f of openFindings || []) {
      if (!activeFingerprints.has(f.fingerprint)) {
        // Discrepancy is resolved!
        await (supabase as any)
          .from('billing_reconciliation_findings')
          .update({
            status: 'resolved',
            resolved_at: nowIso,
            updated_at: nowIso,
          })
          .eq('id', f.id);

        resolvedCount++;
      }
    }

    return resolvedCount;
  }
}
