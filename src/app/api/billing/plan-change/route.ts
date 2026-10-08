import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { CommercialSubscriptionLifecycleService } from '@/lib/billing/commercialSubscriptionLifecycleService';

/**
 * POST /api/billing/plan-change
 * Accepts { plan_stable_key, billing_interval } from authenticated workspace Owner/Admin.
 * Validates target limits, checks downgrade safety, computes server financial preview,
 * and schedules or executes plan change while keeping live Stripe charges gated.
 */
export async function POST(request: Request) {
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
    const { data: profile } = await (supabase as any)
      .from('profiles')
      .select('organization_id, active, role')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'unauthorized_profile', message: 'Active profile and organization assignment required.' },
        { status: 403 }
      );
    }

    // Verify role (Owner or Admin required for plan change)
    const role = (profile.role || '').toLowerCase();
    if (role !== 'owner' && role !== 'admin') {
      return NextResponse.json(
        { error: 'insufficient_permissions', message: 'Only workspace Owners or Admins can change subscription plans.' },
        { status: 403 }
      );
    }

    // 3. Parse payload
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'invalid_json', message: 'Malformed JSON payload.' },
        { status: 400 }
      );
    }

    const targetPlanCode = (body.plan_stable_key || body.planCode || body.targetPlanCode || '').toString();
    const billingInterval = (body.billing_interval || body.billingInterval || 'monthly').toString();

    if (!targetPlanCode) {
      return NextResponse.json(
        { error: 'missing_target_plan', message: 'Target plan code (plan_stable_key) is required.' },
        { status: 400 }
      );
    }

    // 4. Request server-side plan change execution
    const result = await CommercialSubscriptionLifecycleService.requestPlanChange(
      profile.organization_id,
      targetPlanCode,
      billingInterval,
      supabase
    );

    if (!result.success) {
      return NextResponse.json(
        {
          error: result.preview?.blockerType || 'plan_change_blocked',
          message: result.message,
          preview: result.preview,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      result,
    });
  } catch (err: any) {
    console.error('[POST /api/billing/plan-change] Exception:', err.message || err);
    return NextResponse.json(
      { error: 'internal_error', message: 'Internal server error processing plan change request.' },
      { status: 500 }
    );
  }
}
