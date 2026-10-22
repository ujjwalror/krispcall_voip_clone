import 'server-only';
import crypto from 'crypto';
import twilio from 'twilio';
import { ProviderAccountResolver } from '@/lib/telecom/provider/providerAccountResolver';
import { ProviderResourceManager } from '@/lib/telecom/provider/providerResourceManager';

export interface ValidateTwilioRequestOptions {
  /**
   * Explicit Auth Token to use for signature verification.
   * Only used for low-level diagnostic tests. In runtime, credentials are
   * resolved securely server-side via ProviderAccountResolver and TelecomSecretVault.
   */
  authToken?: string;

  /**
   * Expected Twilio Account SID (Parent or Subaccount).
   * If incoming params contain AccountSid, it MUST match this value.
   */
  expectedAccountSid?: string;

  /**
   * Resolver function for subaccount / multi-tenant account credential lookup.
   */
  accountTokenResolver?: (accountSid: string) => Promise<string | null> | string | null;

  /**
   * Explicit webhook URL override if known by caller.
   */
  urlOverride?: string;

  /**
   * Optional raw request body string for bodySHA256 signature validation.
   */
  rawBody?: string;

  /**
   * When true, enforces that params.AccountSid MUST be present in the request.
   * Defaults to false for backward compatibility in raw tests, but account-aware
   * validation requires AccountSid to resolve tenant subaccounts.
   */
  requireAccountSid?: boolean;

  /**
   * Optional database client override for test isolation.
   */
  supabaseClient?: any;

  /**
   * Optional secret vault override for test isolation.
   */
  vaultOverride?: any;

  /**
   * Allowed hostnames for proxy header reconstruction.
   */
  allowedHosts?: string[];

  /**
   * Skip post-signature resource ownership check (for pure signature tests).
   */
  skipResourceOwnershipCheck?: boolean;
}

export interface WebhookValidationResult {
  isValid: boolean;
  errorCode?: string;
  errorMessage?: string;
  trustedProviderAccount?: any;
  organizationId?: string;
  isNewInboundResource?: boolean;
  matchedResourceRecord?: any;
}

/**
 * Sanitizes and validates a hostname from raw header values.
 * Rejects header injection and invalid characters.
 */
function sanitizeHostname(raw: string): string | null {
  if (!raw) return null;
  const first = raw.split(',')[0].trim();
  // Valid hostname characters: alphanumeric, dots, hyphens, optional colon and port
  if (!/^[a-zA-Z0-9.\-_]+(?::\d+)?$/.test(first)) {
    return null;
  }
  return first;
}

/**
 * Normalizes protocol to 'http' or 'https'.
 */
function sanitizeProtocol(rawProto?: string | null, isLocal?: boolean): 'http' | 'https' {
  if (!rawProto) return isLocal ? 'http' : 'https';
  const proto = rawProto.split(',')[0].trim().toLowerCase();
  return proto === 'http' ? 'http' : 'https';
}

/**
 * Extracts origin from an environment variable URL safely.
 */
