import 'server-only';

export type TelecomProvider = 'TWILIO' | 'TELNYX' | 'BANDWIDTH' | 'AWS_CHIME' | 'OTHER';

export type ProviderAccountType = 'SHARED_PARENT' | 'CUSTOMER_SUBACCOUNT' | 'DEDICATED_ACCOUNT' | 'OTHER';

export type TelecomServiceScope =
  | 'ALL'
  | 'VOICE'
  | 'SMS'
  | 'MMS'
  | 'NUMBER_MANAGEMENT'
  | 'RECORDING'
  | 'COMPLIANCE';

export type ProviderAccountStatus = 'active' | 'suspended' | 'deprovisioned' | 'maintenance';

export type ProviderEnvironment = 'production' | 'development' | 'staging' | 'sandbox';

export type ProviderResourceType =
  | 'PHONE_NUMBER'
  | 'CALL'
  | 'MESSAGE'
  | 'RECORDING'
  | 'COMPLIANCE_RESOURCE';

export interface ProviderAccountRecord {
  id: string;
  provider: TelecomProvider;
  accountType: ProviderAccountType;
  accountReference: string;
  credentialReference: string;
  status: ProviderAccountStatus;
  capabilities: TelecomServiceScope[];
  environment: ProviderEnvironment;
  parentProviderAccountId?: string | null;
  metadata: Record<string, any>;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrganizationProviderAssignmentRecord {
  id: string;
  organizationId: string;
  providerAccountId: string;
  serviceScope: TelecomServiceScope;
  countryCode?: string | null;
  priority: number;
  isActive: boolean;
  metadata: Record<string, any>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProviderContext {
  providerAccountId: string;
  provider: TelecomProvider;
  accountType: ProviderAccountType;
  accountReference: string;
  credentialReference: string;
  organizationId: string;
  serviceScope: TelecomServiceScope;
  countryCode?: string | null;
  environment: ProviderEnvironment;
  capabilities: TelecomServiceScope[];
  isSharedParent: boolean;
  metadata?: Record<string, any>;
}

export interface ProviderResourceRecord {
  id: string;
  organizationId: string;
  providerAccountId: string;
  resourceType: ProviderResourceType;
  localResourceId: string;
  remoteResourceId: string;
  provider: TelecomProvider;
  status: string;
  metadata: Record<string, any>;
  createdAt?: string;
  updatedAt?: string;
}

export type ProviderResolutionIntent = 'CUSTOMER_RUNTIME' | 'PLATFORM_ADMIN';

export interface ResolveProviderAccountParams {
  organizationId: string;
  service: TelecomServiceScope;
  intent?: ProviderResolutionIntent;
  expectedProvider?: TelecomProvider;
  environment?: ProviderEnvironment;
  operation?: string;
  countryCode?: string | null;
  phoneNumberId?: string | null;
  strictMode?: boolean; // Defaults to true (Phase 24D.SEC-7F M-01)
  _dangerouslyPermitNonStrict?: boolean; // Explicit administrative opt-out for non-strict operations
  clientPayloadProviderOverride?: string; // For testing negative assertions: must be strictly rejected
  clientPayloadIntentOverride?: string; // For testing negative assertions: client payload attempting to elevate to PLATFORM_ADMIN
}

export interface ResolvePlatformAdminAccountParams {
  service: TelecomServiceScope;
  environment?: ProviderEnvironment;
  expectedProvider?: TelecomProvider;
  clientPayloadProviderOverride?: string;
  clientPayloadIntentOverride?: string;
}

export type ProviderResolutionErrorCode =
  | 'UNKNOWN_ORGANIZATION'
  | 'MISSING_PROVIDER_ASSIGNMENT'
  | 'PROVIDER_ASSIGNMENT_REQUIRED'
  | 'AMBIGUOUS_PROVIDER_ASSIGNMENT'
  | 'UNKNOWN_OR_INACTIVE_PROVIDER'
  | 'PROVIDER_ACCOUNT_INACTIVE'
  | 'CAPABILITY_UNSUPPORTED'
  | 'CLIENT_OVERRIDE_PROHIBITED'
  | 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED'
  | 'PROVIDER_ENVIRONMENT_MISMATCH'
  | 'PROVIDER_MISMATCH'
  | 'MALFORMED_PROVIDER_ACCOUNT'
  | 'INVALID_RESOLUTION_INTENT'
  | 'STRICT_RESOLUTION_REQUIRED'
  | 'DATABASE_ERROR';

export interface ProviderResolutionResult {
  success: boolean;
  context?: ProviderContext;
  errorCode?: ProviderResolutionErrorCode;
  errorMessage?: string;
}

