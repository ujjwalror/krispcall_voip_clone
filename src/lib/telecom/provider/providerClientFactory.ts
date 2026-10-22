import 'server-only';
import twilio from 'twilio';
import { ProviderContext } from './types';
import { TelecomSecretVaultRegistry } from '@/lib/telecom/vault';

export class ProviderClientFactory {
  private static clientOverrides: Map<string, any> = new Map();

  /**
   * Injectable Twilio client constructor for testing without live provider requests.
   */
  public static twilioClientConstructor: (apiKeySidOrAccountSid: string, secret: string, opts?: any) => any = twilio;

  /**
   * Registers a mock client override for testing purposes.
   */
  static registerTestOverride(providerAccountId: string, mockClient: any): void {
    this.clientOverrides.set(providerAccountId, mockClient);
  }

  static clearTestOverrides(): void {
    this.clientOverrides.clear();
  }

  /**
   * Retrieves an authenticated provider SDK client for the given provider context.
   * Credentials are never accepted from client payloads or read from plaintext organization tables.
   */
  static getProviderClient(context: ProviderContext): any {
    if (typeof window !== 'undefined') {
      throw new Error('Security Error: Provider client factory must never be invoked in client/browser context.');
    }

    if (!context || !context.provider) {
      throw new Error('PROVIDER_FACTORY_ERROR: Missing or invalid provider context.');
    }

    // Check for test mock overrides
    if (this.clientOverrides.has(context.providerAccountId)) {
      return this.clientOverrides.get(context.providerAccountId);
    }

    switch (context.provider) {
      case 'TWILIO':
        return this.getTwilioClient(context);

      case 'TELNYX':
      case 'BANDWIDTH':
      case 'AWS_CHIME':
      case 'OTHER':
        throw new Error(
          `PROVIDER_UNAVAILABLE: Telecom provider '${context.provider}' adapter is registered in architecture but not enabled in current deployment.`
        );

      default:
        throw new Error(`UNKNOWN_PROVIDER: Telecom provider '${(context as any).provider}' is unrecognized.`);
    }
  }

  /**
   * Alias for getProviderClient for convenience and consistency.
   */
  static getClient(context: ProviderContext): any {
    return this.getProviderClient(context);
  }

