import crypto from 'crypto';
import { ReconciliationFingerprintInput } from './reconciliationTypes';

/**
 * Deterministic Canonical Finding Fingerprint Generator.
 *
 * Produces a stable, immutable 64-character lowercase SHA-256 hex string based strictly on:
 * - category
 * - organization_id
 * - provider_account_id (explicitly serialized as null when absent)
 * - target_entity_type
 * - target_entity_id
 * - stable_discriminator
 *
 * EXCLUDES mutable financial state: amount, status, timestamps, evidence text.
 */
export function generateFindingFingerprint(input: ReconciliationFingerprintInput): string {
  const {
    category,
    organizationId,
    providerAccountId,
    targetEntityType,
    targetEntityId,
    stableDiscriminator = 'default',
  } = input;

  if (!category || !category.trim()) {
    throw new Error('FINGERPRINT_ERROR: category is required.');
  }
  if (!organizationId || !organizationId.trim()) {
    throw new Error('FINGERPRINT_ERROR: organizationId is required.');
  }
  if (!targetEntityType || !targetEntityType.trim()) {
    throw new Error('FINGERPRINT_ERROR: targetEntityType is required.');
  }
  if (!targetEntityId || !targetEntityId.trim()) {
    throw new Error('FINGERPRINT_ERROR: targetEntityId is required.');
  }

  // Build canonical key-sorted payload object
  const canonicalPayload = {
    category: category.trim(),
    discriminator: stableDiscriminator.trim(),
    organization_id: organizationId.trim(),
    provider_account_id: providerAccountId ? providerAccountId.trim() : null,
    target_entity_id: targetEntityId.trim(),
    target_entity_type: targetEntityType.trim(),
  };

  // Deterministic JSON stringification with sorted keys
  const keys = Object.keys(canonicalPayload).sort() as (keyof typeof canonicalPayload)[];
  const sortedPairs = keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(canonicalPayload[key])}`);
  const canonicalJson = `{${sortedPairs.join(',')}}`;

  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex').toLowerCase();
}

/**
 * Helper to compute evidence payload SHA-256 hash for observation snapshot audit log.
 */
export function generateEvidenceHash(evidenceJson: Record<string, any>): string {
  const sanitized = evidenceJson || {};
  const keys = Object.keys(sanitized).sort();
  const sortedPairs = keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(sanitized[key])}`);
  const canonicalJson = `{${sortedPairs.join(',')}}`;

  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex').toLowerCase();
}
