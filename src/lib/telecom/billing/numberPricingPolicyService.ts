import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { FixedPointMoney } from '@/lib/billing/telecom/fixedPointMoney';
import { PriceQuoteValidator } from '../saga/priceQuoteValidator';
import { NumberPriceQuoteDTO } from '../domain/types';

export const DEFAULT_NUMBER_MARKUP_PERCENT = 30; // 30% default markup
export const DEFAULT_NUMBER_MARKUP_BPS = 3000;    // 3000 basis points

export type NumberPricingPrecedenceLevel =
  | 'specific_resource'
  | 'number_type_scoped'
  | 'country_scoped'
  | 'provider_scoped'
  | 'global_default';

export interface NumberMarkupPolicyRule {
  id: string;
  ruleName: string;
  precedenceLevel: NumberPricingPrecedenceLevel;
  provider?: string | null;
  countryCode?: string | null;
  numberType?: string | null;
  phoneNumberE164?: string | null;
  markupBps: number;
  fixedSurchargeMinor?: number;
  retailFloorMinor?: number;
  currency: string;
  version: number;
  isActive: boolean;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

export interface ResolveNumberPricingPolicyParams {
  phoneNumberE164?: string | null;
  countryCode?: string | null;
  numberType?: string | null;
  provider?: string | null;
  currency?: string;
  client?: SupabaseClient | any;
}

export interface CalculateNumberRetailPriceParams {
  providerCostMinor: number | bigint;
  currency?: string;
  policy?: NumberMarkupPolicyRule | null;
  phoneNumberE164?: string | null;
  countryCode?: string | null;
  numberType?: string | null;
  provider?: string | null;
  client?: SupabaseClient | any;
}

export interface NumberRetailPriceCalculationResult {
  success: boolean;
  providerCostMinor: number;
  retailPriceMinor: number;
  markupAmountMinor: number;
  markupBps: number;
  markupPercent: number;
  currency: string;
  appliedRule: {
    ruleId: string;
    ruleName: string;
    precedenceLevel: NumberPricingPrecedenceLevel;
    markupBps: number;
    markupPercent: number;
    version: number;
  };
  calculationEvidence: {
    formula: string;
    providerCostMicro: string;
    markupMicro: string;
    retailMicro: string;
    roundingMode: 'CEIL';
    appliedBps: number;
  };
}

export interface GenerateNumberQuoteParams {
  organizationId: string;
  phoneNumberE164: string;
  countryCode: string;
  numberType: 'local' | 'mobile' | 'toll_free' | 'national';
  providerRecurringCostMinor: number | bigint;
  providerSetupCostMinor?: number | bigint;
  currency?: string;
  provider?: string;
  ttlSeconds?: number;
  client?: SupabaseClient | any;
}

/**
 * PHASE 23E.1: CANONICAL SERVER-SIDE NUMBER PRICING POLICY SERVICE
 * 
 * Deterministic, extensible retail markup policy engine for telephone numbers.
 * Default Operator Policy: 30% Markup (retail = provider_cost + 30%).
 * 
 * Strict Distributed Financial & Architectural Invariants:
 * 1. ZERO IEEE-754 floating-point operations in monetary calculations.
 * 2. BigInt micro-unit integer arithmetic with deterministic ceiling division.
 * 3. 5-Tier deterministic precedence resolution:
 *    specific_resource > number_type_scoped > country_scoped > provider_scoped > global_default.
 * 4. Provider cost and customer retail charge strictly decoupled and preserved separately.
 * 5. Full calculation evidence recorded with applied rule identifier.
 * 6. Historical quotes and billable resource prices remain 100% immutable against future policy updates.
 * 7. Zero client pricing authority: client-supplied costs or markups are rejected.
 */
export class NumberPricingPolicyService {
  private static testRules: NumberMarkupPolicyRule[] = [];

  /**
   * Registers an in-memory rule for isolated testing of future overrides.
   */
  static registerTestRule(rule: NumberMarkupPolicyRule): void {
    this.testRules.unshift(rule);
  }

  /**
   * Clears registered test rules.
   */
  static clearTestRules(): void {
    this.testRules = [];
  }

