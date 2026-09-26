import 'server-only';
import { createHash } from 'crypto';
import { RequestFingerprintV1Input } from './types';

/**
 * Generates a deterministic SHA-256 request fingerprint (Version 1) for a purchase operation.
 * 
 * Rules:
 * 1. Canonical key ordering (alphabetical).
 * 2. Immutable purchase intent attributes only.
 * 3. Excludes timestamps, mutable UI labels, PII, documents, nonces.
 */
export function generateRequestFingerprintV1(input: RequestFingerprintV1Input): string {
  const canonicalObj = {
    complianceProfileId: input.complianceProfileId || null,
    complianceRequirementFingerprint: input.complianceRequirementFingerprint || null,
    countryCode: input.countryCode.toUpperCase(),
    endUserType: input.endUserType || null,
    numberType: input.numberType.toLowerCase(),
    operationType: 'purchase_number',
    organizationId: input.organizationId,
    phoneNumberE164: input.phoneNumberE164.trim(),
    pricingPolicyId: input.pricingPolicyId || null,
    pricingSource: input.pricingSource,
    provider: input.provider.toLowerCase(),
    providerCostCurrency: input.providerCostCurrency.toUpperCase(),
    providerCostMinor: input.providerCostMinor,
    regulationSid: input.regulationSid || null,
    regulatoryBundleSid: input.regulatoryBundleSid || null,
    retailAmountMinor: input.retailAmountMinor,
    retailCurrency: input.retailCurrency.toUpperCase(),
  };

  const serialized = JSON.stringify(canonicalObj);
  const hash = createHash('sha256').update(serialized).digest('hex');
  return `sha256:${hash}`;
}
