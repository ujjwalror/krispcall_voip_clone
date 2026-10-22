import 'server-only';
import crypto from 'crypto';
export * from './types';
import {
  KeyEncryptionProvider,
  WrapKeyParams,
  WrapKeyResult,
  UnwrapKeyParams,
} from './types';
import { serializeKmsContext } from '../aad';

import {
  AwsKmsKeyEncryptionProvider,
  AwsKmsClientLike,
} from './awsKmsKeyEncryptionProvider';
export * from './awsKmsKeyEncryptionProvider';

/**
 * ============================================================================
 * PRODUCTION CLOUD KMS ADAPTER (FAIL-CLOSED BOUNDARY)
 * ============================================================================
 * Production Cloud KMS boundary supporting AWS KMS / GCP Cloud KMS.
 *
 * SAFETY INVARIANTS:
 * - Fails closed if KMS is unconfigured or unreachable.
 * - NEVER silently falls back to local or deterministic test KMS keys.
 * - Does not invent credentials or make unauthorized external network calls.
 * - Throws sanitized error: PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE
 */
export class ProductionCloudKeyEncryptionProvider implements KeyEncryptionProvider {
  private readonly providerType: 'AWS_KMS' | 'GCP_KMS' | 'UNCONFIGURED';
  private readonly keyIdentifier: string;
  private readonly keyVersion?: string;
  private readonly delegate?: KeyEncryptionProvider;

  constructor(options?: {
    providerType?: 'AWS_KMS' | 'GCP_KMS';
    keyIdentifier?: string;
    keyVersion?: string;
    region?: string;
    delegate?: KeyEncryptionProvider;
    kmsClient?: AwsKmsClientLike;
  }) {
    const envProvider = process.env.TELECOM_KMS_PROVIDER?.trim();
    const envKeyId = process.env.TELECOM_KMS_KEY_ID?.trim();
    const envKeyVersion = process.env.TELECOM_KMS_KEY_VERSION?.trim();
    const envRegion = process.env.TELECOM_KMS_REGION?.trim() || process.env.AWS_REGION?.trim();

    let resolvedProviderType = options?.providerType;
    if (!resolvedProviderType && envProvider) {
      const normalized = envProvider.toUpperCase();
      if (normalized === 'AWS_KMS' || normalized === 'AWS') {
        resolvedProviderType = 'AWS_KMS';
      } else if (normalized === 'GCP_KMS' || normalized === 'GCP') {
        resolvedProviderType = 'GCP_KMS';
      } else {
        resolvedProviderType = envProvider as 'AWS_KMS' | 'GCP_KMS';
      }
    }
    const providerType = resolvedProviderType || 'UNCONFIGURED';
    const keyIdentifier = options?.keyIdentifier || envKeyId || '';
    const keyVersion = options?.keyVersion || envKeyVersion;
    const region = options?.region || envRegion;

    if (providerType !== 'AWS_KMS' && providerType !== 'GCP_KMS' && providerType !== 'UNCONFIGURED') {
      throw new Error(`SECURITY_CONFIG_ERROR: Unsupported KMS provider '${providerType}'. Allowed: 'AWS_KMS', 'GCP_KMS'.`);
    }

    if (providerType !== 'UNCONFIGURED' && !keyIdentifier) {
      throw new Error('SECURITY_CONFIG_ERROR: TELECOM_KMS_KEY_ID must be specified when TELECOM_KMS_PROVIDER is configured.');
    }

    this.providerType = providerType;
    this.keyIdentifier = keyIdentifier;
    this.keyVersion = keyVersion;

    if (options?.delegate) {
      this.delegate = options.delegate;
    } else if (providerType === 'AWS_KMS') {
      this.delegate = new AwsKmsKeyEncryptionProvider({
        keyIdentifier,
        region,
        keyVersion,
        kmsClient: options?.kmsClient,
      });
    }
  }

  getProviderType(): 'AWS_KMS' | 'GCP_KMS' | 'UNCONFIGURED' {
    return this.providerType;
  }

  getKeyIdentifier(): string {
    return this.delegate ? this.delegate.getKeyIdentifier() : (this.keyIdentifier || 'UNCONFIGURED_PRODUCTION_KMS_KEY');
  }

  getKeyVersion(): string | undefined {
    return this.delegate && this.delegate.getKeyVersion ? this.delegate.getKeyVersion() : this.keyVersion;
  }

  async wrapKey(params: WrapKeyParams): Promise<WrapKeyResult> {
    if (!this.delegate) {
      throw new Error('PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: Production KMS provider is unconfigured or unavailable.');
    }
    return this.delegate.wrapKey(params);
  }