  /**
   * Specialized Twilio client builder scoped strictly to provider context.
   *
   * SECURITY INVARIANTS:
   * - Shared parent accounts use environment credentials only for SHARED_PARENT contexts.
   * - Customer subaccounts resolve credentials via TelecomSecretVault.
   * - Tenant customer-subaccount operations NEVER fall back to parent credentials.
   * - Missing, malformed, revoked, or cross-account credentials fail closed immediately.
   */
  static getTwilioClient(context: ProviderContext): twilio.Twilio {
    if (this.clientOverrides.has(context.providerAccountId)) {
      return this.clientOverrides.get(context.providerAccountId);
    }

    // 1. Shared Parent Account Mode (Platform administrative usage only)
    if (context.isSharedParent || context.accountType === 'SHARED_PARENT') {
      if (context.organizationId && context.organizationId !== '00000000-0000-0000-0000-000000000000') {
        throw new Error(
          `TENANT_RUNTIME_PARENT_ACCESS_DENIED: Tenant customer organization context '${context.organizationId}' cannot access shared parent Twilio client.`
        );
      }

      const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
      const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
      const apiKeySid = process.env.TWILIO_API_KEY_SID?.trim();
      const apiKeySecret = process.env.TWILIO_API_KEY_SECRET?.trim();

      if (accountSid && apiKeySid && apiKeySecret) {
        return this.twilioClientConstructor(apiKeySid, apiKeySecret, {
          accountSid,
          timeout: 10000,
          autoRetry: false,
          maxRetries: 0,
        });
      }

      if (accountSid && authToken) {
        return this.twilioClientConstructor(accountSid, authToken, {
          timeout: 10000,
          autoRetry: false,
          maxRetries: 0,
        });
      }

      throw new Error('TWILIO_CREDENTIALS_MISSING: Server environment credentials for shared Twilio account are unconfigured.');
    }

    // 2. Customer Subaccount / Dedicated Account Mode (Type 1 Dedicated Topology)
    if (context.accountType === 'CUSTOMER_SUBACCOUNT' || context.accountType === 'DEDICATED_ACCOUNT') {
      // Step A: Credential reference must be present
      if (!context.credentialReference || typeof context.credentialReference !== 'string' || context.credentialReference.trim() === '') {
        throw new Error(`MISSING_CREDENTIAL_REFERENCE: Provider account '${context.accountReference}' has no credential reference configured.`);
      }

      // Step B: Resolve secret material from TelecomSecretVault
      const vault = TelecomSecretVaultRegistry.getVault();
      if (!vault.getSecretSync) {
        throw new Error(
          `ASYNC_VAULT_INCOMPATIBLE: Synchronous credential resolution is not supported by asynchronous vault '${vault.constructor.name}'. Use getTwilioClientAsync.`
        );
      }
      const secretPayload = vault.getSecretSync(context.credentialReference);

      if (!secretPayload) {
        throw new Error(`SECRET_NOT_FOUND: Credential reference '${context.credentialReference}' was not found in secret vault.`);
      }

      // Step C: Validate credential status
      if (secretPayload.metadata.status === 'revoked') {
        throw new Error(`CREDENTIAL_REVOKED: Credential reference '${context.credentialReference}' is revoked.`);
      }

      if (secretPayload.metadata.status !== 'active') {
        throw new Error(
          `CREDENTIAL_INACTIVE: Credential reference '${context.credentialReference}' is not active (status: ${secretPayload.metadata.status}).`
        );
      }

      // Step D: Cross-Account Isolation Check
      if (secretPayload.metadata.providerAccountId !== context.providerAccountId) {
        throw new Error(
          `CREDENTIAL_ACCOUNT_MISMATCH: Credential reference '${context.credentialReference}' belongs to provider account '${secretPayload.metadata.providerAccountId}', not '${context.providerAccountId}'.`
        );
      }

      if (secretPayload.metadata.provider !== context.provider) {
        throw new Error(
          `CREDENTIAL_PROVIDER_MISMATCH: Credential reference '${context.credentialReference}' belongs to provider '${secretPayload.metadata.provider}', not '${context.provider}'.`
        );
      }

      if (
        secretPayload.metadata.purpose &&
        secretPayload.metadata.purpose !== 'RUNTIME_API' &&
        secretPayload.metadata.purpose !== 'GENERAL'
      ) {
        throw new Error(
          `CREDENTIAL_PURPOSE_MISMATCH: Credential reference '${context.credentialReference}' has purpose '${secretPayload.metadata.purpose}', expected 'RUNTIME_API'.`
        );
      }

      // Step E: Key Identifier (Twilio API Key SID: SKxxx)
      const apiKeySid = secretPayload.metadata.keyIdentifier || context.metadata?.apiKeySid;
      if (!apiKeySid || typeof apiKeySid !== 'string' || !apiKeySid.startsWith('SK')) {
        throw new Error(`API_KEY_IDENTIFIER_MISSING: Missing or invalid API Key SID for subaccount '${context.accountReference}'.`);
      }

      // Step F: Subaccount Identifier (Twilio Subaccount SID: ACxxx)
      const subaccountSid = secretPayload.metadata.accountReference || context.accountReference;
      if (!subaccountSid || typeof subaccountSid !== 'string' || !subaccountSid.startsWith('AC')) {
        throw new Error(`SUBACCOUNT_REFERENCE_MISSING: Missing or invalid Subaccount SID for subaccount '${context.accountReference}'.`);
      }

      // Step G: API Key Secret
      const apiKeySecret = secretPayload.secret;
      if (!apiKeySecret || typeof apiKeySecret !== 'string' || apiKeySecret.trim() === '') {
        throw new Error(`API_KEY_SECRET_EMPTY: API key secret is empty for subaccount '${context.accountReference}'.`);
      }

      // Step H: Construct account-scoped Twilio client
      // Note: STRICTLY NO PARENT FALLBACK
      return this.twilioClientConstructor(apiKeySid, apiKeySecret, {
        accountSid: subaccountSid,
        timeout: 10000,
        autoRetry: false,
        maxRetries: 0,
      });
    }

    throw new Error(`UNSUPPORTED_ACCOUNT_TYPE: Account type '${context.accountType}' is not supported for provider '${context.provider}'.`);
  }