  /**
   * Resolves the authoritative active pricing rule following 5-tier deterministic precedence:
   * 1. specific_resource: exact phone_number_e164 match
   * 2. number_type_scoped: country_code + number_type match
   * 3. country_scoped: country_code match
   * 4. provider_scoped: provider match
   * 5. global_default: standard 30% markup fallback
   */
  static async resolvePolicy(
    params: ResolveNumberPricingPolicyParams
  ): Promise<NumberMarkupPolicyRule> {
    const currency = (params.currency || 'USD').toUpperCase().trim();
    const e164 = params.phoneNumberE164?.trim() || null;
    const country = params.countryCode?.toUpperCase().trim() || null;
    const numType = params.numberType?.toLowerCase().trim() || null;
    const prov = params.provider?.toUpperCase().trim() || null;

    // 1. Check in-memory test rules first (if any registered)
    const matchingTestRules = this.testRules.filter((r) => r.isActive && r.currency.toUpperCase() === currency);
    if (matchingTestRules.length > 0) {
      // 1a. Specific resource match
      if (e164) {
        const match = matchingTestRules.find((r) => r.precedenceLevel === 'specific_resource' && r.phoneNumberE164 === e164);
        if (match) return match;
      }
      // 1b. Number-type + country scoped match
      if (country && numType) {
        const match = matchingTestRules.find(
          (r) =>
            r.precedenceLevel === 'number_type_scoped' &&
            r.countryCode === country &&
            r.numberType === numType &&
            (!r.provider || !prov || r.provider.toUpperCase() === prov)
        );
        if (match) return match;
      }
      // 1c. Country scoped match
      if (country) {
        const match = matchingTestRules.find((r) => r.precedenceLevel === 'country_scoped' && r.countryCode === country);
        if (match) return match;
      }
      // 1d. Provider scoped match
      if (prov) {
        const match = matchingTestRules.find((r) => r.precedenceLevel === 'provider_scoped' && r.provider?.toUpperCase() === prov);
        if (match) return match;
      }
      // 1e. Global default test rule
      const globalMatch = matchingTestRules.find((r) => r.precedenceLevel === 'global_default');
      if (globalMatch) return globalMatch;
    }

    // 2. Query database for configured policies if client is available
    const db = params.client || createAdminClient();
    if (db) {
      try {
        const { data: dbRules, error } = await (db as any)
          .from('telecom_number_markup_policies')
          .select('*')
          .eq('is_active', true)
          .eq('currency', currency);

        if (!error && dbRules && Array.isArray(dbRules) && dbRules.length > 0) {
          const rules: NumberMarkupPolicyRule[] = dbRules.map((r: any) => ({
            id: r.id,
            ruleName: r.rule_name,
            precedenceLevel: r.precedence_level as NumberPricingPrecedenceLevel,
            provider: r.provider,
            countryCode: r.country_code,
            numberType: r.number_type,
            phoneNumberE164: r.phone_number_e164,
            markupBps: Number(r.markup_bps),
            fixedSurchargeMinor: Number(r.fixed_surcharge_minor || 0),
            retailFloorMinor: Number(r.retail_floor_minor || 0),
            currency: r.currency,
            version: Number(r.version || 1),
            isActive: Boolean(r.is_active),
            effectiveFrom: r.effective_from,
            effectiveTo: r.effective_to,
          }));

          // Level 1: Specific resource
          if (e164) {
            const match = rules.find((r) => r.precedenceLevel === 'specific_resource' && r.phoneNumberE164 === e164);
            if (match) return match;
          }
          // Level 2: Scoped rule (number-type + country)
          if (country && numType) {
            const match = rules.find(
              (r) =>
                r.precedenceLevel === 'number_type_scoped' &&
                r.countryCode === country &&
                r.numberType === numType &&
                (!r.provider || !prov || r.provider.toUpperCase() === prov)
            );
            if (match) return match;
          }
          // Level 3: Country rule
          if (country) {
            const match = rules.find((r) => r.precedenceLevel === 'country_scoped' && r.countryCode === country);
            if (match) return match;
          }
          // Level 4: Provider rule
          if (prov) {
            const match = rules.find((r) => r.precedenceLevel === 'provider_scoped' && r.provider?.toUpperCase() === prov);
            if (match) return match;
          }
          // Level 5: Database global default
          const globalMatch = rules.find((r) => r.precedenceLevel === 'global_default');
          if (globalMatch) return globalMatch;
        }
      } catch (err: any) {
        // Fall through to hardcoded global default on DB error or missing table
        console.warn('[NumberPricingPolicyService] Error querying markup policies:', err.message || err);
      }
    }

    // 3. Fallback: Global Default 30% Markup
    return {
      id: 'GLOBAL_DEFAULT_30',
      ruleName: 'Global Default 30% Number Markup',
      precedenceLevel: 'global_default',
      markupBps: DEFAULT_NUMBER_MARKUP_BPS,
      fixedSurchargeMinor: 0,
      retailFloorMinor: 0,
      currency,
      version: 1,
      isActive: true,
      effectiveFrom: new Date().toISOString(),
    };
  }

