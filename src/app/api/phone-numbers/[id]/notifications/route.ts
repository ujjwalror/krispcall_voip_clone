import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export interface NotificationSettingsDTO {
  id?: string;
  phone_number_id: string;
  organization_id: string;
  email_notifications_enabled: boolean;
  notify_new_message: boolean;
  notify_missed_call: boolean;
  notify_new_voicemail: boolean;
  recipient_mode: 'assigned_members' | 'workspace_admins' | 'all_members' | 'selected_users';
  recipient_user_ids: string[];
  created_at?: string;
  updated_at?: string;
}

/**
 * GET /api/phone-numbers/[id]/notifications
 * Fetches per-number email notification preferences and eligible active workspace recipients from public.profiles.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: phoneNumberId } = await params;
    if (!phoneNumberId) {
      return NextResponse.json({ error: 'Missing phone_number_id parameter' }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active !== true) {
      return NextResponse.json({ error: 'Active organization context not found' }, { status: 403 });
    }

    // Verify phone number ownership
    const { data: phoneNumber } = await (supabase as any)
      .from('phone_numbers')
      .select('id, organization_id, phone_number, friendly_name')
      .eq('id', phoneNumberId)
      .eq('organization_id', profile.organization_id)
      .maybeSingle();

    if (!phoneNumber) {
      return NextResponse.json(
        { error: 'not_found', message: 'Phone number not found or access denied.' },
        { status: 404 }
      );
    }

    const adminDb = createAdminClient();

    // Fetch existing notification settings if any
    const { data: existingSettings } = await (adminDb as any)
      .from('number_notification_settings')
      .select('*')
      .eq('phone_number_id', phoneNumberId)
      .eq('organization_id', profile.organization_id)
      .maybeSingle();

    const settings: NotificationSettingsDTO = existingSettings || {
      phone_number_id: phoneNumberId,
      organization_id: profile.organization_id,
      email_notifications_enabled: true,
      notify_new_message: true,
      notify_missed_call: true,
      notify_new_voicemail: true,
      recipient_mode: 'assigned_members',
      recipient_user_ids: [],
    };

    // Fetch eligible active workspace profiles (same organization)
    const { data: activeProfiles } = await (adminDb as any)
      .from('profiles')
      .select('id, full_name, email, role, active')
      .eq('organization_id', profile.organization_id)
      .eq('active', true);

    const availableRecipients = (activeProfiles || []).map((p: any) => ({
      id: p.id,
      full_name: p.full_name || 'Team Member',
      email: p.email || '',
      role: p.role || 'agent',
    }));

    // Resolve active recipient targets according to recipient_mode
    let resolvedRecipients: any[] = [];
    if (settings.recipient_mode === 'assigned_members') {
      const { data: assignments } = await (adminDb as any)
        .from('user_phone_assignments')
        .select('user_id')
        .eq('phone_number_id', phoneNumberId)
        .eq('organization_id', profile.organization_id);

      const assignedUserIds = new Set((assignments || []).map((a: any) => a.user_id));
      resolvedRecipients = availableRecipients.filter((p: any) => assignedUserIds.has(p.id));
    } else if (settings.recipient_mode === 'workspace_admins') {
      resolvedRecipients = availableRecipients.filter(
        (p: any) => p.role === 'owner' || p.role === 'admin'
      );
    } else if (settings.recipient_mode === 'all_members') {
      resolvedRecipients = availableRecipients;
    } else if (settings.recipient_mode === 'selected_users') {
      const selectedSet = new Set(settings.recipient_user_ids || []);
      resolvedRecipients = availableRecipients.filter((p: any) => selectedSet.has(p.id));
    }

    return NextResponse.json({
      settings,
      availableRecipients,
      resolvedRecipients,
      deliveryStatus: 'NOT_READY',
      deliveryNotes:
        'Notification preferences saved. Production email delivery provider (SMTP/API credentials) required for live email dispatch.',
    });
  } catch (err: any) {
    console.error('[NotificationsAPI] GET error:', err);
    return NextResponse.json(
      { error: err?.message || 'Failed to fetch notification settings' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/phone-numbers/[id]/notifications
 * Updates per-number email notification preferences with strict same-workspace recipient validation via public.profiles.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: phoneNumberId } = await params;
    if (!phoneNumberId) {
      return NextResponse.json({ error: 'Missing phone_number_id parameter' }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active !== true) {
      return NextResponse.json({ error: 'Active organization context not found' }, { status: 403 });
    }

    const userRole = (profile.role || '').toLowerCase();
    if (userRole !== 'owner' && userRole !== 'admin') {
      return NextResponse.json(
        { error: 'forbidden', message: 'Managing notification preferences requires Owner or Admin role.' },
        { status: 403 }
      );
    }

    // Verify phone number ownership
    const { data: phoneNumber } = await (supabase as any)
      .from('phone_numbers')
      .select('id, organization_id')
      .eq('id', phoneNumberId)
      .eq('organization_id', profile.organization_id)
      .maybeSingle();

    if (!phoneNumber) {
      return NextResponse.json(
        { error: 'not_found', message: 'Phone number not found or access denied.' },
        { status: 404 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const {
      email_notifications_enabled = true,
      notify_new_message = true,
      notify_missed_call = true,
      notify_new_voicemail = true,
      recipient_mode = 'assigned_members',
      recipient_user_ids = [],
    } = body;

    const adminDb = createAdminClient();

    // Enforce recipient mode consistency: non-selected modes must use empty array
    let validUserIds: string[] = [];
    if (recipient_mode === 'selected_users') {
      if (Array.isArray(recipient_user_ids) && recipient_user_ids.length > 0) {
        // Query public.profiles strictly for active members belonging to the same organization
        const { data: validProfiles } = await (adminDb as any)
          .from('profiles')
          .select('id')
          .eq('organization_id', profile.organization_id)
          .eq('active', true)
          .in('id', recipient_user_ids);

        const validSet = new Set((validProfiles || []).map((p: any) => p.id));
        for (const reqUid of recipient_user_ids) {
          if (!validSet.has(reqUid)) {
            return NextResponse.json(
              {
                error: 'CROSS_TENANT_RECIPIENT_REJECTED',
                message: 'One or more recipient users are invalid, inactive, or do not belong to your workspace.',
              },
              { status: 400 }
            );
          }
        }
        validUserIds = recipient_user_ids;
      }
    } else {
      // Non-selected modes require empty recipient array
      validUserIds = [];
    }

    // Upsert into number_notification_settings
    const { data: saved, error: saveErr } = await (adminDb as any)
      .from('number_notification_settings')
      .upsert(
        {
          organization_id: profile.organization_id,
          phone_number_id: phoneNumberId,
          email_notifications_enabled: Boolean(email_notifications_enabled),
          notify_new_message: Boolean(notify_new_message),
          notify_missed_call: Boolean(notify_missed_call),
          notify_new_voicemail: Boolean(notify_new_voicemail),
          recipient_mode,
          recipient_user_ids: validUserIds,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'phone_number_id' }
      )
      .select('*')
      .single();

    if (saveErr) {
      console.error('[NotificationsAPI] Save error:', saveErr);
      return NextResponse.json(
        { error: 'DATABASE_ERROR', message: 'Failed to persist notification settings.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      settings: saved,
      deliveryStatus: 'NOT_READY',
      deliveryNotes:
        'Preferences updated successfully. Email delivery status is currently NOT_READY until SMTP provider service is configured.',
    });
  } catch (err: any) {
    console.error('[NotificationsAPI] POST error:', err);
    return NextResponse.json(
      { error: err?.message || 'Failed to update notification settings' },
      { status: 500 }
    );
  }
}
