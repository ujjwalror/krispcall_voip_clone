import 'server-only';

export type RenewalStatus =
  | 'active'
  | 'approaching_renewal'
  | 'renewal_due'
  | 'autopay_failed'
  | 'past_due'
  | 'suspended'
  | 'release_pending'
  | 'released';

export type PaymentAttemptState =
  | 'none'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'requires_action';

export type PaymentFailureReason =
  | 'card_declined'
  | 'expired_card'
  | 'authentication_required'
  | 'processor_unavailable'
  | 'ambiguous_payment'
  | 'unknown';

export type CarrierExposureSource =
  | 'authoritative_provider_anchor'
  | 'safely_derived_provisioning_date'
  | 'unknown_requires_reconciliation';

export interface PerNumberRenewalRecord {
  phoneNumberId: string;
  phoneNumberE164: string;
  organizationId: string;
  provider: string;
  providerResourceId: string;
  customerFundedThroughAt: string | null;
  customerNextRenewalAt: string | null;
  providerBillingAnchorAt: string | null;
  providerNextExposureAt: string | null;
  carrierExposureSource: CarrierExposureSource;
  wholesaleCostMinor: number;
  retailPriceMinor: number | null;
  currency: string;
  autopayEnabled: boolean;
  renewalStatus: RenewalStatus;
  paymentAttemptState: PaymentAttemptState;
  lastPaymentFailureReason?: PaymentFailureReason | null;
  hasActivePortOut: boolean;
  isReleased: boolean;
  reconciliationBlocked: boolean;
  unfundedCompanyLiability: boolean;
}

export interface PreRenewalPolicyConfig {
  policyId: string;
  policyVersion: number;
  preRenewalNoticeLeadHours: number;
  autopayAttemptLeadHours: number;
  paymentRetryWindowHours: number;
  strongerWarningLeadHours: number;
  finalWarningLeadHours: number;
  releaseEligibilityBoundaryHours: number;
  allowNumberOnlyRetention: boolean;
  isActive: boolean;
}

export interface RenewalEvaluationResult {
  phoneNumberId: string;
  phoneNumberE164: string;
  organizationId: string;
  renewalStatus: RenewalStatus;
  nextAction:
    | 'RENEW_AUTOPAY'
    | 'SEND_PRE_RENEWAL_NOTICE'
    | 'RETRY_PAYMENT'
    | 'SEND_WARNING'
    | 'SEND_FINAL_NOTICE'
    | 'EVALUATE_RELEASE'
    | 'NO_ACTION';
  customerFundedThroughAt: string | null;
  providerNextExposureAt: string | null;
  effectiveDeadlineAt: string | null;
  isUnfundedLiability: boolean;
  unfundedHours: number;
  reason: string;
  blockers: string[];
}

export interface AdminRenewalPreviewDTO {
  phoneNumberId: string;
  phoneNumberE164: string;
  organizationId: string;
  provider: string;
  policyId: string;
  policyVersion: number;
  providerBillingAnchorAt: string | null;
  providerNextExposureAt: string | null;
  customerFundedThroughAt: string | null;
  calculatedPreRenewalNoticeAt: string | null;
  calculatedAutopayAttemptAt: string | null;
  calculatedRetryWindowEndAt: string | null;
  calculatedFinalWarningAt: string | null;
  calculatedReleaseEligibilityAt: string | null;
  unfundedCompanyLiability: boolean;
  blockers: string[];
}
