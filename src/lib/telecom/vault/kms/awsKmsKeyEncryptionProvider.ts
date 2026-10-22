import 'server-only';
import {
  KMSClient,
  EncryptCommand,
  DecryptCommand,
  EncryptCommandOutput,
  DecryptCommandOutput,
} from '@aws-sdk/client-kms';
import {
  KeyEncryptionProvider,
  WrapKeyParams,
  WrapKeyResult,
  UnwrapKeyParams,
  KeyEncryptionContext,
} from './types';

/**
 * Interface representing the minimal AWS KMS client contract needed by the adapter.
 * Supports native dependency injection of mock/fake clients for 100% network-free testing.
 */
export interface AwsKmsClientLike {
  send(
    command: EncryptCommand,
    options?: { abortSignal?: AbortSignal }
  ): Promise<EncryptCommandOutput>;
  send(
    command: DecryptCommand,
    options?: { abortSignal?: AbortSignal }
  ): Promise<DecryptCommandOutput>;
  send<TInput extends object, TOutput extends object>(
    command: { input?: TInput } | unknown,
    options?: { abortSignal?: AbortSignal }
  ): Promise<TOutput>;
}

export interface AwsKmsKeyEncryptionProviderOptions {
  keyIdentifier?: string;
  region?: string;
  keyVersion?: string;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  kmsClient?: AwsKmsClientLike;
}

/**
 * Validates AWS KMS key identifier format.
 * Supports:
 * 1. Key ARN: arn:aws(-[a-z]+)?:kms:<region>:<account-id>:key/<uuid>
 * 2. Alias ARN: arn:aws(-[a-z]+)?:kms:<region>:<account-id>:alias/<alias-name>
 * 3. Key ID: UUID format (with optional mrk- prefix for multi-region keys)
 * 4. Alias Name: alias/<alias-name>
 */
export function isValidAwsKmsKeyIdentifier(keyId: string): boolean {
  if (!keyId || typeof keyId !== 'string') return false;
  const trimmed = keyId.trim();
  if (trimmed.length === 0) return false;

  const keyArnRegex = /^arn:aws(-[a-z]+)?:kms:[a-z0-9-]+:\d{12}:key\/[a-zA-Z0-9_-]+$/;
  const aliasArnRegex = /^arn:aws(-[a-z]+)?:kms:[a-z0-9-]+:\d{12}:alias\/[a-zA-Z0-9/_-]+$/;
  const keyIdRegex = /^(mrk-)?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32})$/;
  const aliasNameRegex = /^alias\/[a-zA-Z0-9/_-]+$/;

  return (
    keyArnRegex.test(trimmed) ||
    aliasArnRegex.test(trimmed) ||
    keyIdRegex.test(trimmed) ||
    aliasNameRegex.test(trimmed)
  );
}

/**
 * Extracts the AWS region from a Key ARN or Alias ARN, if present.
 */
export function extractRegionFromArn(arn: string): string | null {
  if (!arn || typeof arn !== 'string') return null;
  const match = arn.match(/^arn:aws(?:-[a-z]+)?:kms:([a-z0-9-]+):\d{12}:/);
  return match ? match[1] : null;
}

/**
 * Validates an AWS region identifier format.
 * Standard format: ^[a-z]{2}(-[a-z]+)+-\d+$ (e.g. us-east-1, ap-southeast-2, eu-central-1)
 */
export function isValidAwsRegion(region: string): boolean {
  if (!region || typeof region !== 'string') return false;
  const trimmed = region.trim();
  return /^[a-z]{2}(-[a-z]+)+-\d+$/.test(trimmed);
}

/**
 * Builds and validates the minimal, safe cryptographic EncryptionContext for AWS KMS.
 *
 * CRITICAL SECURITY INVARIANT:
 * AWS KMS EncryptionContext is logged in plaintext in AWS CloudTrail and is NOT confidential.
 * Therefore, this builder strictly includes only non-sensitive structural metadata:
 * - application: 'voip-hub'
 * - environment: context.environment (e.g. 'production', 'test')
 * - providerAccountId: context.providerAccountId (UUID)
 * - credentialPurpose: context.credentialPurpose (e.g. 'ACCOUNT_AUTH_TOKEN')
 * - referenceId: context.referenceId (UUID)
 *
 * NEVER contains:
 * - Plaintext DEKs or raw key material
 * - Provider API secrets, auth tokens, or passwords
 * - Customer PII or end-user call content
 */
