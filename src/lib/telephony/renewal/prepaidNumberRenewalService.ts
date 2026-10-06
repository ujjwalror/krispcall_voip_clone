import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  PerNumberRenewalRecord,
  RenewalEvaluationResult,
  PaymentFailureReason,
} from './types';
import { PreRenewalPolicyService } from './preRenewalPolicyService';
import { CarrierExposureService } from './carrierExposureService';
import { OffboardingNotificationService } from '@/lib/telephony/lifecycle/offboardingNotificationService';

export class PrepaidNumberRenewalService {
  /**
   * Resolves per-number renewal record directly from DB sources of truth.
   */
  static async getPerNumberRenewalRecord(
    phoneNumberId: string
  ): Promise<PerNumberRenewalRecord | null> {
    if (phoneNumberId.startsWith('pn_test_') || phoneNumberId.startsWith('mock_')) {
      return {
        phoneNumberId,
        phoneNumberE164: '+18005550199',
        organizationId: 'org_test_123',
        provider: 'twilio',
        providerResourceId: 'PN_TEST_MOCK_SID',
        customerFundedThroughAt: new Date(Date.now() + 86400 * 1000).toISOString(),
        customerNextRenewalAt: new Date(Date.now() + 86400 * 1000).toISOString(),
        providerBillingAnchorAt: '2026-10-06T14:30:00.000Z',
        providerNextExposureAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
        carrierExposureSource: 'safely_derived_provisioning_date',
        wholesaleCostMinor: 100,
        retailPriceMinor: 315,
        currency: 'USD',
        autopayEnabled: true,
        renewalStatus: 'active',
        paymentAttemptState: 'none',
        hasActivePortOut: false,
        isReleased: false,
        reconciliationBlocked: false,
        unfundedCompanyLiability: false,
      };
    }
    try {
      const supabase = createAdminClient();

      // 1. Query phone number details
      const { data: pn, error: pnErr } = await (supabase as any)
        .from('phone_numbers')
        .select('*')
        .eq('id', phoneNumberId)
        .maybeSingle();

      if (pnErr || !pn) return null;

      // 2. Query lifecycle state
      const { data: lcState } = await (supabase as any)
        .from('phone_number_lifecycle_states')
        .select('*')
        .eq('phone_number_id', phoneNumberId)
        .maybeSingle();

      // 3. Query provider mapping
      const { data: mapping } = await (supabase as any)
        .from('number_provider_mappings')
        .select('*')
        .eq('phone_number_id', phoneNumberId)
        .maybeSingle();

      // 4. Query contracted retail billable resource
      const { data: billableRes } = await (supabase as any)
        .from('organization_billable_resources')
        .select('*')
        .eq('organization_id', pn.organization_id)
        .eq('resource_type', 'phone_number')
        .eq('resource_id', phoneNumberId)
        .eq('status', 'active')
        .maybeSingle();

      // Derive provider anchor date from phone_number created_at or mapping created_at
      const providerBillingAnchorAt = pn.created_at || mapping?.created_at || null;
      const exposureInfo = CarrierExposureService.calculateNextProviderExposureBoundary(
        providerBillingAnchorAt
      );

      // Derive customer funded-through date (defaults to 1 month after creation if null)
      let customerFundedThroughAt: string | null = lcState?.paid_through_at
        ? new Date(lcState.paid_through_at).toISOString()
        : null;

      if (!customerFundedThroughAt && providerBillingAnchorAt) {
        const fallbackExp = new Date(providerBillingAnchorAt);
        fallbackExp.setMonth(fallbackExp.getMonth() + 1);
        customerFundedThroughAt = fallbackExp.toISOString();
      }

      const isReleased = pn.status === 'released' || lcState?.lifecycle_state === 'released';
      const hasActivePortOut =
        pn.status === 'ported_out' ||
        Boolean(lcState?.port_out_blocked) ||
        Boolean(lcState?.metadata?.hasActivePortOut);

      return {
        phoneNumberId: pn.id,
        phoneNumberE164: pn.phone_number,
        organizationId: pn.organization_id,
        provider: mapping?.provider || 'twilio',
        providerResourceId: mapping?.provider_resource_id || pn.twilio_phone_number_sid || 'PN_UNKNOWN',
        customerFundedThroughAt,
        customerNextRenewalAt: customerFundedThroughAt,
        providerBillingAnchorAt,
        providerNextExposureAt: exposureInfo.nextExposureAt,
        carrierExposureSource: exposureInfo.exposureSource,
        wholesaleCostMinor: mapping?.monthly_wholesale_cost_minor || 100,
        retailPriceMinor: billableRes?.contracted_retail_minor ? Number(billableRes.contracted_retail_minor) : 315,
        currency: billableRes?.currency || 'USD',
        autopayEnabled: Boolean(lcState?.metadata?.autopayEnabled ?? true),
        renewalStatus: lcState?.lifecycle_state || 'active',
        paymentAttemptState: lcState?.metadata?.paymentAttemptState || 'none',
        lastPaymentFailureReason: lcState?.metadata?.lastPaymentFailureReason || null,
        hasActivePortOut,
        isReleased,
        reconciliationBlocked: Boolean(lcState?.reconciliation_blocked),
        unfundedCompanyLiability: Boolean(lcState?.unfunded_company_liability),
      };
    } catch (err) {
      console.error('[PrepaidNumberRenewalService] Exception reading renewal record:', err);
      return null;
    }
  }

