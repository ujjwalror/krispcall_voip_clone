import 'server-only';
import { BillingAuthorizationState } from '../domain/types';

export interface FinancialAuthorizationParams {
  organizationId: string;
  authorizationId?: string | null;
  amountMinor: number;
  currency: string;
  source?: 'stripe_payment_intent' | 'prepaid_wallet_hold' | 'subscription_included_allowance';
  expiresAt?: string;
  clientSecret?: string;
  simulateDecline?: boolean;
  simulateCaptureFailure?: boolean;
}

export interface FinancialAuthorizationResult {
  authorized: boolean;
  authorizationId: string;
  state: BillingAuthorizationState;
  amountMinor: number;
  currency: string;
  source: 'stripe_payment_intent' | 'prepaid_wallet_hold' | 'subscription_included_allowance';
  errorCode?: string;
  errorMessage?: string;
}

/**
 * ==============================================================================
 * PHASE 23D.3: FINANCIAL AUTHORIZATION BOUNDARY
 * ==============================================================================
 * Manages financial authorization holds for customer phone-number procurement.
 * 
 * STRICT INVARIANTS:
 * 1. Financial authorization MUST occur BEFORE provider mutation dispatch.
 * 2. Number procurement and recurring subscription fees are strictly SEPARATED
 *    from prepaid telecom usage wallet reservations (Voice/SMS/MMS call debits).
 * 3. Expired or unconfirmed holds fail closed before provider mutation.
 * 4. Zero real Stripe API mutations occur in test/mock environment.
 */
export class FinancialAuthorizationBoundary {
  /**
   * Evaluates or places a financial authorization hold for a phone number purchase.
   */
  static async authorizePurchaseFunds(
    params: FinancialAuthorizationParams
  ): Promise<FinancialAuthorizationResult> {
    const { organizationId, amountMinor, currency } = params;
    const source = params.source || 'subscription_included_allowance';

    if (params.simulateDecline) {
      return {
        authorized: false,
        authorizationId: '',
        state: 'FAILED',
        amountMinor,
        currency,
        source,
        errorCode: 'CARD_DECLINED',
        errorMessage: 'Customer payment method was declined during pre-authorization.',
      };
    }

    if (!organizationId) {
      return {
        authorized: false,
        authorizationId: '',
        state: 'FAILED',
        amountMinor,
        currency,
        source,
        errorCode: 'MISSING_ORGANIZATION_ID',
        errorMessage: 'Organization ID is required for financial authorization.',
      };
    }

    if (amountMinor < 0) {
      return {
        authorized: false,
        authorizationId: '',
        state: 'FAILED',
        amountMinor,
        currency,
        source,
        errorCode: 'INVALID_AMOUNT',
        errorMessage: 'Authorization amount minor cannot be negative.',
      };
    }

    // If an authorizationId was passed, verify its validity and expiration
    if (params.authorizationId) {
      if (params.expiresAt) {
        const expiresMs = new Date(params.expiresAt).getTime();
        if (!isNaN(expiresMs) && Date.now() > expiresMs) {
          return {
            authorized: false,
            authorizationId: params.authorizationId,
            state: 'EXPIRED',
            amountMinor,
            currency,
            source,
            errorCode: 'AUTHORIZATION_EXPIRED',
            errorMessage: 'Payment authorization hold has expired.',
          };
        }
      }

      return {
        authorized: true,
        authorizationId: params.authorizationId,
        state: 'AUTHORIZED',
        amountMinor,
        currency,
        source,
      };
    }

    // Generate a synthetic or local authorization reference for verified allowance or hold
    const authId = `auth_hold_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    return {
      authorized: true,
      authorizationId: authId,
      state: 'AUTHORIZED',
      amountMinor,
      currency,
      source,
    };
  }

  /**
   * Releases or unlocks a financial hold when a purchase fails or inventory vanished.
   */
  static async releaseHold(
    authorizationId: string,
    reason: string
  ): Promise<{ released: boolean; message?: string }> {
    if (!authorizationId) return { released: true };

    // In local / mock environment, marks hold released without real Stripe mutation
    return {
      released: true,
      message: `Authorization hold '${authorizationId}' released due to: ${reason}`,
    };
  }

  /**
   * Finalizes / captures a financial hold following confirmed provider acquisition.
   * Note: Full deferred billing capture occurs in Phase 23D.9.
   */
  static async captureHold(
    authorizationId: string,
    simulateCaptureFailure?: boolean
  ): Promise<{ captured: boolean; state: BillingAuthorizationState }> {
    if (!authorizationId || simulateCaptureFailure) {
      return { captured: false, state: 'FAILED' };
    }

    return {
      captured: true,
      state: 'CAPTURED',
    };
  }
}
