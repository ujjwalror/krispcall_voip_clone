import { SupabaseClient } from '@supabase/supabase-js';
import { NormalizedWholesaleQuote } from './providerWholesaleRateService';

export interface CommercialPricingPolicyRecord {
  id: string;
  policyName: string;
  organizationId: string | null;
  serviceType: string;
  direction: string;
  destinationPattern: string;
  pricingMode: string;
  markupBasisPoints: number;
  fixedSurchargeMicro: number | bigint;
  retailFloorMicro: number | bigint;
  currency: string;
  priority: number;
  effectiveStartAt: string;
}

export interface DerivedRetailRateResult {
  success: boolean;
  derivedRetailRateMicro: bigint;
  wholesaleRateMicro: bigint;
  markupAmountMicro: bigint;
  policyId: string;
  policyName: string;
  pricingMode: string;
  markupBasisPoints: number;
  matchedPrefix: string;
  currency: string;
  unitType: string;
  billingIncrementSeconds: number;
  minChargeableUnits: number;
}

export class CommercialPricingEngine {
  /**
   * Resolves the applicable commercial pricing policy from DB/RPC for an organization & service path.
   */
  public static async resolvePolicy(
    client: SupabaseClient,
    params: {
      organizationId?: string | null;
      serviceType: string;
      direction: string;
      destinationPhoneNumber: string;
      currency?: string;
      timestamp?: string;
    }
  ): Promise<CommercialPricingPolicyRecord> {
    const {
      organizationId = null,
      serviceType,
      direction,
      destinationPhoneNumber,
      currency = 'USD',
      timestamp,
    } = params;

    const { data, error } = await (client as any).rpc('resolve_telecom_retail_pricing_policy_atomic', {
      p_organization_id: organizationId,
      p_service_type: serviceType,
      p_direction: direction,
      p_destination_phone_number: destinationPhoneNumber,
      p_currency: currency,
      p_timestamp: timestamp,
    });

    if (error) {
      throw new Error(`PRICING_POLICY_ERROR: ${error.message}`);
    }

    if (!data || !data.success) {
      throw new Error(`PRICING_POLICY_NOT_FOUND: No applicable pricing policy for service ${serviceType} ${direction}`);
    }

    return {
      id: data.policy_id,
      policyName: data.policy_name,
      organizationId: data.organization_id,
      serviceType: data.service_type,
      direction: data.direction,
      destinationPattern: data.destination_pattern,
      pricingMode: data.pricing_mode,
      markupBasisPoints: Number(data.markup_basis_points || 0),
      fixedSurchargeMicro: BigInt(data.fixed_surcharge_micro || 0),
      retailFloorMicro: BigInt(data.retail_floor_micro || 0),
      currency: data.currency,
      priority: Number(data.priority || 100),
      effectiveStartAt: data.effective_start_at,
    };
  }

  /**
   * Pure mathematical calculation of dynamic retail rate from normalized wholesale quote and policy.
   * Uses BigInt micro-unit integer arithmetic only. Zero floating-point monetary operations.
   */
  public static calculateRetailRate(
    wholesaleQuote: NormalizedWholesaleQuote,
    policy: CommercialPricingPolicyRecord
  ): DerivedRetailRateResult {
    // 1. Currency Mismatch Check -> Fail Closed!
    if (wholesaleQuote.currency.toUpperCase() !== policy.currency.toUpperCase()) {
      throw new Error(
        `CURRENCY_MISMATCH_UNSUPPORTED: Wholesale currency (${wholesaleQuote.currency}) does not match policy currency (${policy.currency})`
      );
    }

    // 2. Pricing Mode Safety Check
    if (policy.pricingMode !== 'markup_percentage') {
      throw new Error(`UNSUPPORTED_PRICING_MODE: Pricing mode '${policy.pricingMode}' is not enabled for runtime execution`);
    }

    const wholesaleMicro = wholesaleQuote.wholesaleRateMicro;
    if (wholesaleMicro < BigInt(0)) {
      throw new Error(`INVALID_WHOLESALE_RATE: Wholesale rate cannot be negative (${wholesaleMicro})`);
    }

    const basisPointsBig = BigInt(policy.markupBasisPoints);
    if (basisPointsBig < BigInt(0)) {
      throw new Error(`INVALID_MARKUP_POLICY: Markup basis points cannot be negative (${policy.markupBasisPoints})`);
    }

    // 3. Integer Markup Calculation with Ceiling Division: (wholesale * bps + 9999) / 10000
    // Positive wholesale rates round UP to next micro-unit so fractional markup is never understated.
    const markupAmountMicro = (wholesaleMicro * basisPointsBig + BigInt(9999)) / BigInt(10000);

    const fixedSurchargeMicro = BigInt(policy.fixedSurchargeMicro || 0);
    const retailFloorMicro = BigInt(policy.retailFloorMicro || 0);

    const derivedBeforeFloor = wholesaleMicro + markupAmountMicro + fixedSurchargeMicro;

    // Apply retail floor if configured
    let finalRetailMicro = derivedBeforeFloor > retailFloorMicro ? derivedBeforeFloor : retailFloorMicro;

    // 4. Retail >= Wholesale Profitability Invariant
    if (finalRetailMicro < wholesaleMicro) {
      finalRetailMicro = wholesaleMicro;
    }

    return {
      success: true,
      derivedRetailRateMicro: finalRetailMicro,
      wholesaleRateMicro: wholesaleMicro,
      markupAmountMicro,
      policyId: policy.id,
      policyName: policy.policyName,
      pricingMode: policy.pricingMode,
      markupBasisPoints: policy.markupBasisPoints,
      matchedPrefix: wholesaleQuote.destinationPrefix,
      currency: wholesaleQuote.currency,
      unitType: wholesaleQuote.unitType,
      billingIncrementSeconds: wholesaleQuote.billingIncrementSeconds,
      minChargeableUnits: wholesaleQuote.minChargeableUnits,
    };
  }
}
