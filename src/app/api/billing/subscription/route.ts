import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getOrganizationEntitlements } from '@/lib/entitlements/server';
import {
  getActiveSeatCountForOrgId,
  calculateRecurringCostPreview,
  getSubscriptionPeriodInfo,
} from '@/lib/billing/lifecycle';

/**
 * GET /api/billing/subscription
 * Read-only server endpoint that returns the canonical subscription summary
 * for the currently authenticated user's organization.
 * Strictly derives organization identity server-side from auth.uid() -> profiles.organization_id.
 */
export async function GET() {
  try {
    const supabase = await createServerSupabaseClient();

    // 1. Authenticate user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    // 2. Fetch authenticated profile & organization_id
    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('organization_id, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id) {
      return NextResponse.json(
        { error: 'profile_not_found', message: 'User profile or organization assignment not found.' },
        { status: 404 }
      );
    }

    if (profile.active === false) {
      return NextResponse.json(
        { error: 'profile_inactive', message: 'User profile account is currently inactive.' },
        { status: 403 }
      );
    }

    const orgId = profile.organization_id;

    // 3. Fetch Organization Subscription
    const { data: subscription, error: subError } = await (supabase as any)
      .from('organization_subscriptions')
      .select(
        'id, organization_id, plan_id, price_id, status, current_period_start, current_period_end, trial_ends_at, cancel_at_period_end, canceled_at, ended_at, created_at, updated_at'
      )
      .eq('organization_id', orgId)
      .maybeSingle();

    if (subError || !subscription) {
      return NextResponse.json(
        { error: 'subscription_missing', message: 'No subscription record found for this organization.' },
        { status: 404 }
      );
    }

    // 4. Fetch Plan metadata
    const { data: plan, error: planError } = await (supabase as any)
      .from('plans')
      .select('id, code, name, description, is_active, is_public')
      .eq('id', subscription.plan_id)
      .maybeSingle();

    if (planError || !plan) {
      return NextResponse.json(
        { error: 'plan_missing', message: 'Subscription refers to an invalid or missing plan.' },
        { status: 404 }
      );
    }

    // 5. Fetch Price metadata (if price_id is set)
    let priceData: any = null;
    if (subscription.price_id) {
      const { data: price, error: priceError } = await (supabase as any)
        .from('prices')
        .select(
          'id, plan_id, currency, billing_interval, pricing_model, unit_amount_minor, base_amount_minor, is_active'
        )
        .eq('id', subscription.price_id)
        .maybeSingle();

      if (!priceError && price) {
        priceData = price;
      }
    }

    // 6. Resolve Active Seat Count & Entitlements
    const activeSeatCount = await getActiveSeatCountForOrgId(orgId, supabase);
    const entsResult = await getOrganizationEntitlements(supabase);

    let seatsIncluded: number | null = null;
    let seatsMax: number | null = null;

    if (entsResult.success) {
      const includedEnt = entsResult.entitlements['team.seats.included'];
      const maxEnt = entsResult.entitlements['team.seats.max'];
      seatsIncluded = includedEnt?.numericValue ?? null;
      seatsMax = maxEnt?.numericValue ?? null;
    }

    // 7. Calculate Recurring Cost Preview if priced
    let recurringCostPreviewObj: any = null;
    if (priceData) {
      const costPreview = calculateRecurringCostPreview(
        priceData,
        activeSeatCount,
        seatsIncluded ?? 0
      );
      recurringCostPreviewObj = {
        currency: costPreview.currency,
        amountMinor: costPreview.totalAmountMinorString,
        isCalculable: costPreview.isCalculable,
        pricingModel: costPreview.pricingModel,
      };
    }

    // 8. Period & Cancellation Information
    const periodInfo = getSubscriptionPeriodInfo(subscription, priceData);

    const isInternalNonBillable = subscription.price_id === null;

    // 9. Format response model (decimal strings for monetary minor units)
    const priceObj = priceData
      ? {
          id: priceData.id,
          currency: priceData.currency,
          billingInterval: priceData.billing_interval,
          pricingModel: priceData.pricing_model,
          unitAmountMinor:
            priceData.unit_amount_minor !== null && priceData.unit_amount_minor !== undefined
              ? String(Math.round(priceData.unit_amount_minor))
              : null,
          baseAmountMinor:
            priceData.base_amount_minor !== null && priceData.base_amount_minor !== undefined
              ? String(Math.round(priceData.base_amount_minor))
              : null,
        }
      : null;

    return NextResponse.json({
      subscription: {
        status: subscription.status,
        plan: {
          code: plan.code,
          name: plan.name,
          description: plan.description,
          isPublic: plan.is_public,
        },
        price: priceObj,
        period: {
          start: periodInfo.currentPeriodStart,
          end: periodInfo.currentPeriodEnd,
          hasFutureBoundary: periodInfo.hasFuturePeriodBoundary,
        },
        cancellation: {
          scheduledAtPeriodEnd: periodInfo.isScheduledToCancel,
          canceledAt: periodInfo.canceledAt,
          endedAt: periodInfo.endedAt,
        },
        seats: {
          active: activeSeatCount,
          included: seatsIncluded,
          maximum: seatsMax,
        },
        recurringCostPreview: recurringCostPreviewObj,
        isInternalNonBillable,
      },
    });
  } catch (err: any) {
    console.error('[GET /api/billing/subscription] Exception:', err.message || err);
    return NextResponse.json(
      { error: 'internal_error', message: 'Internal server error resolving subscription summary.' },
      { status: 500 }
    );
  }
}
