export type PaymentOperationType =
  | 'number_purchase'
  | 'subscription_charge'
  | 'seat_addon'
  | 'credit_topup'
  | 'custom';

export type PaymentCanonicalStatus =
  | 'pending'
  | 'requires_customer_action'
  | 'authorized'
  | 'capture_pending'
  | 'captured'
  | 'cancel_pending'
  | 'canceled'
  | 'failed'
  | 'refund_pending'
  | 'partially_refunded'
  | 'refunded'
  | 'reconciliation_required'
  | 'manual_review_required';

export interface PaymentOperation {
  id: string;
  organizationId: string;
  operationType: PaymentOperationType;
  provider: string;
  status: PaymentCanonicalStatus;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  requestFingerprint: string;
  providerPaymentId: string | null;
  providerCustomerId: string | null;
  priceSnapshotPayload: Record<string, any>;
  telecomOperationId: string | null;
  authorizationExpiresAt: string | null;
  attemptCount: number;
  failureCode: string | null;
  failureMessage: string | null;
  reconciliationState: Record<string, any>;
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export type CreditEntryType = 'grant' | 'consumption' | 'expiration' | 'adjustment' | 'usage_reversal';
export type CreditReferenceType = 'payment_operation' | 'invoice' | 'admin_action' | 'promo' | 'telecom_usage' | 'auto_recharge';

export interface CreditLedgerEntry {
  id: string;
  organizationId: string;
  entryType: CreditEntryType;
  amountMinor: number;
  balanceAfterMinor: number;
  currency: string;
  description: string;
  referenceType: CreditReferenceType | null;
  referenceId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export type TelecomServiceType = 'voice_outbound' | 'voice_inbound' | 'sms_outbound' | 'sms_inbound' | 'mms_outbound' | 'mms_inbound' | 'other';
export type TelecomDirection = 'inbound' | 'outbound';
export type ReservationStatus = 'active' | 'settled' | 'released' | 'expired';

export interface TelecomRetailRateCard {
  id: string;
  rateCode: string;
  serviceType: TelecomServiceType;
  direction: TelecomDirection;
  destinationPattern: string;
  destinationName: string;
  retailRateMicro: number;
  wholesaleCostMicro: number;
  unitType: 'minute' | 'message' | 'event';
  billingIncrementSeconds: number;
  minChargeableUnits: number;
  currency: string;
  isActive: boolean;
  effectiveStartAt: string;
  effectiveEndAt: string | null;
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface TelecomUsageReservation {
  id: string;
  internalUsageId: string;
  organizationId: string;
  serviceType: TelecomServiceType;
  direction: TelecomDirection;
  provider: string;
  providerResourceId: string | null;
  rateCardId: string | null;
  rateSnapshot: Record<string, any>;
  amountReservedMinor: number;
  currency: string;
  status: ReservationStatus;
  idempotencyKey: string;
  expiresAt: string;
  settledAt: string | null;
  releasedAt: string | null;
  settlementLedgerId: string | null;
  actualProviderCostMinor: number | null;
  actualCustomerChargeMinor: number | null;
  actualGrossMarginMinor: number | null;
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface TelecomWalletSummary {
  organizationId: string;
  fundedBalanceMinor: number;
  activeReservationsMinor: number;
  availableBalanceMinor: number;
  currency: string;
}

export type BillableResourceType = 'phone_number' | 'seat' | 'addon';
export type BillableResourceStatus = 'active' | 'paused' | 'terminated';

export interface OrganizationBillableResource {
  id: string;
  organizationId: string;
  resourceType: BillableResourceType;
  resourceId: string;
  billingInterval: 'monthly' | 'annual';
  contractedRetailMinor: number;
  currency: string;
  status: BillableResourceStatus;
  effectiveStartAt: string;
  effectiveEndAt: string | null;
  priceVersionId: string | null;
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface BillableResourcePriceVersion {
  id: string;
  billableResourceId: string;
  contractedRetailMinor: number;
  currency: string;
  effectiveStartAt: string;
  effectiveEndAt: string | null;
  noticeGivenAt: string | null;
  changeReason: string;
  createdBy: string | null;
  createdAt: string;
}

export interface OrganizationBillingControls {
  id: string;
  organizationId: string;
  maxDailyPurchaseSpendMinor: number | null;
  maxPurchaseVelocityPerHour: number | null;
  maxActiveNumbersLimit: number | null;
  disallowHighCostDestinations: boolean;
  riskScoreThreshold: number | null;
  isBillingRestricted: boolean;
  restrictionReason: string | null;
  updatedAt: string;
}

export interface WebhookEventRecord {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  payload: Record<string, any>;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attemptCount: number;
  availableAt: string;
  processingStartedAt: string | null;
  processedAt: string | null;
  lastError: string | null;
  createdAt: string;
}
