import 'server-only';
import { CanonicalReleaseOperationState, ProviderOutcomeCertainty } from '../domain/types';

/**
 * ==============================================================================
 * PHASE 23D.6: CANONICAL RELEASE SAGA STATE MACHINE
 * ==============================================================================
 * Implements the exact frozen Phase 23C release state transitions.
 * 
 * CRITICAL DESTRUCTIVE-OPERATION SAFETY INVARIANTS:
 * 1. UNKNOWN ≠ FAILED. An unknown provider outcome cannot transition directly to FAILED.
 * 2. An unknown provider outcome MUST undergo reconciliation before any terminal action.
 * 3. Terminal states (RELEASED, FAILED) are immutable.
 * 4. PROVIDER_RELEASE_PENDING must be committed durably before provider network call.
 * 5. UNKNOWN RELEASE OUTCOME MUST NEVER TRIGGER A BLIND SECOND RELEASE MUTATION.
 */
export class ReleaseSagaStateMachine {
  private static readonly LEGAL_TRANSITIONS: Record<CanonicalReleaseOperationState, CanonicalReleaseOperationState[]> = {
    REQUESTED: ['VALIDATING', 'BLOCKED', 'FAILED'],
    VALIDATING: ['AUTHORIZED', 'BLOCKED', 'FAILED'],
    BLOCKED: ['REQUESTED', 'FAILED'],
    AUTHORIZED: ['PROVIDER_RELEASE_PENDING', 'BLOCKED', 'FAILED'],
    PROVIDER_RELEASE_PENDING: ['CONFIRMED', 'PROVIDER_OUTCOME_UNKNOWN', 'FAILED'],
    PROVIDER_OUTCOME_UNKNOWN: ['CONFIRMED', 'FAILED'],
    CONFIRMED: ['LOCAL_FINALIZATION', 'RELEASED'],
    LOCAL_FINALIZATION: ['RELEASED', 'FAILED'],
    RELEASED: [], // Terminal success
    FAILED: [],   // Terminal failure
  };

  /**
   * Checks whether a transition between two states is legal according to 23C.
   */
  static isTransitionAllowed(
    fromState: CanonicalReleaseOperationState,
    toState: CanonicalReleaseOperationState
  ): boolean {
    if (fromState === toState) return true; // Idempotent no-op
    const allowed = this.LEGAL_TRANSITIONS[fromState];
    if (!allowed) return false;
    return allowed.includes(toState);
  }

  /**
   * Asserts transition legality; throws descriptive fail-closed error if forbidden.
   */
  static assertTransitionAllowed(
    fromState: CanonicalReleaseOperationState,
    toState: CanonicalReleaseOperationState
  ): void {
    if (!this.isTransitionAllowed(fromState, toState)) {
      throw new Error(
        `INVALID_RELEASE_STATE_TRANSITION: Transition from '${fromState}' to '${toState}' is strictly forbidden by ReleaseSagaStateMachine.`
      );
    }
  }

  /**
   * Checks whether the state is terminal.
   */
  static isTerminalState(state: CanonicalReleaseOperationState): boolean {
    return state === 'RELEASED' || state === 'FAILED';
  }

  /**
   * Checks whether the state represents an ambiguous / in-flight provider mutation outcome.
   */
  static isAmbiguousState(state: CanonicalReleaseOperationState): boolean {
    return state === 'PROVIDER_OUTCOME_UNKNOWN';
  }

  /**
   * Maps canonical internal state to customer-safe status representation.
   */
  static mapToCustomerSafeStatus(
    state: CanonicalReleaseOperationState,
    outcomeCertainty?: ProviderOutcomeCertainty | null,
    blockReason?: string | null
  ): {
    customerStatus:
      | 'RELEASE_ACCEPTED'
      | 'RELEASE_BLOCKED_ACTIVE_TRAFFIC'
      | 'RELEASE_BLOCKED_PORTING'
      | 'RELEASE_UNDER_RECONCILIATION'
      | 'RELEASE_CONFIRMED'
      | 'MANUAL_REVIEW_REQUIRED'
      | 'RELEASE_FAILED';
    customerMessage: string;
  } {
    if (state === 'BLOCKED') {
      if (blockReason?.includes('PORT')) {
        return {
          customerStatus: 'RELEASE_BLOCKED_PORTING',
          customerMessage: 'Cannot release phone number with an active port order.',
        };
      }
      return {
        customerStatus: 'RELEASE_BLOCKED_ACTIVE_TRAFFIC',
        customerMessage: 'Cannot release phone number while a call or session is active.',
      };
    }

    if (outcomeCertainty === 'MANUAL_REVIEW_REQUIRED') {
      return {
        customerStatus: 'MANUAL_REVIEW_REQUIRED',
        customerMessage: 'Release requires administrative manual review.',
      };
    }

    switch (state) {
      case 'REQUESTED':
      case 'VALIDATING':
      case 'AUTHORIZED':
      case 'PROVIDER_RELEASE_PENDING':
        return {
          customerStatus: 'RELEASE_ACCEPTED',
          customerMessage: 'Processing phone number release.',
        };
      case 'CONFIRMED':
      case 'LOCAL_FINALIZATION':
      case 'RELEASED':
        return {
          customerStatus: 'RELEASE_CONFIRMED',
          customerMessage: 'Phone number successfully released from workspace.',
        };
      case 'PROVIDER_OUTCOME_UNKNOWN':
        return {
          customerStatus: 'RELEASE_UNDER_RECONCILIATION',
          customerMessage: 'Release confirmation in progress. Traffic remains blocked until reconciliation completes.',
        };
      case 'FAILED':
      default:
        return {
          customerStatus: 'RELEASE_FAILED',
          customerMessage: 'Phone number release request failed.',
        };
    }
  }
}
