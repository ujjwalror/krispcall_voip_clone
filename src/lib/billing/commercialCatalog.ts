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

export const COMMERCIAL_PLAN_NUMBER_LIMITS: Record<string, number> = {
  starter: 1,
  pro: 3,
  business: 10,
};

export interface ProvisionalPlanPrice {
  planCode: string;
  name: string;
  monthlyUserPriceMinor: number;
  monthlyUserPriceFormatted: string;
  currency: string;
  maxUsers: number;
  maxNumbers: number;
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
    maxNumbers: 1,
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
    maxNumbers: 3,
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
    maxNumbers: 10,
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
  targetMaxNumbers: number;
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
   */
  static getMaxNumbersForPlan(planCode: string): number | null {
    if (!planCode) return null;
    const cleanKey = planCode.toLowerCase().trim();
    return COMMERCIAL_PLAN_NUMBER_LIMITS[cleanKey] ?? null;
  }

  /**
   * Evaluates if an organization can downgrade to a target plan without violating seat or number limits.
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
    const targetMaxNumbers = COMMERCIAL_PLAN_NUMBER_LIMITS[cleanTargetKey];

    if (targetMaxUsers === undefined || targetMaxNumbers === undefined) {
      return {
        allowed: false,
        targetPlanCode,
        currentActiveUsers: 0,
        targetMaxUsers: 0,
        currentActiveNumbers: 0,
        targetMaxNumbers: 0,
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

    // 2. Fetch current active phone number count (excluding released/ported-out/quarantined)
    const { count: activeNumbersCount, error: numErr } = await (supabase as any)
      .from('phone_numbers')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('active', true)
      .eq('status', 'active');

    const currentActiveNumbers = numErr || activeNumbersCount === null ? 0 : activeNumbersCount;

    // Check 1: User count ceiling
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

    // Check 2: Number count ceiling
    if (currentActiveNumbers > targetMaxNumbers) {
      return {
        allowed: false,
        targetPlanCode,
        currentActiveUsers: activeMembers,
        targetMaxUsers,
        currentActiveNumbers,
        targetMaxNumbers,
        reason: `Downgrade blocked: Your workspace currently has ${currentActiveNumbers} active phone numbers. The ${targetPlanCode.toUpperCase()} plan supports a maximum of ${targetMaxNumbers} active number(s). Please release or transfer ${currentActiveNumbers - targetMaxNumbers} phone number(s) before downgrading.`,
        blockerType: 'NUMBER_COUNT_EXCEEDED',
      };
    }

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
