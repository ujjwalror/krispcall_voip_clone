import 'server-only';
import {
  TelecomSecretVault,
  StoreSecretParams,
  StoredSecretPayload,
  RotateSecretParams,
  SecretMetadata,
  CredentialPurpose,
} from './types';
import { EnvelopeTelecomSecretVault } from './envelopeTelecomSecretVault';
import { PostgresEnvelopeStorageAdapter } from './postgresEnvelopeStorageAdapter';
import { KeyEncryptionProviderRegistry } from './kms/keyEncryptionProvider';

/**
 * ============================================================================
 * LOCAL / TEST TELECOM SECRET VAULT IMPLEMENTATION
 * ============================================================================
 * Safe, deterministic, in-memory vault for automated local development & testing.
 *
 * SAFETY INVARIANTS:
 * - Provider-neutral (handles Twilio, Telnyx, Bandwidth, generic secrets)
 * - Secrets are NEVER logged or exposed in metadata
 * - Fails closed on missing, malformed, or revoked references
 * - Prevents cross-account credential leakage
 * - Distinct version-aware secret rotation
 *
 * NOTE: This is explicitly a LOCAL/TEST implementation. Production deployments
 * MUST use a dedicated external secret manager adapter (e.g. AWS/GCP/Vault).
 */
export class LocalMemoryTelecomSecretVault implements TelecomSecretVault {
  private activeSecrets: Map<string, StoredSecretPayload> = new Map();
  private secretHistory: Map<string, StoredSecretPayload[]> = new Map();

  /**
   * Stores a new secret under a unique reference identifier.
   */
  async storeSecret(params: StoreSecretParams): Promise<SecretMetadata> {
    const {
      referenceId,
      secret,
      provider,
      providerAccountId,
      keyIdentifier,
      accountReference,
      environment = 'production',
      expiresAt,
      metadata = {},
    } = params;

    if (!referenceId || typeof referenceId !== 'string' || referenceId.trim() === '') {
      throw new Error('VAULT_STORE_ERROR: Invalid or missing referenceId.');
    }

    if (!secret || typeof secret !== 'string' || secret.trim() === '') {
      throw new Error(`VAULT_STORE_ERROR: Secret value cannot be empty for reference '${referenceId}'.`);
    }

    if (!provider || typeof provider !== 'string') {
      throw new Error(`VAULT_STORE_ERROR: Provider must be specified for reference '${referenceId}'.`);
    }

    if (!providerAccountId || typeof providerAccountId !== 'string') {
      throw new Error(`VAULT_STORE_ERROR: providerAccountId must be specified for reference '${referenceId}'.`);
    }

    const now = new Date().toISOString();
    const cleanRef = referenceId.trim();

    const secretMetadata: SecretMetadata = {
      referenceId: cleanRef,
      provider: provider.toUpperCase(),
      providerAccountId: providerAccountId.trim(),
      purpose: params.purpose || 'GENERAL',
      keyIdentifier: keyIdentifier?.trim(),
      accountReference: accountReference?.trim(),
      status: 'active',
      version: 1,
      environment,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      metadata,
    };

    const payload: StoredSecretPayload = {
      secret: secret.trim(),
      metadata: secretMetadata,
    };

    this.activeSecrets.set(cleanRef, payload);
    this.secretHistory.set(cleanRef, [{ ...payload, metadata: { ...secretMetadata } }]);

    return { ...secretMetadata };
  }

  /**
   * Asynchronously retrieves a stored secret payload by reference identifier.
   */
  async getSecret(referenceId: string): Promise<StoredSecretPayload | null> {
    return this.getSecretSync(referenceId);
  }

  /**
   * Synchronously retrieves a stored secret payload (optimized for in-memory resolution).
   */
  getSecretSync(referenceId: string): StoredSecretPayload | null {
    if (!referenceId || typeof referenceId !== 'string') {
      return null;
    }

    const cleanRef = referenceId.trim();
    const record = this.activeSecrets.get(cleanRef);

    if (!record) {
      return null;
    }

    if (record.metadata.status === 'deleted') {
      return null;
    }

    return {
      secret: record.secret,
      metadata: { ...record.metadata },
    };
  }

