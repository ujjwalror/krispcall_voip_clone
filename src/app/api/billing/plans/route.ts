import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { CatalogService } from '@/lib/billing/catalogService';

export async function GET() {
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

    // 2. Fetch authenticated profile to verify workspace membership
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

    // 3. Query published commercial plans
    const publishedPlans = await CatalogService.getPublishedPlans(supabase);

    return NextResponse.json({
      success: true,
      plans: publishedPlans,
    });
  } catch (err: any) {
    console.error('[API /api/billing/plans] Error fetching published catalog:', err.message || err);
    return NextResponse.json(
      { error: 'Internal server error fetching catalog.', code: 'server_error' },
      { status: 500 }
    );
  }
}
