import 'server-only';
import crypto from 'crypto';
import {
  TelecomSecretVault,
  StoreSecretParams,
  StoredSecretPayload,
  RotateSecretParams,
  SecretMetadata,
  CredentialPurpose,
  SecretStatus,
} from './types';
import {
  KeyEncryptionProvider,
  KeyEncryptionContext,
  KeyEncryptionProviderRegistry,
} from './kms/keyEncryptionProvider';
import { serializeCanonicalAad } from './aad';

export type VaultAuditEventType =
  | 'SECRET_STORED'
  | 'SECRET_ACCESSED'
  | 'SECRET_ROTATED'
  | 'SECRET_REVOKED'
  | 'SECRET_DELETED'
  | 'DECRYPTION_FAILED'
  | 'KMS_UNAVAILABLE'
  | 'CROSS_ACCOUNT_ACCESS_REJECTED';

export interface VaultAuditEvent {
  eventType: VaultAuditEventType;
  referenceId: string;
  providerAccountId?: string;
  purpose?: string;
  secretVersion?: number;
  actor?: string;
  correlationId?: string;
  result: 'SUCCESS' | 'REJECTED' | 'FAILED';
  reason?: string;
  timestamp: string;
}

export interface StoredEnvelopeRecord {
  id: string;
  provider_account_id: string;
  provider: string;
  credential_purpose: CredentialPurpose;
  reference_id: string;
  key_identifier?: string;
  account_reference?: string;
  encrypted_payload: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  wrapped_dek: Buffer;
  kek_identifier: string;
  kek_version?: string;
  secret_version: number;
  algorithm: string;
  status: SecretStatus;
  environment: string;
  created_at: string;
  updated_at: string;
  rotated_at?: string;
  revoked_at?: string;
  expires_at?: string;
  metadata: Record<string, unknown>;
}

export interface EnvelopeStorageAdapter {
  insert(record: StoredEnvelopeRecord): Promise<void>;
  findByReference(referenceId: string): Promise<StoredEnvelopeRecord | null>;
  findByPurpose(providerAccountId: string, purpose: CredentialPurpose): Promise<StoredEnvelopeRecord | null>;
  updateStatus(referenceId: string, status: SecretStatus, updateFields?: Partial<StoredEnvelopeRecord>): Promise<boolean>;
  update(record: StoredEnvelopeRecord): Promise<boolean>;
  deleteLogical(referenceId: string): Promise<boolean>;
}

/**
 * In-memory storage adapter for isolated crypto & security unit testing.
 */
export class InMemoryEnvelopeStorageAdapter implements EnvelopeStorageAdapter {
  private records: Map<string, StoredEnvelopeRecord> = new Map();

  async insert(record: StoredEnvelopeRecord): Promise<void> {
    if (this.records.has(record.reference_id)) {
      throw new Error(`STORAGE_CONFLICT: Reference '${record.reference_id}' already exists.`);
    }
    this.records.set(record.reference_id, { ...record });
  }

  async findByReference(referenceId: string): Promise<StoredEnvelopeRecord | null> {
    const rec = this.records.get(referenceId);
    return rec ? { ...rec } : null;
  }

  async findByPurpose(providerAccountId: string, purpose: CredentialPurpose): Promise<StoredEnvelopeRecord | null> {
    for (const rec of this.records.values()) {
      if (rec.provider_account_id === providerAccountId && rec.credential_purpose === purpose && rec.status === 'active') {
        return { ...rec };
      }
    }
    return null;
  }

  async updateStatus(referenceId: string, status: SecretStatus, updateFields?: Partial<StoredEnvelopeRecord>): Promise<boolean> {
    const rec = this.records.get(referenceId);
    if (!rec) return false;
    this.records.set(referenceId, {
      ...rec,
      ...updateFields,
      status,
      updated_at: new Date().toISOString(),
    });
    return true;
  }

  async update(record: StoredEnvelopeRecord): Promise<boolean> {
    if (!this.records.has(record.reference_id)) return false;
    this.records.set(record.reference_id, { ...record, updated_at: new Date().toISOString() });
    return true;
  }

