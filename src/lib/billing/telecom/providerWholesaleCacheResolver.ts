import { SupabaseClient } from '@supabase/supabase-js';
import { NormalizedWholesaleQuote, GetWholesaleQuoteParams, FreshnessState } from './providers/providerPricingInterface';
import { FreshnessPolicy, FreshnessPolicyConfig } from './freshnessPolicy';

export class ProviderWholesaleCacheResolver {
  /**
   * Resolves authoritative provider wholesale quote from durable local cache.
   * Enforces exact prefix matching, origination context resolution, currency checks,
   * freshness evaluation, and strict fail-closed security.
   */
  public static async resolveWholesaleQuote(
    client: SupabaseClient,
    params: GetWholesaleQuoteParams & { freshnessConfigOverrides?: Partial<FreshnessPolicyConfig> }
  ): Promise<NormalizedWholesaleQuote> {
    const {
      providerKey = 'twilio',
      providerAccountId = 'default',
      serviceType,
      direction,
      destinationPhoneNumber = '*',
      originationPhoneNumber = null,
      isoCountry: rawIsoCountry,
      numberType: rawNumberType = null,
      currency = 'USD',
      timestamp = new Date().toISOString(),
      freshnessConfigOverrides,
    } = params;

    const cleanDest = destinationPhoneNumber.trim();
    const cleanOrig = originationPhoneNumber ? originationPhoneNumber.trim() : null;
    const cleanCurrency = currency.toUpperCase().trim();
    const cleanAccountId = (providerAccountId || 'default').trim();
    const cleanProviderKey = providerKey.toLowerCase().trim();

    // 1. Derive ISO Country if missing
    let isoCountry = rawIsoCountry ? rawIsoCountry.toUpperCase().trim() : '';
    if (!isoCountry) {
      isoCountry = ProviderWholesaleCacheResolver.deriveIsoCountryFromPhoneNumber(cleanDest);
    }

    if (!isoCountry) {
      throw new Error(`INVALID_COUNTRY: Unable to derive ISO country for destination '${destinationPhoneNumber}'`);
    }

    // -------------------------------------------------------------
    // OUTBOUND VOICE CACHE RESOLUTION
    // -------------------------------------------------------------
    if (serviceType === 'voice_outbound') {
      const { data: cachedRows, error } = await client
        .from('provider_voice_pricing_cache')
        .select('*')
        .eq('provider_account_id', cleanAccountId)
        .eq('provider_key', cleanProviderKey)
        .eq('service_type', 'voice_outbound')
        .eq('direction', 'outbound')
        .eq('currency', cleanCurrency)
        .eq('iso_country', isoCountry)
        .eq('is_active', true);

      if (error) {
        throw new Error(`CACHE_QUERY_ERROR: Failed to query provider voice pricing cache: ${error.message}`);
      }

      if (!cachedRows || cachedRows.length === 0) {
        throw new Error(
          `WHOLESALE_RATE_NOT_FOUND: No active wholesale rate cached for ${cleanProviderKey}/${cleanAccountId} (${isoCountry} voice_outbound ${cleanCurrency})`
        );
      }

      // Filter by longest destination prefix match
      const destDigits = cleanDest.replace(/^\+/, '');
      let bestDestLength = -1;
      let destCandidates: any[] = [];

      for (const row of cachedRows) {
        const rawPattern = (row.destination_prefix || '*').trim();
        const patternDigits = rawPattern.replace(/^\+/, '');

        if (rawPattern === '*') {
          if (bestDestLength < 0) {
            bestDestLength = 0;
            destCandidates = [row];
          } else if (bestDestLength === 0) {
            destCandidates.push(row);
          }
        } else if (destDigits.startsWith(patternDigits)) {
          if (patternDigits.length > bestDestLength) {
            bestDestLength = patternDigits.length;
            destCandidates = [row];
          } else if (patternDigits.length === bestDestLength) {
            destCandidates.push(row);
          }
        }
      }

      if (destCandidates.length === 0) {
        throw new Error(`WHOLESALE_RATE_NOT_FOUND: Destination ${cleanDest} does not match any cached wholesale prefix for ${isoCountry}`);
      }

      // Origination context filtering
      let matchedRecord: any = null;
      if (destCandidates.length === 1) {
        matchedRecord = destCandidates[0];
      } else {
        // Multiple candidates exist for the same longest destination prefix (e.g. distinct origination rules)
        const origMatches: any[] = [];
        const origDigits = cleanOrig ? cleanOrig.replace(/^\+/, '') : '';
        for (const candidate of destCandidates) {
          const origPattern = (candidate.origination_prefix || '*').trim();
          const origPatternDigits = origPattern.replace(/^\+/, '');
          if (origPattern === '*' || (origDigits && origDigits.startsWith(origPatternDigits))) {
            origMatches.push(candidate);
          }
        }

        if (origMatches.length === 1) {
          matchedRecord = origMatches[0];
        } else if (origMatches.length > 1) {
          // Check if all origination matches yield identical current_price_micro
          const firstPrice = BigInt(origMatches[0].current_price_micro);
          const allIdentical = origMatches.every((c) => BigInt(c.current_price_micro) === firstPrice);
          if (allIdentical) {
            matchedRecord = origMatches[0];
          } else {
            // Ambiguous origination pricing -> FAIL CLOSED!
            throw new Error(
              `AMBIGUOUS_WHOLESALE_PRICING: Destination ${cleanDest} matched multiple conflicting origination pricing rules for country ${isoCountry}`
            );
          }
        } else {
          throw new Error(
            `AMBIGUOUS_WHOLESALE_PRICING: Destination ${cleanDest} requires origination context to disambiguate ${destCandidates.length} applicable provider pricing rules (${cleanOrig || 'unknown origination'})`
          );
        }
      }

      // Freshness Evaluation
      const freshnessState = FreshnessPolicy.evaluateState(
        matchedRecord.soft_stale_at,
        matchedRecord.hard_expires_at,
        timestamp
      );

      if (freshnessState === 'EXPIRED') {
        throw new Error(
          `EXPIRED_WHOLESALE_PRICING: Cached wholesale price for ${cleanDest} hard expired at ${matchedRecord.hard_expires_at}`
        );
      }

      const currentPriceMicro = BigInt(matchedRecord.current_price_micro);
      const basePriceMicro = matchedRecord.base_price_micro !== null ? BigInt(matchedRecord.base_price_micro) : null;

      return {
        providerKey: cleanProviderKey,
        providerAccountId: cleanAccountId,
        serviceType: 'voice_outbound',
        direction: 'outbound',
        isoCountry: matchedRecord.iso_country,
        destinationPrefix: matchedRecord.destination_prefix,
        originationPrefix: matchedRecord.origination_prefix,
        numberType: null,
        currency: matchedRecord.currency,
        currentPriceMicro,
        wholesaleRateMicro: currentPriceMicro,
        basePriceMicro,
        priceUnit: matchedRecord.price_unit,
        billingIncrementSeconds: Number(matchedRecord.billing_increment_seconds || 60),
        minChargeableUnits: Number(matchedRecord.min_chargeable_units || 1),
        fetchedAt: matchedRecord.fetched_at,
        softStaleAt: matchedRecord.soft_stale_at,
        hardExpiresAt: matchedRecord.hard_expires_at,
        freshnessState,
        sourceApiVersion: matchedRecord.source_api_version || 'v2',
        pricingFingerprint: matchedRecord.pricing_fingerprint,
        version: Number(matchedRecord.version || 1),
        isZero: currentPriceMicro === BigInt(0),
      };
    }

    // -------------------------------------------------------------
    // INBOUND VOICE CACHE RESOLUTION
    // -------------------------------------------------------------
    const targetType = rawNumberType || 'any';
    const { data: inboundRows, error: inboundErr } = await client
      .from('provider_voice_pricing_cache')
      .select('*')
      .eq('provider_account_id', cleanAccountId)
      .eq('provider_key', cleanProviderKey)
      .eq('service_type', 'voice_inbound')
      .eq('direction', 'inbound')
      .eq('currency', cleanCurrency)
      .eq('iso_country', isoCountry)
      .eq('is_active', true);

    if (inboundErr) {
      throw new Error(`CACHE_QUERY_ERROR: Failed to query inbound voice pricing cache: ${inboundErr.message}`);
    }

    if (!inboundRows || inboundRows.length === 0) {
      throw new Error(
        `WHOLESALE_RATE_NOT_FOUND: No active inbound wholesale rate cached for ${cleanProviderKey}/${cleanAccountId} (${isoCountry} voice_inbound ${cleanCurrency})`
      );
    }

    // Match exact number_type or fallback to 'any'
    let matchedInbound = inboundRows.find((r) => (r.number_type || 'any') === targetType);
    if (!matchedInbound) {
      matchedInbound = inboundRows.find((r) => (r.number_type || 'any') === 'any' || (r.number_type || 'any') === 'local');
    }

    if (!matchedInbound) {
      throw new Error(`WHOLESALE_RATE_NOT_FOUND: No inbound wholesale rate found for number type '${targetType}' in country ${isoCountry}`);
    }

    const inboundFreshnessState = FreshnessPolicy.evaluateState(
      matchedInbound.soft_stale_at,
      matchedInbound.hard_expires_at,
      timestamp
    );

    if (inboundFreshnessState === 'EXPIRED') {
      throw new Error(`EXPIRED_WHOLESALE_PRICING: Inbound wholesale price hard expired at ${matchedInbound.hard_expires_at}`);
    }

    const currentPriceMicro = BigInt(matchedInbound.current_price_micro);
    const basePriceMicro = matchedInbound.base_price_micro !== null ? BigInt(matchedInbound.base_price_micro) : null;

    return {
      providerKey: cleanProviderKey,
      providerAccountId: cleanAccountId,
      serviceType: 'voice_inbound',
      direction: 'inbound',
      isoCountry: matchedInbound.iso_country,
      destinationPrefix: '*',
      originationPrefix: '*',
      numberType: matchedInbound.number_type,
      currency: matchedInbound.currency,
      currentPriceMicro,
      wholesaleRateMicro: currentPriceMicro,
      basePriceMicro,
      priceUnit: matchedInbound.price_unit,
      billingIncrementSeconds: Number(matchedInbound.billing_increment_seconds || 60),
      minChargeableUnits: Number(matchedInbound.min_chargeable_units || 1),
      fetchedAt: matchedInbound.fetched_at,
      softStaleAt: matchedInbound.soft_stale_at,
      hardExpiresAt: matchedInbound.hard_expires_at,
      freshnessState: inboundFreshnessState,
      sourceApiVersion: matchedInbound.source_api_version || 'v2',
      pricingFingerprint: matchedInbound.pricing_fingerprint,
      version: Number(matchedInbound.version || 1),
      isZero: currentPriceMicro === BigInt(0),
    };
  }

  /**
   * E.164 phone number prefix parser to derive ISO country code without external runtime dependencies.
   */
  public static deriveIsoCountryFromPhoneNumber(phoneNumber: string): string {
    const clean = (phoneNumber || '').trim().replace(/[^\d+]/g, '');
    if (clean.startsWith('+1')) return 'US';
    if (clean.startsWith('+61')) return 'AU';
    if (clean.startsWith('+44')) return 'GB';
    if (clean.startsWith('+91')) return 'IN';
    if (clean.startsWith('+33')) return 'FR';
    if (clean.startsWith('+49')) return 'DE';
    if (clean.startsWith('+81')) return 'JP';
    if (clean.startsWith('+55')) return 'BR';
    if (clean.startsWith('+52')) return 'MX';
    return 'US'; // Default fallback
  }
}
