import 'server-only';

export interface CanonicalAadInput {
  provider: string;
  providerAccountId: string;
  credentialPurpose: string;
  secretVersion: number;
  environment: string;
  referenceId: string;
}

/**
 * Produces an unambiguous, deterministic canonical JSON byte buffer for AES-GCM
 * Additional Authenticated Data (AAD).
 *
 * Keys are strictly ordered alphabetically with fixed property names and no arbitrary whitespace
 * to prevent cryptographic collision, delimiter injection, or context substitution.
 */
export function serializeCanonicalAad(input: CanonicalAadInput): Buffer {
  if (!input.provider || !input.providerAccountId || !input.credentialPurpose || !input.referenceId) {
    throw new Error('AAD_CANONICALIZATION_ERROR: Missing required fields for canonical AAD.');
  }

  const normalized = {
    credentialPurpose: String(input.credentialPurpose).trim().toUpperCase(),
    environment: String(input.environment || 'production').trim().toLowerCase(),
    provider: String(input.provider).trim().toUpperCase(),
    providerAccountId: String(input.providerAccountId).trim(),
    referenceId: String(input.referenceId).trim(),
    secretVersion: Number(input.secretVersion || 1),
  };

  const canonicalJson = JSON.stringify({
    credentialPurpose: normalized.credentialPurpose,
    environment: normalized.environment,
    provider: normalized.provider,
    providerAccountId: normalized.providerAccountId,
    referenceId: normalized.referenceId,
    secretVersion: normalized.secretVersion,
  });

  return Buffer.from(canonicalJson, 'utf8');
}

/**
 * Serializes KMS Key Encryption Context into deterministic canonical JSON.
 * Sorts all context keys alphabetically.
 */
export function serializeKmsContext(context: Record<string, string>): Buffer {
  const sortedKeys = Object.keys(context).sort();
  const sortedObj: Record<string, string> = {};
  for (const k of sortedKeys) {
    sortedObj[k] = String(context[k]).trim();
  }
  return Buffer.from(JSON.stringify(sortedObj), 'utf8');
}