  /**
   * Retrieves a secret payload filtered by provider account ID and specific credential purpose.
   */
  getSecretByPurpose(providerAccountId: string, purpose: CredentialPurpose): StoredSecretPayload | null {
    if (!providerAccountId || !purpose) return null;
    const cleanAccountId = providerAccountId.trim();

    for (const record of this.activeSecrets.values()) {
      if (
        record.metadata.providerAccountId === cleanAccountId &&
        record.metadata.purpose === purpose &&
        record.metadata.status === 'active'
      ) {
        return {
          secret: record.secret,
          metadata: { ...record.metadata },
        };
      }
    }
    return null;
  }

  /**
   * Rotates an existing secret reference to a new version.
   * Marks the previous version as revoked while keeping history for auditability.
   */
  async rotateSecret(params: RotateSecretParams): Promise<SecretMetadata> {
    const { referenceId, newSecret, newKeyIdentifier, newPurpose, revokePrevious = true } = params;

    if (!referenceId || typeof referenceId !== 'string') {
      throw new Error('VAULT_ROTATE_ERROR: Missing referenceId for rotation.');
    }

    const cleanRef = referenceId.trim();
    const current = this.activeSecrets.get(cleanRef);

    if (!current || current.metadata.status === 'deleted') {
      throw new Error(`VAULT_ROTATE_ERROR: Secret reference '${cleanRef}' not found for rotation.`);
    }

    if (!newSecret || typeof newSecret !== 'string' || newSecret.trim() === '') {
      throw new Error(`VAULT_ROTATE_ERROR: New secret value cannot be empty for reference '${cleanRef}'.`);
    }

    const now = new Date().toISOString();
    const newVersion = current.metadata.version + 1;

    // Archive current version into history as revoked
    if (revokePrevious) {
      const archived: StoredSecretPayload = {
        secret: current.secret,
        metadata: {
          ...current.metadata,
          status: 'revoked',
          revokedAt: now,
        },
      };
      const history = this.secretHistory.get(cleanRef) || [];
      history.push(archived);
      this.secretHistory.set(cleanRef, history);
    }

    // Update active secret to new version
    const updatedMetadata: SecretMetadata = {
      ...current.metadata,
      version: newVersion,
      status: 'active',
      purpose: newPurpose || current.metadata.purpose || 'GENERAL',
      keyIdentifier: newKeyIdentifier ? newKeyIdentifier.trim() : current.metadata.keyIdentifier,
      updatedAt: now,
      revokedAt: undefined,
    };

    const updatedPayload: StoredSecretPayload = {
      secret: newSecret.trim(),
      metadata: updatedMetadata,
    };

    this.activeSecrets.set(cleanRef, updatedPayload);

    return { ...updatedMetadata };
  }

  /**
   * Deletes a secret from the active vault.
   */
  async deleteSecret(referenceId: string): Promise<boolean> {
    if (!referenceId || typeof referenceId !== 'string') {
      return false;
    }

    const cleanRef = referenceId.trim();
    const current = this.activeSecrets.get(cleanRef);

    if (!current || current.metadata.status === 'deleted') {
      return false;
    }

    current.metadata.status = 'deleted';
    current.metadata.updatedAt = new Date().toISOString();
    this.activeSecrets.delete(cleanRef);

    return true;
  }

  /**
   * Explicitly marks a secret reference as revoked.
   */
  revokeSecret(referenceId: string): boolean {
    if (!referenceId || typeof referenceId !== 'string') {
      return false;
    }

    const cleanRef = referenceId.trim();
    const current = this.activeSecrets.get(cleanRef);

    if (!current || current.metadata.status === 'deleted') {
      return false;
    }

    current.metadata.status = 'revoked';
    current.metadata.revokedAt = new Date().toISOString();
    current.metadata.updatedAt = new Date().toISOString();
    return true;
  }

  /**
   * Retrieves metadata for a secret reference without exposing the secret value.
   */
  async getMetadata(referenceId: string): Promise<SecretMetadata | null> {
    if (!referenceId || typeof referenceId !== 'string') {
      return null;
    }

    const cleanRef = referenceId.trim();
    const record = this.activeSecrets.get(cleanRef);

    if (!record || record.metadata.status === 'deleted') {
      return null;
    }

    return { ...record.metadata };
  }

  /**
   * Resets the in-memory vault state (for test isolation).
   */
  clear(): void {
    this.activeSecrets.clear();
    this.secretHistory.clear();
  }
}

