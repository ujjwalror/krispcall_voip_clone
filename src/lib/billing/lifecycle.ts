import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { Database } from '@/lib/types/database.types';

export type SubscriptionRow = Database['public']['Tables']['organization_subscriptions']['Row'];
export type PriceRow = Database['public']['Tables']['prices']['Row'];

export interface RecurringCostPreviewResult {
  currency: string;
  pricingModel: 'per_seat' | 'base_plus_seat' | 'flat' | 'custom';
  isCalculable: boolean;
  totalAmountMinorBigInt: bigint | null;
  totalAmountMinorString: string | null;
  unitAmountMinorString: string | null;
  baseAmountMinorString: string | null;
  billableSeatCount: number;
}

export interface SubscriptionPeriodInfo {
  billingInterval: 'monthly' | 'annual' | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  hasFuturePeriodBoundary: boolean;
  isScheduledToCancel: boolean;
  canceledAt: string | null;
  endedAt: string | null;
}

export type ActiveSeatCountError =
  | 'unauthorized'
  | 'profile_not_found'
  | 'profile_inactive'
  | 'database_error';

export type GetActiveSeatCountResult =
  | { success: true; organizationId: string; activeSeatCount: number }
  | { success: false; error: ActiveSeatCountError; message: string };

/**
 * Tenant-safe server-side helper to count active seats for the currently authenticated user's organization.
 * Derives organization identity strictly from auth.uid() -> profiles.organization_id.
 */
export async function getAuthenticatedOrganizationActiveSeatCount(
  clientOverride?: SupabaseClient
): Promise<GetActiveSeatCountResult> {
  try {
    const supabase = clientOverride || (await createServerSupabaseClient());

    // 1. Authenticate user
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return {
        success: false,
        error: 'unauthorized',
        message: 'Unauthorized. Authenticated user session required.',
      };
    }

    // 2. Fetch authenticated user profile
    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('organization_id, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id) {
      return {
        success: false,
        error: 'profile_not_found',
        message: 'User profile or organization assignment not found.',
      };
    }

    if (profile.active === false) {
      return {
        success: false,
        error: 'profile_inactive',
        message: 'User profile account is currently inactive.',
      };
    }

    const count = await getActiveSeatCountForOrgId(profile.organization_id, supabase);

    return {
      success: true,
      organizationId: profile.organization_id,
      activeSeatCount: count,
    };
  } catch (err: any) {
    console.error('[Billing Lifecycle] Exception fetching active seat count:', err.message || err);
    return {
      success: false,
      error: 'database_error',
      message: 'Internal server error resolving active seat count.',
    };
  }
}

/**
 * Internal/Server helper to count active seats for a specific organization ID using a provided Supabase client.
 * Counts active profiles belonging to the roles: owner, admin, manager, agent.
 */
export async function getActiveSeatCountForOrgId(
  organizationId: string,
  supabase: SupabaseClient
): Promise<number> {
  const { count, error } = await (supabase as any)
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('active', true);

  if (error) {
    console.error('[Billing Lifecycle] Database error counting active seats:', error.message);
    throw new Error(`Failed to count active seats for org ${organizationId}: ${error.message}`);
  }

  return count || 0;
}

/**
 * Calculates recurring monetary cost preview in integer minor units (BigInt).
 * Prevents floating-point precision loss.
 */
