import 'server-only';
import {
  NumberCapabilityType,
  NumberCapabilityStage,
  NumberCapabilityDetail,
  NumberCapabilitiesState,
  PhoneNumberOwnershipState,
  PhoneNumberServiceState,
  PhoneNumberComplianceState,
} from '@/lib/telecom/domain/types';

export type {
  NumberCapabilityType,
  NumberCapabilityStage,
  NumberCapabilityDetail,
  NumberCapabilitiesState,
  PhoneNumberOwnershipState,
  PhoneNumberServiceState,
  PhoneNumberComplianceState,
};

export type CapabilityErrorCode =
  | 'NUMBER_NOT_FOUND'
  | 'NUMBER_NOT_OWNED'
  | 'NUMBER_NOT_ACTIVE'
  | 'NUMBER_SUSPENDED'
  | 'NUMBER_RELEASED'
  | 'NUMBER_RELEASE_PENDING'
  | 'NUMBER_PORTED_OUT'
  | 'NUMBER_ACQUISITION_PENDING'
  | 'NUMBER_UNAVAILABLE'
  | 'NUMBER_PROVISIONING'
  | 'PROVIDER_RESOURCE_MISSING'
  | 'PROVIDER_RESOURCE_MISMATCH'
  | 'PROVIDER_RESOURCE_INCONSISTENT'
  | 'PROVIDER_ACCOUNT_MISSING'
  | 'PROVIDER_ACCOUNT_INACTIVE'
  | 'PROVIDER_ACCOUNT_MISMATCH'
  | 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED'
  | 'CAPABILITY_NOT_CONFIGURED'
  | 'CAPABILITY_ADVERTISED_NOT_USABLE'
  | 'CAPABILITY_PROVISIONED_NOT_CONFIGURED'
  | 'CAPABILITY_NOT_USABLE'
  | 'CAPABILITY_BLOCKED'
  | 'COMPLIANCE_REQUIRED'
  | 'COMPLIANCE_REJECTED'
  | 'COMPLIANCE_EXPIRED'
  | 'USER_NOT_ASSIGNED'
  | 'NUMBER_UNASSIGNED'
  | 'NO_ELIGIBLE_SENDER'
  | 'CAPABILITY_RECONCILIATION_REQUIRED'
  | 'CAPABILITY_DISABLED'
  | 'INTERNAL_ERROR';

export interface CapabilityAuthorizationContext {
  userId?: string;
  destination?: string;
  defaultCountry?: string;
  requireAssignment?: boolean;
  complianceProfileId?: string;
  mediaUrls?: string[];
}

export interface CapabilityAuthorizationEvidence {
  ownershipState?: PhoneNumberOwnershipState | string;
  serviceState?: PhoneNumberServiceState | string;
  stage?: NumberCapabilityStage | string;
  providerAccountType?: string;
  providerAccountStatus?: string;
  providerResourceMatch?: boolean;
  assignmentVerified?: boolean;
  complianceVerified?: boolean;
  reconciliationRequired?: boolean;
}

export interface CapabilityAuthorizationResult {
  allowed: boolean;
  code: CapabilityErrorCode | 'AUTHORIZED';
  reason: string;
  capability: NumberCapabilityType;
  stage?: NumberCapabilityStage;
  phoneNumberId: string;
  phoneNumberE164: string;
  organizationId: string;
  providerAccountId?: string;
  providerResourceRecordId?: string;
  telecomProviderResourceId?: string;
  auditEvidence: CapabilityAuthorizationEvidence;
}