/**
 * ============================================================================
 * PRODUCTION VAULT ADAPTER STUB
 * ============================================================================
 * Explicit contract placeholder for production cloud secret managers.
 * Enforces fail-closed behavior until an approved production secret manager is integrated.
 */
export class ProductionTelecomSecretVaultStub implements TelecomSecretVault {
  async storeSecret(_params: StoreSecretParams): Promise<SecretMetadata> {
    throw new Error('PRODUCTION_VAULT_NOT_CONFIGURED: Production secret manager adapter is not configured.');
  }
  async getSecret(_referenceId: string): Promise<StoredSecretPayload | null> {
    throw new Error('PRODUCTION_VAULT_NOT_CONFIGURED: Production secret manager adapter is not configured.');
  }
  async rotateSecret(_params: RotateSecretParams): Promise<SecretMetadata> {
    throw new Error('PRODUCTION_VAULT_NOT_CONFIGURED: Production secret manager adapter is not configured.');
  }
  async deleteSecret(_referenceId: string): Promise<boolean> {
    throw new Error('PRODUCTION_VAULT_NOT_CONFIGURED: Production secret manager adapter is not configured.');
  }
  async getMetadata(_referenceId: string): Promise<SecretMetadata | null> {
    throw new Error('PRODUCTION_VAULT_NOT_CONFIGURED: Production secret manager adapter is not configured.');
  }
  async getSecretByPurpose(_providerAccountId: string, _purpose: CredentialPurpose): Promise<StoredSecretPayload | null> {
    throw new Error('PRODUCTION_VAULT_NOT_CONFIGURED: Production secret manager adapter is not configured.');
  }
}

/**
 * ============================================================================
 * TELECOM SECRET VAULT REGISTRY
 * ============================================================================
 * Authoritative singleton registry providing access to the configured TelecomSecretVault.
 *
 * PRODUCTION SELECTION INVARIANTS:
 * - Production (NODE_ENV === 'production') MUST require persistent EnvelopeTelecomSecretVault.
 * - In production, LocalMemoryTelecomSecretVault is STRICTLY PROHIBITED.
 * - If required configuration (KMS or persistent storage) is unavailable in production,
 *   startup/use fails closed with PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE.
 * - Safe non-production (tests / local dev) may use LocalMemoryTelecomSecretVault or
 *   EnvelopeTelecomSecretVault if TELECOM_VAULT_DRIVER === 'envelope'.
 */
export class TelecomSecretVaultRegistry {
  private static instance: TelecomSecretVault | null = null;

  static getVault(): TelecomSecretVault {
    if (this.instance) {
      if (process.env.NODE_ENV === 'production' && this.instance instanceof LocalMemoryTelecomSecretVault) {
        throw new Error('PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: LocalMemoryTelecomSecretVault is strictly prohibited in production.');
      }
      return this.instance;
    }

    // Lazy initialization based on runtime environment
    if (process.env.NODE_ENV === 'production') {
      try {
        const storageAdapter = new PostgresEnvelopeStorageAdapter();
        const kmsProvider = KeyEncryptionProviderRegistry.getProvider();

        const vault = new EnvelopeTelecomSecretVault({
          storageAdapter,
          kmsProvider,
        });
        this.instance = vault;
        return vault;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: ${msg || 'Production credential vault is unavailable.'}`);
      }
    }

    // Non-production (test / development)
    if (process.env.TELECOM_VAULT_DRIVER === 'envelope') {
      try {
        const storageAdapter = new PostgresEnvelopeStorageAdapter();
        const kmsProvider = KeyEncryptionProviderRegistry.getProvider();

        const vault = new EnvelopeTelecomSecretVault({
          storageAdapter,
          kmsProvider,
        });
        this.instance = vault;
        return vault;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: ${msg || 'Envelope vault initialization failed.'}`);
      }
    }

    // Safe non-production default: Local in-memory vault
    this.instance = new LocalMemoryTelecomSecretVault();
    return this.instance;
  }

  static setVault(vault: TelecomSecretVault): void {
    if (process.env.NODE_ENV === 'production' && vault instanceof LocalMemoryTelecomSecretVault) {
      throw new Error('PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: LocalMemoryTelecomSecretVault is strictly prohibited in production.');
    }
    this.instance = vault;
  }

  static resetVault(): void {
    if (this.instance instanceof LocalMemoryTelecomSecretVault) {
      this.instance.clear();
    }
    this.instance = null;
  }
}
