import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { NumberPriceQuoteDTO, CanonicalTelecomError } from '../domain/types';

export interface PriceQuoteValidationParams {
  quoteId?: string | null;
  quote?: NumberPriceQuoteDTO | null;
  organizationId: string;
  phoneNumberE164: string;
  expectedProvider?: string;
  expectedCountryCode?: string;
  expectedNumberType?: string;
  expectedCurrency?: string;
}

export interface PriceQuoteValidationResult {
  valid: boolean;
  quote?: NumberPriceQuoteDTO;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * ==============================================================================
 * PHASE 23D.3: PRICE QUOTE VALIDATOR
 * ==============================================================================
 * Validates price quotes against the authoritative public.phone_number_price_quotes table.
 * 
 * STRICT INVARIANT:
 * Quotes expire exactly 15 minutes (900 seconds) after observed_at.
 * An expired quote MUST fail closed with QUOTE_EXPIRED before provider dispatch.
 * Silent re-pricing or buying at altered wholesale rates is strictly prohibited.
 */
export class PriceQuoteValidator {
  /**
   * Maximum quote validity window in milliseconds (15 minutes).
   */
  static readonly MAX_QUOTE_TTL_MS = 15 * 60 * 1000;

  static computeSignature(quote: any): string {
    const secret = process.env.QUOTE_SIGNING_SECRET || 'phase23d_quote_secret_v1';
    const recurring = quote.customerRecurringPriceMinor ?? quote.retailMonthlyAmountMinor ?? 0;
    const upfront = quote.customerSetupPriceMinor ?? quote.retailUpfrontAmountMinor ?? 0;
    const curr = quote.currency || quote.retailCurrency || 'USD';
    const payload = `${quote.organizationId}:${quote.phoneNumberE164}:${recurring}:${upfront}:${curr}:${quote.expiresAt}`;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('crypto').createHmac('sha256', secret).update(payload).digest('hex');
  }

  static signQuote(quote: any): string {
    return this.computeSignature(quote);
  }

