import 'server-only';
import { TelecomProvider, TelecomServiceScope } from '../types';

export type ProvisioningOperationStatus =
  | 'REQUESTED'
  | 'PROVIDER_ACCOUNT_CREATED'
  | 'RUNTIME_CREDENTIAL_CREATED'
  | 'WEBHOOK_CREDENTIAL_CAPTURED'
  | 'SECRETS_STORED'
  | 'LOCAL_ACCOUNT_RECORDED'
  | 'ASSIGNMENT_CREATED'
  | 'READY'
  | 'FAILED'
  | 'REQUIRES_RECONCILIATION';

export interface ProvisioningOperationRecord {
  id: string;
  organizationId: string;
  provider: TelecomProvider;
  serviceScope: TelecomServiceScope;
  idempotencyKey: string;
  status: ProvisioningOperationStatus;
  providerAccountReference?: string | null;
  runtimeCredentialReference?: string | null;
  runtimeKeyIdentifier?: string | null;
  webhookCredentialReference?: string | null;
  providerAccountId?: string | null;
  assignmentId?: string | null;
  attemptCount: number;
  lastErrorCode?: string | null;
  lastErrorMessageSanitized?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProvisionOrganizationProviderAccountParams {
  organizationId: string;
  provider: TelecomProvider;
  serviceScope?: TelecomServiceScope;
  idempotencyKey: string;
  organizationName?: string;
  // Security test assertion: client cannot supply foreign provider account IDs or references
  foreignProviderAccountIdOverride?: string;
}

export interface ProvisionOrganizationProviderAccountResult {
  success: boolean;
  operationId: string;
  status: ProvisioningOperationStatus;
  providerAccountId?: string;
  accountReference?: string;
  assignmentId?: string;
  isExistingAccountReused?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface CreateCustomerAccountParams {
  organizationId: string;
  organizationName?: string;
  serviceScope: TelecomServiceScope;
  idempotencyKey: string;
}

export interface CreateCustomerAccountResult {
  accountReference: string;
  accountName: string;
  status: 'active' | 'pending';
  metadata?: Record<string, unknown>;
}

export interface LookupCustomerAccountParams {
  organizationId: string;
  idempotencyKey?: string;
  accountReference?: string;
}

export interface CreateRuntimeCredentialParams {
  accountReference: string;
  organizationId: string;
}

export interface CreateRuntimeCredentialResult {
  keyIdentifier: string;
  secret: string; // One-time raw secret
  accountSid?: string;
}

export interface BootstrapWebhookCredentialParams {
  accountReference: string;
  organizationId: string;
}

export interface BootstrapWebhookCredentialResult {
  webhookSecret: string; // One-time raw secret
  accountSid?: string;
}

export interface CreateWebRtcCredentialParams {
  accountReference: string;
  organizationId: string;
}

export interface CreateWebRtcCredentialResult {
  keyIdentifier: string;
  secret: string; // One-time raw secret
  accountSid?: string;
}

export interface CreateTwimlAppParams {
  accountReference: string;
  organizationId: string;
  voiceUrl?: string;
  statusCallbackUrl?: string;
}

export interface CreateTwimlAppResult {
  appSid: string;
  friendlyName: string;
  accountSid: string;
}

export interface LookupTwimlAppParams {
  accountReference: string;
  organizationId: string;
}

export interface ProviderProvisioningAdapter {
  readonly provider: TelecomProvider;
  createCustomerAccount(params: CreateCustomerAccountParams): Promise<CreateCustomerAccountResult>;
  createRuntimeCredential(params: CreateRuntimeCredentialParams): Promise<CreateRuntimeCredentialResult>;
  resolveOrBootstrapWebhookCredential(params: BootstrapWebhookCredentialParams): Promise<BootstrapWebhookCredentialResult>;
  createWebRtcCredential?(params: CreateWebRtcCredentialParams): Promise<CreateWebRtcCredentialResult>;
  createTwimlApp?(params: CreateTwimlAppParams): Promise<CreateTwimlAppResult>;
  lookupCustomerAccountByIntent?(params: LookupCustomerAccountParams): Promise<CreateCustomerAccountResult | null>;
  lookupTwimlAppByIntent?(params: LookupTwimlAppParams): Promise<CreateTwimlAppResult | null>;
  suspendCustomerAccount?(params: { accountReference: string }): Promise<void>;
  deleteRuntimeCredential?(params: { accountReference: string; keyIdentifier: string }): Promise<void>;
  deleteWebRtcCredential?(params: { accountReference: string; keyIdentifier: string }): Promise<void>;
  deleteTwimlApp?(params: { accountReference: string; appSid: string }): Promise<void>;
  deleteCustomerAccount?(params: { accountReference: string }): Promise<void>;
}

