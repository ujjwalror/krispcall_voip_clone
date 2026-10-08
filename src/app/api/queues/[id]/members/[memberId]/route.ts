import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireEntitlement } from '@/lib/entitlements/server';
import { QueueService } from '@/lib/telephony/queueService';

/**
 * DELETE /api/queues/[id]/members/[memberId] - Remove an agent from a queue (Owner/Admin required).
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; memberId: string }> }
) {
  try {
    const { id: queueId, memberId } = await params;
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

    const result = await QueueService.removeQueueMember(
      userProfile.organization_id,
      queueId,
      memberId,
      supabase
    );

    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 400 });
    }

    return NextResponse.json({ message: result.message });
  } catch (error: any) {
    console.error('[Queues API] DELETE member error:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
