import 'server-only';
import { OffboardingPolicyService } from './offboardingPolicyService';
import { OffboardingPolicyRecord } from './types';

export interface DeterministicReleaseEvaluationParams {
  organizationId: string;
  phoneNumberId: string;
  phoneNumberE164: string;
  lifecycleState: string;
  saasEntitlementStatus: string;
  serviceEndedAt?: Date | null;
  releasePendingStartedAt?: Date | null;
  hasActivePortOut: boolean;
  hasProviderAmbiguity: boolean;
  hasLegalHold: boolean;
  hasRenewalInProgress: boolean;
  finalReleaseWarningNoticeSent: boolean;
  policy?: OffboardingPolicyRecord | null;
}

export interface DeterministicReleaseEvaluationResult {
  eligible: boolean;
  reason: string;
  blockers: string[];
}

export class DeterministicReleaseEvaluator {
  /**
   * Deterministic Release Eligibility Evaluator.
   * STRICT FAIL-CLOSED GUARANTEE: Returns eligible: false whenever ANY uncertainty, blocker,
   * active port-out, reconciliation hold, missing policy, or un-notified state exists.
   * DOES NOT execute carrier mutations or DB edits. PURE EVALUATOR.
   */
  static async evaluateReleaseEligibility(
    params: DeterministicReleaseEvaluationParams
  ): Promise<DeterministicReleaseEvaluationResult> {
    const blockers: string[] = [];

    // 1. Missing Policy Check (Fail Closed)
    let policy: OffboardingPolicyRecord | null = null;
    if (params.policy !== undefined) {
      policy = params.policy;
    } else {
      policy = await OffboardingPolicyService.getPolicyForOrganization(params.organizationId);
    }

    if (!policy || !policy.isActive) {
      blockers.push('MISSING_OR_INACTIVE_POLICY: Offboarding policy is unconfigured or inactive. Fail closed.');
      return { eligible: false, reason: 'Release blocked by missing/inactive policy.', blockers };
    }

    if (policy.finalReleaseEligibilityDays === null || policy.finalReleaseEligibilityDays === undefined) {
      blockers.push('UNCONFIGURED_POLICY_TIMING: Required release eligibility duration is unconfigured (NULL). Fail closed.');
      return { eligible: false, reason: 'Release blocked by unconfigured policy timing.', blockers };
    }

    // 2. Active Port-Out Protection (CRITICAL INVARIANT)
    if (params.hasActivePortOut) {
      blockers.push('ACTIVE_PORT_OUT_PENDING: Number is undergoing active port-away. Release strictly blocked.');
    }

    // 3. Provider Ambiguity & Unresolved Reconciliation Lock
    if (params.hasProviderAmbiguity) {
      blockers.push('PROVIDER_AMBIGUITY_UNRESOLVED: Provider operation status is ambiguous or pending reconciliation.');
    }

    // 4. Legal or Regulatory Hold
    if (params.hasLegalHold) {
      blockers.push('LEGAL_OR_REGULATORY_HOLD: Active legal or compliance hold placed on number.');
    }

    // 5. Renewal / Payment Restoration in Progress
    if (params.hasRenewalInProgress) {
      blockers.push('RENEWAL_IN_PROGRESS: Customer payment renewal or service restoration is in progress.');
    }

    // 6. Required Customer Notification Notice Check
    if (!params.finalReleaseWarningNoticeSent) {
      blockers.push('FINAL_RELEASE_NOTICE_MISSING: Mandatory customer release warning notice has not been recorded.');
    }

    // 7. Policy Threshold & Lifecycle State Check
    const state = (params.lifecycleState || '').toLowerCase();
    if (state !== 'release_pending' && state !== 'suspended') {
      blockers.push(`INELIGIBLE_LIFECYCLE_STATE: Current state '${params.lifecycleState}' is not eligible for release evaluation.`);
    }

    const now = new Date();
    const serviceEnded = params.serviceEndedAt ?? params.releasePendingStartedAt;
    if (!serviceEnded) {
      blockers.push('SERVICE_END_TIMESTAMP_MISSING: Service end timestamp is unrecorded. Fail closed.');
    } else {
      const elapsedDays = Math.floor((now.getTime() - serviceEnded.getTime()) / (1000 * 60 * 60 * 24));
      if (elapsedDays < policy.finalReleaseEligibilityDays) {
        blockers.push(
          `RETENTION_GRACE_PERIOD_ACTIVE: Only ${elapsedDays} day(s) elapsed since service end. Required threshold is ${policy.finalReleaseEligibilityDays} day(s).`
        );
      }
    }

    const eligible = blockers.length === 0;
    const reason = eligible
      ? 'Number meets all server-authoritative criteria for automatic offboarding release eligibility.'
      : `Automatic release blocked (${blockers.length} active blocker${blockers.length === 1 ? '' : 's'}).`;

    return {
      eligible,
      reason,
      blockers,
    };
  }
}
