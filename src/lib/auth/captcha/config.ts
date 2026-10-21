/**
 * Phase 24D.SEC-6: CAPTCHA Provider Configuration & Client Safety Guards
 */

// Well-known Cloudflare Turnstile dummy testing keys (Official Cloudflare Docs)
export const TURNSTILE_TEST_KEYS = {
  ALWAYS_PASSES: '1x00000000000000000000AA',
  ALWAYS_BLOCKS: '2x00000000000000000000AB',
  INTERACTIVE_CHALLENGE: '3x00000000000000000000FF',
} as const;

/**
 * Centralized Provider Contract Rate-Limit Default:
 * GoTrue enforces a 60-second cooldown window between password recovery and OTP requests per user.
 * This constant coordinates client-side UX suppression without serving as a security boundary.
 */
export const DEFAULT_PROVIDER_RECOVERY_COOLDOWN_SECONDS = 60;

/**
 * Retrieves the public Cloudflare Turnstile Site Key.
 * Returns null if not configured.
 */
export function getTurnstileSiteKey(): string | null {
  const envKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  if (envKey && envKey.trim().length > 0) {
    return envKey.trim();
  }
  return null;
}

/**
 * Checks whether Turnstile is actively configured in the current environment.
 */
export function isTurnstileConfigured(): boolean {
  return getTurnstileSiteKey() !== null;
}

/**
 * Checks whether Turnstile is running in local test mode (e.g. CI, mocked tests, or dummy keys).
 */
export function isTurnstileTestMode(): boolean {
  if (process.env.NEXT_PUBLIC_TURNSTILE_TEST_MODE === 'true') {
    return true;
  }
  const key = getTurnstileSiteKey();
  if (key === TURNSTILE_TEST_KEYS.ALWAYS_PASSES || key === TURNSTILE_TEST_KEYS.ALWAYS_BLOCKS) {
    return true;
  }
  return false;
}

/**
 * Invariant SEC6-023: Verify that no server secret keys are exposed via client env variables.
 * Safe to call in browser or server runtime.
 */
export function assertClientEnvironmentSecurity(): void {
  const publicEnv = process.env as Record<string, string | undefined>;
  const forbiddenPrefixes = [
    'NEXT_PUBLIC_TURNSTILE_SECRET',
    'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE',
    'NEXT_PUBLIC_SUPABASE_SECRET',
  ];

  for (const key of forbiddenPrefixes) {
    if (publicEnv[key] && publicEnv[key]!.length > 0) {
      throw new Error(`CRITICAL SECURITY DEFECT: Server secret exposed in client environment (${key}).`);
    }
  }
}

/**
 * Security Invariant AUTH-CAPTCHA-FAILURE-001:
 * When CAPTCHA is an enabled production security requirement, unexpected CAPTCHA
 * configuration/provider failure MUST NOT silently downgrade password authentication
 * to password-only mode.
 *
 * In production (NODE_ENV === 'production') or when explicitly enabled, CAPTCHA challenge
 * is a mandatory gate on password authentication surfaces.
 */
export function isCaptchaRequired(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return true;
  }
  if (process.env.NEXT_PUBLIC_CAPTCHA_REQUIRED === 'true') {
    return true;
  }
  return isTurnstileConfigured();
}

/**
 * Safe user-facing message displayed during CAPTCHA provider or configuration failure.
 * Obscures internal provider details (DNS, Cloudflare, Supabase internal error).
 */
export const SAFE_CAPTCHA_UNAVAILABLE_MESSAGE =
  'Security verification is temporarily unavailable. Please try again later.';

/**
 * Validates whether a protected password-auth request (login, signup, recovery) may proceed.
 * If CAPTCHA is required and no valid challenge token is provided, fails closed (returns false).
 * Enforces AUTH-CAPTCHA-FAILURE-001 (Zero automatic fallback to password-only authentication).
 */
export function canProceedWithPasswordAuth(captchaToken: string | null | undefined): boolean {
  if (isCaptchaRequired() || isTurnstileConfigured()) {
    return typeof captchaToken === 'string' && captchaToken.trim().length > 0;
  }
  return true;
}

/**
 * Security Configuration Drift States:
 * Models divergence between frontend challenge requirements and GoTrue server policy.
 */
export const CAPTCHA_CONFIGURATION_DRIFT = {
  HEALTHY_ALIGNED: 'HEALTHY_ALIGNED',
  FRONTEND_ENABLED_PROVIDER_DISABLED: 'FRONTEND_ENABLED_PROVIDER_DISABLED',
  FRONTEND_DISABLED_PROVIDER_ENABLED: 'FRONTEND_DISABLED_PROVIDER_ENABLED',
} as const;

export type CaptchaConfigurationDrift =
  (typeof CAPTCHA_CONFIGURATION_DRIFT)[keyof typeof CAPTCHA_CONFIGURATION_DRIFT];

/**
 * Classifies the synchronization status between frontend challenge and backend provider enforcement.
 * Neither drift state represents a healthy production deployment.
 */
export function classifyCaptchaConfigurationDrift(
  frontendEnforced: boolean,
  providerEnforced: boolean
): CaptchaConfigurationDrift {
  if (frontendEnforced && !providerEnforced) {
    return CAPTCHA_CONFIGURATION_DRIFT.FRONTEND_ENABLED_PROVIDER_DISABLED;
  }
  if (!frontendEnforced && providerEnforced) {
    return CAPTCHA_CONFIGURATION_DRIFT.FRONTEND_DISABLED_PROVIDER_ENABLED;
  }
  return CAPTCHA_CONFIGURATION_DRIFT.HEALTHY_ALIGNED;
}
