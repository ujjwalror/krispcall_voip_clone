// ============================================================================
// PUBLIC SAAS PHASE 13.4.3B.2E — PROVIDER CALL CONTROL ADAPTER ABSTRACTION
// Server-only abstraction for active call timeLimit updates and forced hangups.
// Strategy tag: UNVERIFIED_FOR_ACTIVE_DIAL_EXTENSION
// ============================================================================

import twilio from 'twilio';

export type ProviderResultClassification =
  | 'DEFINITE_SUCCESS'
  | 'DEFINITE_PRE_DISPATCH_FAILURE'
  | 'DEFINITE_PROVIDER_REJECTION'
  | 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH'
  | 'READBACK_CONFIRMED_SUCCESS'
  | 'READBACK_CONFIRMED_ABSENT_OR_UNCHANGED';

export interface ActiveCallAllowanceParams {
  callSid: string;
  newTimeLimitSeconds: number;
  idempotencyKey: string;
  remainingLeaseSeconds?: number;
}

export interface ActiveCallAllowanceResult {
  success: boolean;
  effectiveTimeLimitSeconds: number;
  statusClassification: ProviderResultClassification;
  providerAccepted: boolean;
  dialExtensionEmpiricallyConfirmed: boolean;
  isMock: boolean;
  rawResponse?: any;
  errorDetails?: string;
}

export interface ActiveCallTerminateParams {
  callSid: string;
  reason: string;
}

export interface ActiveCallTerminateResult {
  success: boolean;
  isMock: boolean;
  reason?: string;
  errorDetails?: string;
}

export interface ActiveCallFetchParams {
  callSid: string;
  expectedTimeLimitSeconds?: number;
  maxObservations?: number;
}

export interface ActiveCallFetchResult {
  callSid: string;
  status: string;
  timeLimitSeconds?: number;
  statusClassification: 'READBACK_CONFIRMED_SUCCESS' | 'READBACK_CONFIRMED_ABSENT_OR_UNCHANGED' | 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH';
  isMock: boolean;
  errorDetails?: string;
}

export interface TwilioCallControlAdapter {
  extendActiveCallAllowance(params: ActiveCallAllowanceParams): Promise<ActiveCallAllowanceResult>;
  terminateActiveCall(params: ActiveCallTerminateParams): Promise<ActiveCallTerminateResult>;
  fetchActiveCallState(params: ActiveCallFetchParams): Promise<ActiveCallFetchResult>;
}

/**
 * Master Server-only Provider Mutation Gate.
 * Default is FALSE. Live mutations are prohibited unless explicitly enabled in authorized sandbox runs.
 */
export function isProviderMutationGateEnabled(): boolean {
  const envVal = process.env.TELECOM_ACTIVE_CALL_PROVIDER_MUTATIONS_ENABLED || process.env.TELECOM_VOICE_MUTATION_ALLOW_UPDATE;
  return envVal === 'true' || envVal === '1';
}

/**
 * Scoped Mutation Gate: Extension Allowance
 */
export function isExtendAllowanceScopeEnabled(): boolean {
  const envVal = process.env.TELECOM_EXPERIMENT_SCOPE_EXTEND_ALLOWANCE;
  return envVal === 'true' || envVal === '1';
}

/**
 * Scoped Mutation Gate: Call Termination
 */
export function isTerminateCallScopeEnabled(): boolean {
  const envVal = process.env.TELECOM_EXPERIMENT_SCOPE_TERMINATE_CALL;
  return envVal === 'true' || envVal === '1';
}

/**
 * Pre-dispatch Lease Safety Verification
 */
export function validatePreDispatchLeaseSafety(options: {
  remainingLeaseSeconds: number;
  requestTimeoutMs?: number;
  readbackBudgetMs?: number;
  terminationBudgetMs?: number;
  safetyMarginMs?: number;
}): { safe: boolean; requiredSafetySeconds: number; remainingLeaseSeconds: number } {
  const reqMs = options.requestTimeoutMs ?? 10000;
  const readMs = options.readbackBudgetMs ?? 5000;
  const termMs = options.terminationBudgetMs ?? 5000;
  const marginMs = options.safetyMarginMs ?? 10000;

  const requiredSafetySeconds = Math.ceil((reqMs + readMs + termMs + marginMs) / 1000);
  const safe = options.remainingLeaseSeconds >= requiredSafetySeconds;

  return {
    safe,
    requiredSafetySeconds,
    remainingLeaseSeconds: options.remainingLeaseSeconds,
  };
}

