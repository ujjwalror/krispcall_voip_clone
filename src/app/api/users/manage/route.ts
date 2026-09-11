import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Workspace User Management API for Admins and Managers.
 * Allows viewing workspace members, updating roles, extensions, active state, and routing strategy.
 */
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

    const { data: profileData } = await supabase
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    const profile = profileData as { organization_id?: string; role?: string } | null;

    if (!profile || !profile.organization_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const adminSupabase = createAdminClient();

    // Fetch workspace details & routing strategy
    const { data: orgData } = await (adminSupabase as any)
      .from('organizations')
      .select('id, name, slug, routing_strategy')
      .eq('id', profile.organization_id)
      .single();

    // Fetch all workspace users
    const { data: members } = await (adminSupabase as any)
      .from('profiles')
      .select('id, full_name, email, role, active, extension, twilio_identity, availability_status, last_seen_at, created_at')
      .eq('organization_id', profile.organization_id)
      .order('created_at', { ascending: true });

    return NextResponse.json({
      organization: orgData,
      currentUserRole: profile.role,
      members: members || [],
    });
  } catch (error: any) {
    console.error('[User Management API] GET exception:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

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

    // Verify admin / manager permissions
    const { data: profileData } = await supabase
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    const profile = profileData as { organization_id?: string; role?: string } | null;

    if (!profile || !profile.organization_id || !profile.role || !['admin', 'manager'].includes(profile.role)) {
      return NextResponse.json({ error: 'Forbidden. Admin or Manager role required.' }, { status: 403 });
    }

    const body = await request.json();
    const { action, userId, role, extension, active, routingStrategy } = body;

    const adminSupabase = createAdminClient();

    if (action === 'update_routing') {
      if (!['ring_all', 'round_robin'].includes(routingStrategy)) {
        return NextResponse.json({ error: 'Invalid routing strategy' }, { status: 400 });
      }

      await (adminSupabase as any)
        .from('organizations')
        .update({ routing_strategy: routingStrategy, updated_at: new Date().toISOString() })
        .eq('id', profile.organization_id);

      return NextResponse.json({ success: true, routingStrategy });
    }

    if (action === 'update_member' && userId) {
      const { fullName } = body;
      const updates: Record<string, any> = { updated_at: new Date().toISOString() };
      if (fullName && typeof fullName === 'string') updates.full_name = fullName.trim();
      if (role && ['admin', 'manager', 'agent'].includes(role)) updates.role = role;
      if (typeof active === 'boolean') updates.active = active;

      if (extension !== undefined) {
        const trimmedExt = String(extension).trim();
        if (trimmedExt) {
          // Check extension uniqueness in org
          const { data: extConflict } = await (adminSupabase as any)
            .from('profiles')
            .select('id')
            .eq('organization_id', profile.organization_id)
            .eq('extension', trimmedExt)
            .neq('id', userId)
            .maybeSingle();

          if (extConflict) {
            return NextResponse.json(
              { error: `Extension "${trimmedExt}" is already in use by another team member.` },
              { status: 400 }
            );
          }
        }
        updates.extension = trimmedExt || null;
      }

      const { data: updatedMember, error: err } = await (adminSupabase as any)
        .from('profiles')
        .update(updates)
        .eq('id', userId)
        .eq('organization_id', profile.organization_id)
        .select()
        .single();

      if (err) {
        console.error('[User Management API] Update member error:', err);
        return NextResponse.json({ error: 'Failed to update member' }, { status: 500 });
      }

      return NextResponse.json({ success: true, member: updatedMember });
    }

    return NextResponse.json({ error: 'Invalid action specified' }, { status: 400 });
  } catch (error: any) {
    console.error('[User Management API] POST exception:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