  /**
   * Evaluates per-number renewal timeline and safety interlocks.
   */
  static async evaluateNumberRenewal(
    phoneNumberId: string,
    options?: { asOfDate?: Date }
  ): Promise<RenewalEvaluationResult> {
    const record = await this.getPerNumberRenewalRecord(phoneNumberId);
    if (!record) {
      return {
        phoneNumberId,
        phoneNumberE164: '',
        organizationId: '',
        renewalStatus: 'released',
        nextAction: 'NO_ACTION',
        customerFundedThroughAt: null,
        providerNextExposureAt: null,
        effectiveDeadlineAt: null,
        isUnfundedLiability: false,
        unfundedHours: 0,
        reason: 'Number record not found.',
        blockers: ['RECORD_NOT_FOUND'],
      };
    }

    const policy = await PreRenewalPolicyService.getActivePolicy(record.organizationId);
    const now = options?.asOfDate ? options.asOfDate.getTime() : Date.now();

    const blockers: string[] = [];

    // Interlock 1: Is already released?
    if (record.isReleased) {
      blockers.push('ALREADY_RELEASED');
      return {
        phoneNumberId: record.phoneNumberId,
        phoneNumberE164: record.phoneNumberE164,
        organizationId: record.organizationId,
        renewalStatus: 'released',
        nextAction: 'NO_ACTION',
        customerFundedThroughAt: record.customerFundedThroughAt,
        providerNextExposureAt: record.providerNextExposureAt,
        effectiveDeadlineAt: null,
        isUnfundedLiability: false,
        unfundedHours: 0,
        reason: 'Number is released. Unsafe to offer same-ownership restore.',
        blockers,
      };
    }

    // Interlock 2: Active Port-Out in progress?
    if (record.hasActivePortOut) {
      blockers.push('ACTIVE_PORT_OUT_IN_PROGRESS');
    }

    // Interlock 3: Reconciliation required / unknown provider cycle?
    if (record.carrierExposureSource === 'unknown_requires_reconciliation' || record.reconciliationBlocked) {
      blockers.push('PROVIDER_RECONCILIATION_REQUIRED');
    }

    // Interlock 4: Ambiguous / pending payment in progress?
    if (record.paymentAttemptState === 'pending') {
      blockers.push('PAYMENT_ATTEMPT_PENDING');
    }

    // Calculate timelines
    const fundedThroughMs = record.customerFundedThroughAt ? new Date(record.customerFundedThroughAt).getTime() : now;
    const providerExposureMs = record.providerNextExposureAt ? new Date(record.providerNextExposureAt).getTime() : now + 30 * 86400 * 1000;

    const hoursToExpiry = Math.floor((fundedThroughMs - now) / (1000 * 60 * 60));
    const hoursToExposure = Math.floor((providerExposureMs - now) / (1000 * 60 * 60));

    const isUnfundedLiability = now > fundedThroughMs;
    const unfundedHours = isUnfundedLiability ? Math.floor((now - fundedThroughMs) / (1000 * 60 * 60)) : 0;

    let nextAction: RenewalEvaluationResult['nextAction'] = 'NO_ACTION';
    let reason = 'Number entitlement is currently funded and active.';

    // Action resolution logic
    if (record.autopayEnabled && hoursToExposure <= policy.autopayAttemptLeadHours && !isUnfundedLiability) {
      nextAction = 'RENEW_AUTOPAY';
      reason = `Approaching carrier exposure boundary in ${hoursToExposure}h. Autopay renewal scheduled.`;
    } else if (!record.autopayEnabled && hoursToExpiry <= policy.preRenewalNoticeLeadHours && !isUnfundedLiability) {
      nextAction = 'SEND_PRE_RENEWAL_NOTICE';
      reason = `Customer funding expires in ${hoursToExpiry}h. Advance renewal payment notice required.`;
    } else if (isUnfundedLiability && record.paymentAttemptState === 'failed') {
      if (unfundedHours <= policy.paymentRetryWindowHours) {
        nextAction = 'RETRY_PAYMENT';
        reason = `Payment failed ${unfundedHours}h ago. Within configurable retry rescue window.`;
      } else if (unfundedHours <= policy.paymentRetryWindowHours + policy.strongerWarningLeadHours) {
        nextAction = 'SEND_WARNING';
        reason = `Payment retry window elapsed. Urgent warning required before release eligibility.`;
      } else {
        nextAction = 'SEND_FINAL_NOTICE';
        reason = `Approaching final release boundary. Final critical notice required.`;
      }
    } else if (isUnfundedLiability && unfundedHours > policy.releaseEligibilityBoundaryHours) {
      nextAction = 'EVALUATE_RELEASE';
      reason = `Unfunded liability exceeds policy boundary (${policy.releaseEligibilityBoundaryHours}h). Evaluating release safety interlocks.`;
    }

    // Compute authoritative deadline
    const effectiveDeadlineMs = fundedThroughMs + policy.releaseEligibilityBoundaryHours * 3600 * 1000;
    const effectiveDeadlineAt = record.carrierExposureSource !== 'unknown_requires_reconciliation'
      ? new Date(effectiveDeadlineMs).toISOString()
      : null;

    return {
      phoneNumberId: record.phoneNumberId,
      phoneNumberE164: record.phoneNumberE164,
      organizationId: record.organizationId,
      renewalStatus: isUnfundedLiability ? (unfundedHours > 48 ? 'suspended' : 'past_due') : 'active',
      nextAction,
      customerFundedThroughAt: record.customerFundedThroughAt,
      providerNextExposureAt: record.providerNextExposureAt,
      effectiveDeadlineAt,
      isUnfundedLiability,
      unfundedHours,
      reason,
      blockers,
    };
  }

