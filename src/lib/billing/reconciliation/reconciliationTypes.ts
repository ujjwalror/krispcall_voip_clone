/**
/**
 * PUBLIC SAAS PHASE 13.4.3C SUBPHASE C.4E.RECON.B
 * Financial Reconciliation Engine Type Definitions.
 */

export type ReconciliationRunType = 'full_system' | 'organization' | 'provider_account' | 'targeted';
export type ReconciliationRunStatus = 'running' | 'completed' | 'failed' | 'partial';

export type FindingSeverity = 'informational' | 'warning' | 'financial_risk' | 'critical';
export type FindingStatus = 'open' | 'investigating' | 'resolved' | 'ignored';

export type TargetEntityType =
  | 'payment_operation'
  | 'refund_request'
  | 'payment_refund'
  | 'payment_dispute'
  | 'financial_hold'
  | 'account_debt'
  | 'wallet_ledger'
  | 'provider_account'
  | 'telecom_reservation';

export type FindingCategory =
  | 'PAID_NOT_CAPTURED'
  | 'PAID_NOT_FUNDED'
  | 'LOCAL_CAPTURED_NO_PROVIDER_SUCCESS'
  | 'FUNDED_WITHOUT_PAYMENT'
  | 'PAYMENT_AMOUNT_MISMATCH'
  | 'PAYMENT_CURRENCY_MISMATCH'
  | 'PROVIDER_ACCOUNT_MISMATCH'
  | 'DUPLICATE_PROVIDER_PAYMENT_ID'
  | 'DUPLICATE_CREDIT_GRANT'
  | 'STALE_PENDING_PAYMENT'
  | 'PROVIDER_PAYMENT_NOT_FOUND'
  | 'PROVIDER_STATE_AMBIGUOUS'
  | 'PROVIDER_REFUND_WITHOUT_INTERNAL_REQUEST'
  | 'LOCAL_REFUND_UNCONFIRMED_ON_PROVIDER'
  | 'REFUND_EXCEEDS_PAYMENT_GROSS'
  | 'CREDIT_REVERSAL_EXCEEDS_APPROVED'
  | 'REFUND_WITHOUT_CREDIT_REVERSAL'
  | 'APPROVED_REFUND_UNEXECUTED'
  | 'REFUND_STATUS_MISMATCH'
  | 'DUPLICATE_PROVIDER_REFUND_ID'
  | 'DISPUTE_HOLD_MISSING'
  | 'DISPUTE_HOLD_STALE'
  | 'DISPUTE_WON_HOLD_UNRELEASED'
  | 'DISPUTE_LOST_HOLD_UNSETTLED'
  | 'DISPUTE_DEBT_MISSING'
  | 'DISPUTE_STATUS_MISMATCH'
  | 'DUPLICATE_DISPUTE_EVENT'
  | 'LEDGER_BALANCE_MISMATCH'
  | 'AVAILABLE_BALANCE_MISMATCH'
  | 'UNKNOWN_LEDGER_PROVENANCE'
  | 'PROVIDER_CREDENTIALS_UNAVAILABLE'
  | 'PROVIDER_STATE_UNKNOWN';

export interface StripePaymentIntentSnapshot {
  providerPaymentId: string;
  providerAccountId: string;
  environment: 'test' | 'live';
  status: string;
  amountMinor: number;
  amountReceivedMinor: number;
  currency: string;
  customerId: string | null;
  metadata: Record<string, string>;
  createdAt: string;
}

export interface StripeRefundSnapshot {
  providerRefundId: string;
  providerPaymentId: string;
  providerAccountId: string;
  environment: 'test' | 'live';
  amountMinor: number;
  currency: string;
  status: string;
  reason: string | null;
  createdAt: string;
}

export interface StripeRefundSnapshotPage {
  refunds: StripeRefundSnapshot[];
  hasMore: boolean;
  nextStartingAfter?: string;
}

export interface StripeDisputeSnapshot {
  providerDisputeId: string;
  providerPaymentId: string;
  providerAccountId: string;
  environment: 'test' | 'live';
  amountMinor: number;
  currency: string;
  status: string;
  reason: string | null;
  createdAt: string;
}

export interface ReconciliationFingerprintInput {
  category: FindingCategory;
  organizationId: string;
  providerAccountId: string | null;
  targetEntityType: TargetEntityType;
  targetEntityId: string;
  stableDiscriminator?: string;
}

export interface ModuleCoverageDetails {
  inspected: boolean;
  status: 'completed' | 'failed' | 'skipped';
  itemsInspected: number;
  error?: string;
}

export interface RunModuleCoverage {
  eligibleForResolution: boolean;
  modules: {
    payments?: ModuleCoverageDetails;
    refunds?: ModuleCoverageDetails;
    disputes?: ModuleCoverageDetails;
    walletLedger?: ModuleCoverageDetails;
  };
}

export interface RunSummaryCounts {
  totalInspected: number;
  findingsOpen: number;
  findingsResolved: number;
}

export interface ReconciliationFindingRecord {
  id: string;
  fingerprint: string;
  organizationId: string;
  providerAccountId: string | null;
  findingCategory: FindingCategory;
  severity: FindingSeverity;
  status: FindingStatus;
  targetEntityType: TargetEntityType;
  targetEntityId: string;
  stableDiscriminator: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

export interface ReconciliationObservationRecord {
  id: string;
  runId: string;
  findingId: string;
  observedAt: string;
  evidenceJson: Record<string, any>;
  evidenceHash: string;
}
