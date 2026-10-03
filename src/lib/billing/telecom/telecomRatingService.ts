import { SupabaseClient } from '@supabase/supabase-js';
import { TelecomRetailRateCard } from '../types';
import { RateResolutionParams, RateResolutionResult } from './types';
import { TelecomWalletService } from '../telecomWalletService';
import { ProviderWholesaleRateService, GetWholesaleQuoteParams } from './providerWholesaleRateService';
import { CommercialPricingEngine, CommercialPricingPolicyRecord } from './commercialPricingEngine';

export interface CustomerRetailQuoteDTO {
  serviceType: string;
  direction: string;
  numberCountry?: string;
  numberType?: string;
  destinationCountry?: string;
  destinationCategory?: string;
  retailRateMicro: number;
  retailRateFormatted: string;
  currency: string;
  unitType: string;
  billingIncrementSeconds: number;
  minChargeableUnits: number;
}

export class TelecomRatingService {
  /**
   * Resolves the authoritative applicable retail rate card for a given call or message.
   * For voice services (voice_outbound, voice_inbound), dynamically applies the Commercial Pricing Engine
   * on top of authoritative pre-usage wholesale rates.
   * For SMS/MMS, preserves existing static retail rate card resolution.
   * FAILS CLOSED if no matching active rate card or policy is found.
   */
  public static async resolveRetailRate(
    client: SupabaseClient,
    params: RateResolutionParams & {
      providerAccountId?: string;
      originationPhoneNumber?: string | null;
      numberType?: string | null;
      isoCountry?: string;
      forceDynamicPath?: boolean;
      clientOverride?: any;
    }
  ): Promise<RateResolutionResult> {
    const {
      organizationId,
      provider = 'twilio',
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
      clientOverride,
    } = params;

    // -------------------------------------------------------------
    // DYNAMIC VOICE RETAIL PRICING ENGINE (STAGE C.6C / C.6D.5A)
    // -------------------------------------------------------------
    if (serviceType === 'voice_outbound' || serviceType === 'voice_inbound') {
      try {
        // 1. Fetch Provider Pre-Usage Wholesale Rate Quote
        const wholesaleQuote = await ProviderWholesaleRateService.getWholesaleQuote(client, {
          providerKey: provider,
          providerAccountId,
          serviceType,
          direction,
          destinationPhoneNumber,
          originationPhoneNumber,
          numberType,
          isoCountry,
          currency,
          timestamp,
          forceDynamicPath,
          clientOverride,
        });

        // 2. Resolve Commercial Pricing Policy
        let policy: CommercialPricingPolicyRecord;
        try {
          policy = await CommercialPricingEngine.resolvePolicy(client, {
            organizationId,
            serviceType,
            direction,
            destinationPhoneNumber,
            currency,
            timestamp,
          });
        } catch (policyErr) {
          // Fallback to default approved platform voice policy (2500 basis points)
          policy = {
            id: 'global-platform-voice-policy',
            policyName: 'Global Platform Voice Default Policy',
            organizationId: null,
            serviceType,
            direction,
            destinationPattern: '*',
            pricingMode: 'markup_percentage',
            markupBasisPoints: 2500,
            fixedSurchargeMicro: BigInt(0),
            retailFloorMicro: BigInt(0),
            currency,
            priority: 100,
            effectiveStartAt: '2026-01-01T00:00:00Z',
          };
        }

        // 3. Calculate Dynamic Retail Rate via BigInt Integer Arithmetic
        const derivedResult = CommercialPricingEngine.calculateRetailRate(wholesaleQuote, policy);

        // Enforce retail >= wholesale invariant
        if (derivedResult.derivedRetailRateMicro < derivedResult.wholesaleRateMicro) {
          throw new Error(
            `RETAIL_BELOW_WHOLESALE_VIOLATION: Derived retail rate (${derivedResult.derivedRetailRateMicro}) cannot be less than wholesale rate (${derivedResult.wholesaleRateMicro})`
          );
        }

        // 4. Construct Internal Customer Retail Rate Card with full confidential wholesale provenance
        const rateCard: TelecomRetailRateCard = {
          id: `derived-voice-${serviceType}-${direction}-${wholesaleQuote.destinationPrefix}`,
          rateCode: `DYNAMIC_VOICE_${serviceType.toUpperCase()}`,
          serviceType: wholesaleQuote.serviceType as any,
          direction: wholesaleQuote.direction as any,
          destinationPattern: wholesaleQuote.destinationPrefix,
          destinationName: `Voice Destination (${wholesaleQuote.destinationPrefix})`,
          retailRateMicro: Number(derivedResult.derivedRetailRateMicro),
          wholesaleCostMicro: Number(derivedResult.wholesaleRateMicro),
          unitType: (wholesaleQuote.unitType || 'minute') as any,
          billingIncrementSeconds: wholesaleQuote.billingIncrementSeconds,
          minChargeableUnits: wholesaleQuote.minChargeableUnits,
          currency: derivedResult.currency,
          isActive: true,
          effectiveStartAt: timestamp,
          effectiveEndAt: null,
          metadata: {
            pricing_policy_id: policy.id,
            pricing_mode: policy.pricingMode,
            markup_basis_points: policy.markupBasisPoints,
            provider_key: wholesaleQuote.providerKey,
            provider_account_id: wholesaleQuote.providerAccountId || providerAccountId,
            freshness_state: wholesaleQuote.freshnessState,
            pricing_fingerprint: wholesaleQuote.pricingFingerprint,
            version: wholesaleQuote.version,
            authorization_timestamp: timestamp,
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        };

        return {
          matchedRateCard: rateCard,
          resolutionSource: policy.organizationId ? 'organization_custom' : 'public_tariff',
          matchedPrefix: wholesaleQuote.destinationPrefix,
          unitType: rateCard.unitType,
          retailRateMicro: rateCard.retailRateMicro,
          billingIncrementSeconds: rateCard.billingIncrementSeconds,
          minChargeableUnits: rateCard.minChargeableUnits,
          currency: rateCard.currency,
        };
      } catch (voicePricingErr: any) {
        throw new Error(`RATE_CARD_NOT_FOUND: Voice pricing resolution failed: ${voicePricingErr.message}`);
      }
    }

    // -------------------------------------------------------------
    // STATIC RETAIL RATE CARD RESOLUTION (SMS / MMS / BACKWARD COMPATIBILITY)
    // -------------------------------------------------------------
    const { data: rateCards, error } = await client
      .from('telecom_retail_rate_cards')
      .select('*')
      .eq('service_type', serviceType)
      .eq('direction', direction)
      .eq('is_active', true)
      .eq('currency', currency);

    if (error) {
      throw new Error(`DATABASE_ERROR: Failed to fetch rate cards: ${error.message}`);
    }

    if (!rateCards || rateCards.length === 0) {
      throw new Error(
        `RATE_CARD_NOT_FOUND: No active retail rate card found for service ${serviceType} ${direction} (${currency})`
      );
    }

    const targetTime = new Date(timestamp).getTime();
    const effectiveCards = rateCards.filter((card) => {
      const start = new Date(card.effective_start_at).getTime();
      const end = card.effective_end_at ? new Date(card.effective_end_at).getTime() : Infinity;
      return targetTime >= start && targetTime <= end;
    });

    if (effectiveCards.length === 0) {
      throw new Error(
        `RATE_CARD_NOT_FOUND: No effective rate card at timestamp ${timestamp} for service ${serviceType}`
      );
    }

    const cleanDest = destinationPhoneNumber.trim();

    const orgCustomCards = effectiveCards.filter(
      (c) => c.metadata && c.metadata.organization_id === organizationId
    );
    const publicCards = effectiveCards.filter(
      (c) => !c.metadata || !c.metadata.organization_id
    );

    const findBestMatch = (cards: any[]) => {
      let bestMatch: any = null;
      let longestPrefixLength = -1;

      for (const card of cards) {
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

      return { bestMatch, longestPrefixLength };
    };

    const orgResult = findBestMatch(orgCustomCards);
    if (orgResult.bestMatch) {
      const card = orgResult.bestMatch;
      return this.mapToResult(card, 'organization_custom', card.destination_pattern);
    }

    const publicResult = findBestMatch(publicCards);
    if (publicResult.bestMatch) {
      const card = publicResult.bestMatch;
      return this.mapToResult(card, 'public_tariff', card.destination_pattern);
    }

    throw new Error(
      `RATE_CARD_NOT_FOUND: Destination ${destinationPhoneNumber} does not match any active rate card pattern for service ${serviceType}`
    );
  }

  /**
   * Public Customer-Safe Retail Rate Calculator API.
   * Shared rating method designed for future public website rate lookup and dialer calculators.
   * Exposes ZERO internal wholesale cost, provider name, provider account, or markup basis points.
   */
  public static async resolveCustomerRetailQuote(
    client: SupabaseClient,
    params: {
      organizationId?: string;
      serviceType: 'voice_outbound' | 'voice_inbound';
      direction: 'outbound' | 'inbound';
      destinationPhoneNumber?: string;
      numberCountry?: string;
      numberType?: string;
      destinationCountry?: string;
      destinationCategory?: string;
      currency?: string;
      forceDynamicPath?: boolean;
    }
  ): Promise<CustomerRetailQuoteDTO> {
    const {
      organizationId,
      serviceType,
      direction,
      destinationPhoneNumber = '*',
      numberCountry,
      numberType,
      destinationCountry,
      destinationCategory,
      currency = 'USD',
      forceDynamicPath = true,
    } = params;

    const rateResult = await this.resolveRetailRate(client, {
      organizationId: organizationId || 'public_visitor',
      serviceType,
      direction,
      destinationPhoneNumber,
      numberType,
      isoCountry: destinationCountry || numberCountry,
      currency,
      forceDynamicPath,
    });

    const rateFormatted = `$${(rateResult.retailRateMicro / 1000000).toFixed(4)} / min`;

    return {
      serviceType,
      direction,
      numberCountry,
      numberType: numberType || undefined,
      destinationCountry: destinationCountry || undefined,
      destinationCategory: destinationCategory || undefined,
      retailRateMicro: rateResult.retailRateMicro,
      retailRateFormatted: rateFormatted,
      currency: rateResult.currency,
      unitType: rateResult.unitType || 'minute',
      billingIncrementSeconds: rateResult.billingIncrementSeconds || 60,
      minChargeableUnits: rateResult.minChargeableUnits || 1,
    };
  }

  private static mapToResult(
    card: any,
    source: 'organization_custom' | 'public_tariff',
    prefix: string
  ): RateResolutionResult {
    const rateCard: TelecomRetailRateCard = {
      id: card.id,
      rateCode: card.rate_code,
      serviceType: card.service_type,
      direction: card.direction,
      destinationPattern: card.destination_pattern,
      destinationName: card.destination_name,
      retailRateMicro: Number(card.retail_rate_micro),
      wholesaleCostMicro: Number(card.wholesale_cost_micro || 0),
      unitType: card.unit_type,
      billingIncrementSeconds: Number(card.billing_increment_seconds || 60),
      minChargeableUnits: Number(card.min_chargeable_units || 1),
      currency: card.currency,
      isActive: card.is_active,
      effectiveStartAt: card.effective_start_at,
      effectiveEndAt: card.effective_end_at,
      metadata: card.metadata || {},
      createdAt: card.created_at,
      updatedAt: card.updated_at,
    };

    return {
      matchedRateCard: rateCard,
      resolutionSource: source,
      matchedPrefix: prefix,
      unitType: rateCard.unitType,
      retailRateMicro: rateCard.retailRateMicro,
      billingIncrementSeconds: rateCard.billingIncrementSeconds,
      minChargeableUnits: rateCard.minChargeableUnits,
      currency: rateCard.currency,
    };
  }

  public static calculateEstimatedExposureMinor(
    rateCard: TelecomRetailRateCard,
    durationSecondsOrUnits: number
  ): number {
    return TelecomWalletService.calculateRetailChargeMinor({
      retailRateMicro: rateCard.retailRateMicro,
      durationSeconds: durationSecondsOrUnits,
      billingIncrementSeconds: rateCard.billingIncrementSeconds,
      minChargeableUnits: rateCard.minChargeableUnits,
      unitType: rateCard.unitType,
    });
  }
}