  /**
   * Pure mathematical calculation of retail price from provider cost and resolved policy.
   * Uses BigInt micro-unit integer arithmetic with deterministic ceiling division.
   * Zero IEEE-754 floating-point operations.
   */
  static calculateRetailPrice(
    params: CalculateNumberRetailPriceParams
  ): NumberRetailPriceCalculationResult {
    // 1. Validate Provider Cost input
    if (params.providerCostMinor === undefined || params.providerCostMinor === null) {
      throw new Error('MISSING_PROVIDER_COST: Provider wholesale cost evidence is required to calculate retail price.');
    }

    const providerCostMinorBig = BigInt(params.providerCostMinor);
    if (providerCostMinorBig < BigInt(0)) {
      throw new Error(`INVALID_PROVIDER_COST: Provider cost cannot be negative (${providerCostMinorBig}).`);
    }

    const currency = (params.currency || 'USD').toUpperCase().trim();
    // Validate currency support fail-closed
    FixedPointMoney.getCurrencyConfig(currency);

    // 2. Resolve policy if not provided directly
    const policy = params.policy || {
      id: 'GLOBAL_DEFAULT_30',
      ruleName: 'Global Default 30% Number Markup',
      precedenceLevel: 'global_default' as NumberPricingPrecedenceLevel,
      markupBps: DEFAULT_NUMBER_MARKUP_BPS,
      fixedSurchargeMinor: 0,
      retailFloorMinor: 0,
      currency,
      version: 1,
      isActive: true,
    };

    // 3. Currency Mismatch Check Fail-Closed
    if (policy.currency.toUpperCase().trim() !== currency) {
      throw new Error(
        `CURRENCY_MISMATCH: Provider cost currency (${currency}) does not match policy currency (${policy.currency}).`
      );
    }

    // 4. Validate Markup Basis Points
    const markupBpsBig = BigInt(policy.markupBps);
    if (markupBpsBig < BigInt(0)) {
      throw new Error(`INVALID_MARKUP_POLICY: Markup basis points cannot be negative (${policy.markupBps}).`);
    }

    // 5. Fixed-Point Micro-Unit Math
    const providerMicro = FixedPointMoney.minorUnitsToMicroUnits(providerCostMinorBig, currency);
    // Integer markup calculation with ceiling division: (costMicro * bps + 9999) / 10000
    const markupMicro = (providerMicro * markupBpsBig + BigInt(9999)) / BigInt(10000);

    const surchargeMinorBig = BigInt(policy.fixedSurchargeMinor || 0);
    const surchargeMicro = FixedPointMoney.minorUnitsToMicroUnits(surchargeMinorBig, currency);

    const derivedBeforeFloor = providerMicro + markupMicro + surchargeMicro;

    const floorMinorBig = BigInt(policy.retailFloorMinor || 0);
    const floorMicro = FixedPointMoney.minorUnitsToMicroUnits(floorMinorBig, currency);

    let finalRetailMicro = derivedBeforeFloor > floorMicro ? derivedBeforeFloor : floorMicro;

    // Profitability invariant: Retail charge cannot be less than wholesale cost
    if (finalRetailMicro < providerMicro) {
      finalRetailMicro = providerMicro;
    }

    // Convert back to minor units (cents) using CEIL rounding
    const retailPriceMinorBig = FixedPointMoney.microUnitsToMinorUnits(finalRetailMicro, currency, 'CEIL');
    const markupAmountMinorBig = retailPriceMinorBig - providerCostMinorBig;

    return {
      success: true,
      providerCostMinor: Number(providerCostMinorBig),
      retailPriceMinor: Number(retailPriceMinorBig),
      markupAmountMinor: Number(markupAmountMinorBig),
      markupBps: policy.markupBps,
      markupPercent: policy.markupBps / 100,
      currency,
      appliedRule: {
        ruleId: policy.id,
        ruleName: policy.ruleName,
        precedenceLevel: policy.precedenceLevel,
        markupBps: policy.markupBps,
        markupPercent: policy.markupBps / 100,
        version: policy.version,
      },
      calculationEvidence: {
        formula: 'provider_cost + ceil(provider_cost * markup_bps / 10000) + surcharge',
        providerCostMicro: providerMicro.toString(),
        markupMicro: markupMicro.toString(),
        retailMicro: finalRetailMicro.toString(),
        roundingMode: 'CEIL',
        appliedBps: policy.markupBps,
      },
    };
  }

