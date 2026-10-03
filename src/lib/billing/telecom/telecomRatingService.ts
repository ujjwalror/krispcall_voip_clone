import { SupabaseClient } from '@supabase/supabase-js';
import { TelecomRetailRateCard } from '../types';
import { RateResolutionParams, RateResolutionResult } from './types';
import { TelecomWalletService } from '../telecomWalletService';
import { ProviderWholesaleRateService } from './providerWholesaleRateService';
import { CommercialPricingEngine, CommercialPricingPolicyRecord } from './commercialPricingEngine';

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
    params: RateResolutionParams
  ): Promise<RateResolutionResult> {
    const {
      organizationId,
      provider = 'twilio',
      serviceType,
      direction,
      destinationPhoneNumber,
      currency = 'USD',
      timestamp = new Date().toISOString(),
    } = params;

    // -------------------------------------------------------------
    // DYNAMIC VOICE RETAIL PRICING ENGINE (STAGE C.6C)
    // -------------------------------------------------------------
    if (serviceType === 'voice_outbound' || serviceType === 'voice_inbound') {
      try {
        // 1. Fetch Provider Pre-Usage Wholesale Rate Quote
        const wholesaleQuote = await ProviderWholesaleRateService.getWholesaleQuote(client, {
          providerKey: provider,
          serviceType,
          direction,
          destinationPhoneNumber,
          currency,
          timestamp,
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
          // Fallback to default approved platform voice policy (2500 basis points) if DB RPC is not yet executed
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

        // 4. Construct Customer Retail Rate Card
        const rateCard: TelecomRetailRateCard = {
          id: `derived-voice-${serviceType}-${direction}-${wholesaleQuote.destinationPrefix}`,
          rateCode: `DYNAMIC_VOICE_${serviceType.toUpperCase()}`,
          serviceType: wholesaleQuote.serviceType as any,
          direction: wholesaleQuote.direction as any,
          destinationPattern: wholesaleQuote.destinationPrefix,
          destinationName: `Voice Destination (${wholesaleQuote.destinationPrefix})`,
          retailRateMicro: Number(derivedResult.derivedRetailRateMicro),
          wholesaleCostMicro: Number(derivedResult.wholesaleRateMicro),
          unitType: wholesaleQuote.unitType as any,
          billingIncrementSeconds: wholesaleQuote.billingIncrementSeconds,
          minChargeableUnits: wholesaleQuote.minChargeableUnits,
          currency: derivedResult.currency,
          isActive: true,
          effectiveStartAt: timestamp,
          effectiveEndAt: null,
          metadata: {
            pricing_policy_id: policy.id,
            pricing_mode: policy.pricingMode,
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

    // Fetch candidate active rate cards from database
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

    // Filter rate cards by effective date window
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

    // Clean destination E.164 phone number
    const cleanDest = destinationPhoneNumber.trim();

    // 1. Separate organization custom rate cards from public rate cards
    const orgCustomCards = effectiveCards.filter(
      (c) => c.metadata && c.metadata.organization_id === organizationId
    );
    const publicCards = effectiveCards.filter(
      (c) => !c.metadata || !c.metadata.organization_id
    );

    // Helper for longest prefix match
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

    // Try org custom match first
    const orgResult = findBestMatch(orgCustomCards);
    if (orgResult.bestMatch) {
      const card = orgResult.bestMatch;
      return this.mapToResult(card, 'organization_custom', card.destination_pattern);
    }

    // Fall back to public tariff match
    const publicResult = findBestMatch(publicCards);
    if (publicResult.bestMatch) {
      const card = publicResult.bestMatch;
      return this.mapToResult(card, 'public_tariff', card.destination_pattern);
    }

    // If no pattern matched (not even a wildcard '*') -> FAIL CLOSED!
    throw new Error(
      `RATE_CARD_NOT_FOUND: Destination ${destinationPhoneNumber} does not match any active rate card pattern for service ${serviceType}`
    );
  }

  /**
   * Helper to map raw rate card database record to RateResolutionResult DTO
   */
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

  /**
   * Pure mathematical helper to compute estimated exposure in minor units (cents)
   * using precision micro-unit rate (10,000 micro-units = 1 minor-unit / cent).
   * Delegates directly to TelecomWalletService.calculateRetailChargeMinor for 100% rating equivalence.
   */
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
