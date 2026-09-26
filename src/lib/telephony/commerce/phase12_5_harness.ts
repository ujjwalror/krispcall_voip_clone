import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { createTwilioServerClient } from '@/lib/twilio/client';
import { ProvisioningEngine } from './provisioningEngine';
import { ProviderCostService } from '../marketplace/providerCostService';
import { RetailPricingService } from '../marketplace/pricingService';
import { RegulatoryPreCheckService } from '../marketplace/regulatoryPreCheckService';
import { CustomerPurchaseOperationDTO } from './types';

export interface Phase12_5HarnessRunParams {
  organizationId: string;
  userRole: string;
  candidateE164?: string;
  countryCode?: string;
  numberType?: 'local' | 'mobile' | 'toll_free';
  executeLive?: boolean;
}

export interface Phase12_5HarnessRunResult {
  dryRun: boolean;
  success: boolean;
  phoneNumberE164: string;
  providerCostMinor: number | null;
  providerCostCurrency: string | null;
  retailPriceMinor: number | null;
  retailPriceFormatted: string | null;
  regulatoryStatus: string;
  operationDTO?: CustomerPurchaseOperationDTO;
  providerSid?: string | null;
  message: string;
}

export interface Phase12_5TearDownParams {
  organizationId: string;
  phoneNumberE164: string;
  userRole: string;
  executeLive?: boolean;
}

export interface Phase12_5TearDownResult {
  dryRun: boolean;
  success: boolean;
  phoneNumberE164: string;
  providerSid: string | null;
  previousStatus: string;
  newStatus: string;
  historicalRecordRetained: boolean;
  reconciliationOutcome: 'confirmed_released' | 'dry_run_simulated' | 'ambiguous_reconciliation_required' | 'failed';
  message: string;
}

/**
 * Server-only controlled Phase 12.5 Test Harness & Tear-Down Service.
 * Executable ONLY from server CLI / controlled node environment.
 * NEVER exposed as a public API route, query parameter, header, or cookie bypass.
 * Preserves strict payment boundary protection on public checkout endpoints.
 */
export class Phase12_5HarnessService {
  /**
   * Asserts user role is owner or admin.
   */
  private static assertOwnerOrAdmin(role: string): void {
    const norm = (role || '').toLowerCase();
    if (norm !== 'owner' && norm !== 'admin') {
      throw new Error('UNAUTHORIZED_ROLE: Phase 12.5 harness requires Owner or Admin role privileges.');
    }
  }

