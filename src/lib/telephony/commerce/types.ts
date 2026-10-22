import 'server-only';

export type PurchaseOperationStatus =
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'reconciliation_required'
  | 'manual_review_required';

export interface CommercialPriceSnapshot {
  retailAmountMinor: number;
  retailCurrency: string;
  providerCostMinor: number;
  providerCostCurrency: string;
  pricingSource: 'explicit_override' | 'pricing_policy';
  pricingPolicyId?: string | null;
  targetMarginPct?: number | null;
  minimumFixedMarginMinor?: number | null;
  grossMarginMinor: number;
  priceResolvedAt: string; // ISO timestamptz
  schemaVersion: 1;
}

export interface RegulatoryProvisioningContext {
  provider: string;
  countryCode: string;
  numberType: string;
  endUserType?: 'individual' | 'business' | null;
  regulationSid?: string | null;
  complianceProfileId?: string | null;
  bundleSid?: string | null;
  addressSid?: string | null;
  endUserSid?: string | null;
  requirementFingerprint?: string | null;
  readinessVerifiedAt: string; // ISO timestamptz
  providerApprovalStatus?: string | null;
  schemaVersion: 1;
}

export interface RequestFingerprintV1Input {
  operationType: 'purchase_number';
  organizationId: string;
  provider: string;
  phoneNumberE164: string;
  countryCode: string;
  numberType: string;
  retailAmountMinor: number;
  retailCurrency: string;
  pricingSource: 'explicit_override' | 'pricing_policy';
  pricingPolicyId?: string | null;
  providerCostMinor: number;
  providerCostCurrency: string;
  complianceProfileId?: string | null;
  endUserType?: 'individual' | 'business' | null;
  regulationSid?: string | null;
  regulatoryBundleSid?: string | null;
  complianceRequirementFingerprint?: string | null;
}

export interface ProviderNumberOperation {
  id: string;
  organizationId: string;
  operationType: 'purchase_number';
  provider: string;
  phoneNumberE164: string;
  numberType: string;
  countryCode: string;
  status: PurchaseOperationStatus;
  idempotencyKey: string;
  requestFingerprint: string;
  providerResourceId?: string | null;
  providerStatus?: string | null;

  // Commercial Price Snapshot
  retailAmountMinor: number;
  retailCurrency: string;
  providerCostMinor: number;
  providerCostCurrency: string;
  pricingSource: 'explicit_override' | 'pricing_policy';
  pricingPolicyId?: string | null;
  targetMarginPct?: number | null;
  minimumFixedMarginMinor?: number | null;
  grossMarginMinor: number;
  priceResolvedAt: string;
  priceSnapshotPayload: CommercialPriceSnapshot;
  executionProviderCostMinor?: number | null;
  executionProviderCostCurrency?: string | null;

  // Regulatory Context
  complianceProfileId?: string | null;
  regulatoryBundleSid?: string | null;
  regulatoryProvisioningContext: RegulatoryProvisioningContext;

  // Payment Boundary
  paymentAuthorizationId?: string | null;
  paymentStatus?: 'unpaid' | 'authorized' | 'captured' | 'released' | 'waived' | null;

  // 23D.1 & 23D.3 Additive Canonical Fields
  providerAccountId?: string | null;
  canonicalState?: import('@/lib/telecom/domain/types').CanonicalPurchaseOperationState | null;
  outcomeCertainty?: import('@/lib/telecom/domain/types').ProviderOutcomeCertainty | null;
  reconciliationState?: import('@/lib/telecom/domain/types').PurchaseReconciliationState | null;
  quoteId?: string | null;
  providerOrderId?: string | null;
  errorCategory?: import('@/lib/telecom/domain/types').PurchaseFailureCategory | null;
  billingAuthorizationId?: string | null;
  billingAuthorizationState?: import('@/lib/telecom/domain/types').BillingAuthorizationState | null;
  authorizedAt?: string | null;
  dispatchedAt?: string | null;
  confirmedAt?: string | null;
  reconciledAt?: string | null;

  // Operational
  attemptCount: number;
  startedAt?: string | null;
  completedAt?: string | null;
  lastReconciledAt?: string | null;
  sanitizedErrorCode?: string | null;
  sanitizedErrorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerPurchaseOperationDTO {
  operationId: string;
  phoneNumberE164: string;
  countryCode: string;
  numberType: string;
  status: PurchaseOperationStatus;
  retailAmountFormatted: string;
  retailCurrency: string;
  createdAt: string;
  completedAt?: string | null;
  customerMessage?: string | null;
}