export function buildSafeAwsKmsEncryptionContext(context: KeyEncryptionContext): Record<string, string> {
  if (!context || typeof context !== 'object') {
    throw new Error('KMS_CONTEXT_ERROR: KeyEncryptionContext is required.');
  }

  // Validate application context if explicitly supplied
  if (context.application !== undefined && context.application !== null) {
    const rawApp = String(context.application).trim().toLowerCase();
    if (!rawApp || rawApp !== 'voip-hub') {
      throw new Error(`KMS_CONTEXT_ERROR: Invalid application context '${context.application}'. Expected 'voip-hub'.`);
    }
  }

  const environment = (context.environment || '').trim().toLowerCase();
  const providerAccountId = (context.providerAccountId || '').trim();
  const credentialPurpose = (context.credentialPurpose || '').trim().toUpperCase();
  const referenceId = (context.referenceId || '').trim();

  if (!environment) {
    throw new Error('KMS_CONTEXT_ERROR: context.environment is required.');
  }
  if (process.env.NODE_ENV === 'production' && environment !== 'production') {
    throw new Error(`KMS_CONTEXT_ERROR: Production environment requires context.environment = 'production', received '${environment}'.`);
  }
  if (!providerAccountId) {
    throw new Error('KMS_CONTEXT_ERROR: context.providerAccountId is required.');
  }
  if (!credentialPurpose) {
    throw new Error('KMS_CONTEXT_ERROR: context.credentialPurpose is required.');
  }
  if (!referenceId) {
    throw new Error('KMS_CONTEXT_ERROR: context.referenceId is required.');
  }

  return {
    application: 'voip-hub',
    credentialPurpose,
    environment,
    providerAccountId,
    referenceId,
  };
}

/**
 * Sanitizes errors from AWS KMS operations.
 * Maps AWS SDK error codes into stable, non-leaking internal classifications.
 *
 * CRITICAL SECURITY INVARIANT:
 * Error messages must never contain:
 * - Plaintext DEKs or wrapped key bytes
 * - Provider secrets or credentials
 * - AWS secret access keys or session tokens
 * - Sensitive request or response payloads
 */
export function sanitizeKmsError(err: unknown, operation: 'wrap' | 'unwrap'): Error {
  const errObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : null;
  const errName = errObj && typeof errObj.name === 'string' ? errObj.name : '';
  const errCode = errObj && typeof errObj.code === 'string' ? errObj.code : '';
  const rawMsg = err instanceof Error ? err.message : String(err || '');

  if (errName === 'AccessDeniedException' || errCode === 'AccessDenied') {
    return new Error('PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: KMS access denied. IAM policy or key permissions insufficient.');
  }
  if (errName === 'DisabledException') {
    return new Error('PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: KMS key is disabled.');
  }
  if (errName === 'NotFoundException' || errName === 'KeyNotFoundException' || errCode === 'NotFound') {
    return new Error('PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: KMS key not found.');
  }
  if (errName === 'InvalidCiphertextException') {
    return new Error('KMS_UNWRAP_FAILED: Invalid ciphertext or encryption context mismatch.');
  }
  if (
    errName === 'DependencyTimeoutException' ||
    errName === 'TimeoutError' ||
    errName === 'AbortError' ||
    rawMsg.includes('timeout') ||
    rawMsg.includes('aborted')
  ) {
    return new Error('PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: KMS request timed out.');
  }
  if (errName === 'ThrottlingException' || errName === 'LimitExceededException' || errCode === 'Throttling') {
    return new Error('PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: KMS request throttled.');
  }
  if (errName === 'KMSInternalException') {
    return new Error('PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: Internal KMS error.');
  }

  return new Error(`PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: KMS ${operation} failed: ${errName || 'UnknownError'}`);
}