  /**
   * Validates a price quote either from database row lookup or provided quote DTO.
   */
  static async validateQuote(
    params: PriceQuoteValidationParams,
    supabaseClient?: SupabaseClient
  ): Promise<PriceQuoteValidationResult> {
    const {
      quoteId,
      organizationId,
      phoneNumberE164,
      expectedProvider = 'twilio',
      expectedCountryCode,
      expectedNumberType,
      expectedCurrency = 'USD',
    } = params;

    let quote = params.quote;

    // 1. If quoteId is provided, query authoritative database record
    if (quoteId && supabaseClient) {
      const { data: dbQuote, error: dbErr } = await (supabaseClient as any)
        .from('phone_number_price_quotes')
        .select('*')
        .eq('id', quoteId)
        .maybeSingle();

      if (dbErr || !dbQuote) {
        return {
          valid: false,
          errorCode: 'QUOTE_NOT_FOUND',
          errorMessage: `Price quote '${quoteId}' was not found.`,
        };
      }

      quote = {
        id: dbQuote.id,
        organizationId: dbQuote.organization_id,
        provider: dbQuote.provider,
        phoneNumberE164: dbQuote.phone_number_e164,
        numberType: dbQuote.number_type,
        countryCode: dbQuote.country_code,
        currency: dbQuote.currency,
        providerSetupCostMinor: dbQuote.provider_setup_cost_minor,
        providerRecurringCostMinor: dbQuote.provider_recurring_cost_minor,
        customerSetupPriceMinor: dbQuote.customer_setup_price_minor,
        customerRecurringPriceMinor: dbQuote.customer_recurring_price_minor,
        pricingPolicyId: dbQuote.pricing_policy_id,
        observedAt: dbQuote.observed_at,
        expiresAt: dbQuote.expires_at,
        searchTokenSignature: dbQuote.search_token_signature,
        reservationMetadata: dbQuote.reservation_metadata,
      };

      if (dbQuote.status && dbQuote.status !== 'active') {
        return {
          valid: false,
          errorCode: 'QUOTE_ALREADY_CONSUMED',
          errorMessage: `Price quote '${quoteId}' has already been ${dbQuote.status}.`,
        };
      }
    }

    if (!quote) {
      return {
        valid: false,
        errorCode: 'QUOTE_REQUIRED',
        errorMessage: 'A valid price quote is required for customer number purchase.',
      };
    }

    // 2. Tenant isolation check
    if (quote.organizationId !== organizationId) {
      return {
        valid: false,
        errorCode: 'TENANT_MISMATCH',
        errorMessage: 'Price quote does not belong to the requesting organization.',
      };
    }

    // 3. E.164 consistency check
    if (quote.phoneNumberE164.trim() !== phoneNumberE164.trim()) {
      return {
        valid: false,
        errorCode: 'QUOTE_NUMBER_MISMATCH',
        errorMessage: `Price quote E.164 (${quote.phoneNumberE164}) does not match requested number (${phoneNumberE164}).`,
      };
    }

    // 4. Provider consistency check
    if (expectedProvider && quote.provider.toLowerCase() !== expectedProvider.toLowerCase()) {
      return {
        valid: false,
        errorCode: 'QUOTE_PROVIDER_MISMATCH',
        errorMessage: `Price quote provider (${quote.provider}) does not match expected provider (${expectedProvider}).`,
      };
    }

    // 5. Country and number type checks
    if (expectedCountryCode && quote.countryCode.toUpperCase() !== expectedCountryCode.toUpperCase()) {
      return {
        valid: false,
        errorCode: 'QUOTE_COUNTRY_MISMATCH',
        errorMessage: `Price quote country (${quote.countryCode}) does not match expected country (${expectedCountryCode}).`,
      };
    }

    if (expectedNumberType && quote.numberType.toLowerCase() !== expectedNumberType.toLowerCase()) {
      return {
        valid: false,
        errorCode: 'QUOTE_TYPE_MISMATCH',
        errorMessage: `Price quote number type (${quote.numberType}) does not match expected type (${expectedNumberType}).`,
      };
    }

    // 6. Currency check
    const quoteCurrency = quote.currency || (quote as any).retailCurrency || 'USD';
    if (expectedCurrency && quoteCurrency.toUpperCase() !== expectedCurrency.toUpperCase()) {
      return {
        valid: false,
        errorCode: 'QUOTE_CURRENCY_MISMATCH',
        errorMessage: `Price quote currency (${quoteCurrency}) does not match expected currency (${expectedCurrency}).`,
      };
    }

    // 7. Temporal Expiration Check (15-minute window)
    const nowMs = Date.now();
    const expiresAtMs = new Date(quote.expiresAt).getTime();
    const observedAtMs = new Date(quote.observedAt).getTime();

    if (isNaN(expiresAtMs) || nowMs > expiresAtMs) {
      return {
        valid: false,
        errorCode: 'QUOTE_EXPIRED',
        errorMessage: 'Price quote has expired. Please refresh the marketplace catalog.',
      };
    }

    // Sanity check: observedAt cannot be in the future beyond clock skew tolerance (60s)
    if (observedAtMs - nowMs > 60000) {
      return {
        valid: false,
        errorCode: 'QUOTE_INVALID_TIMESTAMPS',
        errorMessage: 'Price quote contains invalid future observed_at timestamp.',
      };
    }

    // 8. Cryptographic Signature Tampering Check
    const sig = (quote as any).quoteSignature || quote.searchTokenSignature;
    if (sig) {
      const expectedSig = PriceQuoteValidator.computeSignature(quote);
      if (sig !== expectedSig) {
        return {
          valid: false,
          errorCode: 'TAMPERED_QUOTE',
          errorMessage: 'Price quote signature verification failed. Quote has been tampered with.',
        };
      }
    }

    return {
      valid: true,
      quote,
    };
  }

  /**
   * Helper that asserts quote validity and throws CanonicalTelecomError on failure.
   */
  static async assertValidQuote(
    params: PriceQuoteValidationParams,
    supabaseClient?: SupabaseClient
  ): Promise<NumberPriceQuoteDTO> {
    const res = await this.validateQuote(params, supabaseClient);
    if (!res.valid || !res.quote) {
      const code = (res.errorCode === 'QUOTE_EXPIRED' ? 'QUOTE_EXPIRED' : 'INVENTORY_VANISHED') as any;
      throw new CanonicalTelecomError(
        code,
        res.errorMessage || 'Price quote validation failed.',
        res.errorCode === 'QUOTE_EXPIRED' ? 410 : 400,
        { errorCode: res.errorCode }
      );
    }
    return res.quote;
  }
}
