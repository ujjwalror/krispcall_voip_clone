import 'server-only';
import twilio from 'twilio';
import { getTwilioConfig } from './config';

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

export const MIN_TOKEN_TTL_SECONDS = 60; // 1 minute
export const MAX_TOKEN_TTL_SECONDS = 3600; // 1 hour (industry standard for browser WebRTC)
export const DEFAULT_TOKEN_TTL_SECONDS = 3600;

export interface TokenGenerationResult {
  token: string;
  identity: string;
  expiresInSeconds: number;
}

export interface GenerateVoiceAccessTokenOptions {
  organizationId?: string;
  context?: any;
  clientOverride?: any;
  supabaseClient?: any;
  vaultOverride?: any;
  allowPlatformAdmin?: boolean;
  incomingAllow?: boolean;
  requestedTtlSeconds?: number;
}

/**
 * Validates and sanitizes a Twilio token identity.
 *
 * CONSTRAINTS:
 * - 1 to 128 characters.
 * - ASCII alphanumeric, underscore, hyphen, dot, colon only.
 * - Strictly NO raw email addresses or PII (e.g. '@' symbol).
 * - Fails closed on invalid format.
 */
export function validateTokenIdentity(rawIdentity: string): string {
  if (!rawIdentity || typeof rawIdentity !== 'string') {
    throw new Error('Twilio Token Error: Identity is required.');
  }

  const cleanIdentity = rawIdentity.trim();
  if (cleanIdentity.length < 1 || cleanIdentity.length > 128) {
    throw new Error(`Twilio Token Error: Identity length must be between 1 and 128 characters (received: ${cleanIdentity.length}).`);
  }

  if (cleanIdentity.includes('@')) {
    throw new Error('Twilio Token Error: Identity cannot contain raw email address or "@" character (PII exposure prohibited).');
  }

  if (!/^[a-zA-Z0-9_\-\.:]+$/.test(cleanIdentity)) {
    throw new Error('Twilio Token Error: Identity contains invalid characters. Only alphanumeric, hyphen, underscore, colon, and period are permitted.');
  }

  return cleanIdentity;
}

/**
 * Bounds token TTL strictly between MIN_TOKEN_TTL_SECONDS and MAX_TOKEN_TTL_SECONDS.
 */
export function boundTokenTtl(rawTtl?: number): number {
  if (rawTtl === undefined || rawTtl === null || Number.isNaN(rawTtl)) {
    return DEFAULT_TOKEN_TTL_SECONDS;
  }
  return Math.max(MIN_TOKEN_TTL_SECONDS, Math.min(Math.floor(rawTtl), MAX_TOKEN_TTL_SECONDS));
}

/**
 * Generates a short-lived Twilio Access Token for WebRTC browser calling.
 *
 * SECURITY INVARIANTS:
 * - Customer tenants may NEVER resolve or receive parent-scoped tokens.
 * - This synchronous function is RESTRICTED to explicit PLATFORM_ADMIN paths.
 * - Customer runtime MUST use generateVoiceAccessTokenAsync.
 */
export function generateVoiceAccessToken(
  identity: string,
  ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS,
  options?: GenerateVoiceAccessTokenOptions
): TokenGenerationResult {
  const safeIdentity = validateTokenIdentity(identity);
  const boundedTtl = boundTokenTtl(ttlSeconds);

  // Prohibit customer organization execution in synchronous parent path
  if (options?.organizationId && options.organizationId !== '00000000-0000-0000-0000-000000000000') {
    const err: any = new Error(
      'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED: Customer organizations cannot be issued tokens under the shared parent account.'
    );
    err.code = 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED';
    throw err;
  }

  if (options?.context) {
    if (
      options.context.organizationId &&
      options.context.organizationId !== '00000000-0000-0000-0000-000000000000' &&
      (options.context.isSharedParent || options.context.accountType === 'SHARED_PARENT')
    ) {
      const err: any = new Error(
        'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED: Customer organizations cannot be issued tokens under the shared parent account.'
      );
      err.code = 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED';
      throw err;
    }

    if (options.context.accountType === 'CUSTOMER_SUBACCOUNT' || options.context.accountType === 'DEDICATED_ACCOUNT') {
      const err: any = new Error(
        'CUSTOMER_SUBACCOUNT_WEBRTC_UNSUPPORTED: Customer subaccount WebRTC calling requires dedicated per-subaccount TwiML App and API key provisioning which has not yet been provisioned. Parent token fallback is strictly prohibited.'
      );
      err.code = 'CUSTOMER_SUBACCOUNT_WEBRTC_UNSUPPORTED';
      throw err;
    }
  }

  if (!options?.allowPlatformAdmin) {
    const err: any = new Error(
      'ORGANIZATION_CONTEXT_REQUIRED: Synchronous voice token generation requires explicit platform admin authorization.'
    );
    err.code = 'ORGANIZATION_CONTEXT_REQUIRED';
    throw err;
  }

  const config = getTwilioConfig();

  // Create short-lived Access Token
  const accessToken = new AccessToken(
    config.accountSid,
    config.apiKeySid,
    config.apiKeySecret,
    {
      identity: safeIdentity,
      ttl: boundedTtl,
    }
  );

  // Configure VoiceGrant for outgoing application & incoming call allowance
  const grant = new VoiceGrant({
    outgoingApplicationSid: config.twimlAppSid,
    incomingAllow: options?.incomingAllow ?? true,
  });

  accessToken.addGrant(grant);

  return {
    token: accessToken.toJwt(),
    identity: safeIdentity,
    expiresInSeconds: boundedTtl,
  };
}