  /**
   * Asynchronous variant of getTwilioClient for fully async secret vaults.
   */
  static async getTwilioClientAsync(context: ProviderContext): Promise<twilio.Twilio> {
    if (this.clientOverrides.has(context.providerAccountId)) {
      return this.clientOverrides.get(context.providerAccountId);
    }

    if (context.isSharedParent || context.accountType === 'SHARED_PARENT') {
      return this.getTwilioClient(context);
    }

    if (context.accountType === 'CUSTOMER_SUBACCOUNT' || context.accountType === 'DEDICATED_ACCOUNT') {
      if (!context.credentialReference || typeof context.credentialReference !== 'string' || context.credentialReference.trim() === '') {
        throw new Error(`MISSING_CREDENTIAL_REFERENCE: Provider account '${context.accountReference}' has no credential reference configured.`);
      }

      const vault = TelecomSecretVaultRegistry.getVault();
      const secretPayload = await vault.getSecret(context.credentialReference);

      if (!secretPayload) {
        throw new Error(`SECRET_NOT_FOUND: Credential reference '${context.credentialReference}' was not found in secret vault.`);
      }

      if (secretPayload.metadata.status === 'revoked') {
        throw new Error(`CREDENTIAL_REVOKED: Credential reference '${context.credentialReference}' is revoked.`);
      }

      if (secretPayload.metadata.status !== 'active') {
        throw new Error(
          `CREDENTIAL_INACTIVE: Credential reference '${context.credentialReference}' is not active (status: ${secretPayload.metadata.status}).`
        );
      }

      if (secretPayload.metadata.providerAccountId !== context.providerAccountId) {
        throw new Error(
          `CREDENTIAL_ACCOUNT_MISMATCH: Credential reference '${context.credentialReference}' belongs to provider account '${secretPayload.metadata.providerAccountId}', not '${context.providerAccountId}'.`
        );
      }

      if (secretPayload.metadata.provider !== context.provider) {
        throw new Error(
          `CREDENTIAL_PROVIDER_MISMATCH: Credential reference '${context.credentialReference}' belongs to provider '${secretPayload.metadata.provider}', not '${context.provider}'.`
        );
      }

      if (
        secretPayload.metadata.purpose &&
        secretPayload.metadata.purpose !== 'RUNTIME_API' &&
        secretPayload.metadata.purpose !== 'GENERAL'
      ) {
        throw new Error(
          `CREDENTIAL_PURPOSE_MISMATCH: Credential reference '${context.credentialReference}' has purpose '${secretPayload.metadata.purpose}', expected 'RUNTIME_API'.`
        );
      }

      const apiKeySid = secretPayload.metadata.keyIdentifier || context.metadata?.apiKeySid;
      if (!apiKeySid || typeof apiKeySid !== 'string' || !apiKeySid.startsWith('SK')) {
        throw new Error(`API_KEY_IDENTIFIER_MISSING: Missing or invalid API Key SID for subaccount '${context.accountReference}'.`);
      }

      const subaccountSid = secretPayload.metadata.accountReference || context.accountReference;
      if (!subaccountSid || typeof subaccountSid !== 'string' || !subaccountSid.startsWith('AC')) {
        throw new Error(`SUBACCOUNT_REFERENCE_MISSING: Missing or invalid Subaccount SID for subaccount '${context.accountReference}'.`);
      }

      const apiKeySecret = secretPayload.secret;
      if (!apiKeySecret || typeof apiKeySecret !== 'string' || apiKeySecret.trim() === '') {
        throw new Error(`API_KEY_SECRET_EMPTY: API key secret is empty for subaccount '${context.accountReference}'.`);
      }

      return this.twilioClientConstructor(apiKeySid, apiKeySecret, {
        accountSid: subaccountSid,
        timeout: 10000,
        autoRetry: false,
        maxRetries: 0,
      });
    }

    throw new Error(`UNSUPPORTED_ACCOUNT_TYPE: Account type '${context.accountType}' is not supported for provider '${context.provider}'.`);
  }

  /**
   * Alias for getTwilioClientAsync.
   */
  static async getClientAsync(context: ProviderContext): Promise<twilio.Twilio> {
    return this.getTwilioClientAsync(context);
  }

