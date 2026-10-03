import { SupabaseClient } from '@supabase/supabase-js';
import { ProviderWholesaleCacheResolver } from './providerWholesaleCacheResolver';
import { TwilioExactNumberFallback } from './providers/twilioExactNumberFallback';

export interface NormalizedWholesaleQuote {
  providerKey: string;
  providerAccountId?: string;
  serviceType: string;
  direction: string;
  destinationPrefix: string;
  originationPrefix?: string;
  numberType?: string | null;
  wholesaleRateMicro: bigint;
  basePriceMicro?: bigint | null;
  currency: string;
  unitType: string;
  billingIncrementSeconds: number;
  minChargeableUnits: number;
  effectiveAt: string;
  freshnessState?: 'FRESH' | 'SOFT_STALE' | 'EXPIRED' | 'MISSING' | 'AMBIGUOUS' | 'INVALID';
  pricingFingerprint?: string;
  version?: number;
}

export interface GetWholesaleQuoteParams {
  providerKey?: string;
  providerAccountId?: string;
  serviceType: string;
  direction: string;
  destinationPhoneNumber: string;
  originationPhoneNumber?: string | null;
  numberType?: string | null;
  isoCountry?: string;
  currency?: string;
  timestamp?: string;
  forceDynamicPath?: boolean;
  skipCacheIngestion?: boolean;
  clientOverride?: any; // For unit test mocking of Twilio API
}

export class ProviderWholesaleRateService {
  /**
   * Checks server-side feature flag for dynamic voice pricing integration.
   */
  public static isDynamicVoicePricingEnabled(): boolean {
    return process.env.TELECOM_DYNAMIC_VOICE_PRICING_ENABLED === 'true';
  }

