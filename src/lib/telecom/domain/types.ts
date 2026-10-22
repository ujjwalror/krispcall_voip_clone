import 'server-only';

/**
 * ==============================================================================
 * PHASE 23D.1: CANONICAL TELECOM DOMAIN TYPES & VALUE OBJECTS
 * ==============================================================================
 * Authoritative TypeScript representations of the frozen Phase 23C architecture.
 */

// ------------------------------------------------------------------------------
// 1. IDENTITY & BRANDED PRIMITIVES
// ------------------------------------------------------------------------------
export type PhoneNumberId = string;
export type E164Number = string;
export type OrganizationId = string;
export type ProviderAccountId = string;
export type ProviderResourceRecordId = string;

// ------------------------------------------------------------------------------
// 2. THE 5 ORTHOGONAL LIFECYCLE DIMENSIONS
// ------------------------------------------------------------------------------

/**
 * Dimension 1: Ownership State (Legal/Carrier Tenancy)
 */
export type PhoneNumberOwnershipState =
  | 'ACQUISITION_PENDING'
  | 'OWNED'
  | 'RELEASE_PENDING'
  | 'RELEASED'
  | 'PORTED_OUT';

/**
 * Dimension 2: Service State (Operational Call/Message Routing)
 */
export type PhoneNumberServiceState =
  | 'PROVISIONING'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'UNAVAILABLE';

/**
 * Dimension 3: Billing State (SaaS Subscription & Entitlement)
 */
export type PhoneNumberBillingState =
  | 'CURRENT'
  | 'PAST_DUE'
  | 'GRACE'
  | 'TERMINATED';

/**
 * Dimension 4: Porting State (Carrier Number Portability)
 */
export type PhoneNumberPortingState =
  | 'NONE'
  | 'PORT_IN_REQUESTED'
  | 'PORT_IN_FOC'
  | 'PORT_IN_FAILED'
  | 'PORT_OUT_REQUESTED'
  | 'PORT_OUT_AUTHORIZED'
  | 'PORT_OUT_REJECTED';

/**
 * Dimension 5: Compliance State (Regulatory Documents & Verification)
 */
export type PhoneNumberComplianceState =
  | 'NOT_REQUIRED'
  | 'PENDING_VERIFICATION'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED';

// ------------------------------------------------------------------------------
// 3. CAPABILITY MODEL & PROGRESSION PIPELINE
// ------------------------------------------------------------------------------

export type NumberCapabilityType =
  | 'VOICE_INBOUND'
  | 'VOICE_OUTBOUND'
  | 'SMS_INBOUND'
  | 'SMS_OUTBOUND'
  | 'MMS_INBOUND'
  | 'MMS_OUTBOUND'
  | 'EMERGENCY_CALLING'
  | 'FAX';

export type NumberCapabilityStage =
  | 'ADVERTISED'
  | 'PROVISIONED'
  | 'CONFIGURED'
  | 'USABLE'
  | 'BLOCKED';

export interface NumberCapabilityDetail {
  stage: NumberCapabilityStage;
  reason?: string | null;
  lastVerifiedAt?: string;
  configuredAt?: string;
  complianceState?: PhoneNumberComplianceState;
}

export type NumberCapabilitiesState = Partial<Record<NumberCapabilityType, NumberCapabilityDetail>>;

// ------------------------------------------------------------------------------
// 4. NUMBER ASSIGNMENT
// ------------------------------------------------------------------------------

export type NumberAssignmentTargetType =
  | 'USER'
  | 'TEAM'
  | 'QUEUE'
  | 'IVR'
  | 'WORKSPACE_MAIN'
  | 'VOICEMAIL'
  | 'UNASSIGNED_POOL';

export interface NumberAssignmentRecord {
  phoneNumberId: PhoneNumberId;
  organizationId: OrganizationId;
  targetType: NumberAssignmentTargetType;
  targetId?: string | null;
  assignedAt: string;
}

// ------------------------------------------------------------------------------
// 5. OPERATION SAGA & OUTCOME CERTAINTY
// ------------------------------------------------------------------------------

