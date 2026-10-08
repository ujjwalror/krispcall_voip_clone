import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import {
  CommercialCatalogService,
  COMMERCIAL_PLAN_USER_LIMITS,
  COMMERCIAL_PLAN_NUMBER_LIMITS,
  PROVISIONAL_PLAN_PRICES,
  ProvisionalPlanPrice,
} from '@/lib/billing/commercialCatalog';
import { SubscriptionPolicyService } from '@/lib/billing/subscriptionPolicyService';
import { SeatBillingService } from '@/lib/billing/seatBillingService';

export const SEAT_ADD_BILLING_POLICY = 'STRIPE_SUBSCRIPTION_QUANTITY_SYNC';
export const SEAT_REMOVE_BILLING_POLICY = 'NEXT_RECURRING_CYCLE_REDUCTION';
export const PRORATION_POLICY = 'STRIPE_STANDARD_NO_IMMEDIATE_CASH_REFUND';

export type PlanChangeType = 'UPGRADE' | 'DOWNGRADE' | 'SAME_PLAN';
export type EffectiveTiming = 'IMMEDIATE_PREVIEW' | 'END_OF_PERIOD';

export interface PlanSelectionPreviewResult {
  success: boolean;
  currentPlanCode: string;
  targetPlanCode: string;
  changeType: PlanChangeType;
  billingInterval: 'monthly' | 'annual';
  activeUsers: number;
  targetMaxUsers: number;
  activeNumbers: number;
  targetMaxNumbers: number;
  provisionalPricePerUserMinor: number;
  totalProvisionalSaaSMinor: number;
  totalProvisionalSaaSFormatted: string;
  currency: string;
  allowed: boolean;
  blockReason?: string;
  blockerType?: 'USER_COUNT_EXCEEDED' | 'NUMBER_COUNT_EXCEEDED' | 'INVALID_PLAN' | 'UNAPPROVED_INTERVAL' | 'SUBSCRIPTION_INACTIVE';
  effectiveTiming: EffectiveTiming;
  seatAddBillingPolicy: typeof SEAT_ADD_BILLING_POLICY;
  seatRemoveBillingPolicy: typeof SEAT_REMOVE_BILLING_POLICY;
  prorationPolicy: typeof PRORATION_POLICY;
  gatedReason: string;
}

export interface PlanChangeExecutionResult {
  success: boolean;
  organizationId: string;
  targetPlanCode: string;
  changeType: PlanChangeType;
  effectiveTiming: EffectiveTiming;
  scheduledAtPeriodEnd?: boolean;
  currentPeriodEnd?: string | null;
  message: string;
  preview: PlanSelectionPreviewResult;
}

export interface CancellationResult {
  success: boolean;
  organizationId: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  message: string;
  assurances: {
    saasActiveUntilPeriodEnd: boolean;
    phoneNumbersPreserved: boolean;
    phoneNumbersSeparateLifecycle: boolean;
    telecomCreditPreserved: boolean;
    portOutRightsPreserved: boolean;
  };
}

export interface ReactivationResult {
  success: boolean;
  organizationId: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  message: string;
}

const PLAN_TIER_ORDER: Record<string, number> = {
  starter: 1,
  pro: 2,
  business: 3,
};

export class CommercialSubscriptionLifecycleService {
  /**
   * Resolves plan tier order (starter=1, pro=2, business=3).
   */
  static getPlanTier(planCode: string): number {
    const clean = (planCode || '').toLowerCase().trim();
    return PLAN_TIER_ORDER[clean] || 0;
  }