/**
 * Mock implementation of TwilioCallControlAdapter for Level 1 simulation and testing.
 */
export class MockTwilioCallControlAdapter implements TwilioCallControlAdapter {
  private mockBehaviors: Map<string, ProviderResultClassification> = new Map();
  private mockReadBacks: Map<string, 'READBACK_CONFIRMED_SUCCESS' | 'READBACK_CONFIRMED_ABSENT_OR_UNCHANGED'> = new Map();
  public dispatchCount: number = 0;
  private defaultClassification: ProviderResultClassification;

  constructor(options: { defaultClassification?: ProviderResultClassification; forcedResult?: ProviderResultClassification } = {}) {
    this.defaultClassification = options.forcedResult || options.defaultClassification || 'DEFINITE_SUCCESS';
  }

  setMockBehavior(callSid: string, classification: ProviderResultClassification) {
    this.mockBehaviors.set(callSid, classification);
  }

  setMockReadBack(callSid: string, result: 'READBACK_CONFIRMED_SUCCESS' | 'READBACK_CONFIRMED_ABSENT_OR_UNCHANGED') {
    this.mockReadBacks.set(callSid, result);
  }

  async extendActiveCallAllowance(params: ActiveCallAllowanceParams): Promise<ActiveCallAllowanceResult> {
    this.dispatchCount++;
    const configuredBehavior = this.mockBehaviors.get(params.callSid) || this.defaultClassification;

    if (configuredBehavior === 'DEFINITE_SUCCESS') {
      return {
        success: true,
        effectiveTimeLimitSeconds: params.newTimeLimitSeconds,
        statusClassification: 'DEFINITE_SUCCESS',
        providerAccepted: true,
        dialExtensionEmpiricallyConfirmed: false,
        isMock: true,
        rawResponse: { callSid: params.callSid, timeLimit: params.newTimeLimitSeconds, status: 'in-progress' },
      };
    }

    if (configuredBehavior === 'READBACK_CONFIRMED_SUCCESS') {
      return {
        success: true,
        effectiveTimeLimitSeconds: params.newTimeLimitSeconds,
        statusClassification: 'READBACK_CONFIRMED_SUCCESS',
        providerAccepted: true,
        dialExtensionEmpiricallyConfirmed: false,
        isMock: true,
      };
    }

    if (configuredBehavior === 'READBACK_CONFIRMED_ABSENT_OR_UNCHANGED') {
      return {
        success: false,
        effectiveTimeLimitSeconds: 0,
        statusClassification: 'READBACK_CONFIRMED_ABSENT_OR_UNCHANGED',
        providerAccepted: false,
        dialExtensionEmpiricallyConfirmed: false,
        isMock: true,
        errorDetails: 'Readback confirmed call duration unchanged',
      };
    }

    if (configuredBehavior === 'DEFINITE_PROVIDER_REJECTION' || configuredBehavior === 'DEFINITE_PRE_DISPATCH_FAILURE') {
      return {
        success: false,
        effectiveTimeLimitSeconds: 0,
        statusClassification: configuredBehavior,
        providerAccepted: false,
        dialExtensionEmpiricallyConfirmed: false,
        isMock: true,
        errorDetails: 'Mock Provider Rejected Call Resource Update (400)',
      };
    }

    if (configuredBehavior === 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH') {
      return {
        success: false,
        effectiveTimeLimitSeconds: 0,
        statusClassification: 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH',
        providerAccepted: false,
        dialExtensionEmpiricallyConfirmed: false,
        isMock: true,
        errorDetails: 'Mock Provider HTTP Gateway Timeout (504)',
      };
    }

    return {
      success: true,
      effectiveTimeLimitSeconds: params.newTimeLimitSeconds,
      statusClassification: 'DEFINITE_SUCCESS',
      providerAccepted: true,
      dialExtensionEmpiricallyConfirmed: false,
      isMock: true,
    };
  }

  async terminateActiveCall(params: ActiveCallTerminateParams): Promise<ActiveCallTerminateResult> {
    return {
      success: true,
      isMock: true,
      reason: params.reason,
    };
  }

