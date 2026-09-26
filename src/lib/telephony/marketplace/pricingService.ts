import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { ProviderCostService } from './providerCostService';
import { normalizeNumberType } from './utils';

export interface PriceSnapshotMetadata {
  pricingSource: 'explicit_override' | 'pricing_policy';
  policyId?: string | null;
  providerCostMinor?: number | null;
  providerCostCurrency?: string | null;
  grossMarginMinor?: number | null;
}

export interface ServerRetailPriceResult {
  hasConfiguredPrice: boolean;
  currency: string;
  monthlyPriceMinor: number | null;
  monthlyPriceFormatted: string | null;
  priceModel: 'OPTION_A_CURRENT_PRICE_ONLY';
  snapshot?: PriceSnapshotMetadata;
  note?: string;
}

/**
 * Service for resolving authoritative server-side retail prices for business phone numbers.
 * Supports explicit price overrides and server-authoritative pricing policy rules.
 */
export class RetailPricingService {
  /**
   * Resolves the authoritative active retail price for a phone number category in a country.
   * Hierarchy:
   * 1. Explicit active override in public.phone_number_retail_prices.
   * 2. Active pricing policy in public.phone_number_pricing_policies + provider wholesale cost.
   * 3. Fail-closed: returns hasConfiguredPrice: false.
   */
  static async resolveRetailPrice(
    countryCode: string,
    numberType: string,
    currency = 'USD'
  ): Promise<ServerRetailPriceResult> {
    const cc = (countryCode || '').toUpperCase();
    const curr = (currency || 'USD').toUpperCase();
    const type = normalizeNumberType(numberType);

    try {
      const supabase = createAdminClient();

      // 1. Check Explicit Retail Override
      const { data: overrideData, error: overrideError } = await (supabase as any)
        .from('phone_number_retail_prices')
        .select('monthly_price_minor, currency')
        .eq('country_code', cc)
        .eq('number_type', type)
        .eq('currency', curr)
        .eq('is_active', true)
        .maybeSingle();

      if (!overrideError && overrideData && overrideData.monthly_price_minor !== null && overrideData.monthly_price_minor !== undefined) {
        const minor = Number(overrideData.monthly_price_minor);
        const major = minor / 100;
        const formatted = new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: overrideData.currency || curr,
        }).format(major);

        return {
          hasConfiguredPrice: true,
          currency: overrideData.currency || curr,
          monthlyPriceMinor: minor,
          monthlyPriceFormatted: formatted,
          priceModel: 'OPTION_A_CURRENT_PRICE_ONLY',
          snapshot: {
            pricingSource: 'explicit_override',
          },
        };
      }

      // 2. Check Active Pricing Policy
      const { data: policyData, error: policyError } = await (supabase as any)
        .from('phone_number_pricing_policies')
        .select('*')
        .eq('country_code', cc)
        .eq('number_type', type)
        .eq('billing_currency', curr)
        .eq('is_active', true)
        .maybeSingle();

      if (!policyError && policyData) {
        // Fetch Provider Wholesale Cost
        const providerCostRes = await ProviderCostService.getProviderCost(cc);
        const matchingPrice = providerCostRes.prices.find(
          (p) => p.numberType.toLowerCase() === type || (type === 'toll_free' && p.numberType.includes('toll'))
        );

        if (matchingPrice && matchingPrice.currentPriceMinor !== null && matchingPrice.currentPriceMinor > 0) {
          const providerCurrency = providerCostRes.currency.toUpperCase();
          if (providerCurrency !== curr) {
            return {
              hasConfiguredPrice: false,
              currency: curr,
              monthlyPriceMinor: null,
              monthlyPriceFormatted: null,
              priceModel: 'OPTION_A_CURRENT_PRICE_ONLY',
              note: `Currency mismatch without server FX converter: Provider ${providerCurrency} vs Billing ${curr}.`,
            };
          }

          const providerMinor = matchingPrice.currentPriceMinor;
          const targetMarginPct = Number(policyData.target_margin_pct ?? 30);
          const minMarginMinor = Number(policyData.minimum_fixed_margin_minor ?? 200);

          const calculatedByPct = Math.round(providerMinor * (1 + targetMarginPct / 100));
          const calculatedByMin = providerMinor + minMarginMinor;

          let rawDerivedMinor = Math.max(calculatedByPct, calculatedByMin);

          // Apply rounding rule if configured
          if (policyData.rounding_rule === 'nearest_99') {
            const dollars = Math.floor(rawDerivedMinor / 100);
            rawDerivedMinor = dollars * 100 + 99;
            if (rawDerivedMinor < providerMinor + minMarginMinor) {
              rawDerivedMinor = (dollars + 1) * 100 + 99;
            }
          }

          const marginMinor = rawDerivedMinor - providerMinor;
          if (marginMinor <= 0) {
            return {
              hasConfiguredPrice: false,
              currency: curr,
              monthlyPriceMinor: null,
              monthlyPriceFormatted: null,
              priceModel: 'OPTION_A_CURRENT_PRICE_ONLY',
              note: 'Derived price results in zero or negative gross margin.',
            };
          }

          const major = rawDerivedMinor / 100;
          const formatted = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: curr,
          }).format(major);

