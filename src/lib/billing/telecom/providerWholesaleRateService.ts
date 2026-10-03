import { SupabaseClient } from '@supabase/supabase-js';

export interface NormalizedWholesaleQuote {
  providerKey: string;
  serviceType: string;
  direction: string;
  destinationPrefix: string;
  wholesaleRateMicro: bigint;
  currency: string;
  unitType: string;
  billingIncrementSeconds: number;
  minChargeableUnits: number;
  effectiveAt: string;
}

export interface GetWholesaleQuoteParams {
  providerKey?: string;
  serviceType: string;
  direction: string;
  destinationPhoneNumber: string;
  currency?: string;
  timestamp?: string;
}

export class ProviderWholesaleRateService {
  /**
   * Resolves the authoritative pre-usage provider wholesale rate quote for a call or message attempt.
   * Internal confidential provider abstraction layer.
   */
  public static async getWholesaleQuote(
    client: SupabaseClient,
    params: GetWholesaleQuoteParams
  ): Promise<NormalizedWholesaleQuote> {
    const {
      providerKey = 'twilio',
      serviceType,
      direction,
      destinationPhoneNumber,
      currency = 'USD',
      timestamp = new Date().toISOString(),
    } = params;

    const cleanDest = (destinationPhoneNumber || '*').trim();
    const cleanCurrency = (currency || 'USD').toUpperCase();

    // Query rate cards table for pre-usage wholesale cost
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

    // Reject invalid negative pre-usage wholesale rates
    if (wholesaleCostMicroRaw < BigInt(0)) {
      throw new Error(`INVALID_WHOLESALE_RATE: Pre-usage wholesale rate cannot be negative (${wholesaleCostMicroRaw})`);
    }

    return {
      providerKey: providerKey.toLowerCase().trim(),
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
