import 'server-only';
import { CanonicalPurchaseOperationState } from '../domain/types';

/**
 * ==============================================================================
 * PHASE 23D.3: CANONICAL PURCHASE SAGA STATE MACHINE
 * ==============================================================================
 * Implements the exact frozen Phase 23C purchase state transitions.
 * 
 * CRITICAL DISTRIBUTED-SYSTEMS INVARIANTS:
 * 1. UNKNOWN ≠ FAILED. An unknown provider outcome cannot transition directly to FAILED.
 * 2. An unknown provider outcome MUST undergo reconciliation before any terminal action.
 * 3. Terminal states (CONFIRMED, FAILED) are immutable.
 * 4. PROVIDER_DISPATCH_PENDING must be committed durably before provider network call.
 */
export class PurchaseSagaStateMachine {
  private static readonly LEGAL_TRANSITIONS: Record<CanonicalPurchaseOperationState, CanonicalPurchaseOperationState[]> = {
    REQUESTED: ['VALIDATING', 'FAILED'],
    VALIDATING: ['AUTHORIZED', 'FAILED'],
    AUTHORIZED: ['PROVIDER_DISPATCH_PENDING', 'FAILED'],
    PROVIDER_DISPATCH_PENDING: ['PROVIDER_DISPATCHED', 'FAILED'],
    PROVIDER_DISPATCHED: ['CONFIRMED', 'PROVIDER_OUTCOME_UNKNOWN', 'FAILED'],
    PROVIDER_OUTCOME_UNKNOWN: ['RECONCILIATION_REQUIRED', 'MANUAL_REVIEW_REQUIRED'],
    RECONCILIATION_REQUIRED: ['CONFIRMED', 'FAILED', 'MANUAL_REVIEW_REQUIRED'],
    MANUAL_REVIEW_REQUIRED: ['CONFIRMED', 'FAILED'],
    CONFIRMED: [], // Terminal success
    FAILED: [], // Terminal failure
  };

  /**
   * Checks whether a transition between two states is legal according to 23C.
   */
  static isTransitionAllowed(
    fromState: CanonicalPurchaseOperationState,
    toState: CanonicalPurchaseOperationState
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
    fromState: CanonicalPurchaseOperationState,
    toState: CanonicalPurchaseOperationState
  ): void {
    if (!this.isTransitionAllowed(fromState, toState)) {
      throw new Error(
        `INVALID_PURCHASE_STATE_TRANSITION: Transition from '${fromState}' to '${toState}' is strictly forbidden by PurchaseSagaStateMachine.`
      );
    }
  }

  /**
   * Checks whether the state is terminal.
   */
  static isTerminalState(state: CanonicalPurchaseOperationState): boolean {
    return state === 'CONFIRMED' || state === 'FAILED';
  }

  /**
   * Checks whether the state represents an ambiguous / in-flight provider mutation outcome.
   */
  static isAmbiguousState(state: CanonicalPurchaseOperationState): boolean {
    return (
      state === 'PROVIDER_DISPATCHED' ||
      state === 'PROVIDER_OUTCOME_UNKNOWN' ||
      state === 'RECONCILIATION_REQUIRED' ||
      state === 'MANUAL_REVIEW_REQUIRED'
    );
  }

  /**
   * Maps canonical internal state to customer-safe status representation.
   */
  static mapToCustomerSafeStatus(state: CanonicalPurchaseOperationState): {
    customerStatus: 'processing' | 'confirmed' | 'failed' | 'reconciling' | 'action_required';
    customerMessage: string;
  } {
    switch (state) {
      case 'REQUESTED':
      case 'VALIDATING':
      case 'AUTHORIZED':
      case 'PROVIDER_DISPATCH_PENDING':
      case 'PROVIDER_DISPATCHED':
        return {
          customerStatus: 'processing',
          customerMessage: 'Processing phone number purchase.',
        };
      case 'CONFIRMED':
        return {
          customerStatus: 'confirmed',
          customerMessage: 'Phone number successfully acquired and added to workspace.',
        };
      case 'PROVIDER_OUTCOME_UNKNOWN':
      case 'RECONCILIATION_REQUIRED':
        return {
          customerStatus: 'reconciling',
          customerMessage: 'Carrier response pending. Reconciling phone number ownership.',
        };
      case 'MANUAL_REVIEW_REQUIRED':
        return {
          customerStatus: 'action_required',
          customerMessage: 'Purchase outcome requires administrative review.',
        };
      case 'FAILED':
      default:
        return {
          customerStatus: 'failed',
          customerMessage: 'Phone number purchase could not be completed.',
        };
    }
  }
}
