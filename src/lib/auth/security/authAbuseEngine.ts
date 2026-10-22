import 'server-only';
import {
  AuthAbuseAction,
  AuthAbuseEngineResult,
  AuthAbuseEvaluationInput,
  AuthAbusePolicy,
} from './authAbuseTypes';
import {
  AuthAbusePseudonymService,
  AuthSecurityConfigurationError,
} from './authAbusePseudonymService';

/**
 * Minimal database client interface compatible with Supabase Client and test wrappers.
 */
export interface AuthAbuseDatabaseClient {
  rpc(functionName: string, params: Record<string, any>): Promise<{ data: any; error: any }>;
}

export class AuthAbuseEngine {
  private pseudonymService: AuthAbusePseudonymService | null = null;
  private dbClient: AuthAbuseDatabaseClient | null = null;

  constructor(options?: {
    pseudonymService?: AuthAbusePseudonymService;
    dbClient?: AuthAbuseDatabaseClient;
  }) {
    if (options?.pseudonymService) {
      this.pseudonymService = options.pseudonymService;
    }
    if (options?.dbClient) {
      this.dbClient = options.dbClient;
    }
  }

  private getPseudonymService(): AuthAbusePseudonymService {
    if (!this.pseudonymService) {
      this.pseudonymService = new AuthAbusePseudonymService();
    }
    return this.pseudonymService;
  }

  private async getDbClient(): Promise<AuthAbuseDatabaseClient> {
    if (this.dbClient) {
      return this.dbClient;
    }
    const { createAdminClient } = await import('@/lib/supabase/admin');
    return createAdminClient() as unknown as AuthAbuseDatabaseClient;
  }

  /**
   * Atomically records an authentication attempt and evaluates rate, spray, and anti-lockout windows.
   */
  async recordAndEvaluateAttempt(
    input: AuthAbuseEvaluationInput
  ): Promise<AuthAbuseEngineResult> {
    try {
      // 1. Policy validation
      if (!input.policy) {
        return {
          success: false,
          errorCode: 'POLICY_INVALID',
          errorMessage: 'AuthAbusePolicy configuration is required.',
        };
      }
      if (
        typeof input.policy.shortWindowSeconds !== 'number' ||
        input.policy.shortWindowSeconds <= 0
      ) {
        return {
          success: false,
          errorCode: 'POLICY_INVALID',
          errorMessage: 'Invalid shortWindowSeconds in policy.',
        };
      }

      // 2. Pseudonym derivation
      let pseudoService: AuthAbusePseudonymService;
      try {
        pseudoService = this.getPseudonymService();
      } catch (err: any) {
        return {
          success: false,
          errorCode: 'PSEUDONYM_SECRET_UNAVAILABLE',
          errorMessage: err.message || 'Pseudonym service initialization failed.',
        };
      }

      let sourcePseudonym: string;
      try {
        const { sourcePseudonym: sp } = pseudoService.pseudonymizeSource(input.sourceIp);
        sourcePseudonym = sp;
      } catch (err: any) {
        return {
          success: false,
          errorCode: 'SOURCE_INVALID',
          errorMessage: err.message || 'Invalid client source IP address.',
        };
      }

      let accountPseudonym: string | null = null;
      if (input.accountIdentifier) {
        try {
          accountPseudonym = pseudoService.pseudonymizeAccount(input.accountIdentifier);
        } catch (err: any) {
          return {
            success: false,
            errorCode: 'SOURCE_INVALID',
            errorMessage: err.message || 'Invalid account identifier.',
          };
        }
      }

      let pairPseudonym: string | null = null;
      if (accountPseudonym) {
        pairPseudonym = pseudoService.pseudonymizePair(sourcePseudonym, accountPseudonym);
      }

      // 3. Serialize policy parameters for the atomic database procedure
      const policyPayload = {
        short_window_seconds: input.policy.shortWindowSeconds,
        medium_window_seconds: input.policy.mediumWindowSeconds,
        long_window_seconds: input.policy.longWindowSeconds,
        spray_window_seconds: input.policy.sprayWindowSeconds,
        source_short_limit: input.policy.sourceShortLimit ?? 2147483647,
        source_medium_limit: input.policy.sourceMediumLimit ?? 2147483647,
        source_long_limit: input.policy.sourceLongLimit ?? 2147483647,
        account_short_challenge_limit: input.policy.accountShortChallengeLimit ?? 2147483647,
        account_short_throttle_limit: input.policy.accountShortThrottleLimit ?? 2147483647,
        account_medium_limit: input.policy.accountMediumLimit ?? 2147483647,
        account_long_limit: input.policy.accountLongLimit ?? 2147483647,
        pair_short_limit: input.policy.pairShortLimit ?? 2147483647,
        pair_medium_limit: input.policy.pairMediumLimit ?? 2147483647,
        spray_diversity_limit: input.policy.sprayDiversityLimit ?? 2147483647,
      };

      // 4. Invoke Atomic PostgreSQL Evaluator Procedure
      const db = await this.getDbClient();
      const timestampIso = (input.timestamp || new Date()).toISOString();

      const { data, error } = await db.rpc('record_and_evaluate_auth_attempt', {
        p_source_pseudonym: sourcePseudonym,
        p_account_pseudonym: accountPseudonym,
        p_action: input.action,
        p_policy: policyPayload,
        p_outcome: input.outcome || 'ATTEMPT',
        p_now: timestampIso,
        p_pair_pseudonym: pairPseudonym,
      });

      if (error) {
        console.error('[AuthAbuseEngine] Database evaluation error:', error);
        return {
          success: false,
          errorCode: 'DATABASE_ERROR',
          errorMessage: error.message || 'Database error during abuse evaluation.',
        };
      }

      if (!data || typeof data !== 'object') {
        return {
          success: false,
          errorCode: 'ENGINE_UNAVAILABLE',
          errorMessage: 'Authoritative evaluation returned empty payload.',
        };
      }

      return {
        success: true,
        decision: data.decision,
        state: data.state,
        reason: data.reason || 'within_limits',
        retryAfterSeconds: data.retry_after_seconds || 0,
        counters: data.counters || {},
      };
    } catch (err: any) {
      console.error('[AuthAbuseEngine] Unhandled exception:', err);
      return {
        success: false,
        errorCode: 'ENGINE_UNAVAILABLE',
        errorMessage: err.message || 'Unexpected engine failure.',
      };
    }
  }

