import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { CommercialCatalogService } from '@/lib/billing/commercialCatalog';

/**
 * POST /api/billing/downgrade-check
 * Evaluates downgrade compatibility and safety against target plan limits.
 * Guarantees NO automatic release of numbers or deactivation of users occurs.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();

    // 1. Authenticate session
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized. Authenticated user session required.', code: 'unauthorized' },
        { status: 401 }
      );
    }

    // 2. Resolve user profile
    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('organization_id, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'Forbidden. Active workspace profile required.', code: 'forbidden' },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const targetPlanCode = (body.targetPlanCode || body.planCode || '').trim();

    if (!targetPlanCode) {
      return NextResponse.json(
        { error: 'Bad Request. targetPlanCode is required.', code: 'invalid_params' },
        { status: 400 }
      );
    }

    // 3. Evaluate downgrade safety through CommercialCatalogService
    const result = await CommercialCatalogService.checkDowngradeEligibility(
      profile.organization_id,
      targetPlanCode,
      supabase
    );

    return NextResponse.json({
      success: true,
      eligibility: result,
    });
  } catch (err: any) {
    console.error('[API /api/billing/downgrade-check] Exception:', err.message || err);
    return NextResponse.json(
      { error: 'Internal server error checking downgrade eligibility.', code: 'server_error' },
      { status: 500 }
    );
  }
}