export type ProviderOutcomeCertainty =
  | 'CONFIRMED_SUCCESS'
  | 'CONFIRMED_FAILURE'
  | 'STILL_UNKNOWN'
  | 'MANUAL_REVIEW_REQUIRED';

export type PurchaseReconciliationState =
  | 'NONE'
  | 'QUEUED'
  | 'AUDITING'
  | 'RESOLVED'
  | 'MANUAL_INTERVENTION_REQUIRED';

export type CanonicalPurchaseOperationState =
  | 'REQUESTED'
  | 'VALIDATING'
  | 'AUTHORIZED'
  | 'PROVIDER_DISPATCH_PENDING'
  | 'PROVIDER_DISPATCHED'
  | 'PROVIDER_OUTCOME_UNKNOWN'
  | 'CONFIRMED'
  | 'FAILED'
  | 'RECONCILIATION_REQUIRED'
  | 'MANUAL_REVIEW_REQUIRED';

export type BillingAuthorizationState =
  | 'PENDING'
  | 'AUTHORIZED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CAPTURED'
  | 'RELEASED';

export type PurchaseFailureCategory =
  | 'SAFE_PRE_DISPATCH_FAILURE'
  | 'INVENTORY_VANISHED'
  | 'QUOTE_EXPIRED'
  | 'PROVIDER_OUTCOME_UNKNOWN'
  | 'CONFIRMED_FAILURE'
  | 'PROVIDER_ACCOUNT_MISMATCH'
  | 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED'
  | 'COMPLIANCE_REQUIRED'
  | 'FINANCIAL_AUTHORIZATION_FAILED'
  | 'INTERNAL_ERROR';

export type PurchaseRetryabilityClass =
  | 'RETRYABLE_PRE_DISPATCH'
  | 'NON_RETRYABLE'
  | 'RECONCILIATION_MANDATORY'
  | 'NEW_QUOTE_REQUIRED'
  | 'MANUAL_REVIEW_REQUIRED';

export interface CanonicalPurchaseOperationRecord {
  id: string; // operation_id
  organizationId: OrganizationId;
  provider: string;
  providerAccountId: ProviderAccountId | null;
  phone_number_e164: E164Number; // requested_e164
  numberType: string;
  countryCode: string;
  requestFingerprint: string;
  idempotencyKey: string;
  quoteId?: string | null;
  providerOrderId?: string | null;
  providerResourceId?: string | null;
  canonicalState: CanonicalPurchaseOperationState;
  providerOutcomeCertainty: ProviderOutcomeCertainty | null;
  reconciliationState: PurchaseReconciliationState | null;
  attemptCount: number;
  errorCategory?: PurchaseFailureCategory | null;
  billingAuthorizationId?: string | null;
  billingAuthorizationState?: BillingAuthorizationState | null;
  retailAmountMinor: number;
  retailCurrency: string;
  providerCostMinor: number;
  providerCostCurrency: string;
  createdAt: string;
  updatedAt: string;
  authorizedAt?: string | null;
  dispatchedAt?: string | null;
  confirmedAt?: string | null;
  reconciledAt?: string | null;
  sanitizedErrorCode?: string | null;
  sanitizedErrorMessage?: string | null;
}

export type CanonicalReleaseOperationState =
  | 'REQUESTED'
  | 'VALIDATING'
  | 'BLOCKED'
  | 'AUTHORIZED'
  | 'PROVIDER_RELEASE_PENDING'
  | 'PROVIDER_OUTCOME_UNKNOWN'
  | 'CONFIRMED'
  | 'LOCAL_FINALIZATION'
  | 'RELEASED'
  | 'FAILED';

// ------------------------------------------------------------------------------
// 6. PRICE QUOTE & SEARCH FOUNDATION
// ------------------------------------------------------------------------------

export interface NumberPriceQuoteDTO {
  id?: string;
  organizationId: OrganizationId;
  provider: string;
  phoneNumberE164: E164Number;
  numberType: 'local' | 'mobile' | 'toll_free' | 'national';
  countryCode: string;
  currency: string;
  providerSetupCostMinor: number;
  providerRecurringCostMinor: number;
  customerSetupPriceMinor: number;
  customerRecurringPriceMinor: number;
  pricingPolicyId?: string | null;
  observedAt: string;
  expiresAt: string;
  searchTokenSignature?: string | null;
  reservationMetadata?: Record<string, unknown>;
}

