import 'server-only';
import { TelecomProvider } from '../provider/types';

export type SecretStatus = 'active' | 'previous' | 'revoked' | 'deleted';
export type CredentialPurpose = 'RUNTIME_API' | 'WEBHOOK_VERIFICATION' | 'WEBRTC_TOKEN_SIGNING' | 'ADMINISTRATIVE' | 'GENERAL';

export interface SecretMetadata {
  referenceId: string;
  provider: TelecomProvider | string;
  providerAccountId: string;
  purpose?: CredentialPurpose;
  keyIdentifier?: string; // e.g., Twilio API Key SID (SKxxx) or public key identifier
  accountReference?: string; // e.g., Twilio Subaccount SID (ACxxx)
  status: SecretStatus;
  version: number;
  environment?: string;
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
  algorithm?: string;
  metadata?: Record<string, any>;
}

export interface StoreSecretParams {
  referenceId: string;
  secret: string;
  provider: TelecomProvider | string;
  providerAccountId: string;
  purpose?: CredentialPurpose;
  keyIdentifier?: string;
  accountReference?: string;
  environment?: string;
  expiresAt?: string;
  metadata?: Record<string, any>;
}

export interface StoredSecretPayload {
  secret: string;
  metadata: SecretMetadata;
}

export interface RotateSecretParams {
  referenceId: string;
  newSecret: string;
  newKeyIdentifier?: string;
  newPurpose?: CredentialPurpose;
  revokePrevious?: boolean;
}

/**
 * Provider-Neutral Secret Vault Interface.
 *
 * Designed to handle runtime credentials across any telecom provider:
 * - Twilio Subaccount API Key Secrets
 * - Twilio Subaccount Auth Tokens
 * - Telnyx API Keys
 * - Bandwidth API Credentials
 * - Generic Provider Bearer Tokens
 *
 * SECRETS ARE NEVER RETURNED IN METADATA OR LOGS.
 */
export interface TelecomSecretVault {
  storeSecret(params: StoreSecretParams): Promise<SecretMetadata>;
  getSecret(referenceId: string): Promise<StoredSecretPayload | null>;
  getSecretSync?(referenceId: string): StoredSecretPayload | null;
  getSecretByPurpose?(providerAccountId: string, purpose: CredentialPurpose): Promise<StoredSecretPayload | null> | StoredSecretPayload | null;
  rotateSecret(params: RotateSecretParams): Promise<SecretMetadata>;
  deleteSecret(referenceId: string): Promise<boolean>;
  getMetadata(referenceId: string): Promise<SecretMetadata | null>;
}
