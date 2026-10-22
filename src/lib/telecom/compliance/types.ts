import 'server-only';
import { ProviderContext } from '@/lib/telecom/provider/types';

/**
 * ==============================================================================
 * PHASE 23D.7B: PROVIDER-NEUTRAL REGULATORY COMPLIANCE DOMAIN TYPES
 * ==============================================================================
 * Authoritative types establishing the decoupling of:
 * - Organization != RegulatorySubject
 * - RequirementsDiscovered != ComplianceApproved
 * - ProviderObjectExists != ComplianceApproved
 * - ComplianceApproved != PermanentlyApproved
 */

export type SubjectType = 'business' | 'individual';

export type CanonicalNumberType = 'local' | 'national' | 'mobile' | 'toll_free';

export type AddressRequirement = 'NONE' | 'ANY' | 'LOCAL' | 'FOREIGN';

/**
 * Canonical Compliance Case State (Provider-Neutral Lifecycle)
 */
export type CanonicalComplianceCaseState =
  | 'NOT_REQUIRED'
  | 'REQUIREMENTS_DISCOVERED'
  | 'INCOMPLETE'
  | 'READY_FOR_SUBMISSION'
  | 'SUBMISSION_PENDING'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'UPDATE_REQUIRED'
  | 'EXPIRED'
  | 'UNKNOWN'
  | 'MANUAL_REVIEW_REQUIRED';

export type ComplianceEvidenceStatus =
  | 'UPLOADED'
  | 'VALIDATED'
  | 'SUBMITTED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'DELETED';

export type ComplianceBindingStatus = 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';

export type ComplianceEnforcementDecision =
  | 'ALLOW'
  | 'BLOCK_NEW_PROVISIONING'
  | 'BLOCK_CAPABILITY_ACTIVATION'
  | 'BLOCK_NEW_OUTBOUND_USAGE'
  | 'SUSPEND_EXISTING_SERVICE'
  | 'MANUAL_REVIEW'
  | 'UNKNOWN_FAIL_CLOSED';

export interface RegulatorySubject {
  id: string;
  organizationId: string;
  subjectType: SubjectType;
  legalName: string;
  tradeName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email: string;
  phoneNumber?: string | null;
  registrationNumberEncrypted?: string | null;
  taxIdEncrypted?: string | null;
  addressStreet?: string | null;
  addressExtended?: string | null;
  addressCity?: string | null;
  addressRegion?: string | null;
  addressPostalCode?: string | null;
  addressCountryCode: string; // ISO 3166-1 alpha-2
  encryptionMetadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface ComplianceRequirementSnapshot {
  id: string;
  complianceProfileId?: string | null;
  provider: string;
  providerRegulationId: string | null;
  countryCode: string;
  numberType: string;
  canonicalNumberType?: CanonicalNumberType | null;
  endUserType: SubjectType;
  requirementPayload: Record<string, any>;
  constraintsPayload?: Record<string, any>;
  retrievedAt: string;
  fingerprint?: string | null;
}

export interface ComplianceCase {
  id: string;
  organizationId: string;
  regulatorySubjectId: string;
  requirementSnapshotId?: string | null;
  provider: string;
  providerAccountId?: string | null;
  countryCode: string;
  numberType: CanonicalNumberType;
  subjectType: SubjectType;
  canonicalStatus: CanonicalComplianceCaseState;
  rawProviderStatus?: string | null;
  rejectionReasons: string[];
  validUntil?: string | null;
  submittedAt?: string | null;
  approvedAt?: string | null;
  reconciledAt?: string | null;
  idempotencyKey?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComplianceEvidence {
  id: string;
  organizationId: string;
  regulatorySubjectId: string;
  complianceCaseId?: string | null;
  evidenceType: string;
  storageObjectPath: string;
  originalFilenameSanitized: string;
  mimeType: string;
  sizeBytes: number;
  sha256Hash: string;
  status: ComplianceEvidenceStatus;
  validUntil?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NumberComplianceBinding {
  id: string;
  organizationId: string;
  phoneNumberId: string;
  complianceCaseId: string;
  providerComplianceResourceId?: string | null;
  status: ComplianceBindingStatus;
  boundAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiscoveredEndUserField {
  fieldKey: string;
  friendlyName: string;
  description: string;
  required: boolean;
  inputType: 'text' | 'email' | 'tel' | 'date' | 'select' | 'radio';
  options?: Array<{ label: string; value: string }>;
}

export interface DiscoveredDocumentType {
  typeKey: string;
  friendlyName: string;
  description: string;
  acceptedDocumentNames: string[];
  fileUploadRequired: boolean;
}

export interface DiscoveredRequirementResult {
  provider: string;
  providerRegulationId: string | null;
  countryCode: string;
  numberType: CanonicalNumberType;
  endUserType: SubjectType;
  bundleRequired: boolean;
  addressRequirement: AddressRequirement;
  requiredEndUserFields: DiscoveredEndUserField[];
  requiredDocumentTypes: DiscoveredDocumentType[];
  retrievedAt: string;
  fingerprint: string;
  rawProviderMetadata?: Record<string, any>;
  isAuthoritativelyNotRequired?: boolean;
}

export interface DiscoverRequirementsParams {
  provider: 'TWILIO' | 'BANDWIDTH' | 'TELNYX';
  countryCode: string;
  numberType: CanonicalNumberType;
  subjectType: SubjectType;
  useCase?: string;
  providerContext?: ProviderContext;
  bypassCache?: boolean;
}

export interface ComplianceEvaluationResult {
  status: CanonicalComplianceCaseState;
  eligibleForPurchase: boolean;
  eligibleForActivation: boolean;
  decision: ComplianceEnforcementDecision;
  blockingReasons: string[];
  applicableComplianceCaseId?: string | null;
  applicableBundleSid?: string | null;
}

export interface ProviderComplianceOperationRecord {
  id: string;
  organizationId: string;
  complianceCaseId?: string | null;
  providerAccountId?: string | null;
  provider: string;
  operationType: string;
  idempotencyKey: string;
  status: 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'reconciliation_required';
  attemptCount: number;
  providerResourceType?: string | null;
  providerResourceId?: string | null;
  requestFingerprint: string;
  lastErrorCode?: string | null;
  lastErrorMessageSanitized?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  lastReconciledAt?: string | null;
}