/**
 * ============================================================================
 * AWS KMS KEY ENCRYPTION PROVIDER (PRODUCTION-CAPABLE ADAPTER)
 * ============================================================================
 * Implements two-tier envelope encryption Key Encryption Key (KEK) operations
 * using AWS Key Management Service (KMS).
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Zero Raw KEK Material:
 *    The application NEVER possesses, sees, or stores raw KEK material. AWS KMS owns the KEK.
 * 2. 256-bit (32-byte) DEK Boundary:
 *    Only the 32-byte envelope DEK is sent to KMS for wrapping (Encrypt) and returned on unwrap (Decrypt).
 *    Exact 32-byte length verification is enforced. Mismatches trigger immediate Buffer zeroization.
 * 3. Cryptographic Context Binding:
 *    Every wrap and unwrap request submits a canonical, non-sensitive EncryptionContext.
 *    KMS Decrypt enforces exact match of this context.
 * 4. Key-ID Integrity:
 *    Unwrap validates that the caller's kekIdentifier matches the configured key, and explicitly
 *    passes KeyId to KMS Decrypt to prevent ciphertext redirection attacks.
 * 5. Bounded Retries & Timeouts:
 *    Max attempts (default: 3) and request timeout (default: 5000ms) with AbortSignal.
 * 6. Standard AWS Credential Chain:
 *    Uses AWS SDK default credential provider chain (OIDC / IAM Roles / Environment).
 *    No custom static secret keys in application configuration.
 * 7. Server-Only Execution:
 *    Guarded by 'server-only' boundary.
 * 8. 100% Mockable:
 *    Accepts injected KMS client for complete offline, network-free local testing.
 */
export class AwsKmsKeyEncryptionProvider implements KeyEncryptionProvider {
  private readonly keyIdentifier: string;
  private readonly region: string;
  private readonly keyVersion?: string;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly kmsClient: AwsKmsClientLike;

  constructor(options?: AwsKmsKeyEncryptionProviderOptions) {
    const envKeyId = process.env.TELECOM_KMS_KEY_ID?.trim();
    const envRegion = process.env.TELECOM_KMS_REGION?.trim() || process.env.AWS_REGION?.trim();
    const envKeyVersion = process.env.TELECOM_KMS_KEY_VERSION?.trim();

    const rawKeyId = options?.keyIdentifier || envKeyId || '';
    if (!rawKeyId) {
      throw new Error('SECURITY_CONFIG_ERROR: AWS KMS key identifier is required.');
    }

    if (!isValidAwsKmsKeyIdentifier(rawKeyId)) {
      throw new Error('SECURITY_CONFIG_ERROR: Invalid AWS KMS key identifier format. Allowed formats: Key ARN, Alias ARN, Key ID (UUID), or Alias Name (\'alias/...\').');
    }
    this.keyIdentifier = rawKeyId.trim();

    // Resolve and validate region
    const arnRegion = extractRegionFromArn(this.keyIdentifier);
    const configuredRegion = options?.region?.trim() || envRegion || arnRegion || '';

    if (!configuredRegion || !isValidAwsRegion(configuredRegion)) {
      throw new Error('SECURITY_CONFIG_ERROR: Valid AWS region is required for AWS KMS provider.');
    }

    // Fail closed on conflicting regions between ARN and configuration
    if (arnRegion && configuredRegion !== arnRegion) {
      throw new Error(`SECURITY_CONFIG_ERROR: Region mismatch. Key ARN region '${arnRegion}' differs from configured region '${configuredRegion}'.`);
    }

    this.region = configuredRegion;
    this.keyVersion = options?.keyVersion || envKeyVersion;
    this.maxAttempts = options?.maxAttempts !== undefined ? options.maxAttempts : 3;
    this.requestTimeoutMs = options?.requestTimeoutMs !== undefined ? options.requestTimeoutMs : 5000;

    if (options?.kmsClient) {
      this.kmsClient = options.kmsClient;
    } else {
      this.kmsClient = new KMSClient({
        region: this.region,
        maxAttempts: this.maxAttempts,
      });
    }
  }

  getKeyIdentifier(): string {
    return this.keyIdentifier;
  }

  getKeyVersion(): string | undefined {
    return this.keyVersion;
  }

  getRegion(): string {
    return this.region;
  }

