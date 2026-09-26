import { PaymentCanonicalStatus } from './types';

const ALLOWED_TRANSITIONS: Record<PaymentCanonicalStatus, PaymentCanonicalStatus[]> = {
  pending: [
    'requires_customer_action',
    'authorized',
    'failed',
    'canceled',
    'reconciliation_required',
  ],
  requires_customer_action: [
    'authorized',
    'failed',
    'canceled',
    'reconciliation_required',
  ],
  authorized: [
    'capture_pending',
    'captured',
    'cancel_pending',
    'canceled',
    'reconciliation_required',
    'manual_review_required',
  ],
  capture_pending: [
    'captured',
    'failed',
    'reconciliation_required',
    'manual_review_required',
  ],
  captured: [
    'refund_pending',
    'refunded',
    'partially_refunded',
    'reconciliation_required',
    'manual_review_required',
  ],
  cancel_pending: [
    'canceled',
    'failed',
    'reconciliation_required',
    'manual_review_required',
  ],
  canceled: ['reconciliation_required'],
  failed: ['reconciliation_required'],
  refund_pending: [
    'refunded',
    'partially_refunded',
    'failed',
    'reconciliation_required',
    'manual_review_required',
  ],
  partially_refunded: [
    'refund_pending',
    'refunded',
    'reconciliation_required',
    'manual_review_required',
  ],
  refunded: [],
  reconciliation_required: [
    'pending',
    'requires_customer_action',
    'authorized',
    'capture_pending',
    'captured',
    'cancel_pending',
    'canceled',
    'failed',
    'refund_pending',
    'partially_refunded',
    'refunded',
    'manual_review_required',
  ],
  manual_review_required: [
    'captured',
    'canceled',
    'refunded',
    'failed',
    'reconciliation_required',
  ],
};

export class PaymentStateMachine {
  /**
   * Validates if a transition from currentStatus to targetStatus is permitted.
   */
  static isTransitionAllowed(
    currentStatus: PaymentCanonicalStatus,
    targetStatus: PaymentCanonicalStatus
  ): boolean {
    if (currentStatus === targetStatus) {
      return true; // No-op transition
    }

    const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
    return allowed.includes(targetStatus);
  }

  /**
   * Enforces transition. Throws Error if transition is invalid.
   */
  static validateTransition(
    currentStatus: PaymentCanonicalStatus,
    targetStatus: PaymentCanonicalStatus
  ): void {
    if (!this.isTransitionAllowed(currentStatus, targetStatus)) {
      throw new Error(
        `INVALID_PAYMENT_STATE_TRANSITION: Cannot transition payment operation from '${currentStatus}' to '${targetStatus}'.`
      );
    }
  }

  /**
   * Checks if status is terminal (canceled or refunded).
   */
  static isTerminalState(status: PaymentCanonicalStatus): boolean {
    return status === 'refunded' || status === 'canceled';
  }
}