  async unwrapKey(params: UnwrapKeyParams): Promise<Buffer> {
    if (!this.delegate) {
      throw new Error('PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: Production KMS provider is unconfigured or unavailable.');
    }
    return this.delegate.unwrapKey(params);
  }
}

/**
 * ============================================================================
 * DETERMINISTIC / LOCAL TEST KMS IMPLEMENTATION (TEST / DEV ONLY)
 * ============================================================================
 * Isolated local KMS implementation for deterministic unit, integration, and security testing.
 *
 * SAFETY INVARIANTS:
 * - STRICTLY FORBIDDEN IN PRODUCTION (fails closed if NODE_ENV === 'production').
 * - Deterministic 256-bit KEK with authenticated AES-256-GCM key wrapping.
 * - Cryptographically verifies KeyEncryptionContext as AAD during unwrapping.
 * - Fails closed on any tampering with wrapped DEK, tag, or encryption context.
 */
export class LocalTestKeyEncryptionProvider implements KeyEncryptionProvider {
  private readonly kek: Buffer;
  private readonly keyId: string;
  private readonly version: string;

  constructor(options?: { kek?: Buffer; keyId?: string; version?: string }) {
    this.assertNotProduction();
    this.keyId = options?.keyId || 'local-test-kek-001';
    this.version = options?.version || 'v1';
    this.kek = options?.kek || crypto.scryptSync('voip-hub-local-test-kek-seed', 'salt', 32);
  }

  private assertNotProduction(): void {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SECURITY_ERROR: LocalTestKeyEncryptionProvider cannot be used in production environment.');
    }
  }

  getKeyIdentifier(): string {
    return this.keyId;
  }

  getKeyVersion(): string | undefined {
    return this.version;
  }

  async wrapKey(params: WrapKeyParams): Promise<WrapKeyResult> {
    this.assertNotProduction();

    if (!params.plaintextDek || params.plaintextDek.length !== 32) {
      throw new Error('KMS_WRAP_ERROR: Plaintext DEK must be a valid 256-bit (32-byte) buffer.');
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.kek, iv);

    const aad = serializeKmsContext(params.context);
    cipher.setAAD(aad);

    const encryptedDek = Buffer.concat([cipher.update(params.plaintextDek), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Wrapped DEK payload format: [IV (12 bytes) | AuthTag (16 bytes) | Encrypted DEK (32 bytes)]
    const wrappedDek = Buffer.concat([iv, authTag, encryptedDek]);

    return {
      wrappedDek,
      kekIdentifier: this.keyId,
      kekVersion: this.version,
    };
  }

  async unwrapKey(params: UnwrapKeyParams): Promise<Buffer> {
    this.assertNotProduction();

    if (!params.wrappedDek || params.wrappedDek.length < 60) {
      throw new Error('KMS_UNWRAP_ERROR: Wrapped DEK is invalid or malformed.');
    }

    if (params.kekIdentifier !== this.keyId) {
      throw new Error(`KMS_UNWRAP_ERROR: KEK identifier mismatch. Expected '${this.keyId}', received '${params.kekIdentifier}'.`);
    }

    const iv = params.wrappedDek.subarray(0, 12);
    const authTag = params.wrappedDek.subarray(12, 28);
    const ciphertext = params.wrappedDek.subarray(28);

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.kek, iv);
      const aad = serializeKmsContext(params.context);
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);

      const plaintextDek = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      if (plaintextDek.length !== 32) {
        plaintextDek.fill(0);
        throw new Error('KMS_UNWRAP_ERROR: Decrypted DEK length is invalid.');
      }

      return plaintextDek;
    } catch (err: unknown) {
      throw new Error(`KMS_UNWRAP_FAILED: Authentication tag or encryption context mismatch: ${(err as Error)?.message || 'Decryption failed'}`);
    }
  }
}

/**
 * Registry managing the active KeyEncryptionProvider.
 */
export class KeyEncryptionProviderRegistry {
  private static provider: KeyEncryptionProvider | null = null;

  static getProvider(): KeyEncryptionProvider {
    if (!this.provider) {
      if (process.env.NODE_ENV === 'production') {
        this.provider = new ProductionCloudKeyEncryptionProvider();
      } else {
        this.provider = new LocalTestKeyEncryptionProvider();
      }
    }
    return this.provider;
  }

  static setProvider(provider: KeyEncryptionProvider): void {
    if (process.env.NODE_ENV === 'production' && provider instanceof LocalTestKeyEncryptionProvider) {
      throw new Error('SECURITY_ERROR: Cannot set LocalTestKeyEncryptionProvider in production.');
    }
    this.provider = provider;
  }

  static resetProvider(): void {
    if (process.env.NODE_ENV === 'production') {
      this.provider = new ProductionCloudKeyEncryptionProvider();
    } else {
      this.provider = new LocalTestKeyEncryptionProvider();
    }
  }
}
