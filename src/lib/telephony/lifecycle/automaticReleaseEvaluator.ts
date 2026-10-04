import 'server-only';
import {
  AutomaticReleaseEvaluationParams,
  AutomaticReleaseEvaluationResult,
} from './types';

/**
 * Server-Authoritative Decision Evaluator for Automatic Abandonment Release Eligibility.
 * STRICT FAIL-CLOSED GUARANTEE: Returns eligible: false whenever ANY uncertainty, blocker,
 * active port-out, reconciliation hold, or payment state ambiguity exists.
 * DOES NOT execute carrier mutations or DB edits. PURE EVALUATOR.
 */
export class AutomaticReleaseEvaluator {
  static evaluateReleaseEligibility(
    params: AutomaticReleaseEvaluationParams
  ): AutomaticReleaseEvaluationResult {
    const blockers: string[] = [];

    // 1. Tenant Ownership Invariant
    if (params.ownershipMismatch) {
      blockers.push('TENANT_OWNERSHIP_MISMATCH: Phone number does not belong exclusively to target organization.');
    }

    // 2. Active Port-Out Protection (CRITICAL INVARIANT)
    if (params.activePortOutPending) {
      blockers.push('ACTIVE_PORT_OUT_PENDING: Number is undergoing active port-away. Automatic release is strictly blocked.');
    }

    // 3. Provider Ambiguity & Unresolved Reconciliation Lock
    if (params.providerAmbiguityOrReconciliationRequired) {
      blockers.push('PROVIDER_AMBIGUITY_UNRESOLVED: Provider operation status is ambiguous or pending reconciliation.');
    }

    // 4. Legal / Regulatory Hold
    if (params.legalOrRegulatoryHold) {
      blockers.push('LEGAL_OR_REGULATORY_HOLD: Active legal or compliance hold is placed on number.');
    }

    // 5. Concurrent Destructive Operation Lock
    if (params.concurrentDestructiveOperation) {
      blockers.push('CONCURRENT_DESTRUCTIVE_OPERATION: Another operation is actively processing this phone number.');
    }

    // 6. Payment State Validation (Fail Closed on Unknown / Paid)
    const paymentState = params.paymentState || 'unknown';
    if (paymentState === 'paid') {
      blockers.push('PAYMENT_STATE_PAID: Subscription or rental payment is in good standing.');
    } else if (paymentState === 'unknown') {
      blockers.push('PAYMENT_STATE_UNKNOWN: Customer payment status is unverified or unknown. Fail closed.');
    }

    // 7. Lifecycle State Validation
    const numberStatus = (params.numberStatus || '').toLowerCase();
    const isStateEligible = ['suspended', 'unpaid', 'inactive'].includes(numberStatus);
    if (!isStateEligible) {
      blockers.push(`LIFECYCLE_STATE_INELIGIBLE: Number status '${params.numberStatus}' is not eligible for automatic abandonment release.`);
    }

    const eligible = blockers.length === 0;
    const reason = eligible
      ? 'Number meets all server-authoritative criteria for automatic abandonment release.'
      : `Automatic release blocked (${blockers.length} active blocker${blockers.length === 1 ? '' : 's'}).`;

    return {
      eligible,
      reason,
      blockers,
    };
  }
}
