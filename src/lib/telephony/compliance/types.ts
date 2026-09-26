import 'server-only';

export type ComplianceInternalStatus =
  | 'draft'
  | 'information_required'
  | 'ready_for_submission';

export type ComplianceEndUserType = 'business' | 'individual';

export type ComplianceReuseState =
  | 'not_evaluated'
  | 'potentially_reusable'
  | 'reuse_requires_validation'
  | 'not_compatible';

export interface EndUserFieldOption {
  label: string;
  value: string;
}

export interface EndUserFieldRequirement {
  fieldKey: string;
  groupKey?: string;
  friendlyName: string;
  required: boolean;
  description?: string;
  inputType?: 'text' | 'email' | 'tel' | 'url' | 'select' | 'radio' | 'date';
  options?: EndUserFieldOption[];
}

export interface SupportingDocumentAcceptedOption {
  name: string;
  type: string;
  fields?: Array<{ machine_name: string; friendly_name: string }>;
}

export interface SupportingDocumentRequirement {
  requirementKey: string;
  name: string;
  description?: string;
  acceptedDocuments: SupportingDocumentAcceptedOption[];
  fileEvidenceRequired: boolean;
}

export interface RequirementSnapshotPayload {
  status: string;
  regulationId: string | null;
  countryCode: string;
  numberType: string;
  endUserType: ComplianceEndUserType;
  addressRequirement: string | null;
  endUserRequirements: EndUserFieldRequirement[];
  supportingDocumentRequirements: SupportingDocumentRequirement[];
  bundleRequired: boolean;
  message?: string;
  providerMetadata?: Record<string, any>;
}

export interface OrganizationComplianceProfile {
  id: string;
  organizationId: string;
  endUserType: ComplianceEndUserType;
  countryCode: string;
  legalName: string;
  givenName?: string | null;
  familyName?: string | null;
  status: ComplianceInternalStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComplianceRequirementSnapshot {
  id: string;
  complianceProfileId: string;
  provider: 'twilio';
  providerRegulationId: string | null;
  countryCode: string;
  numberType: 'local' | 'mobile' | 'toll_free';
  endUserType: ComplianceEndUserType;
  requirementPayload: RequirementSnapshotPayload;
  retrievedAt: string;
}

export interface ComplianceFieldValue {
  id: string;
  complianceProfileId: string;
  requirementKey: string;
  fieldName: string;
  fieldValue: string;
  isEncrypted?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ComplianceProfileWithDetails extends OrganizationComplianceProfile {
  snapshots: ComplianceRequirementSnapshot[];
  fieldValues: ComplianceFieldValue[];
  documents?: any[];
  reuseState: ComplianceReuseState;
}


export interface CreateProfileParams {
  countryCode: string;
  numberType: 'local' | 'mobile' | 'toll_free';
  endUserType: ComplianceEndUserType;
  legalName: string;
  givenName?: string | null;
  familyName?: string | null;
}

export interface UpdateFieldValuesParams {
  fieldValues: Array<{
    requirementKey: string;
    fieldName: string;
    fieldValue: string;
  }>;
}

export type ProviderSubmissionState =
  | 'not_started'
  | 'preparing'
  | 'submission_pending'
  | 'submitted'
  | 'under_review'
  | 'provisionally_approved'
  | 'approved'
  | 'rejected'
  | 'action_required'
  | 'failed'
  | 'reconciliation_required';

export type ComplianceOperationType =
  | 'create_address'
  | 'create_end_user'
  | 'create_supporting_document'
  | 'create_bundle'
  | 'assign_item_to_bundle'
  | 'request_bundle_evaluation'
  | 'submit_bundle';

export type ComplianceOperationStatus =
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'reconciliation_required';

export type ComplianceResourceType =
  | 'address'
  | 'end_user'
  | 'supporting_document'
  | 'bundle'
  | 'item_assignment';

export interface ProviderComplianceOperation {
  id: string;
  organizationId: string;
  complianceProfileId: string;
  provider: 'twilio';
  operationType: ComplianceOperationType;
  idempotencyKey: string;
  status: ComplianceOperationStatus;
  attemptCount: number;
  providerResourceType: ComplianceResourceType | null;
  providerResourceId: string | null;
  requestFingerprint: string;
  lastErrorCode: string | null;
  lastErrorMessageSanitized: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastReconciledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderResourceMapping {
  id: string;
  organizationId: string;
  complianceProfileId: string;
  provider: 'twilio';
  resourceType: ComplianceResourceType;
  providerResourceId: string;
  sourceEntityId: string;
  countryCode: string;
  numberType: 'local' | 'mobile' | 'toll_free';
  endUserType: ComplianceEndUserType;
  providerRegulationId: string | null;
  providerStatus: string;
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}


