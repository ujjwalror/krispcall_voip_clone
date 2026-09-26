import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { ProviderCostService } from './providerCostService';
import { RetailPricingService, ServerRetailPriceResult } from './pricingService';
import { normalizeNumberType } from './utils';

export type CommercialSafetyState =
  | 'retail_not_configured'
  | 'provider_cost_unavailable'
  | 'currency_mismatch'
  | 'negative_margin'
  | 'zero_margin'
  | 'positive_margin';

export type CommercialEnablementStatus =
  | 'AVAILABLE'
  | 'NOT_COMMERCIALLY_CONFIGURED'
  | 'NOT_LAUNCH_ENABLED'
  | 'COMPLIANCE_UNSUPPORTED';

export interface GlobalCommercialEnablementResult {
  countryCode: string;
  numberType: string;
  providerSupported: boolean;
  complianceSupported: boolean;
  commerciallyConfigured: boolean;
  launchEnabled: boolean;
  status: CommercialEnablementStatus;
  customerMessage: string;
}

export interface CommercialMarginComparisonResult {
  countryCode: string;
  numberType: string;
  commercialSafetyState: CommercialSafetyState;
  
  // Retail Pricing (Server-Authoritative)
  retailPrice: ServerRetailPriceResult;
  
  // Provider Wholesale Cost (Internal Only)
  providerCost: {
    currency: string | null;
    currentPriceMinor: number | null;
    currentPriceFormatted: string | null;
  } | null;

  // Margin Calculations (Internal Only)
  expectedGrossMarginMinor: number | null;
  expectedGrossMarginFormatted: string | null;
  grossMarginPercentage: number | null;
  
  note: string;
}

/**
 * Internal Server-Only Commercial Comparison Service.
 * Evaluates provider wholesale cost vs configured customer retail price to derive gross margins & commercial safety states.
 * Strictly FOR INTERNAL ADMIN USE ONLY. NEVER EXPOSED TO NORMAL CLIENT BROWSER RESPONSES.
 */
export class CommercialPricingService {
  /**
   * Evaluates server-authoritative commercial enablement state for a country + number type context.
   */
  static async evaluateCommercialEnablement(
    countryCode: string,
    rawNumberType: string,
    options?: { complianceSupported?: boolean; providerSupported?: boolean }
  ): Promise<GlobalCommercialEnablementResult> {
    const cc = (countryCode || 'US').toUpperCase().trim();
    const type = normalizeNumberType(rawNumberType);

    const providerSupported = options?.providerSupported ?? true;
    const complianceSupported = options?.complianceSupported ?? true;

    // 1. Resolve Retail Pricing
    const retailPrice = await RetailPricingService.resolveRetailPrice(cc, type);
    const commerciallyConfigured = retailPrice.hasConfiguredPrice && retailPrice.monthlyPriceMinor !== null;

    // 2. Server-Authoritative Launch Enablement Check via DB
    let launchEnabled = false;
    try {
      const supabase = createAdminClient();
      const { data: launchData } = await (supabase as any)
        .from('marketplace_launch_enablements')
        .select('is_enabled')
        .eq('provider', 'twilio')
        .eq('country_code', cc)
        .eq('number_type', type)
        .eq('is_enabled', true)
        .maybeSingle();

      if (launchData && launchData.is_enabled) {
        launchEnabled = true;
      } else {
        // Fallback to explicit env CSV ONLY if configured (NO HARDCODED DEFAULT)
        const launchedEnv = process.env.MARKETPLACE_LAUNCHED_COUNTRIES;
        if (launchedEnv) {
          const launchedList = launchedEnv.split(',').map((c) => c.trim().toUpperCase());
          launchEnabled = launchedList.includes(cc);
        }
      }
    } catch (err: any) {
      console.warn('[CommercialPricingService] Error checking launch enablement:', err.message || err);
      launchEnabled = false;
    }

    let status: CommercialEnablementStatus = 'AVAILABLE';
    let customerMessage = 'This line category is available for purchase.';

    if (!complianceSupported) {
      status = 'COMPLIANCE_UNSUPPORTED';
      customerMessage = 'Regulatory compliance is currently unsupported for this country and number category.';
    } else if (!commerciallyConfigured) {
      status = 'NOT_COMMERCIALLY_CONFIGURED';
      customerMessage = 'Pricing unavailable. This number is not currently available for purchase.';
    } else if (!launchEnabled) {
      status = 'NOT_LAUNCH_ENABLED';
      customerMessage = 'Not currently available for purchase in this region.';
    }

    return {
      countryCode: cc,
      numberType: type,
      providerSupported,
      complianceSupported,
      commerciallyConfigured,
      launchEnabled,
      status,
      customerMessage,
    };
  }

