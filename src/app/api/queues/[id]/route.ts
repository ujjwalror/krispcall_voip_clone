import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireEntitlement } from '@/lib/entitlements/server';
import { QueueService } from '@/lib/telephony/queueService';

/**
 * GET /api/queues/[id] - Get queue details.
 * PATCH /api/queues/[id] - Update queue (Owner/Admin).
 * DELETE /api/queues/[id] - Disable queue (Owner/Admin).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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

    const queue = await QueueService.getQueue(userProfile.organization_id, id, supabase);
    if (!queue) {
      return NextResponse.json({ error: 'Queue not found' }, { status: 404 });
    }

    return NextResponse.json({ queue });
  } catch (error: any) {
    console.error('[Queues API] GET [id] error:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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
    const result = await QueueService.updateQueue(userProfile.organization_id, id, body, supabase);

    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 400 });
    }

    return NextResponse.json({ queue: result.queue, message: result.message });
  } catch (error: any) {
    console.error('[Queues API] PATCH [id] error:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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

    const result = await QueueService.deleteQueue(userProfile.organization_id, id, supabase);
    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 400 });
    }

    return NextResponse.json({ message: result.message });
  } catch (error: any) {
    console.error('[Queues API] DELETE [id] error:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
