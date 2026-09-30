import crypto from 'crypto';

/**
 * Server-only cryptographic utilities for telecom experiment authorizations.
 * Computes deterministic, domain-separated, keyed HMAC-SHA256 fingerprints
 * for normalized E.164 destination phone numbers without persisting raw numbers.
 * 
 * STRICT REQUIREMENT: Requires dedicated server-only TELECOM_EXPERIMENT_HMAC_KEY.
 * No fallbacks to Supabase keys or compliance encryption keys.
 */

const DOMAIN_PREFIX = 'telecom-experiment-destination:v1:';
const MIN_KEY_BYTES = 32;

export class ExperimentCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExperimentCryptoError';
  }
}

/**
 * Resolves and validates the dedicated server-only cryptographic secret key.
 * Requires TELECOM_EXPERIMENT_HMAC_KEY environment variable.
 * Key must be a high-entropy secret (base64 encoded 32+ bytes or raw string >= 32 chars).
 * Fails closed if missing or weak.
 */
function getHmacSecretKey(customKey?: string): Buffer {
  const rawKey = (customKey !== undefined ? customKey : process.env.TELECOM_EXPERIMENT_HMAC_KEY) || '';
  const trimmedKey = rawKey.trim();

  if (!trimmedKey) {
    throw new ExperimentCryptoError('Missing server cryptographic key (TELECOM_EXPERIMENT_HMAC_KEY environment variable required).');
  }

  // Attempt base64 decoding if valid base64, otherwise treat as UTF-8 string
  let keyBuffer: Buffer;
  try {
    const isBase64Pattern = /^[A-Za-z0-9+/=]+$/.test(trimmedKey);
    if (isBase64Pattern && trimmedKey.length % 4 === 0) {
      keyBuffer = Buffer.from(trimmedKey, 'base64');
    } else {
      keyBuffer = Buffer.from(trimmedKey, 'utf8');
    }
  } catch {
    keyBuffer = Buffer.from(trimmedKey, 'utf8');
  }

  if (keyBuffer.length < MIN_KEY_BYTES) {
    throw new ExperimentCryptoError(`Malformed or weak cryptographic key. TELECOM_EXPERIMENT_HMAC_KEY must contain at least ${MIN_KEY_BYTES} bytes of entropy.`);
  }

  return keyBuffer;
}

/**
 * Computes a server-authoritative, keyed HMAC-SHA256 destination fingerprint.
 * @param normalizedE164 Destination phone number in normalized E.164 format (e.g. "+919193399740")
 * @param overrideKey Optional explicit key for key-isolation testing (never exposed to browser)
 */
export function computeDestinationFingerprint(normalizedE164: string, overrideKey?: string): string {
  if (!normalizedE164 || typeof normalizedE164 !== 'string') {
    throw new ExperimentCryptoError('Invalid destination string for fingerprint computation.');
  }

  const cleanDestination = normalizedE164.trim();
  if (!cleanDestination.startsWith('+')) {
    throw new ExperimentCryptoError('Destination phone number must be normalized in E.164 format before fingerprinting.');
  }

  const secretKey = getHmacSecretKey(overrideKey);
  const payload = `${DOMAIN_PREFIX}${cleanDestination}`;

  return crypto
    .createHmac('sha256', secretKey)
    .update(payload)
    .digest('hex');
}
