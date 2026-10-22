import 'server-only';
import crypto from 'crypto';
import { AddressNormalizationService, AddressNormalizationOptions } from './addressNormalization';

/**
 * ============================================================================
 * PHASE 24D.SEC-5: DEDICATED AUTHENTICATION ABUSE PSEUDONYMIZATION SERVICE
 * ============================================================================
 *
 * Implements privacy-preserving pseudonymization using HMAC-SHA256 with strict
 * domain separation. Guarantees that raw emails, phone numbers, and IP addresses
 * are never persisted in authentication-abuse tables or audit events.
 *
 * Requirements:
 * - Dedicated secret: AUTH_ABUSE_HMAC_SECRET
 * - Zero fallback to SUPABASE_SERVICE_ROLE_KEY or TELECOM_VELOCITY_HMAC_SECRET
 * - Fails closed on missing or low-entropy secrets (< 32 characters)
 * - Strict domain separation:
 *     auth-account:v1:
 *     auth-source:v1:
 *     auth-pair:v1:
 *     auth-recovery:v1:
 *     auth-signup:v1:
 * - Email normalization: Trim and lowercase (matching Supabase Auth identity matching)
 * - Source address normalization & aggregation
 * - Safe rotation overlap architecture (ACTIVE_KEY_VERSION / PREVIOUS_KEY_VERSION)
 * - Preserves flag: AUTH_ABUSE_HMAC_ROTATION_REQUIRES_SAFE_OVERLAP
 */

export class AuthSecurityConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthSecurityConfigurationError';
  }
}

export interface KeyRotationOptions {
  previousSecret?: string;
}

export class AuthAbusePseudonymService {
  private readonly activeSecret: Buffer;
  private readonly previousSecret: Buffer | null = null;

  constructor(customSecret?: string, rotationOptions?: KeyRotationOptions) {
    const rawSecret = customSecret || process.env.AUTH_ABUSE_HMAC_SECRET;

    if (!rawSecret || typeof rawSecret !== 'string') {
      throw new AuthSecurityConfigurationError(
        'Missing required secret: AUTH_ABUSE_HMAC_SECRET must be configured.'
      );
    }

    const trimmed = rawSecret.trim();
    if (trimmed.length < 32) {
      throw new AuthSecurityConfigurationError(
        'AUTH_ABUSE_HMAC_SECRET has insufficient entropy: must be at least 32 characters.'
      );
    }

    // Prohibit cross-credential reuse / fallback
    if (process.env.TELECOM_VELOCITY_HMAC_SECRET && trimmed === process.env.TELECOM_VELOCITY_HMAC_SECRET.trim()) {
      throw new AuthSecurityConfigurationError(
        'Security boundary violation: AUTH_ABUSE_HMAC_SECRET must not reuse TELECOM_VELOCITY_HMAC_SECRET.'
      );
    }

    if (process.env.SUPABASE_SERVICE_ROLE_KEY && trimmed === process.env.SUPABASE_SERVICE_ROLE_KEY.trim()) {
      throw new AuthSecurityConfigurationError(
        'Security boundary violation: AUTH_ABUSE_HMAC_SECRET must not reuse SUPABASE_SERVICE_ROLE_KEY.'
      );
    }

    if (process.env.TWILIO_AUTH_TOKEN && trimmed === process.env.TWILIO_AUTH_TOKEN.trim()) {
      throw new AuthSecurityConfigurationError(
        'Security boundary violation: AUTH_ABUSE_HMAC_SECRET must not reuse TWILIO_AUTH_TOKEN.'
      );
    }

    if (process.env.STRIPE_SECRET_KEY && trimmed === process.env.STRIPE_SECRET_KEY.trim()) {
      throw new AuthSecurityConfigurationError(
        'Security boundary violation: AUTH_ABUSE_HMAC_SECRET must not reuse STRIPE_SECRET_KEY.'
      );
    }

    this.activeSecret = Buffer.from(trimmed, 'utf8');

    // Handle optional previous key for graceful key rotation
    if (rotationOptions?.previousSecret) {
      const prevTrimmed = rotationOptions.previousSecret.trim();
      if (prevTrimmed.length >= 32 && prevTrimmed !== trimmed) {
        this.previousSecret = Buffer.from(prevTrimmed, 'utf8');
      }
    }
  }