  /**
   * Compares internal provider cost with configured customer retail price for a country and number category.
   */
  static async evaluateCommercialMargin(
    countryCode: string,
    numberType: string
  ): Promise<CommercialMarginComparisonResult> {
    const cc = (countryCode || 'US').toUpperCase();
    const type = (numberType || 'local').toLowerCase().trim();

    // 1. Resolve Server-Authoritative Customer Retail Price
    const retailPrice = await RetailPricingService.resolveRetailPrice(cc, type);

    // 2. Fetch Authoritative Provider Wholesale Cost
    const providerCostRes = await ProviderCostService.getProviderCost(cc);
    const matchingProviderPrice = providerCostRes.prices.find(
      (p) => p.numberType.toLowerCase() === type || (type === 'toll_free' && p.numberType.includes('toll'))
    );

    // If retail price is not configured
    if (!retailPrice.hasConfiguredPrice || retailPrice.monthlyPriceMinor === null) {
      return {
        countryCode: cc,
        numberType: type,
        commercialSafetyState: 'retail_not_configured',
        retailPrice,
        providerCost: matchingProviderPrice
          ? {
              currency: providerCostRes.currency,
              currentPriceMinor: matchingProviderPrice.currentPriceMinor,
              currentPriceFormatted: matchingProviderPrice.currentPriceFormatted,
            }
          : null,
        expectedGrossMarginMinor: null,
        expectedGrossMarginFormatted: null,
        grossMarginPercentage: null,
        note: 'Customer retail price is not configured in public.phone_number_retail_prices.',
      };
    }

    // If provider cost is unavailable
    if (!matchingProviderPrice || matchingProviderPrice.currentPriceMinor === null) {
      return {
        countryCode: cc,
        numberType: type,
        commercialSafetyState: 'provider_cost_unavailable',
        retailPrice,
        providerCost: null,
        expectedGrossMarginMinor: null,
        expectedGrossMarginFormatted: null,
        grossMarginPercentage: null,
        note: 'Twilio provider wholesale pricing unavailable for this country and number category.',
      };
    }

    // Check Currency Match
    const providerCurrency = providerCostRes.currency.toUpperCase();
    const retailCurrency = retailPrice.currency.toUpperCase();

    if (providerCurrency !== retailCurrency) {
      return {
        countryCode: cc,
        numberType: type,
        commercialSafetyState: 'currency_mismatch',
        retailPrice,
        providerCost: {
          currency: providerCurrency,
          currentPriceMinor: matchingProviderPrice.currentPriceMinor,
          currentPriceFormatted: matchingProviderPrice.currentPriceFormatted,
        },
        expectedGrossMarginMinor: null,
        expectedGrossMarginFormatted: null,
        grossMarginPercentage: null,
        note: `Currency mismatch: Provider cost is in ${providerCurrency} while customer retail price is in ${retailCurrency}. Cross-currency margin calculation requires explicit FX conversion.`,
      };
    }

    // Calculate Gross Margin
    const retailMinor = retailPrice.monthlyPriceMinor;
    const providerMinor = matchingProviderPrice.currentPriceMinor;
    const marginMinor = retailMinor - providerMinor;

    const marginMajor = marginMinor / 100;
    const marginFormatted = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: retailCurrency,
    }).format(marginMajor);

    let marginPct: number | null = null;
    if (retailMinor > 0) {
      marginPct = Number(((marginMinor / retailMinor) * 100).toFixed(2));
    }

    let commercialSafetyState: CommercialSafetyState = 'positive_margin';
    if (marginMinor < 0) {
      commercialSafetyState = 'negative_margin';
    } else if (marginMinor === 0) {
      commercialSafetyState = 'zero_margin';
    }

    return {
      countryCode: cc,
      numberType: type,
      commercialSafetyState,
      retailPrice,
      providerCost: {
        currency: providerCurrency,
        currentPriceMinor: providerMinor,
        currentPriceFormatted: matchingProviderPrice.currentPriceFormatted,
      },
      expectedGrossMarginMinor: marginMinor,
      expectedGrossMarginFormatted: marginFormatted,
      grossMarginPercentage: marginPct,
      note: `Evaluated commercial margin: ${marginFormatted} (${marginPct !== null ? `${marginPct}%` : 'N/A'}). State: ${commercialSafetyState}.`,
    };
  }
}
