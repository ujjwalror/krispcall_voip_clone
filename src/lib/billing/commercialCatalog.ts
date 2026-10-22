import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getEntitlementLimit } from '@/lib/entitlements/server';

/**
 * Phase 18E Revised Commercial Catalog, Provisional Pricing & Downgrade Safety Module.
 *
 * IMPORTANT: All pricing targets in this catalog are PROVISIONAL DEVELOPMENT TARGETS.
 * They are NOT published public commercial prices and MUST NOT be charged to customers
 * or created as live Stripe products/prices.
 */

export const COMMERCIAL_PLAN_USER_LIMITS: Record<string, number> = {
  starter: 5,
  pro: 20,
  business: 50,
};

/**
 * @deprecated SUPERSEDED BY PHASE 23E.1 / 23E.1A: SaaS subscription plans (Starter/Pro/Business)
 * MUST NOT impose an ordinary plan-based ceiling on phone number ownership.
 * Telephone numbers are independently recurring billable telecom resources.
 * Current canonical plan capacity is unconstrained (null: Not Applicable).
 */
export const COMMERCIAL_PLAN_NUMBER_LIMITS: Record<string, number | null> = {
  starter: null,
  pro: null,
  business: null,
};

export interface ProvisionalPlanPrice {
  planCode: string;
  name: string;
  monthlyUserPriceMinor: number;
  monthlyUserPriceFormatted: string;
  currency: string;
  maxUsers: number;
  maxNumbers: number | null;
  isProvisional: boolean;
  annualPricingAvailable: false;
  annualPricingNote: string;
}

export const PROVISIONAL_PLAN_PRICES: Record<string, ProvisionalPlanPrice> = {
  starter: {
    planCode: 'starter',
    name: 'Starter',
    monthlyUserPriceMinor: 1800, // USD $18.00 / user / month
    monthlyUserPriceFormatted: '$18',
    currency: 'USD',
    maxUsers: 5,
    maxNumbers: null,
    isProvisional: true,
    annualPricingAvailable: false,
    annualPricingNote: 'Annual pricing coming soon',
  },
  pro: {
    planCode: 'pro',
    name: 'Pro',
    monthlyUserPriceMinor: 3200, // USD $32.00 / user / month
    monthlyUserPriceFormatted: '$32',
    currency: 'USD',
    maxUsers: 20,
    maxNumbers: null,
    isProvisional: true,
    annualPricingAvailable: false,
    annualPricingNote: 'Annual pricing coming soon',
  },
  business: {
    planCode: 'business',
    name: 'Business',
    monthlyUserPriceMinor: 4000, // USD $40.00 / user / month
    monthlyUserPriceFormatted: '$40',
    currency: 'USD',
    maxUsers: 50,
    maxNumbers: null,
    isProvisional: true,
    annualPricingAvailable: false,
    annualPricingNote: 'Annual pricing coming soon',
  },
};

export interface DowngradeEligibilityResult {
  allowed: boolean;
  targetPlanCode: string;
  currentActiveUsers: number;
  targetMaxUsers: number;
  currentActiveNumbers: number;
  targetMaxNumbers: number | null;
  reason?: string;
  blockerType?: 'USER_COUNT_EXCEEDED' | 'NUMBER_COUNT_EXCEEDED' | 'INVALID_PLAN';
}

export class CommercialCatalogService {
  /**
   * Returns provisional development pricing details for a given plan code.
   */
  static getProvisionalPrice(planCode: string): ProvisionalPlanPrice | null {
    if (!planCode) return null;
    const cleanKey = planCode.toLowerCase().trim();
    return PROVISIONAL_PLAN_PRICES[cleanKey] || null;
  }

  /**
   * Resolves maximum active users for a plan code.
   */
  static getMaxUsersForPlan(planCode: string): number | null {
    if (!planCode) return null;
    const cleanKey = planCode.toLowerCase().trim();
    return COMMERCIAL_PLAN_USER_LIMITS[cleanKey] ?? null;
  }

  /**
   * Resolves maximum active phone numbers for a plan code.
   * SUPERSEDED BY PHASE 23E.1 / 23E.1A: Returns null (unconstrained / not applicable).
   */
  static getMaxNumbersForPlan(planCode: string): number | null {
    return null;
  }

  /**
   * Evaluates if an organization can downgrade to a target plan without violating seat limits.
   * PHASE 23E.1A: Subscription downgrade NEVER blocks on phone number count.
   * STRICT GUARANTEE: Does NOT automatically release phone numbers or deactivate users or destroy historical data.
   */
  static async checkDowngradeEligibility(
    organizationId: string,
    targetPlanCode: string,
    clientOverride?: SupabaseClient
  ): Promise<DowngradeEligibilityResult> {
    const supabase = clientOverride || (await createServerSupabaseClient());
    const cleanTargetKey = (targetPlanCode || '').toLowerCase().trim();
    const targetMaxUsers = COMMERCIAL_PLAN_USER_LIMITS[cleanTargetKey];
    const targetMaxNumbers = null;

    if (targetMaxUsers === undefined) {
      return {
        allowed: false,
        targetPlanCode,
        currentActiveUsers: 0,
        targetMaxUsers: 0,
        currentActiveNumbers: 0,
        targetMaxNumbers: null,
        reason: `Invalid or unrecognized target plan code '${targetPlanCode}'.`,
        blockerType: 'INVALID_PLAN',
      };
    }

    // 1. Fetch current active member count for organization
    const { data: members, error: memErr } = await (supabase as any)
      .from('profiles')
      .select('id, active')
      .eq('organization_id', organizationId);

    const activeMembers = memErr || !members ? 0 : members.filter((m: any) => m.active !== false).length;

    // 2. Fetch current active phone number count (for reporting / accounting)
    const { count: activeNumbersCount, error: numErr } = await (supabase as any)
      .from('phone_numbers')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('active', true)
      .eq('status', 'active');

    const currentActiveNumbers = numErr || activeNumbersCount === null ? 0 : activeNumbersCount;

    // Check 1: User count ceiling (SaaS seat limits)
    if (activeMembers > targetMaxUsers) {
      return {
        allowed: false,
        targetPlanCode,
        currentActiveUsers: activeMembers,
        targetMaxUsers,
        currentActiveNumbers,
        targetMaxNumbers,
        reason: `Downgrade blocked: Your workspace currently has ${activeMembers} active users. The ${targetPlanCode.toUpperCase()} plan supports a maximum of ${targetMaxUsers} active users. Please deactivate ${activeMembers - targetMaxUsers} user seat(s) before downgrading.`,
        blockerType: 'USER_COUNT_EXCEEDED',
      };
    }

    // Check 2: Number count ceiling — SUPERSEDED BY PHASE 23E.1 / PHASE 23E.1A
    // SaaS plans do NOT impose phone number quantity limits.
    // Numbers are independently recurring billable telecom resources.
    // Downgrades NEVER block on phone number count, release numbers, or destroy routing.

    return {
      allowed: true,
      targetPlanCode,
      currentActiveUsers: activeMembers,
      targetMaxUsers,
      currentActiveNumbers,
      targetMaxNumbers,
    };
  }
}