export function calculateRecurringCostPreview(
  price: Pick<PriceRow, 'currency' | 'pricing_model' | 'unit_amount_minor' | 'base_amount_minor'>,
  activeSeatCount: number,
  seatsIncluded: number = 0
): RecurringCostPreviewResult {
  const currency = price.currency || 'USD';
  const pricingModel = price.pricing_model;

  const sanitizeSeats = (val: number): bigint => {
    if (!Number.isFinite(val) || val < 0) return BigInt(0);
    return BigInt(Math.floor(val));
  };

  const sanitizeMinorAmount = (val: number | null): bigint | null => {
    if (val === null || val === undefined || !Number.isFinite(val) || val < 0) return null;
    return BigInt(Math.round(val));
  };

  const seatCountBigInt = sanitizeSeats(activeSeatCount);
  const seatsIncludedBigInt = sanitizeSeats(seatsIncluded);

  const unitAmountBigInt = sanitizeMinorAmount(price.unit_amount_minor);
  const baseAmountBigInt = sanitizeMinorAmount(price.base_amount_minor);

  const unitAmountStr = unitAmountBigInt !== null ? unitAmountBigInt.toString() : null;
  const baseAmountStr = baseAmountBigInt !== null ? baseAmountBigInt.toString() : null;

  if (pricingModel === 'per_seat') {
    if (unitAmountBigInt === null) {
      return {
        currency,
        pricingModel,
        isCalculable: false,
        totalAmountMinorBigInt: null,
        totalAmountMinorString: null,
        unitAmountMinorString: unitAmountStr,
        baseAmountMinorString: baseAmountStr,
        billableSeatCount: activeSeatCount,
      };
    }

    const total = seatCountBigInt * unitAmountBigInt;
    return {
      currency,
      pricingModel,
      isCalculable: true,
      totalAmountMinorBigInt: total,
      totalAmountMinorString: total.toString(),
      unitAmountMinorString: unitAmountStr,
      baseAmountMinorString: baseAmountStr,
      billableSeatCount: activeSeatCount,
    };
  }

  if (pricingModel === 'base_plus_seat') {
    if (unitAmountBigInt === null || baseAmountBigInt === null) {
      return {
        currency,
        pricingModel,
        isCalculable: false,
        totalAmountMinorBigInt: null,
        totalAmountMinorString: null,
        unitAmountMinorString: unitAmountStr,
        baseAmountMinorString: baseAmountStr,
        billableSeatCount: Math.max(0, activeSeatCount - seatsIncluded),
      };
    }

    const billableAdditionalSeats =
      seatCountBigInt > seatsIncludedBigInt ? seatCountBigInt - seatsIncludedBigInt : BigInt(0);

    const total = baseAmountBigInt + billableAdditionalSeats * unitAmountBigInt;

    return {
      currency,
      pricingModel,
      isCalculable: true,
      totalAmountMinorBigInt: total,
      totalAmountMinorString: total.toString(),
      unitAmountMinorString: unitAmountStr,
      baseAmountMinorString: baseAmountStr,
      billableSeatCount: Number(billableAdditionalSeats),
    };
  }

  if (pricingModel === 'flat') {
    if (baseAmountBigInt === null) {
      return {
        currency,
        pricingModel,
        isCalculable: false,
        totalAmountMinorBigInt: null,
        totalAmountMinorString: null,
        unitAmountMinorString: unitAmountStr,
        baseAmountMinorString: baseAmountStr,
        billableSeatCount: 0,
      };
    }

    return {
      currency,
      pricingModel,
      isCalculable: true,
      totalAmountMinorBigInt: baseAmountBigInt,
      totalAmountMinorString: baseAmountBigInt.toString(),
      unitAmountMinorString: unitAmountStr,
      baseAmountMinorString: baseAmountStr,
      billableSeatCount: 0,
    };
  }

  // custom or unhandled pricing model
  return {
    currency,
    pricingModel,
    isCalculable: false,
    totalAmountMinorBigInt: null,
    totalAmountMinorString: null,
    unitAmountMinorString: unitAmountStr,
    baseAmountMinorString: baseAmountStr,
    billableSeatCount: 0,
  };
}

/**
 * Returns read-only subscription period information.
 * Does not invent renewal dates or assume cancellation policy.
 */
export function getSubscriptionPeriodInfo(
  subscription: Pick<
    SubscriptionRow,
    | 'current_period_start'
    | 'current_period_end'
    | 'cancel_at_period_end'
    | 'canceled_at'
    | 'ended_at'
    | 'price_id'
  >,
  price?: Pick<PriceRow, 'billing_interval'> | null
): SubscriptionPeriodInfo {
  const billingInterval = price?.billing_interval || null;

  let hasFuturePeriodBoundary = false;
  if (
    subscription.price_id &&
    subscription.current_period_end &&
    new Date(subscription.current_period_end).getTime() > Date.now()
  ) {
    hasFuturePeriodBoundary = true;
  }

  return {
    billingInterval,
    currentPeriodStart: subscription.current_period_start,
    currentPeriodEnd: subscription.current_period_end,
    hasFuturePeriodBoundary,
    isScheduledToCancel: subscription.cancel_at_period_end === true,
    canceledAt: subscription.canceled_at ?? null,
    endedAt: subscription.ended_at ?? null,
  };
}
