import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Agent Presence & Heartbeat API.
 * Allows agents to switch availability status (available, busy, offline)
 * and sends periodic heartbeats updating last_seen_at.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const { status } = body;

    const adminSupabase = createAdminClient();

    const updates: Record<string, any> = {
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (status && ['available', 'busy', 'offline'].includes(status)) {
      updates.availability_status = status;
    }

    const { data: updatedProfile, error: updateError } = await (adminSupabase as any)
      .from('profiles')
      .update(updates)
      .eq('id', user.id)
      .select('id, full_name, email, role, availability_status, last_seen_at, twilio_identity, extension')
      .single();

    if (updateError) {
      console.error('[Presence API] Error updating presence:', updateError);
      return NextResponse.json({ error: 'Failed to update presence' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      profile: updatedProfile,
    });
  } catch (error: any) {
    console.error('[Presence API] Exception handling presence update:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: userProfile } = await supabase
      .from('profiles')
      .select('organization_id, availability_status, last_seen_at')
      .eq('id', user.id)
      .single();

    const profile = userProfile as { organization_id?: string; availability_status?: string; last_seen_at?: string } | null;

    if (!profile || !profile.organization_id) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 404 });
    }

    // Fetch team agents presence status
    const adminSupabase = createAdminClient();
    const { data: teamMembers } = await (adminSupabase as any)
      .from('profiles')
      .select('id, full_name, email, role, extension, availability_status, last_seen_at, active, twilio_identity')
      .eq('organization_id', profile.organization_id)
      .order('full_name', { ascending: true });

    return NextResponse.json({
      currentStatus: profile.availability_status || 'available',
      lastSeenAt: profile.last_seen_at,
      team: teamMembers || [],
    });
  } catch (error: any) {
    console.error('[Presence API] Exception handling GET presence:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
