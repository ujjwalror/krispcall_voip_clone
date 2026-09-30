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
const DIAG_PREFIX = 'telecom-key-diag:v1:';
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
 * 
 * ENCODING CONTRACT:
 * - Trims outer whitespace/newlines.
 * - Supports explicit prefix: base64:<val> or utf8:<val>.
 * - For backward compatibility: Unprefixed 44-char base64 strings ending in '='
 *   decoding to exactly 32 bytes are parsed as base64.
 * - Otherwise parsed strictly as UTF-8 string bytes.
 * - Fails closed if entropy is less than 32 bytes.
 */
function getHmacSecretKey(customKey?: string): Buffer {
  const rawKey = (customKey !== undefined ? customKey : process.env.TELECOM_EXPERIMENT_HMAC_KEY) || '';
  const trimmedKey = rawKey.trim();

  if (!trimmedKey) {
    throw new ExperimentCryptoError('Missing server cryptographic key (TELECOM_EXPERIMENT_HMAC_KEY environment variable required).');
  }

  let keyBuffer: Buffer;

  if (trimmedKey.startsWith('base64:')) {
    const payload = trimmedKey.slice(7).trim();
    try {
      keyBuffer = Buffer.from(payload, 'base64');
    } catch {
      throw new ExperimentCryptoError('Malformed base64 secret key provided.');
    }
  } else if (trimmedKey.startsWith('utf8:')) {
    const payload = trimmedKey.slice(5);
    keyBuffer = Buffer.from(payload, 'utf8');
  } else {
    // Unprefixed legacy compatibility check:
    // 44-character valid base64 pattern (e.g. 32 bytes base64-encoded)
    const isStandardBase6432BytePattern = /^([A-Za-z0-9+/]{43}=)$/.test(trimmedKey);
    if (isStandardBase6432BytePattern) {
      try {
        const decoded = Buffer.from(trimmedKey, 'base64');
        if (decoded.length === MIN_KEY_BYTES) {
          keyBuffer = decoded;
        } else {
          keyBuffer = Buffer.from(trimmedKey, 'utf8');
        }
      } catch {
        keyBuffer = Buffer.from(trimmedKey, 'utf8');
      }
    } else {
      keyBuffer = Buffer.from(trimmedKey, 'utf8');
    }
  }

  if (keyBuffer.length < MIN_KEY_BYTES) {
    throw new ExperimentCryptoError(`Malformed or weak cryptographic key. TELECOM_EXPERIMENT_HMAC_KEY must contain at least ${MIN_KEY_BYTES} bytes of entropy.`);
  }

  return keyBuffer;
}

/**
 * Returns a server-only, non-secret diagnostic key version fingerprint.
 * Allows verifying that local runner and remote server share the exact same key
 * without ever exposing secret key bytes.
 */
export function getExperimentKeyVersion(customKey?: string): string {
  const secretKey = getHmacSecretKey(customKey);
  return crypto
    .createHash('sha256')
    .update(`${DIAG_PREFIX}${secretKey.toString('hex')}`)
    .digest('hex')
    .slice(0, 8);
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
