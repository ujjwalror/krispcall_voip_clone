import 'server-only';
import {
  PreRenewalPolicyConfig,
  ProviderCycleSource,
  ProviderCycleStatus,
  PaymentFailureReason,
} from './types';
import { CarrierExposureService } from './carrierExposureService';

export interface SimulationInput {
  phoneNumberId?: string;
  phoneNumberE164: string;
  cycleAnchorAt: string | Date;
  customerFundedThroughAt: string | Date;
  providerNextExposureAt?: string | Date | null;
  policy: PreRenewalPolicyConfig;
  autopayEnabled: boolean;
  paymentOutcomes?: Array<{
    attemptIndex: number;
    outcome: 'success' | 'failure' | 'pending' | 'processor_unavailable';
    failureReason?: PaymentFailureReason;
  }>;
  hasActivePortOut?: boolean;
  reconciliationBlocked?: boolean;
  providerCycleStatus?: ProviderCycleStatus;
  providerCycleSource?: ProviderCycleSource;
  asOfDate?: string | Date;
}

export interface SimulationTimelineStage {
  stage:
    | 'UPCOMING_RENEWAL_NOTICE'
    | 'AUTOPAY_ATTEMPT'
    | 'PAYMENT_REQUIRED_WARNING'
    | 'PAYMENT_FAILURE_RECOVERY'
    | 'STRONGER_WARNING'
    | 'FINAL_CRITICAL_WARNING'
    | 'FUNDING_DEADLINE_REACHED'
    | 'RELEASE_ELIGIBILITY_EVALUATION';
  timestamp: string | null;
  description: string;
  status: 'completed' | 'pending' | 'blocked' | 'skipped';
}

export interface SimulationResult {
  phoneNumberE164: string;
  cycleAnchorAt: string;
  customerFundedThroughAt: string;
  providerNextExposureAt: string | null;
  policyVersion: number;
  autopayEnabled: boolean;
  timeline: SimulationTimelineStage[];
  finalOutcome:
    | 'RENEWED'
    | 'PAYMENT_REQUIRED_WARNING'
    | 'RETRY_RECOVERY'
    | 'RELEASE_ELIGIBLE'
    | 'BLOCKED_BY_PORT_OUT'
    | 'BLOCKED_BY_RECONCILIATION'
    | 'UNFUNDED_EXPOSURE_SURFACED';
  releaseEligible: boolean;
  isUnfundedLiability: boolean;
  blockers: string[];
  releaseWording: string;
}