          return {
            hasConfiguredPrice: true,
            currency: curr,
            monthlyPriceMinor: rawDerivedMinor,
            monthlyPriceFormatted: formatted,
            priceModel: 'OPTION_A_CURRENT_PRICE_ONLY',
            snapshot: {
              pricingSource: 'pricing_policy',
              policyId: policyData.id,
              providerCostMinor: providerMinor,
              providerCostCurrency: providerCurrency,
              grossMarginMinor: marginMinor,
            },
          };
        }
      }

      // 3. Dynamic Default Pricing Policy Fallback (30% markup, USD $2.00 minimum markup)
      const providerCostRes = await ProviderCostService.getProviderCost(cc);
      const matchingPrice = providerCostRes.prices.find(
        (p) => p.numberType.toLowerCase() === type || (type === 'toll_free' && p.numberType.includes('toll'))
      );

      if (matchingPrice && matchingPrice.currentPriceMinor !== null && matchingPrice.currentPriceMinor > 0) {
        const providerCurrency = providerCostRes.currency.toUpperCase();
        if (providerCurrency !== curr) {
          return {
            hasConfiguredPrice: false,
            currency: curr,
            monthlyPriceMinor: null,
            monthlyPriceFormatted: null,
            priceModel: 'OPTION_A_CURRENT_PRICE_ONLY',
            note: `Currency mismatch without server FX converter: Provider ${providerCurrency} vs Billing ${curr}.`,
          };
        }

        const providerMinor = matchingPrice.currentPriceMinor;
        const targetMarginPct = 30;
        const minMarginMinor = 200; // USD $2.00 minimum markup

        const calculatedByPct = Math.round(providerMinor * (1 + targetMarginPct / 100));
        const calculatedByMin = providerMinor + minMarginMinor;
        const rawDerivedMinor = Math.max(calculatedByPct, calculatedByMin);

        const marginMinor = rawDerivedMinor - providerMinor;
        const major = rawDerivedMinor / 100;
        const formatted = new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: curr,
        }).format(major);

        return {
          hasConfiguredPrice: true,
          currency: curr,
          monthlyPriceMinor: rawDerivedMinor,
          monthlyPriceFormatted: formatted,
          priceModel: 'OPTION_A_CURRENT_PRICE_ONLY',
          snapshot: {
            pricingSource: 'pricing_policy',
            policyId: null,
            providerCostMinor: providerMinor,
            providerCostCurrency: providerCurrency,
            grossMarginMinor: marginMinor,
          },
        };
      }

      // 4. Fail-Closed Default
      return {
        hasConfiguredPrice: false,
        currency: curr,
        monthlyPriceMinor: null,
        monthlyPriceFormatted: null,
        priceModel: 'OPTION_A_CURRENT_PRICE_ONLY',
        note: 'No active retail override or pricing policy configured for this country and number category.',
      };
    } catch (err: any) {
      console.warn('[RetailPricingService] Error resolving retail price:', err.message || err);
      return {
        hasConfiguredPrice: false,
        currency: curr,
        monthlyPriceMinor: null,
        monthlyPriceFormatted: null,
        priceModel: 'OPTION_A_CURRENT_PRICE_ONLY',
        note: 'Retail pricing resolution failed or uninitialized.',
      };
    }
  }
}

