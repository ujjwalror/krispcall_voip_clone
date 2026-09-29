// ============================================================================
// PUBLIC SAAS PHASE 13.4.3B.2E — PROVIDER CALL CONTROL ADAPTER ABSTRACTION
// Server-only abstraction for active call timeLimit updates and forced hangups.
// Level 1 operates strictly in MOCK mode (server gate default FALSE).
// Strategy tag: UNVERIFIED_FOR_ACTIVE_DIAL_EXTENSION
// ============================================================================

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
}

export interface ActiveCallAllowanceResult {
  success: boolean;
  effectiveTimeLimitSeconds: number;
  statusClassification: ProviderResultClassification;
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
}

export interface ActiveCallFetchParams {
  callSid: string;
}

export interface ActiveCallFetchResult {
  callSid: string;
  status: string;
  timeLimitSeconds?: number;
  statusClassification: 'READBACK_CONFIRMED_SUCCESS' | 'READBACK_CONFIRMED_ABSENT_OR_UNCHANGED' | 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH';
  isMock: boolean;
}

export interface TwilioCallControlAdapter {
  extendActiveCallAllowance(params: ActiveCallAllowanceParams): Promise<ActiveCallAllowanceResult>;
  terminateActiveCall(params: ActiveCallTerminateParams): Promise<ActiveCallTerminateResult>;
  fetchActiveCallState(params: ActiveCallFetchParams): Promise<ActiveCallFetchResult>;
}

/**
 * Server-only provider mutation gate check.
 * Default is FALSE. Live mutations are prohibited unless explicitly enabled in authorized sandbox runs.
 */
export function isProviderMutationGateEnabled(): boolean {
  const envVal = process.env.TELECOM_ACTIVE_CALL_PROVIDER_MUTATIONS_ENABLED || process.env.TELECOM_VOICE_MUTATION_ALLOW_UPDATE;
  return envVal === 'true' || envVal === '1';
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

  /**
   * Configure mock behavior for a specific callSid or default.
   */
  setMockBehavior(callSid: string, classification: ProviderResultClassification) {
    this.mockBehaviors.set(callSid, classification);
  }

  setMockReadBack(callSid: string, result: 'READBACK_CONFIRMED_SUCCESS' | 'READBACK_CONFIRMED_ABSENT_OR_UNCHANGED') {
    this.mockReadBacks.set(callSid, result);
  }

  async extendActiveCallAllowance(params: ActiveCallAllowanceParams): Promise<ActiveCallAllowanceResult> {
    this.dispatchCount++;
    // Gate Enforcer: Always operate in MOCK mode if gate is false
    const gateActive = isProviderMutationGateEnabled();
    if (!gateActive) {
      // Force mock execution
      const configuredBehavior = this.mockBehaviors.get(params.callSid) || this.defaultClassification;

      if (configuredBehavior === 'DEFINITE_SUCCESS') {
        return {
          success: true,
          effectiveTimeLimitSeconds: params.newTimeLimitSeconds,
          statusClassification: 'DEFINITE_SUCCESS',
          isMock: true,
          rawResponse: { callSid: params.callSid, timeLimit: params.newTimeLimitSeconds, status: 'in-progress' },
        };
      }

      if (configuredBehavior === 'READBACK_CONFIRMED_SUCCESS') {
        return {
          success: true,
          effectiveTimeLimitSeconds: params.newTimeLimitSeconds,
          statusClassification: 'READBACK_CONFIRMED_SUCCESS',
          isMock: true,
        };
      }

      if (configuredBehavior === 'READBACK_CONFIRMED_ABSENT_OR_UNCHANGED') {
        return {
          success: false,
          effectiveTimeLimitSeconds: 0,
          statusClassification: 'READBACK_CONFIRMED_ABSENT_OR_UNCHANGED',
          isMock: true,
          errorDetails: 'Readback confirmed call duration unchanged',
        };
      }

      if (configuredBehavior === 'DEFINITE_PROVIDER_REJECTION' || configuredBehavior === 'DEFINITE_PRE_DISPATCH_FAILURE') {
        return {
          success: false,
          effectiveTimeLimitSeconds: 0,
          statusClassification: configuredBehavior,
          isMock: true,
          errorDetails: 'Mock Provider Rejected Call Resource Update (400)',
        };
      }

      if (configuredBehavior === 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH') {
        return {
          success: false,
          effectiveTimeLimitSeconds: 0,
          statusClassification: 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH',
          isMock: true,
          errorDetails: 'Mock Provider HTTP Gateway Timeout (504)',
        };
      }
    }

    // Safety fallback: Never perform live mutations in Level 1
    return {
      success: true,
      effectiveTimeLimitSeconds: params.newTimeLimitSeconds,
      statusClassification: 'DEFINITE_SUCCESS',
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
