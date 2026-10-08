import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireEntitlement } from '@/lib/entitlements/server';
import { QueueService } from '@/lib/telephony/queueService';

/**
 * POST /api/queues/[id]/members - Add an agent to a queue (Owner/Admin required).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: queueId } = await params;
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
    const { userId, priority } = body;

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }

    const result = await QueueService.addQueueMember(
      userProfile.organization_id,
      queueId,
      userId,
      priority || 1,
      supabase
    );

    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 400 });
    }

    return NextResponse.json({ member: result.member, message: result.message }, { status: 201 });
  } catch (error: any) {
    console.error('[Queues API] POST member error:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