export class PolicySimulationEngine {
  /**
   * Deterministically calculates renewal timeline, stage sequence, and safety interlocks for a number.
   * STRICTLY NO HARDCODED CALENDAR DATES.
   */
  static simulateTimeline(input: SimulationInput): SimulationResult {
    const {
      phoneNumberE164,
      cycleAnchorAt: anchorInput,
      customerFundedThroughAt: fundedInput,
      policy,
      autopayEnabled,
      paymentOutcomes = [],
      hasActivePortOut = false,
      reconciliationBlocked = false,
      providerCycleStatus = 'verified',
      providerCycleSource = 'PROVIDER_AUTHORITATIVE',
      asOfDate: asOfInput,
    } = input;

    const anchorIso = new Date(anchorInput).toISOString();
    const fundedThroughMs = new Date(fundedInput).getTime();
    const asOfMs = asOfInput ? new Date(asOfInput).getTime() : Date.now();

    // Provider exposure calculation (anchor-preserving)
    let providerNextExposureAt: string | null = null;
    if (input.providerNextExposureAt) {
      providerNextExposureAt = new Date(input.providerNextExposureAt).toISOString();
    } else if (providerCycleStatus === 'verified') {
      const expInfo = CarrierExposureService.calculateNextProviderExposureBoundary({
        cycleAnchorDate: anchorIso,
        explicitSource: providerCycleSource,
        hasProviderProvenance: true,
        asOfDate: asOfInput,
      });
      providerNextExposureAt = expInfo.providerNextExposureAt;
    }

    const providerExposureMs = providerNextExposureAt ? new Date(providerNextExposureAt).getTime() : fundedThroughMs;

    // Calculate stage timestamps dynamically relative to provider exposure boundary T0
    const upcomingNoticeMs = providerExposureMs - policy.preRenewalNoticeLeadHours * 3600 * 1000;
    const autopayAttemptMs = providerExposureMs - policy.autopayAttemptLeadHours * 3600 * 1000;
    const retryWindowEndMs = providerExposureMs - policy.paymentRetryWindowHours * 3600 * 1000;
    const strongerWarningMs = providerExposureMs - policy.strongerWarningLeadHours * 3600 * 1000;
    const finalWarningMs = providerExposureMs - policy.finalWarningLeadHours * 3600 * 1000;
    const releaseEligibilityMs = providerExposureMs + policy.releaseEligibilityBoundaryHours * 3600 * 1000;

    const timeline: SimulationTimelineStage[] = [];
    const blockers: string[] = [];

    // Interlocks evaluation
    if (hasActivePortOut) blockers.push('ACTIVE_PORT_OUT_IN_PROGRESS');
    if (reconciliationBlocked) blockers.push('PROVIDER_RECONCILIATION_REQUIRED');
    if (providerCycleStatus === 'unknown_requires_reconciliation' || !providerNextExposureAt) {
      blockers.push('UNKNOWN_CARRIER_EXPOSURE_DATE');
    }

    // Process Payment Outcomes
    const hasPendingPayment = paymentOutcomes.some((p) => p.outcome === 'pending');
    if (hasPendingPayment) blockers.push('PAYMENT_ATTEMPT_PENDING');

    const firstSuccess = paymentOutcomes.find((p) => p.outcome === 'success');
    const isPaymentSuccessful = Boolean(firstSuccess);

    // Build Stage Sequence
    if (autopayEnabled) {
      timeline.push({
        stage: 'UPCOMING_RENEWAL_NOTICE',
        timestamp: new Date(upcomingNoticeMs).toISOString(),
        description: `Advance notice sent to customer ${policy.preRenewalNoticeLeadHours}h before T0.`,
        status: asOfMs >= upcomingNoticeMs ? 'completed' : 'pending',
      });
      timeline.push({
        stage: 'AUTOPAY_ATTEMPT',
        timestamp: new Date(autopayAttemptMs).toISOString(),
        description: `Autopay attempt scheduled ${policy.autopayAttemptLeadHours}h before T0.`,
        status: isPaymentSuccessful ? 'completed' : asOfMs >= autopayAttemptMs ? 'completed' : 'pending',
      });
    } else {
      timeline.push({
        stage: 'PAYMENT_REQUIRED_WARNING',
        timestamp: new Date(upcomingNoticeMs).toISOString(),
        description: `Advance payment requirement notice sent to customer ${policy.preRenewalNoticeLeadHours}h before T0.`,
        status: asOfMs >= upcomingNoticeMs ? 'completed' : 'pending',
      });
    }

    if (!isPaymentSuccessful) {
      timeline.push({
        stage: 'PAYMENT_FAILURE_RECOVERY',
        timestamp: new Date(retryWindowEndMs).toISOString(),
        description: `Payment retry reminder scheduled at T-3 (${policy.paymentRetryWindowHours}h before T0).`,
        status: asOfMs >= retryWindowEndMs ? 'completed' : 'pending',
      });

      timeline.push({
        stage: 'STRONGER_WARNING',
        timestamp: new Date(strongerWarningMs).toISOString(),
        description: `Stronger warning issued at T-2 (${policy.strongerWarningLeadHours}h before T0).`,
        status: asOfMs >= strongerWarningMs ? 'completed' : 'pending',
      });

      timeline.push({
        stage: 'FINAL_CRITICAL_WARNING',
        timestamp: new Date(finalWarningMs).toISOString(),
        description: `Final critical notice issued at T-1 (${policy.finalWarningLeadHours}h before T0).`,
        status: asOfMs >= finalWarningMs ? 'completed' : 'pending',
      });

      timeline.push({
        stage: 'RELEASE_ELIGIBILITY_EVALUATION',
        timestamp: providerCycleStatus === 'verified' && providerNextExposureAt ? new Date(releaseEligibilityMs).toISOString() : null,
        description: `Release eligibility evaluation boundary T0 (${policy.releaseEligibilityBoundaryHours}h post-T0). Safety interlocks evaluated.`,
        status: blockers.length > 0 ? 'blocked' : asOfMs >= releaseEligibilityMs ? 'completed' : 'pending',
      });
    }

    // Determine Final Outcome & Release Eligibility
    let finalOutcome: SimulationResult['finalOutcome'] = 'RENEWED';
    let releaseEligible = false;

    if (isPaymentSuccessful) {
      finalOutcome = 'RENEWED';
      releaseEligible = false;
    } else if (hasActivePortOut) {
      finalOutcome = 'BLOCKED_BY_PORT_OUT';
      releaseEligible = false;
    } else if (reconciliationBlocked || providerCycleStatus === 'unknown_requires_reconciliation') {
      finalOutcome = 'BLOCKED_BY_RECONCILIATION';
      releaseEligible = false;
    } else if (asOfMs < releaseEligibilityMs) {
      finalOutcome = autopayEnabled ? 'RETRY_RECOVERY' : 'PAYMENT_REQUIRED_WARNING';
      releaseEligible = false;
    } else if (blockers.length === 0 && asOfMs >= releaseEligibilityMs) {
      finalOutcome = 'RELEASE_ELIGIBLE';
      releaseEligible = true;
    } else {
      finalOutcome = 'UNFUNDED_EXPOSURE_SURFACED';
      releaseEligible = false;
    }

    const isUnfundedLiability = asOfMs > fundedThroughMs && !isPaymentSuccessful;

    // Standard Approved Release Wording (No unconditional deletion promises!)
    const formattedDeadline = providerCycleStatus === 'verified' && providerNextExposureAt
      ? new Date(releaseEligibilityMs).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : null;

    const releaseWording = formattedDeadline
      ? `If payment is not received by ${formattedDeadline} and you have not initiated an eligible port-out, your number may become eligible for automatic release after the required safety checks.`
      : 'Action is required to maintain this phone number entitlement.';

    return {
      phoneNumberE164,
      cycleAnchorAt: anchorIso,
      customerFundedThroughAt: new Date(fundedInput).toISOString(),
      providerNextExposureAt,
      policyVersion: policy.policyVersion,
      autopayEnabled,
      timeline,
      finalOutcome,
      releaseEligible,
      isUnfundedLiability,
      blockers,
      releaseWording,
    };
  }
}