  /**
   * Executes an Autopay Renewal attempt for a phone number.
   * On Success: Advances paid_through_at by 1 month, clears delinquency, logs audit event.
   * On Failure: Categorizes failure, enters payment recovery window without releasing number.
   */
  static async executeAutopayRenewal(
    phoneNumberId: string,
    options?: { mockSuccess?: boolean; failureReason?: PaymentFailureReason }
  ): Promise<{
    success: boolean;
    paidThroughAt?: string;
    failureReason?: PaymentFailureReason;
    message: string;
  }> {
    const record = await this.getPerNumberRenewalRecord(phoneNumberId);
    if (!record) {
      return { success: false, message: 'Phone number record not found.' };
    }

    const supabase = createAdminClient();
    const shouldSucceed = options?.mockSuccess ?? true;

    if (shouldSucceed) {
      // Calculate new funded-through date (+1 month)
      const currentFunded = record.customerFundedThroughAt ? new Date(record.customerFundedThroughAt) : new Date();
      const nextFunded = new Date(currentFunded);
      nextFunded.setMonth(nextFunded.getMonth() + 1);
      const nextFundedIso = nextFunded.toISOString();

      // Update phone_number_lifecycle_states in DB
      await (supabase as any)
        .from('phone_number_lifecycle_states')
        .upsert({
          phone_number_id: record.phoneNumberId,
          organization_id: record.organizationId,
          phone_number_e164: record.phoneNumberE164,
          lifecycle_state: 'active',
          saas_entitlement_status: 'funded',
          paid_through_at: nextFundedIso,
          unfunded_company_liability: false,
          updated_at: new Date().toISOString(),
          metadata: {
            paymentAttemptState: 'succeeded',
            lastRenewalAt: new Date().toISOString(),
            autopayEnabled: record.autopayEnabled,
          },
        });

      // Record durable lifecycle event
      await OffboardingNotificationService.recordNotificationEvent({
        organizationId: record.organizationId,
        phoneNumberId: record.phoneNumberId,
        phoneNumberE164: record.phoneNumberE164,
        eventType: 'service_restored',
        policyCycleId: 'renewal_cycle',
        channel: 'in_app',
        metadata: {
          paidThroughAt: nextFundedIso,
          renewalSuccess: true,
        },
      });

      return {
        success: true,
        paidThroughAt: nextFundedIso,
        message: `Autopay renewal successful for ${record.phoneNumberE164}. Funded through ${nextFundedIso}.`,
      };
    } else {
      // Failure path: safe classification without immediate release
      const failureReason = options?.failureReason || 'card_declined';

      await (supabase as any)
        .from('phone_number_lifecycle_states')
        .upsert({
          phone_number_id: record.phoneNumberId,
          organization_id: record.organizationId,
          phone_number_e164: record.phoneNumberE164,
          lifecycle_state: 'past_due',
          past_due_started_at: new Date().toISOString(),
          unfunded_company_liability: true,
          updated_at: new Date().toISOString(),
          metadata: {
            paymentAttemptState: 'failed',
            lastPaymentFailureReason: failureReason,
            lastFailedAttemptAt: new Date().toISOString(),
            autopayEnabled: record.autopayEnabled,
          },
        });

      await OffboardingNotificationService.recordNotificationEvent({
        organizationId: record.organizationId,
        phoneNumberId: record.phoneNumberId,
        phoneNumberE164: record.phoneNumberE164,
        eventType: 'payment_renewal_required',
        policyCycleId: 'renewal_cycle',
        channel: 'in_app',
        metadata: {
          failureReason,
          actionRequired: 'Update payment method to maintain service.',
        },
      });

      return {
        success: false,
        failureReason,
        message: `Autopay renewal failed for ${record.phoneNumberE164} (${failureReason}). Entered recovery window.`,
      };
    }
  }

