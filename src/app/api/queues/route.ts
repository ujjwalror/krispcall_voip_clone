import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireEntitlement } from '@/lib/entitlements/server';
import { QueueService } from '@/lib/telephony/queueService';

/**
 * GET /api/queues - List all call queues for the organization.
 * POST /api/queues - Create a new call queue (Owner/Admin required).
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

    const queues = await QueueService.listQueues(userProfile.organization_id, supabase);
    return NextResponse.json({ queues });
  } catch (error: any) {
    console.error('[Queues API] GET error:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
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
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    const userProfile = profile as any;

    if (!userProfile?.organization_id) {
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    }

    if (!['owner', 'admin'].includes(userProfile.role || '')) {
      return NextResponse.json({ error: 'Forbidden: Owner or Admin role required' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const result = await QueueService.createQueue(userProfile.organization_id, body, supabase);

    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 400 });
    }

    return NextResponse.json({ queue: result.queue, message: result.message }, { status: 201 });
  } catch (error: any) {
    console.error('[Queues API] POST error:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