  /**
   * Executes a controlled Phase 12.5 purchase test run.
   * Defaults to SAFE DRY RUN (executeLive = false).
   */
  static async runPurchaseHarness(
    params: Phase12_5HarnessRunParams
  ): Promise<Phase12_5HarnessRunResult> {
    this.assertOwnerOrAdmin(params.userRole);

    const dryRun = params.executeLive !== true;
    const countryCode = (params.countryCode || 'US').toUpperCase();
    const numberType = params.numberType || 'local';

    // 1. Discover or recheck candidate E.164
    let candidateE164 = params.candidateE164;
    if (!candidateE164) {
      const client = createTwilioServerClient();
      const available = await client.availablePhoneNumbers(countryCode).local.list({ limit: 1 });
      if (!available || available.length === 0) {
        return {
          dryRun,
          success: false,
          phoneNumberE164: '',
          providerCostMinor: null,
          providerCostCurrency: null,
          retailPriceMinor: null,
          retailPriceFormatted: null,
          regulatoryStatus: 'unavailable',
          message: `No available inventory found for ${countryCode} ${numberType}.`,
        };
      }
      candidateE164 = available[0].phoneNumber;
    }

    // 2. Refresh Wholesale Cost & Retail Price
    const costRes = await ProviderCostService.getProviderCost(countryCode);
    const matchingCost = costRes.prices.find((p) => p.numberType === numberType);
    const providerCostMinor = matchingCost?.currentPriceMinor ?? null;
    const providerCostCurrency = costRes.currency;

    const retailRes = await RetailPricingService.resolveRetailPrice(countryCode, numberType);
    if (!retailRes.hasConfiguredPrice || retailRes.monthlyPriceMinor === null) {
      return {
        dryRun,
        success: false,
        phoneNumberE164: candidateE164,
        providerCostMinor,
        providerCostCurrency,
        retailPriceMinor: null,
        retailPriceFormatted: null,
        regulatoryStatus: 'not_evaluated',
        message: 'Retail price is not configured for this number category.',
      };
    }

    // 3. Evaluate Regulatory Pre-Check Status
    const preCheck = await RegulatoryPreCheckService.evaluateRequirements(countryCode, numberType, 'business');
    if (preCheck.status === 'error' || preCheck.status === 'unavailable') {
      return {
        dryRun,
        success: false,
        phoneNumberE164: candidateE164,
        providerCostMinor,
        providerCostCurrency,
        retailPriceMinor: retailRes.monthlyPriceMinor,
        retailPriceFormatted: retailRes.monthlyPriceFormatted,
        regulatoryStatus: preCheck.status,
        message: 'Regulatory precheck returned error/unavailable. Purchase blocked.',
      };
    }

    // DRY RUN SAFE MODE: Return simulation without executing live provider POST
    if (dryRun) {
      return {
        dryRun: true,
        success: true,
        phoneNumberE164: candidateE164,
        providerCostMinor,
        providerCostCurrency,
        retailPriceMinor: retailRes.monthlyPriceMinor,
        retailPriceFormatted: retailRes.monthlyPriceFormatted,
        regulatoryStatus: preCheck.status,
        providerSid: 'PN_MOCK_DRY_RUN_SID',
        message: `[DRY_RUN] Phase 12.5 purchase harness validated candidate ${candidateE164} ($${(retailRes.monthlyPriceMinor / 100).toFixed(2)}/mo). No live provider purchase was executed.`,
      };
    }

    // LIVE MODE: Execute purchase workflow through production ProvisioningEngine
    const idempotencyKey = `purch_live_test_12_5_${Date.now()}`;
    const operationDTO = await ProvisioningEngine.executeLivePurchaseWorkflow({
      organizationId: params.organizationId,
      maxCapacityLimit: 50,
      idempotencyKey,
      phoneNumberE164: candidateE164,
      countryCode,
      numberType,
      retailAmountMinor: retailRes.monthlyPriceMinor,
      retailCurrency: retailRes.currency,
      providerCostMinor: providerCostMinor || 0,
      providerCostCurrency: providerCostCurrency || 'USD',
      pricingSource: 'pricing_policy',
      endUserType: 'business',
    });

    let resolvedProviderSid: string | null = null;
    if (operationDTO.status === 'succeeded') {
      const supabase = createAdminClient();
      const { data: phoneRow } = await (supabase as any)
        .from('phone_numbers')
        .select('provider_sid')
        .eq('organization_id', params.organizationId)
        .eq('phone_number', candidateE164)
        .maybeSingle();
      if (phoneRow) {
        resolvedProviderSid = phoneRow.provider_sid || null;
      } else {
        const { data: opRow } = await (supabase as any)
          .from('provider_number_operations')
          .select('provider_resource_id')
          .eq('id', operationDTO.operationId)
          .maybeSingle();
        if (opRow) {
          resolvedProviderSid = opRow.provider_resource_id || null;
        }
      }
    }

    return {
      dryRun: false,
      success: operationDTO.status === 'succeeded',
      phoneNumberE164: candidateE164,
      providerCostMinor,
      providerCostCurrency,
      retailPriceMinor: retailRes.monthlyPriceMinor,
      retailPriceFormatted: retailRes.monthlyPriceFormatted,
      regulatoryStatus: preCheck.status,
      operationDTO,
      providerSid: resolvedProviderSid,
      message: `[LIVE_EXECUTION] Purchase workflow completed with status '${operationDTO.status}'.`,
    };
  }

