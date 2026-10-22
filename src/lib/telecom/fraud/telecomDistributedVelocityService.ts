import 'server-only';
import { createHmac } from 'crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import { TelecomVelocityCheckParams, TelecomVelocityCheckResult } from './types';
import { normalizeE164PhoneNumber } from '../../utils';

/**
 * Minimum required entropy length for TELECOM_VELOCITY_HMAC_SECRET in characters.
 * Enforces at least 256 bits of entropy (32 raw characters or 64 hex characters).
 */
export const MIN_VELOCITY_HMAC_SECRET_LENGTH = 32;

/**
 * Returns the dedicated application-level secret for keyed HMAC pseudonymization.
 *
 * Strict Cryptographic Boundary Invariants (Phase 24C.2):
 * - Sourced EXCLUSIVELY from process.env.TELECOM_VELOCITY_HMAC_SECRET.
 * - ZERO fallback to SUPABASE_SERVICE_ROLE_KEY, anon keys, JWT secrets, Twilio credentials,
 *   AWS/KMS keys, Stripe secrets, or any other application credential.
 * - Enforces minimum entropy (length >= 32 characters).
 * - Returns null if missing, empty, malformed, or below required entropy.
 */
export function getDedicatedVelocityHmacSecret(): string | null {
  const secret = process.env.TELECOM_VELOCITY_HMAC_SECRET;
  if (!secret) return null;
  const trimmed = secret.trim();
  if (trimmed.length < MIN_VELOCITY_HMAC_SECRET_LENGTH) return null;
  return trimmed;
}

/**
 * TelecomDistributedVelocityService
 *
 * Implements authoritative, shared, distributed anti-abuse velocity enforcement
 * using atomic PostgreSQL state (Phase 24C / Phase 24C.1 / Phase 24C.2 Cryptographically Isolated).
 *
 * Replaces process-local in-memory Map counters with shared, transactional,
 * restart-persistent, multi-worker safe rate limiting.
 *
 * Enforces strict FAIL-CLOSED semantics on database or secret unavailability.
 */
export class TelecomDistributedVelocityService {
  /**
   * Computes a deterministic keyed HMAC-SHA-256 hash of a destination number
   * using canonical E.164 normalization and explicit domain prefix 'dest:v1:'.
   *
   * FAILS CLOSED if TELECOM_VELOCITY_HMAC_SECRET is missing or below minimum entropy.
   */
  public static computeDestinationHash(destination?: string, defaultCountry?: string): string {
    if (!destination) return '';
    const trimmed = destination.trim();
    if (!trimmed) return '';

    const secret = getDedicatedVelocityHmacSecret();
    if (!secret) {
      throw new Error(
        'VELOCITY_HMAC_KEY_UNAVAILABLE: TELECOM_VELOCITY_HMAC_SECRET is missing or below minimum entropy (256-bit requirement)'
      );
    }

    // Authoritative normalization: reuse canonical normalizeE164PhoneNumber
    const normResult = normalizeE164PhoneNumber(trimmed, defaultCountry);
    // If valid, use canonical E.164 string; if unparseable, prefix with 'raw:' to prevent diversity bypass
    const canonicalNumber =
      normResult.isValid && normResult.normalized ? normResult.normalized : `raw:${trimmed.toLowerCase()}`;

    // Explicit domain separation 'dest:v1:'
    return createHmac('sha256', secret).update(`dest:v1:${canonicalNumber}`).digest('hex');
  }

  /**
   * Computes a deterministic keyed HMAC-SHA-256 hash of message content
   * using explicit domain prefix 'content:v1:'.
   *
   * FAILS CLOSED if TELECOM_VELOCITY_HMAC_SECRET is missing or below minimum entropy.
   */
  public static computeContentHash(body?: string): string {
    if (!body) return '';
    const normalized = body.trim();
    if (!normalized) return '';

    const secret = getDedicatedVelocityHmacSecret();
    if (!secret) {
      throw new Error(
        'VELOCITY_HMAC_KEY_UNAVAILABLE: TELECOM_VELOCITY_HMAC_SECRET is missing or below minimum entropy (256-bit requirement)'
      );
    }

    // Explicit domain separation 'content:v1:'
    return createHmac('sha256', secret).update(`content:v1:${normalized}`).digest('hex');
  }