  /**
   * Normalizes an account identifier (typically email address).
   * Semantics: Trim whitespace and lowercase.
   * Note: Provider-specific modifications like stripping dots from Gmail are intentionally NOT applied,
   * matching Supabase Auth's canonical email matching behavior.
   */
  normalizeAccountIdentifier(rawAccount: string): string {
    if (!rawAccount || typeof rawAccount !== 'string') {
      throw new Error('Account identifier must be a non-empty string');
    }
    const normalized = rawAccount.trim().toLowerCase();
    if (normalized.length === 0) {
      throw new Error('Account identifier cannot be empty');
    }
    return normalized;
  }

  /**
   * Derives a deterministic 64-character hex pseudonym for an account target.
   */
  pseudonymizeAccount(rawAccount: string, usePreviousKey = false): string {
    const normalized = this.normalizeAccountIdentifier(rawAccount);
    const secret = (usePreviousKey && this.previousSecret) ? this.previousSecret : this.activeSecret;
    return crypto
      .createHmac('sha256', secret)
      .update(`auth-account:v1:${normalized}`)
      .digest('hex');
  }

  /**
   * Normalizes client IP and derives a deterministic 64-character hex pseudonym.
   */
  pseudonymizeSource(
    rawIp: string,
    options?: AddressNormalizationOptions,
    usePreviousKey = false
  ): {
    sourcePseudonym: string;
    canonicalAddress: string;
    aggregationKey: string;
  } {
    const { canonicalAddress, aggregationKey } = AddressNormalizationService.normalize(rawIp, options);
    const secret = (usePreviousKey && this.previousSecret) ? this.previousSecret : this.activeSecret;
    const sourcePseudonym = crypto
      .createHmac('sha256', secret)
      .update(`auth-source:v1:${aggregationKey}`)
      .digest('hex');

    return {
      sourcePseudonym,
      canonicalAddress,
      aggregationKey,
    };
  }

  /**
   * Derives a deterministic 64-character hex pseudonym for a source-account pair.
   */
  pseudonymizePair(sourcePseudonym: string, accountPseudonym: string, usePreviousKey = false): string {
    if (!sourcePseudonym || !accountPseudonym) {
      throw new Error('sourcePseudonym and accountPseudonym are required to derive pair pseudonym');
    }
    const secret = (usePreviousKey && this.previousSecret) ? this.previousSecret : this.activeSecret;
    return crypto
      .createHmac('sha256', secret)
      .update(`auth-pair:v1:${sourcePseudonym}:${accountPseudonym}`)
      .digest('hex');
  }

  /**
   * Derives a deterministic 64-character hex pseudonym for recovery recipients (email or phone).
   */
  pseudonymizeRecoveryRecipient(recipient: string, usePreviousKey = false): string {
    const normalized = recipient.trim().toLowerCase();
    const secret = (usePreviousKey && this.previousSecret) ? this.previousSecret : this.activeSecret;
    return crypto
      .createHmac('sha256', secret)
      .update(`auth-recovery:v1:${normalized}`)
      .digest('hex');
  }

  /**
   * Derives a deterministic 64-character hex pseudonym for signup sources.
   */
  pseudonymizeSignupSource(rawIp: string, options?: AddressNormalizationOptions, usePreviousKey = false): string {
    const { aggregationKey } = AddressNormalizationService.normalize(rawIp, options);
    const secret = (usePreviousKey && this.previousSecret) ? this.previousSecret : this.activeSecret;
    return crypto
      .createHmac('sha256', secret)
      .update(`auth-signup:v1:${aggregationKey}`)
      .digest('hex');
  }

  /**
   * Returns true if a previous key is configured for rotation overlap.
   */
  hasPreviousKey(): boolean {
    return this.previousSecret !== null;
  }
}
