import 'server-only';

/**
 * Context bound to the wrapped DEK (Data Encryption Key) during KMS wrapping and unwrapping.
 * Both AWS KMS and GCP Cloud KMS support or require cryptographic context binding.
 */
export interface KeyEncryptionContext {
  environment: string;
  providerAccountId: string;
  credentialPurpose: string;
  referenceId: string;
  [key: string]: string;
}

export interface WrapKeyParams {
  plaintextDek: Buffer;
  context: KeyEncryptionContext;
}

export interface WrapKeyResult {
  wrappedDek: Buffer;
  kekIdentifier: string;
  kekVersion?: string;
}

export interface UnwrapKeyParams {
  wrappedDek: Buffer;
  context: KeyEncryptionContext;
  kekIdentifier: string;
  kekVersion?: string;
}

/**
 * Provider-Neutral KMS Key Encryption Abstraction.
 *
 * Implements the KEK (Key Encryption Key) operations for Two-Tier Envelope Encryption:
 * 1. wrapKey: Uses the external KMS KEK to wrap an ephemeral 256-bit DEK, binding it to the encryption context.
 * 2. unwrapKey: Uses the external KMS KEK to unwrap the wrapped DEK, strictly verifying the encryption context.
 */
export interface KeyEncryptionProvider {
  wrapKey(params: WrapKeyParams): Promise<WrapKeyResult>;
  unwrapKey(params: UnwrapKeyParams): Promise<Buffer>;
  getKeyIdentifier(): string;
  getKeyVersion?(): string | undefined;
}
