import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { createAdminClient } from '@/lib/supabase/admin';
import { NumberSubscriptionService } from '@/lib/telephony/marketplace/numberSubscriptionService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try {
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    // Server-authoritative organization & role resolution
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'FORBIDDEN: Active organization profile required.', code: 'forbidden' },
        { status: 403 }
      );
    }

    // SERVER-AUTHORITATIVE TENANT ISOLATION:
    // Ignore any browser-supplied organization_id parameter! Use profile.organization_id exclusively.
    const organizationId = profile.organization_id;
    const adminSupabase = createAdminClient();

    const summary = await NumberSubscriptionService.getOrganizationSubscriptions(organizationId, adminSupabase);

    return NextResponse.json(summary, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      },
    });
  } catch (error: any) {
    console.error('[GET /api/billing/numbers] Error fetching number subscriptions:', error.message || error);
    return NextResponse.json(
      {
        error: 'NUMBER_SUBSCRIPTIONS_UNAVAILABLE',
        message: 'Number subscriptions temporarily unavailable.',
      },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      }
    );
  }
}
