import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { CommercialSubscriptionLifecycleService } from '@/lib/billing/commercialSubscriptionLifecycleService';

/**
 * POST /api/billing/subscription/cancel
 * Schedules SaaS subscription cancellation at the end of the paid period.
 * Does NOT release phone numbers automatically and does NOT wipe wallet balance.
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

    // 2. Fetch authenticated profile & role
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

    const role = (profile.role || '').toLowerCase();
    if (role !== 'owner' && role !== 'admin') {
      return NextResponse.json(
        { error: 'insufficient_permissions', message: 'Only workspace Owners or Admins can cancel subscription plans.' },
        { status: 403 }
      );
    }

    // 3. Execute cancellation scheduling
    const result = await CommercialSubscriptionLifecycleService.requestSubscriptionCancellation(
      profile.organization_id,
      supabase
    );

    if (!result.success) {
      return NextResponse.json(
        { error: 'cancellation_failed', message: result.message },
        { status: 400 }
      );
    }

    return NextResponse.json({
      result,
    });
  } catch (err: any) {
    console.error('[POST /api/billing/subscription/cancel] Exception:', err.message || err);
    return NextResponse.json(
      { error: 'internal_error', message: 'Internal server error processing cancellation request.' },
      { status: 500 }
    );
  }
}