/**
 * Asynchronous account-aware voice access token generator.
 *
 * CRYPTOGRAPHIC BOUNDARY INVARIANTS:
 * 1. Derives organization provider context via ProviderAccountResolver.
 * 2. Customer organization resolving to SHARED_PARENT -> FAILS CLOSED (PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED).
 * 3. Customer subaccount without dedicated WebRTC resources -> FAILS CLOSED (CUSTOMER_SUBACCOUNT_WEBRTC_UNSUPPORTED).
 * 4. Customer subaccount with dedicated WebRTC resources -> Generates token using customer Subaccount SID,
 *    customer subaccount API Key (SID + Secret from vault), and customer subaccount TwiML App SID.
 * 5. Bounded token TTL: strictly [60, 3600] seconds.
 * 6. ZERO customer token generation from parent credentials.
 */
export async function generateVoiceAccessTokenAsync(
  identity: string,
  ttlOrOptions: number | GenerateVoiceAccessTokenOptions = DEFAULT_TOKEN_TTL_SECONDS,
  opts?: GenerateVoiceAccessTokenOptions
): Promise<TokenGenerationResult> {
  const rawTtl = typeof ttlOrOptions === 'number' ? ttlOrOptions : ttlOrOptions?.requestedTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
  const options = typeof ttlOrOptions === 'object' && ttlOrOptions !== null ? ttlOrOptions : opts;
  const safeIdentity = validateTokenIdentity(identity);
  const boundedTtl = boundTokenTtl(rawTtl);

  // 1. Explicit Platform Admin Path Guard
  if (options?.allowPlatformAdmin) {
    if (
      (options.organizationId && options.organizationId !== '00000000-0000-0000-0000-000000000000') ||
      (options.context?.organizationId && options.context.organizationId !== '00000000-0000-0000-0000-000000000000')
    ) {
      const err: any = new Error(
        'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED: Customer organizations cannot request platform admin voice tokens.'
      );
      err.code = 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED';
      throw err;
    }
    return generateVoiceAccessToken(safeIdentity, boundedTtl, { ...options, allowPlatformAdmin: true });
  }

  // 2. Organization Context Required
  if (!options?.organizationId && !options?.context) {
    const err: any = new Error(
      'ORGANIZATION_CONTEXT_REQUIRED: WebRTC voice token generation requires a valid customer organization context.'
    );
    err.code = 'ORGANIZATION_CONTEXT_REQUIRED';
    throw err;
  }

  // 3. Resolve Organization Provider Account
  const { ProviderAccountResolver } = await import('@/lib/telecom/provider/providerAccountResolver');

  let account: any = null;
  let isSharedParent = false;
  let accountType = '';

  if (options.context) {
    if (
      options.context.isSharedParent ||
      options.context.accountType === 'SHARED_PARENT' ||
      options.context.account?.account_type === 'SHARED_PARENT' ||
      options.context.providerAccountId === '00000000-0000-0000-0000-000000000001' ||
      (process.env.TWILIO_ACCOUNT_SID && options.context.accountReference === process.env.TWILIO_ACCOUNT_SID) ||
      (options.context.accountReference && options.context.accountReference.includes('PARENT'))
    ) {
      if (!options.allowPlatformAdmin || (options.organizationId && options.organizationId !== '00000000-0000-0000-0000-000000000000')) {
        const err: any = new Error(
          'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED: Customer organizations cannot be issued tokens under the shared parent account.'
        );
        err.code = 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED';
        throw err;
      }
    }

    account = options.context.account || {
      id: options.context.providerAccountId,
      provider: options.context.provider || 'TWILIO',
      account_type: options.context.accountType,
      account_reference: options.context.accountReference,
      credential_reference: options.context.credentialReference,
      metadata: options.context.metadata || {},
      status: options.context.status || 'active',
      environment: options.context.environment || 'production',
    };
    accountType = options.context.accountType || account.account_type || (options.context.isSharedParent ? 'SHARED_PARENT' : '');
    isSharedParent = Boolean(options.context.isSharedParent || accountType === 'SHARED_PARENT');
  } else if (options.organizationId) {
    const resolution = await ProviderAccountResolver.resolveAccount(
      {
        organizationId: options.organizationId,
        service: 'VOICE',
      },
      options.clientOverride || options.supabaseClient
    );

    if (!resolution.success || !resolution.context) {
      const err: any = new Error(
        `PROVIDER_ASSIGNMENT_REQUIRED: ${resolution.errorMessage || 'No active telecom provider assignment configured for organization.'}`
      );
      err.code = resolution.errorCode || 'PROVIDER_ASSIGNMENT_REQUIRED';
      throw err;
    }

    account = {
      id: resolution.context.providerAccountId,
      provider: resolution.context.provider,
      account_type: resolution.context.accountType,
      account_reference: resolution.context.accountReference,
      credential_reference: resolution.context.credentialReference,
      metadata: resolution.context.metadata || {},
      status: 'active',
      environment: resolution.context.environment,
    };
    accountType = resolution.context.accountType;
    isSharedParent = Boolean(resolution.context.isSharedParent);
  }

  // 4. Invariant Checks on Resolved Account
  if (isSharedParent || accountType === 'SHARED_PARENT') {
    const err: any = new Error(
      'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED: Customer organizations cannot be issued tokens under the shared parent account.'
    );
    err.code = 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED';
    throw err;
  }

  if (accountType !== 'CUSTOMER_SUBACCOUNT' && accountType !== 'DEDICATED_ACCOUNT') {
    const err: any = new Error(
      `INVALID_PROVIDER_ACCOUNT_TYPE: Provider account type '${accountType}' does not support customer WebRTC calling.`
    );
    err.code = 'INVALID_PROVIDER_ACCOUNT_TYPE';
    throw err;
  }

  if (!account || account.status !== 'active') {
    const err: any = new Error(
      `PROVIDER_ACCOUNT_INACTIVE: Provider account '${account?.account_reference || 'UNKNOWN'}' is not active.`
    );
    err.code = 'PROVIDER_ACCOUNT_INACTIVE';
    throw err;
  }

  // 5. Resolve Customer Subaccount WebRTC Signing Credentials (API Key SID + Secret + TwiML App SID)
  const credRes = await ProviderAccountResolver.resolveWebRtcSigningCredentials(account, options.vaultOverride);
  if (!credRes.success || !credRes.apiKeySid || !credRes.apiKeySecret || !credRes.twimlAppSid || !credRes.subaccountSid) {
    const code = credRes.errorCode || 'CUSTOMER_SUBACCOUNT_WEBRTC_UNSUPPORTED';
    const msg =
      credRes.errorMessage ||
      'Customer subaccount WebRTC calling requires dedicated per-subaccount TwiML App and API key provisioning which has not yet been provisioned. Parent token fallback is strictly prohibited.';
    const err: any = new Error(`${code}: ${msg}`);
    err.code = code;
    throw err;
  }

  // 6. Generate Dedicated Subaccount Access Token
  const accessToken = new AccessToken(
    credRes.subaccountSid,
    credRes.apiKeySid,
    credRes.apiKeySecret,
    {
      identity: safeIdentity,
      ttl: boundedTtl,
    }
  );

  const grant = new VoiceGrant({
    outgoingApplicationSid: credRes.twimlAppSid,
    incomingAllow: options.incomingAllow ?? true,
  });

  accessToken.addGrant(grant);

  return {
    token: accessToken.toJwt(),
    identity: safeIdentity,
    expiresInSeconds: boundedTtl,
  };
}
