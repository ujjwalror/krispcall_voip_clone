/**
 * Phase 24D.SEC-6: Centralized Auth-Provider Error Classification & Safe UX Normalization
 * Standardizes GoTrue/Supabase Auth errors into privacy-preserving, non-enumerating categories.
 */

export type AuthErrorCategory =
  | 'INVALID_CREDENTIALS'
  | 'CAPTCHA_REQUIRED_OR_FAILED'
  | 'RATE_LIMITED'
  | 'EMAIL_RATE_LIMITED'
  | 'RECOVERY_TOKEN_INVALID'
  | 'RECOVERY_TOKEN_EXPIRED'
  | 'NETWORK_FAILURE'
  | 'PROVIDER_UNAVAILABLE'
  | 'UNKNOWN';

export interface NormalizedAuthError {
  category: AuthErrorCategory;
  code: string;
  status?: number;
  safeUserMessage: string;
}

/**
 * Normalizes any provider or network error into a controlled category and safe UX message.
 * Invariant SEC6-010 / SEC6-012 / SEC6-021: Never expose internal rate thresholds or account existence.
 */
export function normalizeAuthError(
  err: any,
  context: 'login' | 'signup' | 'recovery' | 'reset_password' = 'login'
): NormalizedAuthError {
  if (!err) {
    return {
      category: 'UNKNOWN',
      code: 'unknown_empty',
      safeUserMessage: 'An unexpected error occurred. Please try again.',
    };
  }

  const code = (err.code || err.error_code || '').toLowerCase();
  const status = typeof err.status === 'number' ? err.status : undefined;
  const message = (err.message || '').toLowerCase();

  // 1. CAPTCHA verification failures
  if (
    code === 'captcha_failed' ||
    message.includes('captcha') ||
    message.includes('bot protection') ||
    message.includes('turnstile')
  ) {
    return {
      category: 'CAPTCHA_REQUIRED_OR_FAILED',
      code: code || 'captcha_failed',
      status: status || 400,
      safeUserMessage: 'Security verification failed or expired. Please verify the challenge and try again.',
    };
  }

  // 2. Email-specific rate limits
  if (
    code === 'over_email_send_rate_limit' ||
    message.includes('email rate limit exceeded') ||
    message.includes('too many emails')
  ) {
    return {
      category: 'EMAIL_RATE_LIMITED',
      code: 'over_email_send_rate_limit',
      status: 429,
      safeUserMessage: 'Email delivery rate limit reached. Please wait a few minutes before requesting another email.',
    };
  }

  // 3. General request rate limits
  if (
    status === 429 ||
    code === 'over_request_rate_limit' ||
    message.includes('rate limit') ||
    message.includes('too many requests')
  ) {
    return {
      category: 'RATE_LIMITED',
      code: code || 'over_request_rate_limit',
      status: 429,
      safeUserMessage: 'Too many requests. Please wait a few moments before trying again.',
    };
  }

  // 4. Token expiration
  if (
    code === 'otp_expired' ||
    code === 'flow_state_expired' ||
    message.includes('expired')
  ) {
    return {
      category: 'RECOVERY_TOKEN_EXPIRED',
      code: code || 'token_expired',
      status: status || 400,
      safeUserMessage:
        context === 'reset_password'
          ? 'This password reset link has expired. Please request a new one.'
          : 'The verification link or token has expired. Please request a new one.',
    };
  }

  // 5. Invalid token / malformed verification
  if (
    code === 'token_not_found' ||
    code === 'flow_state_not_found' ||
    message.includes('invalid token') ||
    message.includes('token not found')
  ) {
    return {
      category: 'RECOVERY_TOKEN_INVALID',
      code: code || 'token_invalid',
      status: status || 400,
      safeUserMessage:
        context === 'reset_password'
          ? 'This password reset link is invalid or has already been used. Please request a new one.'
          : 'Invalid verification token. Please request a new link.',
    };
  }

  // 6. Network failure / Offline
  if (
    code === 'network_error' ||
    message.includes('failed to fetch') ||
    message.includes('network request failed')
  ) {
    return {
      category: 'NETWORK_FAILURE',
      code: 'network_failure',
      safeUserMessage: 'Network error. Please check your internet connection and try again.',
    };
  }

  // 7. Provider 5xx / outage
  if (status && status >= 500) {
    return {
      category: 'PROVIDER_UNAVAILABLE',
      code: code || 'provider_5xx',
      status,
      safeUserMessage: 'Authentication service temporarily unavailable. Please try again shortly.',
    };
  }

  // 8. Invalid credentials (login surface)
  if (
    code === 'invalid_credentials' ||
    code === 'invalid_grant' ||
    message.includes('invalid login credentials') ||
    message.includes('invalid email or password')
  ) {
    return {
      category: 'INVALID_CREDENTIALS',
      code: 'invalid_credentials',
      status: 400,
      safeUserMessage: 'Invalid email address or password. Please verify your credentials.',
    };
  }

  // 9. Weak password validation
  if (code === 'weak_password' || message.includes('password should be at least')) {
    return {
      category: 'UNKNOWN',
      code: 'weak_password',
      status: 422,
      safeUserMessage: err.message || 'Password does not meet the minimum security requirements.',
    };
  }

  // 10. Default / unknown fallback
  return {
    category: 'UNKNOWN',
    code: code || 'unknown_auth_error',
    status,
    safeUserMessage:
      context === 'login'
        ? 'Invalid email address or password. Please verify your credentials.'
        : err.message || 'An error occurred processing your authentication request.',
  };
}