  async deleteLogical(referenceId: string): Promise<boolean> {
    const rec = this.records.get(referenceId);
    if (!rec || rec.status === 'deleted') return false;
    const now = new Date().toISOString();
    // Cryptographic Revocation and Deletion: Overwrite cryptographic material with schema-compatible
    // zero-length buffers (BYTEA NOT NULL compliant) and mark status as 'deleted'.
    this.records.set(referenceId, {
      ...rec,
      status: 'deleted',
      encrypted_payload: Buffer.alloc(0),
      auth_tag: Buffer.alloc(0),
      nonce: Buffer.alloc(0),
      wrapped_dek: Buffer.alloc(0),
      revoked_at: now,
      updated_at: now,
    });
    return true;
  }

  clear(): void {
    this.records.clear();
  }
}

/**
 * ============================================================================
 * PRODUCTION-CAPABLE TWO-TIER ENVELOPE TELECOM SECRET VAULT
 * ============================================================================
 * Cryptographic Invariants:
 * 1. Two-Tier Envelope Encryption:
 *    Secret -> AES-256-GCM (per-secret random 256-bit DEK, fresh 96-bit nonce)
 *    DEK -> Wrapped by external KMS KEK via KeyEncryptionProvider.
 * 2. Canonical AAD Binding:
 *    Binds provider, providerAccountId, credentialPurpose, secretVersion, environment, referenceId.
 * 3. Zero Plaintext DEK or Secret Persistence:
 *    Plaintext DEK is zeroized immediately after wrapping/decryption.
 * 4. Zero Plaintext Secret Cache:
 *    NO_PLAINTEXT_SECRET_CACHE. Plaintext is decrypted on-demand and discarded.
 * 5. Strict Status State Machine:
 *    Only 'active' decrypts. 'revoked', 'deleted', 'previous' fail closed.
 * 6. Audit Logging:
 *    Sanitized audit events with zero sensitive material.
 */
export class EnvelopeTelecomSecretVault implements TelecomSecretVault {
  private kmsProvider: KeyEncryptionProvider;
  private storage: EnvelopeStorageAdapter;
  private auditEvents: VaultAuditEvent[] = [];
  private onAuditEvent?: (event: VaultAuditEvent) => void;

  constructor(options?: {
    kmsProvider?: KeyEncryptionProvider;
    storageAdapter?: EnvelopeStorageAdapter;
    onAuditEvent?: (event: VaultAuditEvent) => void;
  }) {
    if (typeof window !== 'undefined') {
      throw new Error('Security Error: EnvelopeTelecomSecretVault cannot be executed in browser context.');
    }
    this.kmsProvider = options?.kmsProvider || KeyEncryptionProviderRegistry.getProvider();
    this.storage = options?.storageAdapter || new InMemoryEnvelopeStorageAdapter();
    this.onAuditEvent = options?.onAuditEvent;
  }

  private emitAudit(event: Omit<VaultAuditEvent, 'timestamp'>): void {
    const fullEvent: VaultAuditEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    this.auditEvents.push(fullEvent);
    if (this.onAuditEvent) {
      try {
        this.onAuditEvent(fullEvent);
      } catch {
        // Logging failure must not compromise security execution
      }
    }
  }

  getAuditEvents(): VaultAuditEvent[] {
    return [...this.auditEvents];
  }

  clearAuditEvents(): void {
    this.auditEvents = [];
  }