  /**
   * PARENT ADMINISTRATIVE CLIENT
   * Strictly reserved for platform-level administrative operations:
   * - subaccount provisioning / suspension
   * - parent-level key bootstrap
   *
   * LOCKED SECURITY INVARIANT:
   * Tenant runtime operations (calls, messages, numbers, recordings)
   * MUST NEVER invoke getParentAdministrativeClient.
   */
  static getParentAdministrativeClient(context?: ProviderContext): twilio.Twilio {
    if (typeof window !== 'undefined') {
      throw new Error('Security Error: Administrative client must never be accessed in browser context.');
    }

    if (context) {
      if (context.accountType === 'CUSTOMER_SUBACCOUNT' || context.accountType === 'DEDICATED_ACCOUNT') {
        throw new Error('TENANT_RUNTIME_PARENT_ACCESS_DENIED: Tenant customer-subaccount context cannot access parent administrative client.');
      }
      if (context.organizationId && context.organizationId !== '00000000-0000-0000-0000-000000000000') {
        throw new Error(`TENANT_RUNTIME_PARENT_ACCESS_DENIED: Tenant customer organization context '${context.organizationId}' cannot access parent administrative client.`);
      }
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
    const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
    const apiKeySid = process.env.TWILIO_API_KEY_SID?.trim();
    const apiKeySecret = process.env.TWILIO_API_KEY_SECRET?.trim();

    if (accountSid && apiKeySid && apiKeySecret) {
      return this.twilioClientConstructor(apiKeySid, apiKeySecret, {
        accountSid,
        timeout: 10000,
        autoRetry: false,
        maxRetries: 0,
      });
    }

    if (accountSid && authToken) {
      return this.twilioClientConstructor(accountSid, authToken, {
        timeout: 10000,
        autoRetry: false,
        maxRetries: 0,
      });
    }

    throw new Error('TWILIO_ADMIN_CREDENTIALS_MISSING: Server environment credentials for parent Twilio account are unconfigured.');
  }

  /**
   * Account-aware webhook authentication token resolver.
   * Resolves the authoritative auth token for a provider account reference without exposing secrets in DB.
   */
  static resolveAccountAuthToken(accountReference?: string): string | null {
    if (!accountReference) return null;

    const trimmed = accountReference.trim();
    const envAccountSid = process.env.TWILIO_ACCOUNT_SID?.trim();

    // Match shared parent account reference or shared Account SID
    if (trimmed === 'shared_parent_twilio' || (envAccountSid && trimmed === envAccountSid)) {
      const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
      return authToken || null;
    }

    // Check secret vault if reference exists
    try {
      const vault = TelecomSecretVaultRegistry.getVault();
      if (vault.getSecretSync) {
        const payload = vault.getSecretSync(trimmed);
        if (payload && payload.metadata.status === 'active') {
          return payload.secret;
        }
      }
    } catch {
      // Fail closed
    }

    // Unknown or unconfigured subaccount returns null fail-closed
    return null;
  }

  /**
   * Account-aware asynchronous webhook / API authentication token resolver.
   * Resolves the authoritative auth token for a provider account reference from the asynchronous production vault.
   *
   * SAFE COMPATIBILITY ABSTRACTION (Phase 22C-R2.1 Preparation for R3):
   * - Compatible with EnvelopeTelecomSecretVault and external KMS backends.
   * - Strictly NO sync blocking, NO busy waiting, NO filesystem cache, NO global plaintext cache.
   * - Customer subaccounts resolve exclusively from vault; NEVER fall back to parent credentials.
   * - Missing, inactive, revoked, or deleted credentials fail closed to null.
   */
  static async resolveAccountAuthTokenAsync(accountReference?: string): Promise<string | null> {
    if (!accountReference) return null;

    const trimmed = accountReference.trim();
    const envAccountSid = process.env.TWILIO_ACCOUNT_SID?.trim();

    // Match shared parent account reference or shared Account SID
    if (trimmed === 'shared_parent_twilio' || (envAccountSid && trimmed === envAccountSid)) {
      const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
      return authToken || null;
    }

    // Check asynchronous secret vault
    try {
      const vault = TelecomSecretVaultRegistry.getVault();
      const payload = await vault.getSecret(trimmed);
      if (payload && payload.metadata.status === 'active') {
        if (
          payload.metadata.purpose &&
          payload.metadata.purpose !== 'WEBHOOK_VERIFICATION' &&
          payload.metadata.purpose !== 'GENERAL'
        ) {
          return null;
        }
        return payload.secret;
      }
    } catch {
      // Fail closed
    }

    // Unknown, unconfigured, revoked, or inactive subaccount returns null fail-closed
    return null;
  }
}
