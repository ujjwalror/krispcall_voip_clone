import crypto from 'crypto';

/**
 * Server-only cryptographic utilities for telecom experiment authorizations.
 * Computes deterministic, domain-separated, keyed HMAC-SHA256 fingerprints
 * for normalized E.164 destination phone numbers without persisting raw numbers.
 */

const DOMAIN_PREFIX = 'telecom-experiment-destination:v1:';

export class ExperimentCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExperimentCryptoError';
  }
}

/**
 * Resolves the server-only cryptographic secret key for experiment destination hashing.
 * Prefers COMPLIANCE_ENCRYPTION_KEY or SUPABASE_SECRET_KEY.
 * Fails closed if missing.
 */
function getHmacSecretKey(): Buffer {
  const rawSecret = process.env.COMPLIANCE_ENCRYPTION_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!rawSecret || rawSecret.trim().length === 0) {
    throw new ExperimentCryptoError('Missing server cryptographic key (COMPLIANCE_ENCRYPTION_KEY or SUPABASE_SECRET_KEY required).');
  }
  // Derive a 32-byte key via SHA-256 for domain separation
  return crypto.createHash('sha256').update(`experiment-hmac-key:${rawSecret.trim()}`).digest();
}

/**
 * Computes a server-authoritative, keyed HMAC-SHA256 destination fingerprint.
 * @param normalizedE164 Destination phone number in normalized E.164 format (e.g. "+919193399740")
 */
export function computeDestinationFingerprint(normalizedE164: string): string {
  if (!normalizedE164 || typeof normalizedE164 !== 'string') {
    throw new ExperimentCryptoError('Invalid destination string for fingerprint computation.');
  }

  const cleanDestination = normalizedE164.trim();
  if (!cleanDestination.startsWith('+')) {
    throw new ExperimentCryptoError('Destination phone number must be normalized in E.164 format before fingerprinting.');
  }

  const secretKey = getHmacSecretKey();
  const payload = `${DOMAIN_PREFIX}${cleanDestination}`;

  return crypto
    .createHmac('sha256', secretKey)
    .update(payload)
    .digest('hex');
}