  /**
   * Atomically checks velocity windows and consumes capacity in PostgreSQL.
   *
   * If capacity is available, reserves 1 slot atomically within the database transaction.
   * If throttled, returns structured limit violation and consumes 0 slots.
   * If database or secret is unreachable, FAILS CLOSED with structured limitType.
   */
  public static async checkAndConsume(
    client: SupabaseClient | any,
    params: TelecomVelocityCheckParams
  ): Promise<TelecomVelocityCheckResult> {
    const {
      organizationId,
      userId,
      serviceType,
      destination,
      contentHash,
      body,
      idempotencyKey,
      consume = true,
    } = params;

    // Fail-closed guard 1: Cryptographic key availability & entropy
    const secret = getDedicatedVelocityHmacSecret();
    if (!secret) {
      return {
        allowed: false,
        limitType: 'velocity_hmac_key_unavailable',
        reason: 'Dedicated telecom velocity HMAC secret unavailable or below minimum entropy (256-bit requirement). Telecom operation throttled.',
        retryAfterSeconds: 60,
      };
    }

    // Fail-closed guard 2: client must be present and provide RPC capability
    if (!client || typeof client.rpc !== 'function') {
      return {
        allowed: false,
        limitType: 'velocity_state_unavailable',
        reason: 'Distributed telecom velocity state unavailable. Telecom operation throttled.',
        retryAfterSeconds: 60,
      };
    }

    // Keyed HMAC pseudonymization with domain separation
    let destHash = '';
    let finalContentHash = '';
    try {
      if (destination) {
        destHash = this.computeDestinationHash(destination);
      }
      if (body) {
        finalContentHash = this.computeContentHash(body);
      } else if (contentHash) {
        // If caller already passed a 64-character hex hash, verify and preserve or hash it
        finalContentHash =
          contentHash.length === 64 && /^[0-9a-fA-F]+$/.test(contentHash)
            ? contentHash.toLowerCase()
            : this.computeContentHash(contentHash);
      }
    } catch {
      return {
        allowed: false,
        limitType: 'velocity_hmac_key_unavailable',
        reason: 'Dedicated telecom velocity HMAC secret unavailable or below minimum entropy (256-bit requirement). Telecom operation throttled.',
        retryAfterSeconds: 60,
      };
    }

    try {
      const { data, error } = await client.rpc('check_and_consume_telecom_velocity', {
        p_organization_id: organizationId,
        p_user_id: userId,
        p_service_type: serviceType,
        p_destination_hash: destHash || null,
        p_content_hash: finalContentHash || null,
        p_idempotency_key: idempotencyKey ? idempotencyKey.trim() : null,
        p_consume: consume,
      });

      if (error) {
        console.error('[TelecomDistributedVelocity] RPC error:', error.message || error);
        return {
          allowed: false,
          limitType: 'velocity_state_unavailable',
          reason: 'Distributed telecom velocity state unavailable. Telecom operation throttled.',
          retryAfterSeconds: 60,
        };
      }

      if (!data || typeof data.allowed !== 'boolean') {
        return {
          allowed: false,
          limitType: 'velocity_state_unavailable',
          reason: 'Distributed telecom velocity returned malformed result. Telecom operation throttled.',
          retryAfterSeconds: 60,
        };
      }

      if (!data.allowed) {
        return {
          allowed: false,
          limitType: data.limitType,
          currentRate: data.currentRate,
          limitThreshold: data.limitThreshold,
          retryAfterSeconds: data.retryAfterSeconds || 60,
          reason: data.reason || 'Telecom velocity limit exceeded.',
        };
      }

      return {
        allowed: true,
        idempotencyReplayed: data.idempotencyReplayed === true,
        eventId: data.eventId,
        createdAt: data.createdAt,
        simulatedOnly: data.simulatedOnly === true,
      };
    } catch (err: any) {
      console.error('[TelecomDistributedVelocity] Exception executing velocity check:', err.message || err);
      return {
        allowed: false,
        limitType: 'velocity_state_unavailable',
        reason: 'Distributed telecom velocity state unavailable. Telecom operation throttled.',
        retryAfterSeconds: 60,
      };
    }
  }

  /**
   * Helper to check and atomically consume voice velocity capacity.
   */
  public static async checkAndConsumeVoice(
    client: SupabaseClient | any,
    params: Omit<TelecomVelocityCheckParams, 'serviceType'> & { serviceType?: 'voice_outbound' }
  ): Promise<TelecomVelocityCheckResult> {
    return this.checkAndConsume(client, {
      ...params,
      serviceType: 'voice_outbound',
    });
  }

  /**
   * Helper to check and atomically consume messaging (SMS / MMS) velocity capacity.
   */
  public static async checkAndConsumeMessaging(
    client: SupabaseClient | any,
    params: TelecomVelocityCheckParams
  ): Promise<TelecomVelocityCheckResult> {
    return this.checkAndConsume(client, params);
  }

  /**
   * Cleans up expired ephemeral velocity records older than the specified horizon (default 2 hours).
   */
  public static async cleanupExpiredEvents(
    client: SupabaseClient | any,
    horizonHours: number = 2
  ): Promise<number> {
    if (!client || typeof client.rpc !== 'function') {
      throw new Error('Database client required for velocity cleanup');
    }

    const { data, error } = await client.rpc('cleanup_expired_telecom_velocity_events', {
      p_horizon_interval: `${horizonHours} hours`,
    });

    if (error) {
      throw new Error(`Failed to clean up expired velocity events: ${error.message}`);
    }

    return typeof data === 'number' ? data : Number(data || 0);
  }
}
