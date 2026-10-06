import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Resolve authenticated organization ID from server context
    const { data: profile } = await supabase
      .from('profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single();

    const profileAny = profile as any;
    if (!profileAny?.organization_id) {
      return NextResponse.json(
        { error: 'Organization context not found' },
        { status: 403 }
      );
    }

    const orgId = profileAny.organization_id;
    const adminClient = createAdminClient();

    // Query notifications strictly scoped to authenticated tenant orgId
    const { data: rawRows, error: fetchErr } = await (adminClient as any)
      .from('number_lifecycle_notifications')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (fetchErr) {
      console.error('[API /notifications/lifecycle] Fetch error:', fetchErr);
      return NextResponse.json({ notifications: [], unreadCount: 0 }, { status: 200 });
    }

    const items = (rawRows || []).map((row: any) => {
      const meta = row.metadata || {};
      const isRead = Boolean(meta.readAt);
      const isAcknowledged = Boolean(meta.acknowledgedAt);

      // Determine severity from event type
      let severity: 'high' | 'medium' | 'low' = 'low';
      if (
        row.event_type === 'release_pending_warning' ||
        row.event_type === 'final_surrender_notice' ||
        row.event_type === 'number_released'
      ) {
        severity = 'high';
      } else if (
        row.event_type === 'past_due_warning' ||
        row.event_type === 'suspension_warning' ||
        row.event_type === 'service_suspended'
      ) {
        severity = 'medium';
      }

      return {
        id: row.id,
        organizationId: row.organization_id,
        phoneNumberId: row.phone_number_id,
        phoneNumberE164: row.phone_number_e164,
        eventType: row.event_type,
        channel: row.channel,
        deliveryStatus: row.delivery_status,
        createdAt: row.created_at,
        deliveredAt: row.delivered_at,
        severity,
        read: isRead,
        readAt: meta.readAt || null,
        acknowledged: isAcknowledged,
        acknowledgedAt: meta.acknowledgedAt || null,
        metadata: meta,
      };
    });

    const unreadCount = items.filter((item: any) => !item.read).length;

    return NextResponse.json({
      notifications: items,
      unreadCount,
    });
  } catch (err: any) {
    console.error('[API /notifications/lifecycle] GET Exception:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single();

    const profileAny = profile as any;
    if (!profileAny?.organization_id) {
      return NextResponse.json(
        { error: 'Organization context not found' },
        { status: 403 }
      );
    }

    const orgId = profileAny.organization_id;
    const body = await req.json();
    const { notificationId, action } = body || {};

    if (!notificationId || !['read', 'acknowledge'].includes(action)) {
      return NextResponse.json(
        { error: 'Missing notificationId or valid action (read | acknowledge)' },
        { status: 400 }
      );
    }

    const adminClient = createAdminClient();

    // Verify row exists AND strictly belongs to authenticated organizationId
    const { data: existing, error: selectErr } = await (adminClient as any)
      .from('number_lifecycle_notifications')
      .select('*')
      .eq('id', notificationId)
      .maybeSingle();

    if (selectErr || !existing) {
      return NextResponse.json({ error: 'Notification not found' }, { status: 404 });
    }

    // STRICT TENANT ISOLATION: Cross-tenant notification mutation strictly rejected
    if (existing.organization_id !== orgId) {
      return NextResponse.json(
        { error: 'Forbidden: Cannot modify another tenant notification' },
        { status: 403 }
      );
    }

    const currentMeta = existing.metadata || {};
    const nowIso = new Date().toISOString();

    let updatedMeta = { ...currentMeta };

    if (action === 'read') {
      // Idempotent read handling
      if (!updatedMeta.readAt) {
        updatedMeta.readAt = nowIso;
        updatedMeta.readBy = user.id;
      }
    } else if (action === 'acknowledge') {
      // Idempotent acknowledgement handling
      if (!updatedMeta.readAt) {
        updatedMeta.readAt = nowIso;
        updatedMeta.readBy = user.id;
      }
      if (!updatedMeta.acknowledgedAt) {
        updatedMeta.acknowledgedAt = nowIso;
        updatedMeta.acknowledgedBy = user.id;
      }
    }

    const { data: updatedRow, error: updateErr } = await (adminClient as any)
      .from('number_lifecycle_notifications')
      .update({
        metadata: updatedMeta,
        delivery_status: 'delivered',
        delivered_at: existing.delivered_at || nowIso,
      })
      .eq('id', notificationId)
      .eq('organization_id', orgId)
      .select()
      .single();

    if (updateErr || !updatedRow) {
      return NextResponse.json({ error: 'Failed to update notification state' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      notification: {
        id: updatedRow.id,
        organizationId: updatedRow.organization_id,
        phoneNumberId: updatedRow.phone_number_id,
        phoneNumberE164: updatedRow.phone_number_e164,
        eventType: updatedRow.event_type,
        read: Boolean(updatedMeta.readAt),
        readAt: updatedMeta.readAt || null,
        acknowledged: Boolean(updatedMeta.acknowledgedAt),
        acknowledgedAt: updatedMeta.acknowledgedAt || null,
        metadata: updatedMeta,
      },
    });
  } catch (err: any) {
    console.error('[API /notifications/lifecycle] POST Exception:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
