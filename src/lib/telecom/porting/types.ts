import 'server-only';
import { ProviderContext, TelecomProvider } from '@/lib/telecom/provider/types';
import { SubjectType, CanonicalNumberType } from '@/lib/telecom/compliance/types';

/**
 * ==============================================================================
 * PHASE 23D.8B: CANONICAL PROVIDER-NEUTRAL NUMBER PORTING DOMAIN TYPES
 * ==============================================================================
 */

export type PortDirection = 'PORT_IN' | 'PORT_OUT';

/**
 * Canonical Port-In Lifecycle State (Independent Directed Graph)
 */
export type PortInCanonicalState =
  | 'DRAFT'
  | 'REQUIREMENTS_PENDING'
  | 'CUSTOMER_ACTION_REQUIRED'
  | 'READY_FOR_SUBMISSION'
  | 'SUBMISSION_PENDING'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'REMEDIATION_REQUIRED'
  | 'FOC_CONFIRMED'
  | 'PORTING'
  | 'PROVIDER_OUTCOME_UNKNOWN'
  | 'MANUAL_REVIEW_REQUIRED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED_PRE_DISPATCH';

/**
 * Canonical Port-Out Lifecycle State (Independent Directed Graph)
 */
export type PortOutCanonicalState =
  | 'DETECTED'
  | 'REQUESTED'
  | 'AUTHORIZATION_REQUIRED'
  | 'SECURITY_REVIEW'
  | 'AUTHORIZED'
  | 'INSTRUCTIONS_ISSUED'
  | 'PROVIDER_PROCESSING'
  | 'ACTION_REQUIRED'
  | 'PORTING'
  | 'PROVIDER_OUTCOME_UNKNOWN'
  | 'MANUAL_REVIEW_REQUIRED'
  | 'COMPLETED'
  | 'DISPUTED'
  | 'CANCELLED'
  | 'REJECTED_FRAUD_LOCK';

export type PortCanonicalState = PortInCanonicalState | PortOutCanonicalState;

export type PortabilityStatus =
  | 'PORTABLE'
  | 'NOT_PORTABLE'
  | 'MANUAL_PORTING_AVAILABLE'
  | 'UNKNOWN';

export type PortOutcomeCertainty = 'DEFINITIVE' | 'UNCERTAIN' | 'AMBIGUOUS';

export type PortReconciliationStatus =
  | 'STILL_PENDING'
  | 'CUSTOMER_ACTION_REQUIRED'
  | 'REMEDIATION_REQUIRED'
  | 'SCHEDULED'
  | 'FOC_CONFIRMED'
  | 'PORTING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'STILL_UNKNOWN';

export type PortWorkflowMode = 'AUTOMATED_API' | 'ASSISTED_MANUAL' | 'UNSUPPORTED';

/**
 * Granular Provider Porting Capabilities (Phase 23D.8A.1)
 */
export interface PortingDocumentConstraints {
  maxSizeBytes: number;
  supportedMimeTypes: string[];
  maxInvoiceAgeDays: number;
  requiresSignedLoa: boolean;
}

export interface TelecomProviderPortingCapabilities {
  supportsPortabilityCheckApi: boolean;
  supportsTargetAccountPortability: boolean;
  supportsPortInSubmissionApi: boolean;
  supportsPortInStatusApi: boolean;
  supportsPortInWebhook: boolean;
  supportsDigitalEloa: boolean;
  supportsManualPortInFallback: boolean;
  supportsPortOutInitiationApi: boolean;
  supportsPortOutValidationWebhook: boolean;
  supportsPortOutManagementApi: boolean;
  supportsPortOutCompletionWebhook: boolean;
  supportsPortOutPasscodeApi: boolean;
  supportsManualPortOutCoordination: boolean;
  documentConstraints: PortingDocumentConstraints;
}

/**
 * Canonical Port Evidence Model
 */
export interface PortEvidenceItem {
  id: string;
  evidenceType: 'utility_bill' | 'loa_signed' | 'csr' | 'id_document' | 'regulatory_form';
  storageObjectPath: string;
  originalFilenameSanitized: string;
  mimeType: string;
  sizeBytes: number;
  sha256Hash: string;
  verifiedAt?: string | null;
  uploadedAt: string;
}

/**
 * Configurable Port-Out Risk Policy
 */
export interface PortSecurityPolicy {
  portOutLocked: boolean;
  stepUpAuthRequired: boolean;
  securityNotificationRequired: boolean;
  riskReviewRequired: boolean;
  cooldownSeconds: number; // Configurable: 0, 43200 (12h), 86400 (24h), 172800 (48h)
  unlockedAt?: string | null;
  cooldownExpiresAt?: string | null;
  unlockedByActor?: string | null;
}

/**
 * Structured Port Remediation Record
 */
export interface PortRemediationRecord {
  rejectionCategory: string;
  providerRawCode?: string | null;
  customerMessage: string;
  evidenceCategoryRequired?: string | null;
  isResubmissionEligible: boolean;
  recordedAt: string;
}

