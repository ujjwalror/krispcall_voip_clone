/**
 * Phase 13.3.1 Commercial Saga State Machine (Hardened)
 * Authoritative state machine for commercial number purchase saga lifecycle.
 */

export type CommercialSagaState =
  | 'awaiting_authorization'
  | 'authorized'
  | 'provisioning_claimed'
  | 'provisioning_in_progress'
  | 'provider_reconciliation_required'
  | 'ownership_confirmed'
  | 'capture_pending'
  | 'completed'
  | 'authorization_cancel_pending'
  | 'authorization_canceled'
  | 'financial_reconciliation_required'
  | 'manual_review_required'
  | 'failed';

export interface CustomerSagaStatusDTO {
  state: CommercialSagaState;
  customerTitle: string;
  customerDescription: string;
  isTerminal: boolean;
  isSuccess: boolean;
}

export class CommercialSagaStateMachine {
  /**
   * Explicit map of legal state transitions.
   * HARDENED DEFECT 3 FIX: Generic terminal 'failed' transitions removed after payment authorization exists.
   * Prevents stranding authorization holds or erasing reconciliation requirements.
   */
  private static readonly LEGAL_TRANSITIONS: Record<CommercialSagaState, CommercialSagaState[]> = {
    awaiting_authorization: ['authorized', 'authorization_canceled', 'failed'],
    authorized: ['provisioning_claimed', 'authorization_cancel_pending'], // 'failed' removed: holds must be released via authorization_cancel_pending
    provisioning_claimed: ['provisioning_in_progress', 'authorization_cancel_pending'], // 'failed' removed: holds must be released via authorization_cancel_pending
    provisioning_in_progress: ['ownership_confirmed', 'provider_reconciliation_required', 'authorization_cancel_pending'],
    provider_reconciliation_required: ['ownership_confirmed', 'authorization_cancel_pending', 'manual_review_required'],
    ownership_confirmed: ['capture_pending', 'financial_reconciliation_required'],
    capture_pending: ['completed', 'financial_reconciliation_required'],
    financial_reconciliation_required: ['completed', 'manual_review_required'],
    authorization_cancel_pending: ['authorization_canceled', 'manual_review_required'],
    manual_review_required: ['completed', 'authorization_canceled', 'failed'], // Manual admin resolution only
    completed: [], // Terminal success - no outgoing transitions allowed
    authorization_canceled: [], // Terminal non-success - no outgoing transitions allowed
    failed: [], // Terminal failure - no outgoing transitions allowed
  };

  /**
   * Validates whether a state transition from `fromState` to `toState` is allowed.
   */
  static isTransitionAllowed(fromState: CommercialSagaState, toState: CommercialSagaState): boolean {
    const allowed = this.LEGAL_TRANSITIONS[fromState];
    if (!allowed) return false;
    return allowed.includes(toState);
  }

  /**
   * Asserts that a state transition is legal, throwing a descriptive Error if illegal.
   */
  static assertTransitionAllowed(fromState: CommercialSagaState, toState: CommercialSagaState): void {
    if (!this.isTransitionAllowed(fromState, toState)) {
      throw new Error(
        `INVALID_SAGA_STATE_TRANSITION: Transition from '${fromState}' to '${toState}' is strictly forbidden by CommercialSagaStateMachine.`
      );
    }
  }

  /**
   * Returns true if the state is terminal (no further transitions permitted).
   */
  static isTerminalState(state: CommercialSagaState): boolean {
    return state === 'completed' || state === 'authorization_canceled' || state === 'failed';
  }

  /**
   * Returns true strictly for canonical 'completed' state.
   * `manual_review_required` and `financial_reconciliation_required` are NEVER success states.
   */
  static isSuccessState(state: CommercialSagaState): boolean {
    return state === 'completed';
  }

  /**
   * Returns true if the state requires background worker polling or manual administrative review.
   */
  static isUnresolvedState(state: CommercialSagaState): boolean {
    return (
      state === 'awaiting_authorization' ||
      state === 'authorized' ||
      state === 'provisioning_claimed' ||
      state === 'provisioning_in_progress' ||
      state === 'provider_reconciliation_required' ||
      state === 'ownership_confirmed' ||
      state === 'capture_pending' ||
      state === 'authorization_cancel_pending' ||
      state === 'financial_reconciliation_required' ||
      state === 'manual_review_required'
    );
  }

  /**
   * Maps a saga state to a customer-safe DTO.
   * Sanitizes all provider internals, SIDs, PaymentIntent IDs, and technical failure details.
   */
  static mapStateToCustomerDTO(state: CommercialSagaState): CustomerSagaStatusDTO {
    switch (state) {
      case 'awaiting_authorization':
        return {
          state,
          customerTitle: 'Preparing Checkout',
          customerDescription: 'Initializing secure checkout authorization...',
          isTerminal: false,
          isSuccess: false,
        };
      case 'authorized':
      case 'provisioning_claimed':
      case 'provisioning_in_progress':
        return {
          state,
          customerTitle: 'Securing Your Number',
          customerDescription: 'Payment authorization verified. Securing your requested phone number...',
          isTerminal: false,
          isSuccess: false,
        };
      case 'provider_reconciliation_required':
        return {
          state,
          customerTitle: 'Confirming Line Activation',
          customerDescription: 'Confirming line assignment with telecom provider. Please wait...',
          isTerminal: false,
          isSuccess: false,
        };
      case 'ownership_confirmed':
      case 'capture_pending':
        return {
          state,
          customerTitle: 'Finalizing Purchase',
          customerDescription: 'Phone line secured. Finalizing commercial transaction...',
          isTerminal: false,
          isSuccess: false,
        };
      case 'completed':
        return {
          state,
          customerTitle: 'Number Activated',
          customerDescription: 'Your phone number has been successfully assigned and activated for your workspace.',
          isTerminal: true,
          isSuccess: true,
        };
      case 'authorization_cancel_pending':
        return {
          state,
          customerTitle: 'Canceling Purchase',
          customerDescription: 'We were unable to complete the purchase. Requesting payment authorization cancellation...',
          isTerminal: false,
          isSuccess: false,
        };
      case 'authorization_canceled':
        return {
          state,
          customerTitle: 'Purchase Canceled',
          customerDescription: 'We were unable to complete the purchase. Payment authorization hold has been released.',
          isTerminal: true,
          isSuccess: false,
        };
      case 'financial_reconciliation_required':
      case 'manual_review_required':
        return {
          state,
          customerTitle: 'Activation Under Review',
          customerDescription: 'Your number has been secured. Our team is finalizing account setup.',
          isTerminal: false,
          isSuccess: false,
        };
      case 'failed':
      default:
        return {
          state,
          customerTitle: 'Purchase Failed',
          customerDescription: 'We were unable to complete the purchase.',
          isTerminal: true,
          isSuccess: false,
        };
    }
  }
}