function getValidOrigin(envVar?: string): string | null {
  if (!envVar) return null;
  try {
    const u = new URL(envVar.trim());
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Validates whether a candidate hostname is in the trusted allowlist.
 * Prevents host header injection / candidate URL poisoning.
 */
function isAllowedHost(host: string, options?: ValidateTwilioRequestOptions): boolean {
  if (!host) return false;
  const cleanHost = host.replace(/:\d+$/, '').toLowerCase();

  // 1. Explicit options allowlist
  if (options?.allowedHosts) {
    if (options.allowedHosts.some((h) => h.toLowerCase() === cleanHost || h.toLowerCase() === host.toLowerCase())) {
      return true;
    }
  }

  // 2. Configured environment hosts
  const envHosts = [
    process.env.TWILIO_WEBHOOK_BASE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.APP_URL,
  ]
    .filter(Boolean)
    .map((url) => {
      try {
        return new URL(url!).hostname.toLowerCase();
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (envHosts.includes(cleanHost)) {
    return true;
  }

  // 3. Allowed development and automated test hosts
  if (process.env.NODE_ENV !== 'production') {
    if (
      cleanHost === 'localhost' ||
      cleanHost === '127.0.0.1' ||
      cleanHost.endsWith('.ngrok-free.app') ||
      cleanHost.endsWith('.ngrok.io') ||
      cleanHost === 'voiphub.example.com' // used in existing security test suites
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Builds candidate URLs for Twilio signature verification according to strict VPS/proxy safety rules.
 * Never considers attacker-controlled arbitrary hosts.
 */
function buildAuthoritativeCandidateUrls(
  request: Request,
  options?: ValidateTwilioRequestOptions
): string[] {
  const parsedUrl = new URL(request.url);
  const pathAndSearch = `${parsedUrl.pathname}${parsedUrl.search}`;

  const candidateUrls: string[] = [];

  // A. Explicit caller override
  if (options?.urlOverride) {
    candidateUrls.push(options.urlOverride);
    return candidateUrls;
  }

  // B. Configured environment base URLs (authoritative)
  const envBaseUrls = [
    getValidOrigin(process.env.TWILIO_WEBHOOK_BASE_URL),
    getValidOrigin(process.env.NEXT_PUBLIC_APP_URL),
    getValidOrigin(process.env.APP_URL),
  ].filter(Boolean) as string[];

  for (const origin of envBaseUrls) {
    candidateUrls.push(`${origin}${pathAndSearch}`);
  }

  // C. Reverse proxy header inspection ONLY if host is in allowlist
  const xForwardedHost = request.headers.get('x-forwarded-host') || '';
  const sanitizedForwardedHost = sanitizeHostname(xForwardedHost);
  const xForwardedProto = request.headers.get('x-forwarded-proto') || '';

  if (sanitizedForwardedHost && isAllowedHost(sanitizedForwardedHost, options)) {
    const isLocal = sanitizedForwardedHost.includes('localhost') || sanitizedForwardedHost.includes('127.0.0.1');
    const proto = sanitizeProtocol(xForwardedProto, isLocal);
    candidateUrls.push(`${proto}://${sanitizedForwardedHost}${pathAndSearch}`);
    const cleanForwarded = sanitizedForwardedHost.replace(/:\d+$/, '');
    if (cleanForwarded !== sanitizedForwardedHost) {
      candidateUrls.push(`${proto}://${cleanForwarded}${pathAndSearch}`);
    }
  }

  // D. Raw Host inspection ONLY if host is in allowlist
  const rawHost = request.headers.get('host') || '';
  const sanitizedRawHost = sanitizeHostname(rawHost);

  if (sanitizedRawHost && isAllowedHost(sanitizedRawHost, options)) {
    const isLocal = sanitizedRawHost.includes('localhost') || sanitizedRawHost.includes('127.0.0.1');
    const proto = sanitizeProtocol(xForwardedProto, isLocal);
    candidateUrls.push(`${proto}://${sanitizedRawHost}${pathAndSearch}`);
    const cleanRaw = sanitizedRawHost.replace(/:\d+$/, '');
    if (cleanRaw !== sanitizedRawHost) {
      candidateUrls.push(`${proto}://${cleanRaw}${pathAndSearch}`);
    }
  }

  // E. Fallback to request.url only if request host is allowed or candidates are currently empty
  const reqHost = parsedUrl.host;
  if (isAllowedHost(reqHost, options) || candidateUrls.length === 0) {
    candidateUrls.push(request.url);
    if (request.url.startsWith('http://') && !reqHost.includes('localhost') && !reqHost.includes('127.0.0.1')) {
      candidateUrls.push(request.url.replace(/^http:\/\//, 'https://'));
    }
  }

  return Array.from(new Set(candidateUrls));
}

/**
 * Evaluates HMAC-SHA1 signature against candidate URLs and parameter permutations.
 */
function verifySignatureCandidates(
  authToken: string,
  signature: string,
  candidateUrls: string[],
  params: Record<string, string>,
  options?: ValidateTwilioRequestOptions,
  parsedUrl?: URL
): boolean {
  const hasBodySha = parsedUrl?.searchParams?.has('bodySHA256');

  // Parameter Candidate Sets (Defense against Query Param Collisions)
  const paramCandidates: Record<string, string>[] = [params];

  if (parsedUrl?.searchParams && parsedUrl.searchParams.size > 0) {
    let hasOverlap = false;
    const bodyOnlyParams: Record<string, string> = {};
    for (const [key, val] of Object.entries(params)) {
      if (parsedUrl.searchParams.has(key)) {
        hasOverlap = true;
      } else {
        bodyOnlyParams[key] = val;
      }
    }
    if (hasOverlap) {
      paramCandidates.push(bodyOnlyParams);
    }
  }

  for (const candidateUrl of candidateUrls) {
    if (hasBodySha && options?.rawBody !== undefined) {
      if (twilio.validateRequestWithBody(authToken, signature, candidateUrl, options.rawBody)) {
        return true;
      }
    }

    for (const candidateParams of paramCandidates) {
      if (twilio.validateRequest(authToken, signature, candidateUrl, candidateParams)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Canonical Twilio HMAC-SHA1 signature computation utility.
 * Can be used by tests and diagnostic tools to calculate valid expected signatures.
 */
export function constructExpectedTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

/**
 * Account-Aware Twilio Webhook Request Validator.
 *
 * LOCKED TRUST CHAIN:
 * Incoming Webhook
 *   │
 *   ├─► Untrusted AccountSid lookup hint
 *   ├─► Server-Side Provider Account Resolution (telecom_provider_accounts)
 *   ├─► Authoritative Webhook Verification Credential (TelecomSecretVault)
 *   ├─► Cryptographic Signature Verification (HMAC-SHA1)
 *   ├─► Provider Account Identity Established as TRUSTED
 *   ├─► Resource & Tenant Ownership Validation (telecom_provider_resource_records)
 *   └─► Authorized for Business Logic Execution
 *
 * FAIL-CLOSED INVARIANTS:
 * - Customer subaccount webhooks NEVER fall back to parent Auth Token.
 * - Missing, unknown, inactive, suspended, or ambiguous accounts REJECT immediately.
 * - Unknown or unverifiable = REJECT.
 */
export async function validateAccountAwareTwilioWebhook(
  request: Request,
  params: Record<string, string>,
  options?: ValidateTwilioRequestOptions
): Promise<WebhookValidationResult> {
  const signature = request.headers.get('x-twilio-signature')?.trim();
  if (!signature) {
    console.warn('[Twilio Signature Security] Rejected request: missing x-twilio-signature header.');
    return { isValid: false, errorCode: 'MISSING_SIGNATURE', errorMessage: 'Missing x-twilio-signature header.' };
  }

  const incomingAccountSid = (params.AccountSid || params.accountSid || '').trim();
  if (!incomingAccountSid) {
    console.warn('[Twilio Signature Security] Rejected request: missing required AccountSid in payload.');
    return { isValid: false, errorCode: 'MISSING_ACCOUNT_SID', errorMessage: 'Webhook payload missing required AccountSid.' };
  }

  // Expected AccountSid guard
  if (options?.expectedAccountSid && incomingAccountSid !== options.expectedAccountSid.trim()) {
    console.warn('[Twilio Signature Security] Rejected request: AccountSid mismatch.', {
      expected: `${options.expectedAccountSid.substring(0, 6)}...`,
      received: `${incomingAccountSid.substring(0, 6)}...`,
    });
    return { isValid: false, errorCode: 'ACCOUNT_SID_MISMATCH', errorMessage: 'AccountSid mismatch.' };
  }

  // 1. Untrusted Hint -> Server-Side Provider Account Resolution
  const accRes = await ProviderAccountResolver.resolveAccountByAccountSid(incomingAccountSid, options?.supabaseClient);
  if (!accRes.success || !accRes.account) {
    console.warn(
      `[Twilio Signature Security] Rejected request: account resolution failed (${accRes.errorCode}): ${accRes.errorMessage}`
    );
    return { isValid: false, errorCode: accRes.errorCode || 'UNKNOWN_ACCOUNT_SID', errorMessage: accRes.errorMessage };
  }

  const account = accRes.account;

  // 2. Resolve Exact Webhook Verification Credential
  const secRes = await ProviderAccountResolver.resolveWebhookVerificationSecret(account, options?.vaultOverride);
  if (!secRes.success || !secRes.secret) {
    console.warn(
      `[Twilio Signature Security] Rejected request: secret resolution failed (${secRes.errorCode}): ${secRes.errorMessage}`
    );
    return { isValid: false, errorCode: secRes.errorCode || 'MISSING_VAULT_SECRET', errorMessage: secRes.errorMessage };
  }

  const authToken = secRes.secret;

  // 3. Cryptographic Signature Verification
  const parsedUrl = new URL(request.url);
  const candidateUrls = buildAuthoritativeCandidateUrls(request, options);

  const isSignatureValid = verifySignatureCandidates(authToken, signature, candidateUrls, params, options, parsedUrl);
  if (!isSignatureValid) {
    console.warn('[Twilio Signature Security] Cryptographic signature verification failed.', {
      requestPath: parsedUrl.pathname,
      candidateUrlCount: candidateUrls.length,
      incomingAccount: `${incomingAccountSid.substring(0, 6)}...`,
    });
    return { isValid: false, errorCode: 'INVALID_SIGNATURE', errorMessage: 'Signature verification failed.' };
  }

  // 4. Provider Account Identity is now TRUSTED. Perform Resource Ownership Verification
  if (options?.skipResourceOwnershipCheck !== true) {
    const resCheck = await ProviderResourceManager.validateWebhookResourceOwnership(
      {
        trustedProviderAccountId: account.id,
        isSharedParent: account.account_type === 'SHARED_PARENT',
        bodyParams: params,
      },
      options?.supabaseClient
    );

    if (!resCheck.isValid) {
      console.warn(
        `[Twilio Signature Security] Resource ownership verification failed (${resCheck.errorCode}): ${resCheck.errorMessage}`
      );
      return {
        isValid: false,
        errorCode: resCheck.errorCode || 'CROSS_TENANT_RESOURCE_MISMATCH',
        errorMessage: resCheck.errorMessage,
        trustedProviderAccount: account,
      };
    }

    return {
      isValid: true,
      trustedProviderAccount: account,
      organizationId: resCheck.organizationId,
      isNewInboundResource: resCheck.isNewInboundResource,
      matchedResourceRecord: resCheck.matchedResource,
    };
  }

  return {
    isValid: true,
    trustedProviderAccount: account,
  };
}

/**
 * Strict, Fail-Closed Server-Side Twilio Webhook HTTP Signature Validator.
 *
 * Automatically delegates to Account-Aware validation unless explicit test overrides are provided.
 */
export async function validateTwilioRequest(
  request: Request,
  params: Record<string, string>,
  options?: ValidateTwilioRequestOptions
): Promise<boolean> {
  // If options.authToken is explicitly provided (e.g. low-level test harnesses)
  if (options?.authToken !== undefined) {
    const signature = request.headers.get('x-twilio-signature')?.trim();
    if (!signature) return false;

    const authToken = options.authToken.trim();
    if (!authToken) return false;

    const incomingAccountSid = (params.AccountSid || params.accountSid || '').trim();
    if (options.requireAccountSid && !incomingAccountSid) return false;
    if (options.expectedAccountSid && incomingAccountSid && incomingAccountSid !== options.expectedAccountSid.trim()) {
      return false;
    }

    const parsedUrl = new URL(request.url);
    const candidateUrls = buildAuthoritativeCandidateUrls(request, options);
    return verifySignatureCandidates(authToken, signature, candidateUrls, params, options, parsedUrl);
  }

  // If options.accountTokenResolver is provided (e.g. Phase 20.1A subaccount tests 13/14)
  if (options?.accountTokenResolver) {
    const signature = request.headers.get('x-twilio-signature')?.trim();
    if (!signature) return false;

    const incomingAccountSid = (params.AccountSid || params.accountSid || '').trim();
    if (!incomingAccountSid) return false;

    const resolved = await options.accountTokenResolver(incomingAccountSid);
    if (!resolved || resolved.trim() === '') {
      // STRICT FAIL-CLOSED: No fallback to parent!
      return false;
    }

    const parsedUrl = new URL(request.url);
    const candidateUrls = buildAuthoritativeCandidateUrls(request, options);
    return verifySignatureCandidates(resolved.trim(), signature, candidateUrls, params, options, parsedUrl);
  }

  // Default: Account-aware server-side resolution
  const result = await validateAccountAwareTwilioWebhook(request, params, options);
  return result.isValid;
}
