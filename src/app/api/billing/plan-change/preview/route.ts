import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { CommercialSubscriptionLifecycleService } from '@/lib/billing/commercialSubscriptionLifecycleService';

/**
 * POST /api/billing/plan-change/preview
 * Accepts { plan_stable_key, billing_interval } from authenticated user.
 * Returns server-authoritative preview calculation of active users, active numbers,
 * provisional SaaS financial amounts, downgrade safety checks, and interval validations.
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

    // 2. Resolve profile and organization_id
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

    // 3. Parse request payload safely
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

    // 4. Calculate server-authoritative plan selection preview
    const preview = await CommercialSubscriptionLifecycleService.selectPlanAndPreview(
      profile.organization_id,
      targetPlanCode,
      billingInterval,
      supabase
    );

    return NextResponse.json({
      preview,
    });
  } catch (err: any) {
    console.error('[POST /api/billing/plan-change/preview] Exception:', err.message || err);
    return NextResponse.json(
      { error: 'internal_error', message: 'Internal server error calculating plan preview.' },
      { status: 500 }
    );
  }
}