  /**
   * Server-authoritative plan selection and financial preview calculation.
   * Enforces server catalog rules and fails closed for unapproved annual intervals.
   */
  static async selectPlanAndPreview(
    organizationId: string,
    targetPlanCode: string,
    billingInterval: string = 'monthly',
    clientOverride?: SupabaseClient
  ): Promise<PlanSelectionPreviewResult> {
    const supabase = clientOverride || (await createServerSupabaseClient());
    const cleanTargetKey = (targetPlanCode || '').toLowerCase().trim();
    const cleanInterval = (billingInterval || '').toLowerCase().trim();

    // 1. Annual interval validation (Annual pricing is NOT approved -> fail closed)
    if (cleanInterval === 'annual') {
      return {
        success: false,
        currentPlanCode: '',
        targetPlanCode: cleanTargetKey,
        changeType: 'SAME_PLAN',
        billingInterval: 'annual',
        activeUsers: 0,
        targetMaxUsers: 0,
        activeNumbers: 0,
        targetMaxNumbers: 0,
        provisionalPricePerUserMinor: 0,
        totalProvisionalSaaSMinor: 0,
        totalProvisionalSaaSFormatted: '$0',
        currency: 'USD',
        allowed: false,
        blockReason: 'Annual pricing is not yet approved. "Annual pricing coming soon".',
        blockerType: 'UNAPPROVED_INTERVAL',
        effectiveTiming: 'END_OF_PERIOD',
        seatAddBillingPolicy: SEAT_ADD_BILLING_POLICY,
        seatRemoveBillingPolicy: SEAT_REMOVE_BILLING_POLICY,
        prorationPolicy: PRORATION_POLICY,
        gatedReason: 'Annual pricing is unapproved.',
      };
    }

    // 2. Validate target plan exists in provisional catalog
    const provisionalPriceObj = CommercialCatalogService.getProvisionalPrice(cleanTargetKey);
    if (!provisionalPriceObj) {
      return {
        success: false,
        currentPlanCode: '',
        targetPlanCode: cleanTargetKey,
        changeType: 'SAME_PLAN',
        billingInterval: 'monthly',
        activeUsers: 0,
        targetMaxUsers: 0,
        activeNumbers: 0,
        targetMaxNumbers: 0,
        provisionalPricePerUserMinor: 0,
        totalProvisionalSaaSMinor: 0,
        totalProvisionalSaaSFormatted: '$0',
        currency: 'USD',
        allowed: false,
        blockReason: `Unrecognized or invalid target plan code '${targetPlanCode}'.`,
        blockerType: 'INVALID_PLAN',
        effectiveTiming: 'END_OF_PERIOD',
        seatAddBillingPolicy: SEAT_ADD_BILLING_POLICY,
        seatRemoveBillingPolicy: SEAT_REMOVE_BILLING_POLICY,
        prorationPolicy: PRORATION_POLICY,
        gatedReason: 'Invalid plan selection.',
      };
    }

    // 3. Fetch current subscription and plan
    const { data: sub } = await (supabase as any)
      .from('organization_subscriptions')
      .select('id, status, plans!inner(code, stable_key)')
      .eq('organization_id', organizationId)
      .maybeSingle();

    const currentPlanCode = (sub?.plans?.stable_key || sub?.plans?.code || 'starter').toLowerCase().trim();
    const currentTier = this.getPlanTier(currentPlanCode);
    const targetTier = this.getPlanTier(cleanTargetKey);

    let changeType: PlanChangeType = 'SAME_PLAN';
    if (targetTier > currentTier) {
      changeType = 'UPGRADE';
    } else if (targetTier < currentTier) {
      changeType = 'DOWNGRADE';
    }

    // 4. Fetch current active members and phone numbers
    const { data: members } = await (supabase as any)
      .from('profiles')
      .select('id, active')
      .eq('organization_id', organizationId);

    const activeMembers = members ? members.filter((m: any) => m.active !== false).length : 0;

    const { count: activeNumbersCount } = await (supabase as any)
      .from('phone_numbers')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('active', true)
      .eq('status', 'active');

    const activeNumbers = activeNumbersCount || 0;

    const targetMaxUsers = provisionalPriceObj.maxUsers;
    const targetMaxNumbers = provisionalPriceObj.maxNumbers;

    // 5. Evaluate downgrade eligibility / limits
    let allowed = true;
    let blockReason: string | undefined;
    let blockerType: PlanSelectionPreviewResult['blockerType'];

    if (changeType === 'DOWNGRADE') {
      const eligibility = await CommercialCatalogService.checkDowngradeEligibility(
        organizationId,
        cleanTargetKey,
        supabase
      );
      if (!eligibility.allowed) {
        allowed = false;
        blockReason = eligibility.reason;
        blockerType = eligibility.blockerType;
      }
    } else if (changeType === 'UPGRADE') {
      // Check if user count already exceeds target max (unlikely for upgrade, but safe check)
      if (activeMembers > targetMaxUsers) {
        allowed = false;
        blockReason = `Upgrade target ${cleanTargetKey.toUpperCase()} supports max ${targetMaxUsers} users, but organization has ${activeMembers} active users.`;
        blockerType = 'USER_COUNT_EXCEEDED';
      }
    }

    // 6. Calculate server-authoritative provisional financial amount
    const pricePerUserMinor = provisionalPriceObj.monthlyUserPriceMinor;
    const totalSaaSMinor = activeMembers * pricePerUserMinor;
    const totalSaaSFormatted = `$${(totalSaaSMinor / 100).toFixed(2)}`;

    const effectiveTiming: EffectiveTiming = changeType === 'DOWNGRADE' ? 'END_OF_PERIOD' : 'IMMEDIATE_PREVIEW';

    return {
      success: true,
      currentPlanCode,
      targetPlanCode: cleanTargetKey,
      changeType,
      billingInterval: 'monthly',
      activeUsers: activeMembers,
      targetMaxUsers,
      activeNumbers,
      targetMaxNumbers,
      provisionalPricePerUserMinor: pricePerUserMinor,
      totalProvisionalSaaSMinor: totalSaaSMinor,
      totalProvisionalSaaSFormatted: totalSaaSFormatted,
      currency: 'USD',
      allowed,
      blockReason,
      blockerType,
      effectiveTiming,
      seatAddBillingPolicy: SEAT_ADD_BILLING_POLICY,
      seatRemoveBillingPolicy: SEAT_REMOVE_BILLING_POLICY,
      prorationPolicy: PRORATION_POLICY,
      gatedReason: 'Development pricing is provisional. Live Stripe mutations and charges remain gated.',
    };
  }

