import 'server-only';

/**
 * ============================================================================
 * PHASE 24D.SEC-5: AUTHENTICATION ABUSE DEFENSE ENGINE DATA & POLICY TYPES
 * ============================================================================
 */

export type AuthAbuseAction =
  | 'LOGIN'
  | 'SIGNUP'
  | 'PASSWORD_RECOVERY'
  | 'OTP_REQUEST'
  | 'OTP_VERIFY';

export type AuthAbuseDimension =
  | 'SOURCE'
  | 'ACCOUNT_TARGET'
  | 'SOURCE_ACCOUNT_PAIR'
  | 'RECOVERY_RECIPIENT'
  | 'SIGNUP_SOURCE';

export type AuthAbuseWindowType = 'SHORT' | 'MEDIUM' | 'LONG';

export type AuthAbuseOutcome = 'ATTEMPT' | 'FAILURE' | 'SUCCESS';

export type AuthAbuseDecision = 'ALLOW' | 'CHALLENGE' | 'THROTTLE' | 'DENY';

export type AuthAbuseRiskState =
  | 'NORMAL'
  | 'ELEVATED'
  | 'CHALLENGE_REQUIRED'
  | 'TEMPORARILY_THROTTLED';

export type AuthAuditEventType =
  | 'AUTH_LOGIN_FAILED'
  | 'AUTH_LOGIN_CHALLENGE_REQUIRED'
  | 'AUTH_LOGIN_THROTTLED'
  | 'AUTH_PASSWORD_SPRAY_SIGNAL'
  | 'AUTH_CREDENTIAL_STUFFING_SIGNAL'
  | 'AUTH_RECOVERY_REQUESTED'
  | 'AUTH_RECOVERY_THROTTLED'
  | 'AUTH_SIGNUP_THROTTLED'
  | 'AUTH_PASSWORD_CHANGED'
  | 'AUTH_SESSION_REVOKED'
  | 'AUTH_MFA_CHANGED';

/**
 * Policy structure abstraction.
 * Note: No frozen production values are defined here.
 * Thresholds must be supplied via policy configuration.
 * Preserves flag: AUTH_RATE_LIMIT_POLICY_REQUIRES_DEFINITION
 */
export interface AuthAbusePolicy {
  shortWindowSeconds: number;
  mediumWindowSeconds: number;
  longWindowSeconds: number;
  sprayWindowSeconds: number;

  sourceShortLimit?: number;
  sourceMediumLimit?: number;
  sourceLongLimit?: number;

  accountShortChallengeLimit?: number;
  accountShortThrottleLimit?: number;
  accountMediumLimit?: number;
  accountLongLimit?: number;

  pairShortLimit?: number;
  pairMediumLimit?: number;

  sprayDiversityLimit?: number;
}

export interface AuthAbuseEvaluationInput {
  sourceIp: string;
  accountIdentifier?: string; // e.g. email or username
  action: AuthAbuseAction;
  policy: AuthAbusePolicy;
  outcome?: AuthAbuseOutcome;
  timestamp?: Date;
}

export interface AuthAbuseEvaluationCounters {
  source_short: number;
  source_med: number;
  source_long: number;
  account_short: number;
  account_med: number;
  account_long: number;
  pair_short: number;
  pair_med: number;
  spray_diversity: number;
}

export type AuthAbuseEngineResult =
  | {
      success: true;
      decision: AuthAbuseDecision;
      state: AuthAbuseRiskState;
      reason: string;
      retryAfterSeconds: number;
      counters: AuthAbuseEvaluationCounters;
    }
  | {
      success: false;
      errorCode:
        | 'ENGINE_UNAVAILABLE'
        | 'POLICY_INVALID'
        | 'PSEUDONYM_SECRET_UNAVAILABLE'
        | 'SOURCE_INVALID'
        | 'DATABASE_ERROR';
      errorMessage: string;
    };

/**
 * Strictly allowlisted metadata keys for security audit events.
 * Prevents dumping secrets, passwords, tokens, raw emails, or raw IPs into telemetry.
 */
export const ALLOWED_AUDIT_METADATA_KEYS = [
  'spray_count',
  'source_short',
  'source_med',
  'account_short',
  'account_med',
  'pair_short',
  'retry_after',
  'threshold',
  'window_seconds',
  'correlation_id',
  'client_type',
  'key_version',
] as const;

export function sanitizeAuditMetadata(rawMetadata: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  for (const key of Object.keys(rawMetadata)) {
    if ((ALLOWED_AUDIT_METADATA_KEYS as readonly string[]).includes(key)) {
      sanitized[key] = rawMetadata[key];
    }
  }
  return sanitized;
}
