import 'server-only';
import { PortInCanonicalState } from './types';

/**
 * ==============================================================================
 * PHASE 23D.8B: CANONICAL PORT-IN STATE MACHINE
 * ==============================================================================
 * Explicit directed graph authority for Port-In lifecycle transitions.
 * Strict distributed-systems invariants:
 * - No naive numeric monotonic ordering.
 * - UNKNOWN != FAILED.
 * - Terminal states (COMPLETED, CANCELLED, FAILED_PRE_DISPATCH) cannot be reopened.
 * - UNKNOWN cannot transition directly to fresh submission without reconciliation.
 */

export class PortInStateMachine {
  private static readonly ALLOWED_TRANSITIONS: Record<PortInCanonicalState, PortInCanonicalState[]> = {
    DRAFT: [
      'REQUIREMENTS_PENDING',
      'CUSTOMER_ACTION_REQUIRED',
      'READY_FOR_SUBMISSION',
      'CANCELLED',
    ],
    REQUIREMENTS_PENDING: [
      'CUSTOMER_ACTION_REQUIRED',
      'READY_FOR_SUBMISSION',
      'MANUAL_REVIEW_REQUIRED',
      'CANCELLED',
    ],
    CUSTOMER_ACTION_REQUIRED: [
      'READY_FOR_SUBMISSION',
      'MANUAL_REVIEW_REQUIRED',
      'CANCELLED',
    ],
    READY_FOR_SUBMISSION: [
      'SUBMISSION_PENDING',
      'CUSTOMER_ACTION_REQUIRED',
      'MANUAL_REVIEW_REQUIRED',
      'CANCELLED',
    ],
    SUBMISSION_PENDING: [
      'SUBMITTED',
      'PROVIDER_OUTCOME_UNKNOWN',
      'FAILED_PRE_DISPATCH',
      'MANUAL_REVIEW_REQUIRED',
    ],
    SUBMITTED: [
      'UNDER_REVIEW',
      'REMEDIATION_REQUIRED',
      'FOC_CONFIRMED',
      'PORTING',
      'MANUAL_REVIEW_REQUIRED',
      'CANCELLED',
    ],
    UNDER_REVIEW: [
      'REMEDIATION_REQUIRED',
      'FOC_CONFIRMED',
      'PORTING',
      'MANUAL_REVIEW_REQUIRED',
      'CANCELLED',
    ],
    REMEDIATION_REQUIRED: [
      'CUSTOMER_ACTION_REQUIRED',
      'READY_FOR_SUBMISSION',
      'MANUAL_REVIEW_REQUIRED',
      'CANCELLED',
    ],
    FOC_CONFIRMED: [
      'PORTING',
      'COMPLETED',
      'REMEDIATION_REQUIRED',
      'MANUAL_REVIEW_REQUIRED',
      'CANCELLED',
    ],
    PORTING: [
      'COMPLETED',
      'REMEDIATION_REQUIRED',
      'MANUAL_REVIEW_REQUIRED',
    ],
    PROVIDER_OUTCOME_UNKNOWN: [
      'SUBMITTED',             // Confirmed received on provider reconciliation
      'FAILED_PRE_DISPATCH',   // Confirmed never received by provider
      'MANUAL_REVIEW_REQUIRED',
    ],
    MANUAL_REVIEW_REQUIRED: [
      'CUSTOMER_ACTION_REQUIRED',
      'READY_FOR_SUBMISSION',
      'SUBMITTED',
      'FOC_CONFIRMED',
      'PORTING',
      'COMPLETED',
      'CANCELLED',
    ],
    COMPLETED: [], // Terminal
    CANCELLED: [], // Terminal
    FAILED_PRE_DISPATCH: [], // Terminal
  };

  /**
   * Evaluates whether a transition from currentState to targetState is permitted.
   */
  static isValidTransition(
    currentState: PortInCanonicalState,
    targetState: PortInCanonicalState
  ): boolean {
    if (currentState === targetState) {
      return true; // Idempotent same-state is allowed
    }
    const allowed = this.ALLOWED_TRANSITIONS[currentState] || [];
    return allowed.includes(targetState);
  }

  /**
   * Asserts that a state transition is valid, throwing an explicit error if violated.
   */
  static assertTransition(
    currentState: PortInCanonicalState,
    targetState: PortInCanonicalState
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
        `INVALID_PORT_IN_TRANSITION: Transition from ${currentState} to ${targetState} is not permitted by canonical directed graph.`
      );
    }
  }

  static isTerminalState(state: PortInCanonicalState): boolean {
    return state === 'COMPLETED' || state === 'CANCELLED' || state === 'FAILED_PRE_DISPATCH';
  }

  static isTerminal(state: PortInCanonicalState): boolean {
    return this.isTerminalState(state);
  }

  static isNonUsableServiceState(state: PortInCanonicalState): boolean {
    // Port-In never grants USABLE capabilities before COMPLETED
    return state !== 'COMPLETED';
  }
}