/**
 * Canonical Port Operation Authority Record
 */
export interface PortOperationRecord {
  id: string;
  organizationId: string;
  phoneNumberId?: string | null;
  phoneNumberE164: string;
  direction: PortDirection;
  canonicalState: PortCanonicalState;
  reconciliationState?: string | null;
  outcomeCertainty?: PortOutcomeCertainty | null;
  workflowMode: PortWorkflowMode;
  provider: TelecomProvider | string;
  providerAccountId?: string | null;
  providerPortId?: string | null;
  providerStatus?: string | null;
  requirementSnapshotId?: string | null;
  regulatorySubjectId?: string | null;
  carrierName?: string | null;
  accountNumberEncrypted?: string | null;
  portingPinEncrypted?: string | null;
  serviceAddress?: Record<string, any>;
  authorizedName?: string | null;
  authorizedEmail?: string | null;
  requestedFocAt?: string | null;
  estimatedFocAt?: string | null;
  confirmedFocAt?: string | null;
  actualCompletedAt?: string | null;
  providerDispatchedAt?: string | null;
  providerAcknowledgedAt?: string | null;
  customerActionRequiredAt?: string | null;
  manualReviewRequiredAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  idempotencyKey?: string | null;
  requestFingerprint?: string | null;
  portEvidence: PortEvidenceItem[];
  remediationHistory: PortRemediationRecord[];
  portSecurityPolicy: PortSecurityPolicy;
  createdAt: string;
  updatedAt: string;
}

/**
 * Port Requirement Snapshot Model
 */
export interface PortRequirementSnapshotRecord {
  id: string;
  organizationId: string;
  provider: string;
  countryCode: string;
  numberType: string;
  direction: PortDirection;
  subjectType: SubjectType | string;
  losingCarrier?: string | null;
  targetProviderAccountId?: string | null;
  requiresAccountNumber: boolean;
  requiresPin: boolean;
  requiresBillingAddress: boolean;
  requiresUtilityInvoice: boolean;
  requiresDigitalEloa: boolean;
  requiresManualDocumentUpload: boolean;
  requiredDocuments: Array<{
    documentType: string;
    description: string;
    mandatory: boolean;
  }>;
  documentConstraints: PortingDocumentConstraints;
  providerCapabilities: TelecomProviderPortingCapabilities;
  fingerprint: string;
  retrievedAt: string;
  createdAt: string;
}

/**
 * Service Contract Parameters & Results
 */
export interface CheckPortabilityParams {
  phoneNumberE164: string;
  targetAccountSid?: string;
  provider?: TelecomProvider;
}

export interface PortabilityResult {
  phoneNumberE164: string;
  status: PortabilityStatus;
  provider: TelecomProvider | string;
  notPortableReason?: string | null;
  pinRequired: boolean;
  accountNumberRequired: boolean;
  supportedWorkflow: PortWorkflowMode;
  checkedAt: string;
  targetAccountEvaluated?: string | null;
}

export interface DiscoverPortRequirementsParams {
  countryCode: string;
  numberType: CanonicalNumberType | string;
  direction: PortDirection;
  subjectType: SubjectType | string;
  losingCarrier?: string | null;
  targetProviderAccountId?: string | null;
  provider?: TelecomProvider;
}

export interface SubmitPortInParams {
  organizationId: string;
  phoneNumberE164: string;
  providerAccountId: string;
  requirementSnapshotId: string;
  regulatorySubjectId?: string | null;
  accountNumber?: string | null;
  portingPin?: string | null;
  authorizedName: string;
  authorizedEmail: string;
  serviceAddress?: Record<string, any>;
  portEvidence: PortEvidenceItem[];
  requestedFocDate?: string | null;
  idempotencyKey: string;
  actorIdentity: string;
}

export interface SubmitPortInResult {
  operationId: string;
  canonicalState: PortInCanonicalState;
  providerPortId?: string | null;
  outcomeCertainty: PortOutcomeCertainty;
  dispatchedAt: string;
  idempotent: boolean;
}

export interface PortOutUnlockParams {
  organizationId: string;
  phoneNumberId: string;
  phoneNumberE164: string;
  cooldownSeconds?: number;
  actorIdentity: string;
  actorRole: string;
  mfaVerified: boolean;
  reauthTimestamp: string;
}

export interface PortOutUnlockResult {
  success: boolean;
  portOutLocked: boolean;
  cooldownExpiresAt?: string | null;
  requiresManualReview: boolean;
  securityEventId: string;
}

export interface StepUpAuthContract {
  actorIdentity: string;
  actorRole: string; // Must be 'owner'
  mfaVerified: boolean;
  reauthTimestamp: string;
  maxReauthAgeSeconds: number; // Must be <= 300 (5 minutes)
}

export interface ReconcilePortResult {
  operationId: string;
  phoneNumberE164: string;
  previousState: PortCanonicalState;
  newState: PortCanonicalState | 'STILL_UNKNOWN';
  providerStatus: string;
  outcomeCertainty: PortOutcomeCertainty;
  completedCutover: boolean;
  message: string;
}