  /**
   * Executes a plan change request (Upgrade or Downgrade) server-side.
   * Gated from live financial mutations while preserving preview & state management architecture.
   */
  static async requestPlanChange(
    organizationId: string,
    targetPlanCode: string,
    billingInterval: string = 'monthly',
    clientOverride?: SupabaseClient
  ): Promise<PlanChangeExecutionResult> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const preview = await this.selectPlanAndPreview(
      organizationId,
      targetPlanCode,
      billingInterval,
      supabase
    );

    if (!preview.success || !preview.allowed) {
      return {
        success: false,
        organizationId,
        targetPlanCode: (targetPlanCode || '').toLowerCase(),
        changeType: preview.changeType,
        effectiveTiming: preview.effectiveTiming,
        message: preview.blockReason || 'Plan change is not permitted.',
        preview,
      };
    }

    // Verify subscription state is active
    const subState = await SubscriptionPolicyService.getSubscriptionState(organizationId, supabase);
    if (subState.canonicalState !== 'active') {
      return {
        success: false,
        organizationId,
        targetPlanCode: (targetPlanCode || '').toLowerCase(),
        changeType: preview.changeType,
        effectiveTiming: preview.effectiveTiming,
        message: 'Plan changes can only be initiated when the workspace subscription status is ACTIVE.',
        preview: {
          ...preview,
          allowed: false,
          blockReason: 'Subscription status is inactive or suspended.',
          blockerType: 'SUBSCRIPTION_INACTIVE',
        },
      };
    }

    // Resolve target plan DB record
    const { data: targetPlan } = await (supabase as any)
      .from('plans')
      .select('id, stable_key, code')
      .or(`stable_key.eq.${preview.targetPlanCode},code.eq.${preview.targetPlanCode}`)
      .maybeSingle();

    if (!targetPlan) {
      return {
        success: false,
        organizationId,
        targetPlanCode: preview.targetPlanCode,
        changeType: preview.changeType,
        effectiveTiming: preview.effectiveTiming,
        message: `Database record for target plan '${preview.targetPlanCode}' not found.`,
        preview: {
          ...preview,
          allowed: false,
          blockReason: 'Database plan metadata missing.',
          blockerType: 'INVALID_PLAN',
        },
      };
    }

    // If DOWNGRADE: schedule change at period end
    if (preview.changeType === 'DOWNGRADE') {
      const { data: sub } = await (supabase as any)
        .from('organization_subscriptions')
        .select('current_period_end')
        .eq('organization_id', organizationId)
        .single();

      return {
        success: true,
        organizationId,
        targetPlanCode: preview.targetPlanCode,
        changeType: 'DOWNGRADE',
        effectiveTiming: 'END_OF_PERIOD',
        scheduledAtPeriodEnd: true,
        currentPeriodEnd: sub?.current_period_end || null,
        message: `Downgrade to ${preview.targetPlanCode.toUpperCase()} scheduled at the end of the current billing period. Active user limit will become ${preview.targetMaxUsers} and phone limit will become ${preview.targetMaxNumbers}.`,
        preview,
      };
    }