  /**
   * Resolves the authoritative pre-usage provider wholesale rate quote for a call or message attempt.
   * Internal confidential provider abstraction layer.
   *
   * When dynamic path is active (TELECOM_DYNAMIC_VOICE_PRICING_ENABLED=true or forceDynamicPath=true):
   * - Resolves dynamic wholesale cache via ProviderWholesaleCacheResolver.
   * - Performs exact-number/country provider fallback if cache is EXPIRED or MISSING.
   * - FAILS CLOSED if authoritative pricing cannot be established. NEVER falls back to static rate cards!
   *
   * When legacy path is active (TELECOM_DYNAMIC_VOICE_PRICING_ENABLED=false):
   * - Resolves static wholesale_cost_micro from telecom_retail_rate_cards table.
   */
  public static async getWholesaleQuote(
    client: SupabaseClient,
    params: GetWholesaleQuoteParams
  ): Promise<NormalizedWholesaleQuote> {
    const {
      providerKey = 'twilio',
      providerAccountId = 'default',
      serviceType,
      direction,
      destinationPhoneNumber,
      originationPhoneNumber = null,
      numberType = null,
      isoCountry,
      currency = 'USD',
      timestamp = new Date().toISOString(),
      forceDynamicPath = false,
      skipCacheIngestion = false,
      clientOverride,
    } = params;

    const useDynamicPath = ProviderWholesaleRateService.isDynamicVoicePricingEnabled() || forceDynamicPath;
    const cleanDest = (destinationPhoneNumber || '*').trim();
    const cleanCurrency = (currency || 'USD').toUpperCase().trim();
    const cleanAccountId = (providerAccountId || 'default').trim();
    const cleanProviderKey = (providerKey || 'twilio').toLowerCase().trim();

    // -------------------------------------------------------------
    // DYNAMIC VOICE PRICING PATH (STAGE C.6D.5A)
    // -------------------------------------------------------------
    if (useDynamicPath && (serviceType === 'voice_outbound' || serviceType === 'voice_inbound')) {
      try {
        // Step 1: Attempt dynamic wholesale cache resolution
        const cacheQuote = await ProviderWholesaleCacheResolver.resolveWholesaleQuote(client, {
          providerKey: cleanProviderKey,
          providerAccountId: cleanAccountId,
          serviceType: serviceType as any,
          direction: direction as any,
          destinationPhoneNumber: cleanDest,
          originationPhoneNumber,
          numberType: numberType as any,
          isoCountry,
          currency: cleanCurrency,
          timestamp,
        });

        if (cacheQuote.freshnessState === 'SOFT_STALE') {
          console.warn(
            `[ProviderWholesaleRateService] Wholesale quote for ${cleanDest} is SOFT_STALE. Serving quote and recording durable refresh signal.`
          );
        }

        return {
          providerKey: cacheQuote.providerKey,
          providerAccountId: cacheQuote.providerAccountId || undefined,
          serviceType: cacheQuote.serviceType,
          direction: cacheQuote.direction,
          destinationPrefix: cacheQuote.destinationPrefix,
          originationPrefix: cacheQuote.originationPrefix || undefined,
          numberType: cacheQuote.numberType,
          wholesaleRateMicro: cacheQuote.wholesaleRateMicro,
          basePriceMicro: cacheQuote.basePriceMicro,
          currency: cacheQuote.currency,
          unitType: cacheQuote.priceUnit || 'minute',
          billingIncrementSeconds: cacheQuote.billingIncrementSeconds,
          minChargeableUnits: cacheQuote.minChargeableUnits,
          effectiveAt: timestamp,
          freshnessState: cacheQuote.freshnessState,
          pricingFingerprint: cacheQuote.pricingFingerprint,
          version: cacheQuote.version,
        };
      } catch (cacheErr: any) {
        const errMsg = cacheErr.message || '';
        console.warn(`[ProviderWholesaleRateService] Dynamic cache resolution notice: ${errMsg}`);

        // If cache is AMBIGUOUS or INVALID -> FAIL CLOSED immediately
        if (errMsg.includes('AMBIGUOUS') || errMsg.includes('INVALID')) {
          throw new Error(`DYNAMIC_WHOLESALE_PRICING_UNAVAILABLE: ${errMsg}`);
        }

        // Step 2: Fallback to READ-ONLY Twilio Pricing API if cache is EXPIRED or MISSING
        if (serviceType === 'voice_outbound') {
          const fallbackRes = await TwilioExactNumberFallback.fetchExactNumberPricing(cleanDest, { clientOverride });
          if (fallbackRes.success && fallbackRes.currentPriceMicro >= BigInt(0)) {
            // Persist exact-number fallback quote via atomic RPC if database client is available & ingestion is enabled
            if (!skipCacheIngestion) {
              try {
                await (client as any).rpc('upsert_provider_voice_pricing_record_atomic', {
                  p_provider_account_id: cleanAccountId,
                  p_provider_key: cleanProviderKey,
                  p_service_type: 'voice_outbound',
                  p_direction: 'outbound',
                  p_iso_country: fallbackRes.isoCountry,
                  p_destination_prefix: cleanDest,
                  p_origination_prefix: '*',
                  p_number_type: null,
                  p_currency: fallbackRes.currency,
                  p_current_price_micro: fallbackRes.currentPriceMicro.toString(),
                  p_base_price_micro: fallbackRes.basePriceMicro ? fallbackRes.basePriceMicro.toString() : null,
                  p_price_unit: fallbackRes.priceUnit,
                  p_fetched_at: timestamp,
                  p_soft_stale_at: new Date(Date.now() + 86400000).toISOString(),
                  p_hard_expires_at: new Date(Date.now() + 172800000).toISOString(),
                  p_source_api_version: fallbackRes.sourceApiVersion,
                  p_pricing_fingerprint: `exact_fallback:${cleanDest}:${fallbackRes.currentPriceMicro}`,
                });
              } catch (ingestErr: any) {
                console.warn('[ProviderWholesaleRateService] Fallback quote ingestion warning:', ingestErr.message);
              }
            }

            return {
              providerKey: cleanProviderKey,
              providerAccountId: cleanAccountId,
              serviceType: 'voice_outbound',
              direction: 'outbound',
              destinationPrefix: cleanDest,
              originationPrefix: '*',
              numberType: null,
              wholesaleRateMicro: fallbackRes.currentPriceMicro,
              basePriceMicro: fallbackRes.basePriceMicro,
              currency: fallbackRes.currency,
              unitType: fallbackRes.priceUnit || 'minute',
              billingIncrementSeconds: 60,
              minChargeableUnits: 1,
              effectiveAt: timestamp,
              freshnessState: 'FRESH',
              pricingFingerprint: `exact_fallback:${cleanDest}:${fallbackRes.currentPriceMicro}`,
            };
          }
        } else if (serviceType === 'voice_inbound') {
          const derivedCountry = isoCountry || ProviderWholesaleCacheResolver.deriveIsoCountryFromPhoneNumber(cleanDest);
          const countryInboundRes = await TwilioExactNumberFallback.fetchCountryInboundPricing(derivedCountry, { clientOverride });
          if (countryInboundRes.success && countryInboundRes.inboundCallPrices.length > 0) {
            const cleanType = (numberType || 'any').toLowerCase().trim();
            const matched = countryInboundRes.inboundCallPrices.find((p) => p.numberType === cleanType) || countryInboundRes.inboundCallPrices[0];
            if (matched && matched.currentPriceMicro >= BigInt(0)) {
              return {
                providerKey: cleanProviderKey,
                providerAccountId: cleanAccountId,
                serviceType: 'voice_inbound',
                direction: 'inbound',
                destinationPrefix: '*',
                originationPrefix: '*',
                numberType: matched.numberType,
                wholesaleRateMicro: matched.currentPriceMicro,
                basePriceMicro: matched.basePriceMicro,
                currency: matched.currency,
                unitType: 'minute',
                billingIncrementSeconds: 60,
                minChargeableUnits: 1,
                effectiveAt: timestamp,
                freshnessState: 'FRESH',
              };
            }
          }
        }

        // FAIL CLOSED: Dynamic path does NOT fall back to static rate cards!
        throw new Error(
          `DYNAMIC_WHOLESALE_PRICING_UNAVAILABLE: Authoritative dynamic wholesale pricing is unavailable for ${cleanProviderKey}/${cleanAccountId} ${serviceType} ${cleanDest}`
        );
      }
    }

    // -------------------------------------------------------------
    // LEGACY STATIC WHOLESALE RATE CARD RESOLUTION
    // -------------------------------------------------------------
    const { data: rateCards, error } = await client
      .from('telecom_retail_rate_cards')
      .select('*')
      .eq('service_type', serviceType)
      .eq('direction', direction)
      .eq('is_active', true)
      .eq('currency', cleanCurrency);

    if (error) {
      throw new Error(`WHOLESALE_RATE_ERROR: Failed to fetch rate cards for wholesale quote: ${error.message}`);
    }

    if (!rateCards || rateCards.length === 0) {
      throw new Error(`WHOLESALE_RATE_NOT_FOUND: No active rate card for service ${serviceType} ${direction} (${cleanCurrency})`);
    }

    // Filter by effective date window
    const targetTime = new Date(timestamp).getTime();
    const effectiveCards = rateCards.filter((card) => {
      const start = new Date(card.effective_start_at).getTime();
      const end = card.effective_end_at ? new Date(card.effective_end_at).getTime() : Infinity;
      return targetTime >= start && targetTime <= end;
    });

    if (effectiveCards.length === 0) {
      throw new Error(`WHOLESALE_RATE_NOT_FOUND: No effective rate card at timestamp ${timestamp} for service ${serviceType}`);
    }

    // Perform longest prefix match for wholesale rate
    let bestMatch: any = null;
    let longestPrefixLength = -1;

    for (const card of effectiveCards) {
      const pattern = (card.destination_pattern || '*').trim();
      if (pattern === '*') {
        if (longestPrefixLength < 0) {
          bestMatch = card;
          longestPrefixLength = 0;
        }
      } else if (cleanDest.startsWith(pattern)) {
        if (pattern.length > longestPrefixLength) {
          bestMatch = card;
          longestPrefixLength = pattern.length;
        }
      }
    }

    if (!bestMatch) {
      throw new Error(`WHOLESALE_RATE_NOT_FOUND: Destination ${destinationPhoneNumber} does not match any rate card pattern for service ${serviceType}`);
    }

    const wholesaleCostMicroRaw = BigInt(bestMatch.wholesale_cost_micro || 0);

    if (wholesaleCostMicroRaw < BigInt(0)) {
      throw new Error(`INVALID_WHOLESALE_RATE: Pre-usage wholesale rate cannot be negative (${wholesaleCostMicroRaw})`);
    }

    return {
      providerKey: cleanProviderKey,
      providerAccountId: cleanAccountId,
      serviceType: bestMatch.service_type,
      direction: bestMatch.direction,
      destinationPrefix: bestMatch.destination_pattern,
      wholesaleRateMicro: wholesaleCostMicroRaw,
      currency: bestMatch.currency,
      unitType: bestMatch.unit_type,
      billingIncrementSeconds: Number(bestMatch.billing_increment_seconds || 60),
      minChargeableUnits: Number(bestMatch.min_chargeable_units || 1),
      effectiveAt: timestamp,
    };
  }
}