  /**
   * Generates, signs, and records an authoritative immutable NumberPriceQuoteDTO.
   * Client-supplied prices and markups are completely ignored.
   */
  static async generateAuthoritativeQuote(
    params: GenerateNumberQuoteParams
  ): Promise<NumberPriceQuoteDTO> {
    const currency = (params.currency || 'USD').toUpperCase().trim();
    const provider = (params.provider || 'TWILIO').toUpperCase().trim();
    const ttlSeconds = params.ttlSeconds || 900; // 15 minutes TTL

    // 1. Resolve applicable pricing policy
    const policy = await this.resolvePolicy({
      phoneNumberE164: params.phoneNumberE164,
      countryCode: params.countryCode,
      numberType: params.numberType,
      provider,
      currency,
      client: params.client,
    });

    // 2. Authoritatively calculate recurring retail price
    const recurringCalc = this.calculateRetailPrice({
      providerCostMinor: params.providerRecurringCostMinor,
      currency,
      policy,
    });

    // 3. Authoritatively calculate setup/upfront retail price (if applicable)
    let setupRetailMinor = 0;
    const setupCostMinor = Number(params.providerSetupCostMinor || 0);
    if (setupCostMinor > 0) {
      const setupCalc = this.calculateRetailPrice({
        providerCostMinor: setupCostMinor,
        currency,
        policy,
      });
      setupRetailMinor = setupCalc.retailPriceMinor;
    }

    const observedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    // 4. Assemble quote object
    const unsignedQuote: any = {
      organizationId: params.organizationId,
      provider,
      phoneNumberE164: params.phoneNumberE164,
      numberType: params.numberType,
      countryCode: params.countryCode,
      currency,
      providerSetupCostMinor: setupCostMinor,
      providerRecurringCostMinor: recurringCalc.providerCostMinor,
      customerSetupPriceMinor: setupRetailMinor,
      customerRecurringPriceMinor: recurringCalc.retailPriceMinor,
      pricingPolicyId: policy.id.startsWith('GLOBAL_') ? null : policy.id,
      observedAt,
      expiresAt,
      reservationMetadata: {
        appliedRule: recurringCalc.appliedRule,
        calculationEvidence: recurringCalc.calculationEvidence,
      },
    };

    // 5. Sign quote with HMAC-SHA256
    const signature = PriceQuoteValidator.signQuote(unsignedQuote);
    unsignedQuote.searchTokenSignature = signature;

    // 6. Persist to public.phone_number_price_quotes if DB client is provided
    const db = params.client || createAdminClient();
    if (db) {
      try {
        const { data: dbRow, error } = await (db as any)
          .from('phone_number_price_quotes')
          .insert({
            organization_id: unsignedQuote.organizationId,
            provider: unsignedQuote.provider,
            phone_number_e164: unsignedQuote.phoneNumberE164,
            number_type: unsignedQuote.numberType,
            country_code: unsignedQuote.countryCode,
            currency: unsignedQuote.currency,
            provider_setup_cost_minor: unsignedQuote.providerSetupCostMinor,
            provider_recurring_cost_minor: unsignedQuote.providerRecurringCostMinor,
            customer_setup_price_minor: unsignedQuote.customerSetupPriceMinor,
            customer_recurring_price_minor: unsignedQuote.customerRecurringPriceMinor,
            pricing_policy_id: unsignedQuote.pricingPolicyId,
            observed_at: unsignedQuote.observedAt,
            expires_at: unsignedQuote.expiresAt,
            search_token_signature: unsignedQuote.searchTokenSignature,
            reservation_metadata: unsignedQuote.reservationMetadata,
          })
          .select('id')
          .maybeSingle();

        if (!error && dbRow?.id) {
          unsignedQuote.id = dbRow.id;
        }
      } catch (err: any) {
        console.warn('[NumberPricingPolicyService] Notice: could not persist quote to DB:', err.message || err);
      }
    }

    return unsignedQuote as NumberPriceQuoteDTO;
  }
}