// ------------------------------------------------------------------------------
// 7. LIFECYCLE AUDIT EVENTS
// ------------------------------------------------------------------------------

export type PhoneNumberLifecycleEventType =
  | 'PURCHASE_REQUESTED'
  | 'PURCHASE_CONFIRMED'
  | 'PURCHASE_FAILED'
  | 'PURCHASE_RECONCILED'
  | 'ASSIGNED'
  | 'UNASSIGNED'
  | 'ROUTING_CHANGED'
  | 'SUSPENDED'
  | 'REACTIVATED'
  | 'RELEASE_REQUESTED'
  | 'RELEASE_BLOCKED'
  | 'RELEASE_CONFIRMED'
  | 'PORT_IN_REQUESTED'
  | 'PORT_IN_COMPLETED'
  | 'PORT_IN_FAILED'
  | 'PORT_OUT_REQUESTED'
  | 'PORT_OUT_AUTHORIZED'
  | 'PORT_OUT_COMPLETED'
  | 'PORT_FREEZE_CHANGED'
  | 'COMPLIANCE_CHANGED';

export interface PhoneNumberLifecycleEventRecord {
  id: string;
  organizationId: OrganizationId;
  phoneNumberId: PhoneNumberId;
  phoneNumberE164: E164Number;
  eventType: PhoneNumberLifecycleEventType;
  actorType: 'USER' | 'SYSTEM' | 'CARRIER_WEBHOOK' | 'CRON_WORKER';
  actorId?: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

// ------------------------------------------------------------------------------
// 8. CANONICAL PHONE NUMBER DOMAIN ASSET
// ------------------------------------------------------------------------------

export interface CanonicalPhoneNumber {
  id: PhoneNumberId;
  organizationId: OrganizationId;
  phoneNumberE164: E164Number;
  countryCode: string;
  numberType: string;
  ownershipState: PhoneNumberOwnershipState;
  serviceState: PhoneNumberServiceState;
  isPrimary: boolean;
  friendlyName: string | null;
  providerAccountId: ProviderAccountId | null;
  providerResourceRecordId: ProviderResourceRecordId | null;
  assignmentTargetType: NumberAssignmentTargetType | null;
  assignmentTargetId: string | null;
  assignedAt: string | null;
  capabilitiesState: NumberCapabilitiesState;
  portOutLocked: boolean;
  portOutLockUpdatedAt: string;
  portOutLockUpdatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  releasedAt: string | null;
}

// ------------------------------------------------------------------------------
// 9. CANONICAL ERROR TAXONOMY
// ------------------------------------------------------------------------------

export type CanonicalTelecomErrorCode =
  | 'INVENTORY_VANISHED'
  | 'QUOTE_EXPIRED'
  | 'COMPLIANCE_REQUIRED'
  | 'COMPLIANCE_REJECTED'
  | 'PROVIDER_ACCOUNT_REQUIRED'
  | 'PROVIDER_ACCOUNT_MISMATCH'
  | 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'PURCHASE_ALREADY_IN_PROGRESS'
  | 'PROVIDER_OUTCOME_UNKNOWN'
  | 'RELEASE_BLOCKED_ACTIVE_CALL'
  | 'RELEASE_BLOCKED_PORTING'
  | 'PORT_OUT_LOCKED'
  | 'PORT_AUTHORIZATION_REQUIRED'
  | 'PROVIDER_UNAVAILABLE'
  | 'RECONCILIATION_REQUIRED';

export class CanonicalTelecomError extends Error {
  public readonly code: CanonicalTelecomErrorCode;
  public readonly httpStatus: number;
  public readonly details?: Record<string, unknown>;

  constructor(code: CanonicalTelecomErrorCode, message: string, httpStatus = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CanonicalTelecomError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    Object.setPrototypeOf(this, CanonicalTelecomError.prototype);
  }
}