  /**
   * Helper to record an authentication failure outcome.
   */
  async recordFailure(input: {
    sourceIp: string;
    accountIdentifier?: string;
    action: AuthAbuseAction;
    policy: AuthAbusePolicy;
    timestamp?: Date;
  }): Promise<AuthAbuseEngineResult> {
    return this.recordAndEvaluateAttempt({
      ...input,
      outcome: 'FAILURE',
    });
  }

  /**
   * Helper to record an authentication success outcome.
   */
  async recordSuccess(input: {
    sourceIp: string;
    accountIdentifier?: string;
    action: AuthAbuseAction;
    policy: AuthAbusePolicy;
    timestamp?: Date;
  }): Promise<AuthAbuseEngineResult> {
    return this.recordAndEvaluateAttempt({
      ...input,
      outcome: 'SUCCESS',
    });
  }

  /**
   * Invokes the retention cleanup procedure to purge expired counters, spray records, and audit events.
   */
  async cleanupRecords(options: {
    counterRetention: string;
    sprayRetention: string;
    auditRetention: string;
    now?: Date;
  }): Promise<{ countersDeleted: number; sprayDeleted: number; auditDeleted: number }> {
    const db = await this.getDbClient();
    const timestampIso = (options.now || new Date()).toISOString();

    const { data, error } = await db.rpc('cleanup_auth_abuse_records', {
      p_counter_retention: options.counterRetention,
      p_spray_retention: options.sprayRetention,
      p_audit_retention: options.auditRetention,
      p_now: timestampIso,
    });

    if (error) {
      throw new Error(`Cleanup failed: ${error.message}`);
    }

    return {
      countersDeleted: data?.counters_deleted || 0,
      sprayDeleted: data?.spray_deleted || 0,
      auditDeleted: data?.audit_deleted || 0,
    };
  }
}