  /**
   * Executes a controlled Phase 12.5 test tear-down/release.
   * Handles deterministic release success, dry-run simulation, and ambiguous release reconciliation.
   * STRICT INVARIANT: Never physically deletes the historical phone_numbers DB row.
   */
  static async executeTestTearDown(
    params: Phase12_5TearDownParams
  ): Promise<Phase12_5TearDownResult> {
    this.assertOwnerOrAdmin(params.userRole);

    const dryRun = params.executeLive !== true;
    const e164 = (params.phoneNumberE164 || '').trim();

    const supabase = createAdminClient();

    // 1. Fetch phone number record from DB
    const { data: phoneRow, error: fetchErr } = await (supabase as any)
      .from('phone_numbers')
      .select('*')
      .eq('organization_id', params.organizationId)
      .eq('phone_number', e164)
      .in('status', ['active', 'inactive', 'suspended'])
      .maybeSingle();

    if (fetchErr || !phoneRow) {
      return {
        dryRun,
        success: false,
        phoneNumberE164: e164,
        providerSid: null,
        previousStatus: 'unknown',
        newStatus: 'unknown',
        historicalRecordRetained: false,
        reconciliationOutcome: 'failed',
        message: `No active phone_numbers ownership record found for ${e164} in organization.`,
      };
    }

    const previousStatus = phoneRow.status;
    const providerSid = phoneRow.provider_sid || phoneRow.twilio_phone_number_sid || null;

    // DRY RUN SAFE MODE: Simulate release without executing Twilio DELETE
    if (dryRun) {
      return {
        dryRun: true,
        success: true,
        phoneNumberE164: e164,
        providerSid,
        previousStatus,
        newStatus: 'released (simulated)',
        historicalRecordRetained: true,
        reconciliationOutcome: 'dry_run_simulated',
        message: `[DRY_RUN] Tear-down harness validated release target ${e164} (SID: ${providerSid || 'N/A'}). No live Twilio release was executed.`,
      };
    }

    if (!providerSid) {
      return {
        dryRun: false,
        success: false,
        phoneNumberE164: e164,
        providerSid: null,
        previousStatus,
        newStatus: previousStatus,
        historicalRecordRetained: true,
        reconciliationOutcome: 'failed',
        message: `Cannot execute live tear-down for ${e164}: provider_sid is missing.`,
      };
    }

    // LIVE MODE: Execute Twilio remove() call with ambiguous reconciliation handling
    const client = createTwilioServerClient();
    let releaseConfirmed = false;
    let ambiguous = false;

    try {
      await client.incomingPhoneNumbers(providerSid).remove();
      releaseConfirmed = true;
    } catch (err: any) {
      console.warn(`[Phase12_5HarnessService] Twilio remove() returned notice for ${providerSid}:`, err.message || err);

      // Check if error is deterministic 404 (already deleted/absent on provider)
      if (err.status === 404 || err.code === 20404) {
        releaseConfirmed = true;
      } else {
        // Ambiguous failure: perform GET lookup to reconcile authoritatively
        ambiguous = true;
        try {
          await client.incomingPhoneNumbers(providerSid).fetch();
          // If fetch succeeds, number still exists on provider!
          releaseConfirmed = false;
        } catch (fetchErr: any) {
          if (fetchErr.status === 404 || fetchErr.code === 20404) {
            // Resource is authoritatively absent on provider -> release confirmed!
            releaseConfirmed = true;
            ambiguous = false;
          }
        }
      }
    }

    if (releaseConfirmed) {
      // Update local phone_numbers row to 'released' (retaining historical row!)
      const { error: updateErr } = await (supabase as any)
        .from('phone_numbers')
        .update({
          status: 'released',
          active: false,
          updated_at: new Date().toISOString(),
        })
        .eq('id', phoneRow.id);

      if (updateErr) {
        console.error('[Phase12_5HarnessService] Error updating local status to released:', updateErr);
      }

      return {
        dryRun: false,
        success: true,
        phoneNumberE164: e164,
        providerSid,
        previousStatus,
        newStatus: 'released',
        historicalRecordRetained: true,
        reconciliationOutcome: 'confirmed_released',
        message: `[LIVE_EXECUTION] Provider number ${e164} (${providerSid}) released cleanly. Local lifecycle updated to 'released' and historical record retained.`,
      };
    }

    // Inconclusive outcome: fail closed, retain safe active status, DO NOT retry POST/DELETE
    return {
      dryRun: false,
      success: false,
      phoneNumberE164: e164,
      providerSid,
      previousStatus,
      newStatus: previousStatus,
      historicalRecordRetained: true,
      reconciliationOutcome: 'ambiguous_reconciliation_required',
      message: `[LIVE_EXECUTION] Release outcome for ${e164} (${providerSid}) was ambiguous. Local active status retained. Manual review required.`,
    };
  }
}