  /**
   * Stores a new secret with two-tier envelope encryption.
   */
  async storeSecret(params: StoreSecretParams): Promise<SecretMetadata> {
    const {
      referenceId,
      secret,
      provider,
      providerAccountId,
      purpose = 'GENERAL',
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
      throw new Error('VAULT_STORE_ERROR: Secret value cannot be empty.');
    }
    if (!provider || typeof provider !== 'string') {
      throw new Error('VAULT_STORE_ERROR: Provider must be specified.');
    }
    if (!providerAccountId || typeof providerAccountId !== 'string') {
      throw new Error('VAULT_STORE_ERROR: providerAccountId must be specified.');
    }

    const cleanRef = referenceId.trim();
    const cleanProvider = provider.trim().toUpperCase();
    const cleanAccountId = providerAccountId.trim();
    const cleanEnv = environment.trim().toLowerCase();
    const cleanPurpose: CredentialPurpose = purpose;
    const now = new Date().toISOString();

    // 1. Generate cryptographically secure random 256-bit (32-byte) DEK
    const dek = crypto.randomBytes(32);
    let wrappedDek: Buffer;
    let kekIdentifier: string;
    let kekVersion: string | undefined;
    let encryptedPayload: Buffer;
    let authTag: Buffer;
    let nonce: Buffer;

    try {
      // 2. Generate fresh 96-bit (12-byte) AES-GCM nonce
      nonce = crypto.randomBytes(12);

      // 3. Serialize canonical AAD
      const aad = serializeCanonicalAad({
        provider: cleanProvider,
        providerAccountId: cleanAccountId,
        credentialPurpose: cleanPurpose,
        secretVersion: 1,
        environment: cleanEnv,
        referenceId: cleanRef,
      });

      // 4. AES-256-GCM encryption with AAD binding
      try {
        const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
        cipher.setAAD(aad);
        encryptedPayload = Buffer.concat([cipher.update(Buffer.from(secret, 'utf8')), cipher.final()]);
        authTag = cipher.getAuthTag();
      } catch (err: unknown) {
        this.emitAudit({
          eventType: 'DECRYPTION_FAILED',
          referenceId: cleanRef,
          providerAccountId: cleanAccountId,
          purpose: cleanPurpose,
          result: 'FAILED',
          reason: 'Encryption failed',
        });
        throw new Error(`VAULT_ENCRYPTION_ERROR: ${(err as Error)?.message || 'Encryption failed'}`);
      }

      // 5. Wrap DEK through KeyEncryptionProvider binding KMS context
      const kmsContext: KeyEncryptionContext = {
        environment: cleanEnv,
        providerAccountId: cleanAccountId,
        credentialPurpose: cleanPurpose,
        referenceId: cleanRef,
      };

      try {
        const wrapResult = await this.kmsProvider.wrapKey({
          plaintextDek: dek,
          context: kmsContext,
        });
        wrappedDek = wrapResult.wrappedDek;
        kekIdentifier = wrapResult.kekIdentifier;
        kekVersion = wrapResult.kekVersion;
      } catch (err: unknown) {
        this.emitAudit({
          eventType: 'KMS_UNAVAILABLE',
          referenceId: cleanRef,
          providerAccountId: cleanAccountId,
          purpose: cleanPurpose,
          result: 'FAILED',
          reason: (err as Error)?.message || 'KMS wrap failed',
        });
        throw new Error(`PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: ${(err as Error)?.message || 'KMS wrapping failed'}`);
      }
    } finally {
      // Best-effort reduction of plaintext key lifetime / explicit Buffer zeroization
      dek.fill(0);
    }

    // 5. Persist record to storage
    const record: StoredEnvelopeRecord = {
      id: crypto.randomUUID(),
      provider_account_id: cleanAccountId,
      provider: cleanProvider,
      credential_purpose: cleanPurpose,
      reference_id: cleanRef,
      key_identifier: keyIdentifier?.trim(),
      account_reference: accountReference?.trim(),
      encrypted_payload: encryptedPayload,
      nonce,
      auth_tag: authTag,
      wrapped_dek: wrappedDek,
      kek_identifier: kekIdentifier,
      kek_version: kekVersion,
      secret_version: 1,
      algorithm: 'AES-256-GCM',
      status: 'active',
      environment: cleanEnv,
      created_at: now,
      updated_at: now,
      expires_at: expiresAt,
      metadata,
    };

    await this.storage.insert(record);

    this.emitAudit({
      eventType: 'SECRET_STORED',
      referenceId: cleanRef,
      providerAccountId: cleanAccountId,
      purpose: cleanPurpose,
      secretVersion: 1,
      result: 'SUCCESS',
    });

    return {
      referenceId: cleanRef,
      provider: cleanProvider,
      providerAccountId: cleanAccountId,
      purpose: cleanPurpose,
      keyIdentifier: record.key_identifier,
      accountReference: record.account_reference,
      status: 'active',
      version: 1,
      environment: cleanEnv,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      algorithm: 'AES-256-GCM',
      metadata,
    };
  }