  /**
   * Wraps an ephemeral 256-bit DEK using AWS KMS Encrypt.
   * Cryptographically binds the wrapped DEK to the safe EncryptionContext.
   */
  async wrapKey(params: WrapKeyParams): Promise<WrapKeyResult> {
    if (!params || !params.plaintextDek || !(params.plaintextDek instanceof Buffer) || params.plaintextDek.length !== 32) {
      throw new Error('KMS_WRAP_ERROR: Plaintext DEK must be a valid 256-bit (32-byte) buffer.');
    }

    let encryptionContext: Record<string, string>;
    try {
      encryptionContext = buildSafeAwsKmsEncryptionContext(params.context);
    } catch (err: unknown) {
      throw new Error(`PROVIDER_CREDENTIAL_VAULT_UNAVAILABLE: ${(err as Error)?.message || 'Invalid KMS encryption context'}`);
    }

    try {
      const command = new EncryptCommand({
        KeyId: this.keyIdentifier,
        Plaintext: params.plaintextDek,
        EncryptionContext: encryptionContext,
      });

      const abortSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const response = await this.kmsClient.send(command, { abortSignal });

      if (!response || !response.CiphertextBlob) {
        throw new Error('KMS_WRAP_ERROR: AWS KMS Encrypt response did not contain CiphertextBlob.');
      }

      const wrappedDek = Buffer.from(response.CiphertextBlob);
      if (wrappedDek.length === 0) {
        throw new Error('KMS_WRAP_ERROR: AWS KMS returned an empty ciphertext blob.');
      }

      return {
        wrappedDek,
        kekIdentifier: this.keyIdentifier,
        kekVersion: this.keyVersion,
      };
    } catch (err: unknown) {
      // Re-throw our internal KMS_WRAP_ERROR or wrap in sanitized classification
      if (err instanceof Error && err.message.startsWith('KMS_WRAP_ERROR:')) {
        throw err;
      }
      if (err instanceof Error && err.message.startsWith('KMS_CONTEXT_ERROR:')) {
        throw err;
      }
      throw sanitizeKmsError(err, 'wrap');
    }
  }

  /**
   * Unwraps a wrapped DEK using AWS KMS Decrypt.
   * Enforces exact matching of the safe EncryptionContext and passes KeyId to prevent ciphertext redirection.
   * Validates that the unwrapped DEK is exactly 32 bytes.
   */
  async unwrapKey(params: UnwrapKeyParams): Promise<Buffer> {
    if (!params || !params.wrappedDek || !(params.wrappedDek instanceof Buffer) || params.wrappedDek.length === 0) {
      throw new Error('KMS_UNWRAP_ERROR: Wrapped DEK is invalid or empty.');
    }

    if (!params.kekIdentifier || params.kekIdentifier.trim() === '') {
      throw new Error('KMS_UNWRAP_ERROR: Missing KEK identifier.');
    }

    if (params.kekIdentifier !== this.keyIdentifier) {
      throw new Error(`KMS_UNWRAP_ERROR: KEK identifier mismatch. Expected '${this.keyIdentifier}', received '${params.kekIdentifier}'.`);
    }

    let encryptionContext: Record<string, string>;
    try {
      encryptionContext = buildSafeAwsKmsEncryptionContext(params.context);
    } catch (err: unknown) {
      throw new Error(`KMS_UNWRAP_FAILED: ${(err as Error)?.message || 'Invalid KMS encryption context'}`);
    }

    try {
      const command = new DecryptCommand({
        CiphertextBlob: params.wrappedDek,
        KeyId: this.keyIdentifier,
        EncryptionContext: encryptionContext,
      });

      const abortSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const response = await this.kmsClient.send(command, { abortSignal });

      if (!response || !response.Plaintext) {
        throw new Error('KMS_UNWRAP_ERROR: AWS KMS Decrypt response did not contain Plaintext DEK.');
      }

      const plaintextDek = Buffer.from(response.Plaintext);

      if (plaintextDek.length !== 32) {
        // Zeroize mismatched memory immediately before failing closed
        plaintextDek.fill(0);
        throw new Error(`KMS_UNWRAP_ERROR: Decrypted DEK length is invalid. Expected 32 bytes, received ${plaintextDek.length}.`);
      }

      return plaintextDek;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('KMS_UNWRAP_ERROR:')) {
        throw err;
      }
      if (err instanceof Error && err.message.startsWith('KMS_CONTEXT_ERROR:')) {
        throw err;
      }
      throw sanitizeKmsError(err, 'unwrap');
    }
  }
}
