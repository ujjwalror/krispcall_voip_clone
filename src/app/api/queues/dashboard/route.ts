import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireEntitlement } from '@/lib/entitlements/server';
import { QueueService } from '@/lib/telephony/queueService';

/**
 * GET /api/queues/dashboard - Authoritative Live Queue Dashboard metrics endpoint.
 * Returns waiting callers, active calls, agent presence matrix, longest wait time, and abandoned today metric.
 */
export async function GET() {
  try {
    const entitlementRes = await requireEntitlement('call_queue');
    if (!entitlementRes.success) return entitlementRes.errorResponse;

    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single();

    const userProfile = profile as any;

    if (!userProfile?.organization_id) {
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    }

    const metrics = await QueueService.getDashboardMetrics(userProfile.organization_id, supabase);
    return NextResponse.json({ metrics });
  } catch (error: any) {
    console.error('[Queues Dashboard API] GET error:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