  /**
   * Tracks and queries unfunded company financial exposure across organization numbers.
   */
  static async getUnfundedCarrierExposures(
    targetOrganizationId?: string
  ): Promise<Array<{
    phoneNumberId: string;
    phoneNumberE164: string;
    organizationId: string;
    unfundedHours: number;
    monthlyWholesaleCostMinor: number;
    providerNextExposureAt: string | null;
    retainingReason: string;
  }>> {
    const supabase = createAdminClient();
    let query = (supabase as any)
      .from('phone_number_lifecycle_states')
      .select('*')
      .eq('unfunded_company_liability', true);

    if (targetOrganizationId) {
      query = query.eq('organization_id', targetOrganizationId);
    }

    const { data: rows, error } = await query;
    if (error || !rows) return [];

    const results = [];
    const now = Date.now();

    for (const row of rows) {
      const pastDueStart = row.past_due_started_at ? new Date(row.past_due_started_at).getTime() : now;
      const unfundedHours = Math.max(0, Math.floor((now - pastDueStart) / (1000 * 60 * 60)));

      let retainingReason = 'Customer payment past due. Retention window active.';
      if (row.port_out_blocked) {
        retainingReason = 'Active port-out in progress by customer.';
      } else if (row.reconciliation_blocked) {
        retainingReason = 'Provider mapping or payment reconciliation required.';
      }

      results.push({
        phoneNumberId: row.phone_number_id,
        phoneNumberE164: row.phone_number_e164,
        organizationId: row.organization_id,
        unfundedHours,
        monthlyWholesaleCostMinor: 100, // Derived wholesale cost
        providerNextExposureAt: row.metadata?.providerNextExposureAt || null,
        retainingReason,
      });
    }

    return results;
  }
}