    // If UPGRADE: update plan_id in DB (Development/Provisional preview execution)
    if (preview.changeType === 'UPGRADE') {
      await (supabase as any)
        .from('organization_subscriptions')
        .update({
          plan_id: targetPlan.id,
          updated_at: new Date().toISOString(),
        })
        .eq('organization_id', organizationId);

      return {
        success: true,
        organizationId,
        targetPlanCode: preview.targetPlanCode,
        changeType: 'UPGRADE',
        effectiveTiming: 'IMMEDIATE_PREVIEW',
        scheduledAtPeriodEnd: false,
        message: `Plan successfully upgraded to ${preview.targetPlanCode.toUpperCase()}. Active user limit is now ${preview.targetMaxUsers} and active number limit is now ${preview.targetMaxNumbers}.`,
        preview,
      };
    }

    return {
      success: true,
      organizationId,
      targetPlanCode: preview.targetPlanCode,
      changeType: 'SAME_PLAN',
      effectiveTiming: 'IMMEDIATE_PREVIEW',
      message: 'Workspace is already on the requested plan.',
      preview,
    };
  }

  /**
   * Synchronizes billable seat quantity for an organization.
   * Ensures active members are counted, invitations are excluded, and concurrency limits are respected.
   */
  static async syncBillableSeats(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<{ billableSeats: number; activeMembers: number; maxLimit: number | null }> {
    const supabase = clientOverride || (await createServerSupabaseClient());
    const seatMetrics = await SeatBillingService.calculateSeats(organizationId, supabase);
    return {
      billableSeats: seatMetrics.billableSeats,
      activeMembers: seatMetrics.activeMembers,
      maxLimit: seatMetrics.maxActiveUsersLimit,
    };
  }

  /**
   * Atomic check prior to inviting or accepting an invitation for a member.
   * Fails closed if invitation acceptance would exceed plan seat limits.
   */
  static async checkInviteSeatCapacity(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<{ allowed: boolean; activeMembers: number; limit: number | null; reason?: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const canIncrease = await SubscriptionPolicyService.mayIncreaseSeats(organizationId, supabase);
    if (!canIncrease) {
      return {
        allowed: false,
        activeMembers: 0,
        limit: 0,
        reason: 'Workspace subscription status is inactive or suspended. Cannot add seats.',
      };
    }

    return SeatBillingService.canAddActiveUser(organizationId, supabase);
  }

  /**
   * Requests SaaS subscription cancellation for an organization.
   * V1 policy: Sets cancel_at_period_end = true. Service remains active through paid period end.
   * Phone numbers are NOT released automatically and wallet balance is untouched.
   */
  static async requestSubscriptionCancellation(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<CancellationResult> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const { data: sub, error } = await (supabase as any)
      .from('organization_subscriptions')
      .select('id, status, current_period_end, cancel_at_period_end')
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error || !sub) {
      return {
        success: false,
        organizationId,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        message: 'No subscription record found to cancel.',
        assurances: {
          saasActiveUntilPeriodEnd: false,
          phoneNumbersPreserved: true,
          phoneNumbersSeparateLifecycle: true,
          telecomCreditPreserved: true,
          portOutRightsPreserved: true,
        },
      };
    }

    const nowIso = new Date().toISOString();
    await (supabase as any)
      .from('organization_subscriptions')
      .update({
        cancel_at_period_end: true,
        canceled_at: nowIso,
        updated_at: nowIso,
      })
      .eq('organization_id', organizationId);

    return {
      success: true,
      organizationId,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: sub.current_period_end || null,
      message: 'Subscription cancellation scheduled at the end of the current billing period.',
      assurances: {
        saasActiveUntilPeriodEnd: true,
        phoneNumbersPreserved: true,
        phoneNumbersSeparateLifecycle: true,
        telecomCreditPreserved: true,
        portOutRightsPreserved: true,
      },
    };
  }

  /**
   * Reactivates a canceled subscription before the period end.
   */
  static async reactivateSubscription(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<ReactivationResult> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const { data: sub, error } = await (supabase as any)
      .from('organization_subscriptions')
      .select('id, status, cancel_at_period_end')
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error || !sub) {
      return {
        success: false,
        organizationId,
        status: 'unknown',
        cancelAtPeriodEnd: false,
        message: 'Subscription record not found for reactivation.',
      };
    }

    const nowIso = new Date().toISOString();
    await (supabase as any)
      .from('organization_subscriptions')
      .update({
        cancel_at_period_end: false,
        canceled_at: null,
        status: 'active',
        updated_at: nowIso,
      })
      .eq('organization_id', organizationId);

    return {
      success: true,
      organizationId,
      status: 'active',
      cancelAtPeriodEnd: false,
      message: 'Subscription successfully reactivated.',
    };
  }
}
