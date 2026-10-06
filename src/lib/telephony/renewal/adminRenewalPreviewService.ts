import 'server-only';
import { AdminRenewalPreviewDTO } from './types';
import { PrepaidNumberRenewalService } from './prepaidNumberRenewalService';
import { PreRenewalPolicyService } from './preRenewalPolicyService';

export class AdminRenewalPreviewService {
  /**
   * Computes an administrative timeline preview for a specific phone number's renewal lifecycle.
   * All dates are calculated dynamically from number-specific dates and active policy.
   * STRICTLY NO HARDCODED CALENDAR DATES.
   */
  static async getNumberRenewalPreview(
    phoneNumberId: string,
    actorRole: string,
    actorId: string
  ): Promise<{ success: boolean; preview?: AdminRenewalPreviewDTO; error?: string }> {
    // Verify platform admin authorization
    if (!PreRenewalPolicyService.isPlatformAdmin(actorRole, actorId)) {
      return {
        success: false,
        error: 'FORBIDDEN: Admin renewal timeline previews require PLATFORM_ADMIN role.',
      };
    }

    const record = await PrepaidNumberRenewalService.getPerNumberRenewalRecord(phoneNumberId);
    if (!record) {
      return { success: false, error: 'Phone number record not found.' };
    }

    const policy = await PreRenewalPolicyService.getActivePolicy(record.organizationId);

    const fundedThroughMs = record.customerFundedThroughAt
      ? new Date(record.customerFundedThroughAt).getTime()
      : Date.now();

    const providerExposureMs = record.providerNextExposureAt
      ? new Date(record.providerNextExposureAt).getTime()
      : fundedThroughMs;

    // Dynamically calculate timeline stages relative to number's dates & policy
    const preRenewalNoticeMs = fundedThroughMs - policy.preRenewalNoticeLeadHours * 3600 * 1000;
    const autopayAttemptMs = providerExposureMs - policy.autopayAttemptLeadHours * 3600 * 1000;
    const retryWindowEndMs = fundedThroughMs + policy.paymentRetryWindowHours * 3600 * 1000;
    const finalWarningMs = retryWindowEndMs + policy.strongerWarningLeadHours * 3600 * 1000;
    const releaseEligibilityMs = fundedThroughMs + policy.releaseEligibilityBoundaryHours * 3600 * 1000;

    const blockers: string[] = [];
    if (record.isReleased) blockers.push('NUMBER_ALREADY_RELEASED');
    if (record.hasActivePortOut) blockers.push('ACTIVE_PORT_OUT_IN_PROGRESS');
    if (record.reconciliationBlocked) blockers.push('PROVIDER_RECONCILIATION_REQUIRED');
    if (record.carrierExposureSource === 'unknown_requires_reconciliation') blockers.push('UNKNOWN_CARRIER_EXPOSURE_DATE');

    const preview: AdminRenewalPreviewDTO = {
      phoneNumberId: record.phoneNumberId,
      phoneNumberE164: record.phoneNumberE164,
      organizationId: record.organizationId,
      provider: record.provider,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      providerBillingAnchorAt: record.providerBillingAnchorAt,
      providerNextExposureAt: record.providerNextExposureAt,
      customerFundedThroughAt: record.customerFundedThroughAt,
      calculatedPreRenewalNoticeAt: new Date(preRenewalNoticeMs).toISOString(),
      calculatedAutopayAttemptAt: new Date(autopayAttemptMs).toISOString(),
      calculatedRetryWindowEndAt: new Date(retryWindowEndMs).toISOString(),
      calculatedFinalWarningAt: new Date(finalWarningMs).toISOString(),
      calculatedReleaseEligibilityAt: new Date(releaseEligibilityMs).toISOString(),
      unfundedCompanyLiability: record.unfundedCompanyLiability,
      blockers,
    };

    return { success: true, preview };
  }
}