  async fetchActiveCallState(params: ActiveCallFetchParams): Promise<ActiveCallFetchResult> {
    const configuredReadBack = this.mockReadBacks.get(params.callSid) || 'READBACK_CONFIRMED_SUCCESS';
    return {
      callSid: params.callSid,
      status: 'in-progress',
      timeLimitSeconds: configuredReadBack === 'READBACK_CONFIRMED_SUCCESS' ? 120 : 60,
      statusClassification: configuredReadBack,
      isMock: true,
    };
  }
}

/**
 * Real Twilio Call Control Adapter implementation behind multi-gated safety.
 * Strategy tag: UNVERIFIED_FOR_ACTIVE_DIAL_EXTENSION
 * Disables SDK-level automatic retries (autoRetry: false, maxRetries: 0).
 */
export class RealTwilioCallControlAdapter implements TwilioCallControlAdapter {
  private client: twilio.Twilio | null = null;

  constructor() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (accountSid && authToken) {
      // Disables transparent SDK-level mutation retries
      this.client = twilio(accountSid, authToken, {
        timeout: 10000,
        autoRetry: false,
        maxRetries: 0,
      });
    }
  }

  async extendActiveCallAllowance(params: ActiveCallAllowanceParams): Promise<ActiveCallAllowanceResult> {
    // 1. PRE-DISPATCH SAFETY & GATE CHECKS (Definite Pre-Dispatch Failures)
    if (!isProviderMutationGateEnabled()) {
      return {
        success: false,
        effectiveTimeLimitSeconds: 0,
        statusClassification: 'DEFINITE_PRE_DISPATCH_FAILURE',
        providerAccepted: false,
        dialExtensionEmpiricallyConfirmed: false,
        isMock: false,
        errorDetails: 'MASTER_MUTATION_GATE_DISABLED: TELECOM_ACTIVE_CALL_PROVIDER_MUTATIONS_ENABLED is false',
      };
    }

    if (!isExtendAllowanceScopeEnabled()) {
      return {
        success: false,
        effectiveTimeLimitSeconds: 0,
        statusClassification: 'DEFINITE_PRE_DISPATCH_FAILURE',
        providerAccepted: false,
        dialExtensionEmpiricallyConfirmed: false,
        isMock: false,
        errorDetails: 'SCOPED_MUTATION_GATE_DISABLED: TELECOM_EXPERIMENT_SCOPE_EXTEND_ALLOWANCE is false',
      };
    }

    if (params.remainingLeaseSeconds !== undefined) {
      const leaseSafety = validatePreDispatchLeaseSafety({ remainingLeaseSeconds: params.remainingLeaseSeconds });
      if (!leaseSafety.safe) {
        return {
          success: false,
          effectiveTimeLimitSeconds: 0,
          statusClassification: 'DEFINITE_PRE_DISPATCH_FAILURE',
          providerAccepted: false,
          dialExtensionEmpiricallyConfirmed: false,
          isMock: false,
          errorDetails: `INSUFFICIENT_LEASE_REMAINING: Lease remaining (${params.remainingLeaseSeconds}s) < required (${leaseSafety.requiredSafetySeconds}s)`,
        };
      }
    }

    if (!this.client) {
      return {
        success: false,
        effectiveTimeLimitSeconds: 0,
        statusClassification: 'DEFINITE_PRE_DISPATCH_FAILURE',
        providerAccepted: false,
        dialExtensionEmpiricallyConfirmed: false,
        isMock: false,
        errorDetails: 'TWILIO_CLIENT_NOT_INITIALIZED: Missing Account SID or Auth Token',
      };
    }

    // 2. EXECUTE BOUNDED TWILIO REST API CALL (POST /Calls/{CallSid})
    try {
      const timeoutMs = 10000; // 10s request timeout
      const updatePromise = this.client.calls(params.callSid).update({
        timeLimit: params.newTimeLimitSeconds,
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('TWILIO_API_TIMEOUT_10S')), timeoutMs)
      );

      const response: any = await Promise.race([updatePromise, timeoutPromise]);

      // HTTP 200 OK proves provider accepted update request, but NOT empirical Dial extension verification
      return {
        success: true,
        effectiveTimeLimitSeconds: params.newTimeLimitSeconds,
        statusClassification: 'DEFINITE_SUCCESS',
        providerAccepted: true,
        dialExtensionEmpiricallyConfirmed: false, // Must be empirically observed in Level 2B bridge cross
        isMock: false,
        rawResponse: { sid: response.sid, status: response.status, duration: response.duration },
      };
    } catch (err: any) {
      console.warn(`[RealTwilioCallControlAdapter] Extension dispatch error for ${params.callSid}: ${err.message}`);

      // Explicit HTTP 4xx authoritatively rejected by Twilio API before socket mutation
      if (err.status >= 400 && err.status < 500) {
        return {
          success: false,
          effectiveTimeLimitSeconds: 0,
          statusClassification: 'DEFINITE_PROVIDER_REJECTION',
          providerAccepted: false,
          dialExtensionEmpiricallyConfirmed: false,
          isMock: false,
          errorDetails: `HTTP_${err.status}_${err.message}`,
        };
      }

      // Once request MAY have reached network socket (timeout, 5xx, ECONNRESET, AbortError, connection loss):
      // MUST BE CLASSIFIED AS AMBIGUOUS_TIMEOUT_AFTER_DISPATCH. ZERO IMMEDIATE ROLLBACK.
      return {
        success: false,
        effectiveTimeLimitSeconds: 0,
        statusClassification: 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH',
        providerAccepted: false,
        dialExtensionEmpiricallyConfirmed: false,
        isMock: false,
        errorDetails: err.message || 'POST_DISPATCH_NETWORK_AMBIGUITY',
      };
    }
  }

  async terminateActiveCall(params: ActiveCallTerminateParams): Promise<ActiveCallTerminateResult> {
    if (!isProviderMutationGateEnabled()) {
      return {
        success: false,
        isMock: false,
        reason: 'MASTER_MUTATION_GATE_DISABLED',
        errorDetails: 'TELECOM_ACTIVE_CALL_PROVIDER_MUTATIONS_ENABLED is false',
      };
    }

    if (!isTerminateCallScopeEnabled()) {
      return {
        success: false,
        isMock: false,
        reason: 'SCOPED_MUTATION_GATE_DISABLED',
        errorDetails: 'TELECOM_EXPERIMENT_SCOPE_TERMINATE_CALL is false',
      };
    }

    if (!this.client) {
      return {
        success: false,
        isMock: false,
        reason: 'TWILIO_CLIENT_NOT_INITIALIZED',
      };
    }

    try {
      await this.client.calls(params.callSid).update({ status: 'completed' });
      return {
        success: true,
        isMock: false,
        reason: params.reason,
      };
    } catch (err: any) {
      return {
        success: false,
        isMock: false,
        reason: 'TERMINATION_FAILED',
        errorDetails: err.message,
      };
    }
  }

  async fetchActiveCallState(params: ActiveCallFetchParams): Promise<ActiveCallFetchResult> {
    if (!this.client) {
      return {
        callSid: params.callSid,
        status: 'unknown',
        statusClassification: 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH',
        isMock: false,
        errorDetails: 'TWILIO_CLIENT_NOT_INITIALIZED',
      };
    }

    try {
      const call = await this.client.calls(params.callSid).fetch();
      const currentDurationSec = parseInt(call.duration || '0', 10);

      // Eventual-consistency handling: Single stale GET does NOT prove mutation absent if call is in-progress
      if (params.expectedTimeLimitSeconds && currentDurationSec < params.expectedTimeLimitSeconds && call.status === 'in-progress') {
        return {
          callSid: params.callSid,
          status: call.status,
          timeLimitSeconds: currentDurationSec,
          statusClassification: 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH', // Stale readback stays ambiguous pending further budget
          isMock: false,
          errorDetails: 'EVENTUAL_CONSISTENCY_READBACK_PENDING: Readback duration < expected boundary',
        };
      }

      const isConfirmed = params.expectedTimeLimitSeconds
        ? currentDurationSec >= params.expectedTimeLimitSeconds
        : call.status === 'in-progress';

      return {
        callSid: params.callSid,
        status: call.status,
        timeLimitSeconds: currentDurationSec,
        statusClassification: isConfirmed ? 'READBACK_CONFIRMED_SUCCESS' : 'READBACK_CONFIRMED_ABSENT_OR_UNCHANGED',
        isMock: false,
      };
    } catch (err: any) {
      return {
        callSid: params.callSid,
        status: 'unknown',
        statusClassification: 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH',
        isMock: false,
        errorDetails: err.message,
      };
    }
  }
}
