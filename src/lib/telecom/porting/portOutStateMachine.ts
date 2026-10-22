import 'server-only';
import { PortOutCanonicalState } from './types';

/**
 * ==============================================================================
 * PHASE 23D.8B: CANONICAL PORT-OUT STATE MACHINE
 * ==============================================================================
 * Explicit directed graph authority for Port-Out lifecycle transitions.
 * Supports externally-detected requests and customer-initiated preparation.
 * Strict anti-fraud and anti-slamming invariants:
 * - PORT_OUT != RELEASE.
 * - Terminal states cannot be reopened.
 * - Out-of-order stale webhooks cannot downgrade COMPLETED.
 */

export class PortOutStateMachine {
  private static readonly ALLOWED_TRANSITIONS: Record<PortOutCanonicalState, PortOutCanonicalState[]> = {
    DETECTED: [
      'AUTHORIZATION_REQUIRED',
      'SECURITY_REVIEW',
      'PROVIDER_PROCESSING',
      'PORTING',
      'COMPLETED',
      'DISPUTED',
      'MANUAL_REVIEW_REQUIRED',
      'CANCELLED',
    ],
    REQUESTED: [
      'AUTHORIZATION_REQUIRED',
      'SECURITY_REVIEW',
      'REJECTED_FRAUD_LOCK',
      'AUTHORIZED',
      'CANCELLED',
    ],
    AUTHORIZATION_REQUIRED: [
      'SECURITY_REVIEW',
      'REJECTED_FRAUD_LOCK',
      'AUTHORIZED',
      'CANCELLED',
    ],
    SECURITY_REVIEW: [
      'AUTHORIZED',
      'REJECTED_FRAUD_LOCK',
      'MANUAL_REVIEW_REQUIRED',
      'CANCELLED',
    ],
    AUTHORIZED: [
      'INSTRUCTIONS_ISSUED',
      'PROVIDER_PROCESSING',
      'PORTING',
      'MANUAL_REVIEW_REQUIRED',
      'CANCELLED',
    ],
    INSTRUCTIONS_ISSUED: [
      'PROVIDER_PROCESSING',
      'PORTING',
      'ACTION_REQUIRED',
      'DISPUTED',
      'MANUAL_REVIEW_REQUIRED',
      'CANCELLED',
    ],
    PROVIDER_PROCESSING: [
      'ACTION_REQUIRED',
      'PORTING',
      'COMPLETED',
      'DISPUTED',
      'MANUAL_REVIEW_REQUIRED',
      'CANCELLED',
    ],
    ACTION_REQUIRED: [
      'PROVIDER_PROCESSING',
      'PORTING',
      'COMPLETED',
      'DISPUTED',
      'MANUAL_REVIEW_REQUIRED',
      'CANCELLED',
    ],
    PORTING: [
      'COMPLETED',
      'DISPUTED',
      'MANUAL_REVIEW_REQUIRED',
    ],
    PROVIDER_OUTCOME_UNKNOWN: [
      'PROVIDER_PROCESSING',
      'PORTING',
      'COMPLETED',
      'MANUAL_REVIEW_REQUIRED',
      'CANCELLED',
    ],
    MANUAL_REVIEW_REQUIRED: [
      'AUTHORIZED',
      'PROVIDER_PROCESSING',
      'PORTING',
      'COMPLETED',
      'DISPUTED',
      'CANCELLED',
    ],
    DISPUTED: [
      'CANCELLED',
      'PROVIDER_PROCESSING', // Dispute resolved/withdrawn
      'MANUAL_REVIEW_REQUIRED',
    ],
    COMPLETED: [], // Terminal
    CANCELLED: [], // Terminal
    REJECTED_FRAUD_LOCK: [], // Terminal
  };

  /**
   * Evaluates whether a transition from currentState to targetState is permitted.
   */
  static isValidTransition(
    currentState: PortOutCanonicalState,
    targetState: PortOutCanonicalState
  ): boolean {
    if (currentState === targetState) {
      return true;
    }
    const allowed = this.ALLOWED_TRANSITIONS[currentState] || [];
    return allowed.includes(targetState);
  }

  /**
   * Asserts that a state transition is valid, throwing an explicit error if violated.
   */
  static assertTransition(
    currentState: PortOutCanonicalState,
    targetState: PortOutCanonicalState
  ): void {
    if (currentState === targetState) {
      return;
    }

    if (this.isTerminalState(currentState)) {
      throw new Error(
        `TERMINAL_STATE_VIOLATION: Cannot transition from terminal state ${currentState} to ${targetState}.`
      );
    }

    if (!this.isValidTransition(currentState, targetState)) {
      throw new Error(
        `INVALID_PORT_OUT_TRANSITION: Transition from ${currentState} to ${targetState} is not permitted by canonical directed graph.`
      );
    }
  }

  static isTerminalState(state: PortOutCanonicalState): boolean {
    return state === 'COMPLETED' || state === 'CANCELLED' || state === 'REJECTED_FRAUD_LOCK';
  }

  static isTerminal(state: PortOutCanonicalState): boolean {
    return this.isTerminalState(state);
  }

  static isActivePortOutState(state: PortOutCanonicalState): boolean {
    return (
      state === 'DETECTED' ||
      state === 'REQUESTED' ||
      state === 'AUTHORIZATION_REQUIRED' ||
      state === 'SECURITY_REVIEW' ||
      state === 'AUTHORIZED' ||
      state === 'INSTRUCTIONS_ISSUED' ||
      state === 'PROVIDER_PROCESSING' ||
      state === 'ACTION_REQUIRED' ||
      state === 'PORTING' ||
      state === 'PROVIDER_OUTCOME_UNKNOWN' ||
      state === 'MANUAL_REVIEW_REQUIRED'
    );
  }
}
