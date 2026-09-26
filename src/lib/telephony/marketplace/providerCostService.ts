import 'server-only';
import { createTwilioServerClient } from '@/lib/twilio/client';
import { withTimeout } from './utils';

export interface NormalizedProviderNumberCost {
  numberType: string;
  basePriceMinor: number | null;
  currentPriceMinor: number | null;
  basePriceFormatted: string | null;
  currentPriceFormatted: string | null;
}

export interface NormalizedProviderCostResult {
  provider: 'twilio';
  countryCode: string;
  currency: string;
  prices: NormalizedProviderNumberCost[];
  fetchedAt: string;
  rawResponseAvailable: boolean;
  note?: string;
}

/**
 * Server-Only Service for fetching authoritative wholesale provider costs from Twilio Pricing API.
 * Internal commercial information only. Provider cost must NEVER be exposed to normal SaaS customers.
 */
export class ProviderCostService {
  /**
   * Fetches current authoritative provider phone number pricing for a country via Twilio Pricing API.
   */
  static async getProviderCost(countryCode: string): Promise<NormalizedProviderCostResult> {
    const cc = (countryCode || 'US').toUpperCase();
    const fetchedAt = new Date().toISOString();

    try {
      const client = createTwilioServerClient();
      const pricingApi = (client as any).pricing;

      let pricingObj: any = null;
      if (pricingApi?.v1?.phoneNumbers?.countries) {
        pricingObj = await withTimeout<any>(pricingApi.v1.phoneNumbers.countries(cc).fetch(), 3000, null);
      } else if (pricingApi?.v2?.phoneNumbers?.countries) {
        pricingObj = await withTimeout<any>(pricingApi.v2.phoneNumbers.countries(cc).fetch(), 3000, null);
      }

      if (!pricingObj) {
        return {
          provider: 'twilio',
          countryCode: cc,
          currency: 'USD',
          prices: [],
          fetchedAt,
          rawResponseAvailable: false,
          note: 'Twilio Pricing API resource unavailable or uninitialized.',
        };
      }

      const currency = (pricingObj.priceUnit || 'USD').toUpperCase();
      const rawPrices: any[] = pricingObj.phoneNumberPrices || [];

      const prices: NormalizedProviderNumberCost[] = rawPrices.map((p) => {
        const rawType = (p.numberType || 'unknown').toLowerCase().trim();
        let numberType = rawType;
        if (rawType === 'tollfree' || rawType === 'toll_free' || rawType === 'toll-free' || rawType === 'toll free') {
          numberType = 'toll_free';
        }

        const baseVal = p.basePrice !== undefined && p.basePrice !== null ? Number(p.basePrice) : null;
        const currVal = p.currentPrice !== undefined && p.currentPrice !== null ? Number(p.currentPrice) : null;

        const basePriceMinor = baseVal !== null ? Math.round(baseVal * 100) : null;
        const currentPriceMinor = currVal !== null ? Math.round(currVal * 100) : null;

        const basePriceFormatted =
          baseVal !== null
            ? new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(baseVal)
            : null;
        const currentPriceFormatted =
          currVal !== null
            ? new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(currVal)
            : null;

        return {
          numberType,
          basePriceMinor,
          currentPriceMinor,
          basePriceFormatted,
          currentPriceFormatted,
        };
      });

      return {
        provider: 'twilio',
        countryCode: cc,
        currency,
        prices,
        fetchedAt,
        rawResponseAvailable: true,
        note: 'Authoritative provider pricing retrieved from Twilio Pricing API.',
      };
    } catch (err: any) {
      console.warn(`[ProviderCostService] Failed to fetch Twilio pricing for ${cc}:`, err.message || err);
      return {
        provider: 'twilio',
        countryCode: cc,
        currency: 'USD',
        prices: [],
        fetchedAt,
        rawResponseAvailable: false,
        note: `Provider pricing fetch error: ${err.message || err}`,
      };
    }
  }
}
