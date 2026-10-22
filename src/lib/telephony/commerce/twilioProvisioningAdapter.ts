import 'server-only';
import { ProviderClientFactory } from '@/lib/telecom/provider/providerClientFactory';
import { ProviderContext } from '@/lib/telecom/provider/types';

/**
 * PHASE 23D.2: CUSTOMER NUMBER PROVIDER CONTEXT ENFORCEMENT
 *
 * Customer number operations (purchase, lookup, release) require an explicit
 * ProviderContext with account_type === 'CUSTOMER_SUBACCOUNT' or 'DEDICATED_ACCOUNT'.
 *
 * SECURITY INVARIANT: ZERO runtime fallback to SHARED_PARENT for customer number operations.
 * Missing or malformed context is a compile-time error (non-optional parameter)
 * AND a runtime fail-closed rejection.
 */

/**
 * Validates that a ProviderContext is a legitimate customer number execution context.
 * Throws fail-closed on any violation.
 */
function assertCustomerNumberContext(context: ProviderContext, operation: string): void {
  if (!context) {
    throw Object.assign(
      new Error(`PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED: Customer number operation '${operation}' requires explicit ProviderContext. No implicit parent fallback.`),
      { code: 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED' }
    );
  }
  if (context.isSharedParent || context.accountType === 'SHARED_PARENT') {
    throw Object.assign(
      new Error(`PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED: Customer number operation '${operation}' cannot use SHARED_PARENT context. Customer operations require CUSTOMER_SUBACCOUNT.`),
      { code: 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED' }
    );
  }
  if (context.accountType !== 'CUSTOMER_SUBACCOUNT' && context.accountType !== 'DEDICATED_ACCOUNT') {
    throw Object.assign(
      new Error(`PROVIDER_ACCOUNT_MISMATCH: Customer number operation '${operation}' requires account type CUSTOMER_SUBACCOUNT or DEDICATED_ACCOUNT, got '${context.accountType}'.`),
      { code: 'PROVIDER_ACCOUNT_MISMATCH' }
    );
  }
  if (!context.providerAccountId || !context.organizationId) {
    throw Object.assign(
      new Error(`MALFORMED_PROVIDER_CONTEXT: Customer number operation '${operation}' requires providerAccountId and organizationId.`),
      { code: 'MALFORMED_PROVIDER_CONTEXT' }
    );
  }
}

export interface TwilioPurchasePostParams {
  phoneNumberE164: string;
  bundleSid?: string | null;
  addressSid?: string | null;
  emergencyAddressSid?: string | null;
  voiceUrl?: string | null;
  smsUrl?: string | null;
  statusCallback?: string | null;
}

export interface PurchasePostResultSuccess {
  success: true;
  sid: string;
  status: string;
  priceMinor?: number | null;
  priceCurrency?: string | null;
}

export interface PurchasePostResultFailure {
  success: false;
  deterministicFailure: boolean;
  errorCode: string;
  errorMessage: string;
}

export type PurchasePostResult = PurchasePostResultSuccess | PurchasePostResultFailure;

export interface AuthoritativeLookupResult {
  found: boolean;
  sid?: string;
  status?: string;
}

export interface PrePurchaseRecheckResult {
  available: boolean;
  exactMatch: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Twilio error codes representing definitive, documented pre-mutation purchase rejections.
 * Any error code NOT in this set is treated as ambiguous (failing toward reconciliation_required).
 */
export const DETERMINISTIC_TWILIO_REJECTION_CODES = new Set<number>([
  20003, // Permission / Authentication Failure
  20404, // Resource Not Found / Invalid SID
  21201, // No phone number specified
  21421, // Address Sid is required for this phone number
  21422, // Address Sid is invalid or rejected
  21450, // Phone number is unavailable or already sold
  21452, // Requested phone number is not valid for purchase
  21601, // Phone number is not a valid SMS / Voice number
  21614, // Emergency address verification failed
]);

export class TwilioProvisioningAdapter {
  /**
   * Classifies whether a Twilio exception is a deterministic pre-mutation rejection
   * versus an ambiguous network/timeout/server failure.
   */
  static isDeterministicFailure(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    const err = error as Record<string, unknown>;
    const httpStatus = Number(err.status || err.statusCode);
    const twilioCode = Number(err.code);

    // Only definitive HTTP 400, 401, 403, 404, 422 with documented rejection codes are deterministic
    if (httpStatus >= 400 && httpStatus < 500) {
      if (twilioCode && DETERMINISTIC_TWILIO_REJECTION_CODES.has(twilioCode)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Re-checks live Twilio availability of an exact E.164 number immediately prior to purchase dispatch.
   *
   * SCOPE CLASSIFICATION: PLATFORM_ADMIN_ALLOWED
   * Twilio AvailablePhoneNumbers search operates at parent account scope for catalog discovery.
   * A search result does NOT authorize a purchase — purchase always performs its own
   * validated customer-account authorization independently.
   *
   * If a customerContext is provided, the search will be scoped to that subaccount.
   * Otherwise, parent administrative client is used for platform-level catalog visibility.
   */
  static async recheckNumberAvailability(
    phoneNumberE164: string,
    countryCode: string,
    numberType: string,
    customerContext?: ProviderContext
  ): Promise<PrePurchaseRecheckResult> {
    try {
      // If customer context is provided, scope search to subaccount.
      // Otherwise, use parent admin for platform-level catalog visibility.
      // CRITICAL: Search scope does NOT authorize purchase scope.
      const client = customerContext
        ? await ProviderClientFactory.getTwilioClientAsync(customerContext)
        : ProviderClientFactory.getParentAdministrativeClient();
      const countryUpper = countryCode.toUpperCase();
      let results: Array<{ phoneNumber?: string }> = [];

      if (numberType === 'toll_free') {
        results = await client.availablePhoneNumbers(countryUpper).tollFree.list({
          contains: phoneNumberE164,
          limit: 10,
        });
      } else if (numberType === 'mobile') {
        results = await client.availablePhoneNumbers(countryUpper).mobile.list({
          contains: phoneNumberE164,
          limit: 10,
        });
      } else {
        results = await client.availablePhoneNumbers(countryUpper).local.list({
          contains: phoneNumberE164,
          limit: 10,
        });
      }

      if (!Array.isArray(results)) {
        console.warn('[TwilioProvisioningAdapter.recheckNumberAvailability] Malformed provider response: expected array, received', typeof results);
        return {
          available: false,
          exactMatch: false,
          errorCode: 'MALFORMED_PROVIDER_RESPONSE',
          errorMessage: 'Carrier inventory response is malformed.',
        };
      }

      const match = results.some((item: { phoneNumber?: string }) => item.phoneNumber === phoneNumberE164);
      return {
        available: match,
        exactMatch: match,
      };
    } catch (err: any) {
      // Phase 24D.SEC-7F L-02: Fail-Closed on provider error/timeout/5xx/malformed.
      // Under NO circumstances treat an unknown or failed availability check as available!
      const rawMsg = err?.message || String(err || 'Unknown provider error');
      const sanitizedMsg = rawMsg
        .replace(/SK[a-f0-9]{32}/gi, '[REDACTED_API_KEY]')
        .replace(/AC[a-f0-9]{32}/gi, '[REDACTED_ACCOUNT_SID]')
        .replace(/(Bearer|Basic)\s+[A-Za-z0-9+/=]+/gi, '$1 [REDACTED]')
        .substring(0, 256);

      const errCode = String(err?.code || err?.status || 'PROVIDER_AVAILABILITY_ERROR');

      console.warn('[TwilioProvisioningAdapter.recheckNumberAvailability] Carrier availability check failed (FAIL-CLOSED):', {
        code: errCode,
        message: sanitizedMsg,
      });

      return {
        available: false,
        exactMatch: false,
        errorCode: errCode,
        errorMessage: sanitizedMsg,
      };
    }
  }

  /**
   * Executes the IncomingPhoneNumbers POST request against Twilio REST API.
   * NEVER called automatically during recovery.
   *
   * PHASE 23D.2 SECURITY INVARIANT:
   * ProviderContext is MANDATORY. Customer number purchase MUST use explicit
   * CUSTOMER_SUBACCOUNT context. SHARED_PARENT context is rejected fail-closed.
   * Missing context is a compile-time error and runtime rejection.
   */
  static async executePurchasePost(
    params: TwilioPurchasePostParams,
    context: ProviderContext
  ): Promise<PurchasePostResult> {
    try {
      // PHASE 23D.2: Fail-closed validation — context is mandatory, parent is prohibited
      assertCustomerNumberContext(context, 'executePurchasePost');

      const client = await ProviderClientFactory.getTwilioClientAsync(context);

      const postPayload: Record<string, string> = {
        phoneNumber: params.phoneNumberE164,
      };

      if (params.bundleSid) postPayload.bundleSid = params.bundleSid;
      if (params.addressSid) postPayload.addressSid = params.addressSid;
      if (params.emergencyAddressSid) postPayload.emergencyAddressSid = params.emergencyAddressSid;
      if (params.voiceUrl) postPayload.voiceUrl = params.voiceUrl;
      if (params.smsUrl) postPayload.smsUrl = params.smsUrl;
      if (params.statusCallback) postPayload.statusCallback = params.statusCallback;

      const purchasedNumber = await (client.incomingPhoneNumbers as { create: (p: Record<string, string>) => Promise<{ sid: string; status?: string }> }).create(postPayload);

      return {
        success: true,
        sid: purchasedNumber.sid,
        status: purchasedNumber.status || 'active',
      };
    } catch (error: unknown) {
      const err = error as Record<string, unknown>;
      // Propagate security errors as deterministic failures with original error code
      if (
        err.code === 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED' ||
        err.code === 'PROVIDER_ACCOUNT_MISMATCH' ||
        err.code === 'MALFORMED_PROVIDER_CONTEXT'
      ) {
        return {
          success: false,
          deterministicFailure: true,
          errorCode: String(err.code),
          errorMessage: String(err.message),
        };
      }

      const deterministic = TwilioProvisioningAdapter.isDeterministicFailure(error);
      const errorCode = err.code ? `TWILIO_${err.code}` : (err.name as string) || 'PROVIDER_DISPATCH_ERROR';
      const errorMessage = (err.message as string) || 'An error occurred during provider purchase dispatch.';

      return {
        success: false,
        deterministicFailure: deterministic,
        errorCode,
        errorMessage,
      };
    }
  }

  /**
   * Queries Twilio account inventory to authoritatively verify whether an exact E.164 is owned.
   *
   * PHASE 23D.2 SECURITY INVARIANT:
   * ProviderContext is MANDATORY. Customer-owned number lookup MUST use explicit
   * CUSTOMER_SUBACCOUNT context. SHARED_PARENT is rejected fail-closed.
   */
  static async lookupOwnedNumberByE164(
    phoneNumberE164: string,
    context: ProviderContext
  ): Promise<AuthoritativeLookupResult> {
    try {
      // PHASE 23D.2: Fail-closed validation — context is mandatory, parent is prohibited
      assertCustomerNumberContext(context, 'lookupOwnedNumberByE164');

      const client = await ProviderClientFactory.getTwilioClientAsync(context);

      const list = await client.incomingPhoneNumbers.list({
        phoneNumber: phoneNumberE164,
        limit: 1,
      });

      if (list && list.length > 0 && list[0].phoneNumber === phoneNumberE164) {
        return {
          found: true,
          sid: list[0].sid,
          status: list[0].status || 'active',
        };
      }

      return { found: false };
    } catch {
      // Inconclusive observation due to network/API error
      return { found: false };
    }
  }
}