  /**
   * Asynchronously retrieves and decrypts a secret reference.
   *
   * STRICT SAFETY BOUNDARIES:
   * - Fails closed on revoked, deleted, or previous secret status.
   * - Fails closed on expired secrets.
   * - Fails closed on KMS unwrap failure or context tampering.
   * - Fails closed on AES-GCM authentication tag verification failure.
   * - ZERO plaintext secret cache.
   */
  async getSecret(referenceId: string): Promise<StoredSecretPayload | null> {
    if (!referenceId || typeof referenceId !== 'string') {
      return null;
    }

    const cleanRef = referenceId.trim();
    const record = await this.storage.findByReference(cleanRef);

    if (!record) {
      return null;
    }

    // Status state machine enforcement
    if (record.status === 'deleted') {
      this.emitAudit({
        eventType: 'SECRET_DELETED',
        referenceId: cleanRef,
        providerAccountId: record.provider_account_id,
        purpose: record.credential_purpose,
        secretVersion: record.secret_version,
        result: 'REJECTED',
        reason: 'Attempted access to deleted secret',
      });
      return null;
    }

    if (record.status === 'revoked') {
      this.emitAudit({
        eventType: 'SECRET_REVOKED',
        referenceId: cleanRef,
        providerAccountId: record.provider_account_id,
        purpose: record.credential_purpose,
        secretVersion: record.secret_version,
        result: 'REJECTED',
        reason: 'Attempted access to revoked secret',
      });
      return null;
    }

    if (record.status === 'previous') {
      this.emitAudit({
        eventType: 'CROSS_ACCOUNT_ACCESS_REJECTED',
        referenceId: cleanRef,
        providerAccountId: record.provider_account_id,
        purpose: record.credential_purpose,
        secretVersion: record.secret_version,
        result: 'REJECTED',
        reason: 'Previous secret is not permitted as implicit runtime fallback',
      });
      return null;
    }

    if (record.status !== 'active') {
      return null;
    }

    // Algorithm, version, and KEK identifier verification (fail-closed on unknown algorithm or version)
    if (record.algorithm !== 'AES-256-GCM') {
      this.emitAudit({
        eventType: 'DECRYPTION_FAILED',
        referenceId: cleanRef,
        providerAccountId: record.provider_account_id,
        purpose: record.credential_purpose,
        secretVersion: record.secret_version,
        result: 'REJECTED',
        reason: `Unsupported encryption algorithm: ${record.algorithm}`,
      });
      throw new Error(`VAULT_DECRYPTION_FAILED: Unsupported encryption algorithm '${record.algorithm}'.`);
    }

    if (!record.secret_version || record.secret_version < 1) {
      this.emitAudit({
        eventType: 'DECRYPTION_FAILED',
        referenceId: cleanRef,
        providerAccountId: record.provider_account_id,
        purpose: record.credential_purpose,
        secretVersion: record.secret_version,
        result: 'REJECTED',
        reason: 'Invalid secret version',
      });
      throw new Error('VAULT_DECRYPTION_FAILED: Invalid secret version.');
    }

    if (!record.kek_identifier || record.kek_identifier.trim() === '') {
      this.emitAudit({
        eventType: 'KMS_UNAVAILABLE',
        referenceId: cleanRef,
        providerAccountId: record.provider_account_id,
        purpose: record.credential_purpose,
        secretVersion: record.secret_version,
        result: 'REJECTED',
        reason: 'Missing KEK identifier',
      });
      throw new Error('VAULT_DECRYPTION_FAILED: Missing KEK identifier.');
    }

    // Expiration enforcement
    if (record.expires_at) {
      const expTime = new Date(record.expires_at).getTime();
      if (!isNaN(expTime) && expTime <= Date.now()) {
        this.emitAudit({
          eventType: 'DECRYPTION_FAILED',
          referenceId: cleanRef,
          providerAccountId: record.provider_account_id,
          purpose: record.credential_purpose,
          secretVersion: record.secret_version,
          result: 'REJECTED',
          reason: 'Secret expired',
        });
        return null;
      }
    }

    // 1. KMS Unwrap DEK
    const kmsContext: KeyEncryptionContext = {
      environment: record.environment,
      providerAccountId: record.provider_account_id,
      credentialPurpose: record.credential_purpose,
      referenceId: record.reference_id,
    };

    let dek: Buffer | null = null;
    let secretPlaintext: string;

    try {
      try {
        dek = await this.kmsProvider.unwrapKey({
          wrappedDek: record.wrapped_dek,
          context: kmsContext,
          kekIdentifier: record.kek_identifier,
          kekVersion: record.kek_version,
        });
      } catch (err: unknown) {
        this.emitAudit({
          eventType: 'KMS_UNAVAILABLE',
          referenceId: cleanRef,
          providerAccountId: record.provider_account_id,
          purpose: record.credential_purpose,
          secretVersion: record.secret_version,
          result: 'FAILED',
          reason: (err as Error)?.message || 'KMS unwrap failed',
        });
        throw new Error(`PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: ${(err as Error)?.message || 'Failed to unwrap DEK'}`);
      }

      // 2. Decrypt with AES-256-GCM using canonical AAD
      try {
        const aad = serializeCanonicalAad({
          provider: record.provider,
          providerAccountId: record.provider_account_id,
          credentialPurpose: record.credential_purpose,
          secretVersion: record.secret_version,
          environment: record.environment,
          referenceId: record.reference_id,
        });

        const decipher = crypto.createDecipheriv('aes-256-gcm', dek, record.nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(record.auth_tag);

        const plaintextBuf = Buffer.concat([decipher.update(record.encrypted_payload), decipher.final()]);
        secretPlaintext = plaintextBuf.toString('utf8');
      } catch {
        this.emitAudit({
          eventType: 'DECRYPTION_FAILED',
          referenceId: cleanRef,
          providerAccountId: record.provider_account_id,
          purpose: record.credential_purpose,
          secretVersion: record.secret_version,
          result: 'FAILED',
          reason: 'Ciphertext authentication tag or AAD verification failed',
        });
        throw new Error('VAULT_DECRYPTION_FAILED: Ciphertext authentication or context verification failed.');
      }
    } finally {
      // Best-effort reduction of plaintext key lifetime / explicit Buffer zeroization
      if (dek) {
        dek.fill(0);
      }
    }

    this.emitAudit({
      eventType: 'SECRET_ACCESSED',
      referenceId: cleanRef,
      providerAccountId: record.provider_account_id,
      purpose: record.credential_purpose,
      secretVersion: record.secret_version,
      result: 'SUCCESS',
    });

    const metadata: SecretMetadata = {
      referenceId: record.reference_id,
      provider: record.provider,
      providerAccountId: record.provider_account_id,
      purpose: record.credential_purpose,
      keyIdentifier: record.key_identifier,
      accountReference: record.account_reference,
      status: record.status,
      version: record.secret_version,
      environment: record.environment,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
      revokedAt: record.revoked_at,
      expiresAt: record.expires_at,
      algorithm: record.algorithm,
      metadata: record.metadata,
    };

    return {
      secret: secretPlaintext,
      metadata,
    };
  }

  /**
   * Retrieves a secret payload filtered by providerAccountId and credentialPurpose.
   */
  async getSecretByPurpose(providerAccountId: string, purpose: CredentialPurpose): Promise<StoredSecretPayload | null> {
    if (!providerAccountId || !purpose) return null;
    const cleanAccountId = providerAccountId.trim();

    const record = await this.storage.findByPurpose(cleanAccountId, purpose);
    if (!record) return null;

    return this.getSecret(record.reference_id);
  }

  /**
   * Rotates a secret reference to a new version (N -> N+1).
   * Generates a new DEK, new nonce, and wraps through KMS.
   *
   * IN-PLACE SECRET ROTATION (Phase 22C-R2.1 Architecture Limitation):
   * WARNING: This operation performs an IN-PLACE update of the envelope secret row in
   * `public.telecom_vault_secrets`. Because `reference_id` has a UNIQUE constraint in the
   * certified schema, previous ciphertext, nonce, auth tag, and wrapped DEK are overwritten.
   * This operation DOES NOT preserve historical ciphertexts and MUST NOT be described as
   * audit-preserving rotation. Preserving encrypted historical versions requires future
   * architectural schema design (SECRET_ROTATION_HISTORY_REQUIRES_DESIGN).
   *
   * ZEROIZATION GUARANTEE:
   * Plaintext DEK cleanup is registered immediately upon allocation; explicit Buffer zeroization
   * is guaranteed to execute in a `finally` block even if cipher construction, AAD setup,
   * encryption, auth tag retrieval, KMS wrapping, or storage persistence fails.
   */
  async rotateSecret(params: RotateSecretParams): Promise<SecretMetadata> {
    const { referenceId, newSecret, newKeyIdentifier, newPurpose } = params;

    if (!referenceId || typeof referenceId !== 'string') {
      throw new Error('VAULT_ROTATE_ERROR: Missing referenceId.');
    }
    if (!newSecret || typeof newSecret !== 'string' || newSecret.trim() === '') {
      throw new Error('VAULT_ROTATE_ERROR: New secret value cannot be empty.');
    }

    const cleanRef = referenceId.trim();
    const current = await this.storage.findByReference(cleanRef);

    if (!current || current.status === 'deleted') {
      throw new Error(`VAULT_ROTATE_ERROR: Reference '${cleanRef}' not found or deleted.`);
    }

    const now = new Date().toISOString();
    const newVersion = current.secret_version + 1;
    const cleanPurpose = newPurpose || current.credential_purpose;

    // 1. Generate fresh DEK
    const dek = crypto.randomBytes(32);
    let wrappedDek: Buffer;
    let kekIdentifier: string;
    let kekVersion: string | undefined;
    let encryptedPayload: Buffer;
    let authTag: Buffer;
    let nonce: Buffer;

    try {
      // 2. Generate fresh 96-bit (12-byte) AES-GCM nonce
      nonce = crypto.randomBytes(12);

      // 3. Serialize canonical AAD
      const aad = serializeCanonicalAad({
        provider: current.provider,
        providerAccountId: current.provider_account_id,
        credentialPurpose: cleanPurpose,
        secretVersion: newVersion,
        environment: current.environment,
        referenceId: cleanRef,
      });

      // 4. AES-256-GCM encryption with AAD binding
      try {
        const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
        cipher.setAAD(aad);
        encryptedPayload = Buffer.concat([cipher.update(Buffer.from(newSecret, 'utf8')), cipher.final()]);
        authTag = cipher.getAuthTag();
      } catch (err: unknown) {
        this.emitAudit({
          eventType: 'DECRYPTION_FAILED',
          referenceId: cleanRef,
          providerAccountId: current.provider_account_id,
          purpose: cleanPurpose,
          result: 'FAILED',
          reason: 'Rotation encryption failed',
        });
        throw new Error(`VAULT_ENCRYPTION_ERROR: ${(err as Error)?.message || 'Rotation encryption failed'}`);
      }

      // 5. Wrap DEK through KeyEncryptionProvider binding KMS context
      const kmsContext: KeyEncryptionContext = {
        environment: current.environment,
        providerAccountId: current.provider_account_id,
        credentialPurpose: cleanPurpose,
        referenceId: cleanRef,
      };

      try {
        const wrapResult = await this.kmsProvider.wrapKey({
          plaintextDek: dek,
          context: kmsContext,
        });
        wrappedDek = wrapResult.wrappedDek;
        kekIdentifier = wrapResult.kekIdentifier;
        kekVersion = wrapResult.kekVersion;
      } catch (err: unknown) {
        this.emitAudit({
          eventType: 'KMS_UNAVAILABLE',
          referenceId: cleanRef,
          providerAccountId: current.provider_account_id,
          purpose: cleanPurpose,
          result: 'FAILED',
          reason: (err as Error)?.message || 'Rotation KMS wrap failed',
        });
        throw new Error(`PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: ${(err as Error)?.message || 'Rotation KMS wrap failed'}`);
      }

      const updatedRecord: StoredEnvelopeRecord = {
        ...current,
        encrypted_payload: encryptedPayload,
        nonce,
        auth_tag: authTag,
        wrapped_dek: wrappedDek,
        kek_identifier: kekIdentifier,
        kek_version: kekVersion,
        secret_version: newVersion,
        credential_purpose: cleanPurpose,
        key_identifier: newKeyIdentifier ? newKeyIdentifier.trim() : current.key_identifier,
        status: 'active',
        updated_at: now,
        rotated_at: now,
        revoked_at: undefined,
      };

      await this.storage.update(updatedRecord);

      this.emitAudit({
        eventType: 'SECRET_ROTATED',
        referenceId: cleanRef,
        providerAccountId: current.provider_account_id,
        purpose: cleanPurpose,
        secretVersion: newVersion,
        result: 'SUCCESS',
      });

      return {
        referenceId: cleanRef,
        provider: current.provider,
        providerAccountId: current.provider_account_id,
        purpose: cleanPurpose,
        keyIdentifier: updatedRecord.key_identifier,
        accountReference: current.account_reference,
        status: 'active',
        version: newVersion,
        environment: current.environment,
        createdAt: current.created_at,
        updatedAt: now,
        rotatedAt: now,
        algorithm: current.algorithm,
        metadata: current.metadata,
      };
    } finally {
      // Best-effort reduction of plaintext key lifetime / explicit Buffer zeroization
      dek.fill(0);
    }
  }

  /**
   * Cryptographic Revocation and Deletion:
   * Permanently revokes and marks a secret reference as 'deleted'.
   *
   * STORAGE DELETION MODEL:
   * Model: CRYPTOGRAPHIC_REVOCATION_AND_DELETION.
   * Note on PostgreSQL physical zeroization: PostgreSQL MVCC architecture,
   * Write-Ahead Logging (WAL), point-in-time snapshots, and streaming replicas
   * preserve physical page versions. Therefore, this implementation does NOT claim
   * guaranteed physical disk zeroization from PostgreSQL. Instead, it provides
   * rigorous Cryptographic Revocation and Deletion:
   * 1. Status is permanently transitioned to 'deleted'
   * 2. Active runtime retrieval via getSecret and findByPurpose immediately fails closed
   * 3. Rotation or key-derivation from deleted secrets is strictly prohibited
   * 4. Wrapped DEKs and encrypted payload are logically overwritten with schema-compatible
   *    zero-length byte arrays (Buffer.alloc(0) / E'\\x'), ensuring compatibility with
   *    BYTEA NOT NULL schema constraints while destroying active cipher material
   * 5. Audit metadata and tombstone records are preserved for compliance and verification.
   */
  async deleteSecret(referenceId: string): Promise<boolean> {
    if (!referenceId || typeof referenceId !== 'string') {
      return false;
    }

    const cleanRef = referenceId.trim();
    const record = await this.storage.findByReference(cleanRef);
    if (!record || record.status === 'deleted') {
      return false;
    }

    await this.storage.deleteLogical(cleanRef);

    this.emitAudit({
      eventType: 'SECRET_DELETED',
      referenceId: cleanRef,
      providerAccountId: record.provider_account_id,
      purpose: record.credential_purpose,
      secretVersion: record.secret_version,
      result: 'SUCCESS',
      reason: 'Cryptographic revocation and logical deletion completed',
    });

    return true;
  }

  /**
   * Retrieves secret metadata without decrypting secret or unwrapping DEK.
   */
  async getMetadata(referenceId: string): Promise<SecretMetadata | null> {
    if (!referenceId || typeof referenceId !== 'string') {
      return null;
    }

    const cleanRef = referenceId.trim();
    const record = await this.storage.findByReference(cleanRef);
    if (!record || record.status === 'deleted') {
      return null;
    }

    return {
      referenceId: record.reference_id,
      provider: record.provider,
      providerAccountId: record.provider_account_id,
      purpose: record.credential_purpose,
      keyIdentifier: record.key_identifier,
      accountReference: record.account_reference,
      status: record.status,
      version: record.secret_version,
      environment: record.environment,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
      rotatedAt: record.rotated_at,
      revokedAt: record.revoked_at,
      expiresAt: record.expires_at,
      algorithm: record.algorithm,
      metadata: record.metadata,
    };
  }
}
