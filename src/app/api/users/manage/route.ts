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

    // Fetch active calls in organization to determine automatic call occupancy per user
    // A call is occupied ONLY if ended_at IS NULL AND (status === 'in-progress' OR (transient status IN ('initiated', 'ringing', 'queued') AND created_at within 15 mins))
    const { data: activeCalls } = await (adminSupabase as any)
      .from('calls')
      .select('user_id, status, created_at')
      .eq('organization_id', profile.organization_id)
      .is('ended_at', null)
      .in('status', ['initiated', 'ringing', 'in-progress', 'queued'])
      .not('user_id', 'is', null);

    // Fetch active non-expired reservations in organization
    const { data: activeRes } = await (adminSupabase as any)
      .from('agent_call_reservations')
      .select('user_id')
      .eq('organization_id', profile.organization_id)
      .gt('expires_at', new Date().toISOString());

    const cutoffMs = Date.now() - 15 * 60 * 1000;
    const occupiedUserIds = new Set<string>();

    if (activeCalls) {
      for (const c of activeCalls) {
        if (!c.user_id) continue;
        const isConnected = c.status === 'in-progress';
        const isRecentSetup =
          ['initiated', 'ringing', 'queued'].includes(c.status) &&
          c.created_at &&
          new Date(c.created_at).getTime() > cutoffMs;

        if (isConnected || isRecentSetup) {
          occupiedUserIds.add(c.user_id);
        }
      }
    }
    if (activeRes) {
      for (const r of activeRes) {
        if (r.user_id) occupiedUserIds.add(r.user_id);
      }
    }

    const membersWithOccupancy = (members || []).map((m: any) => ({
      ...m,
      is_occupied: occupiedUserIds.has(m.id),
    }));

    return NextResponse.json({
      organization: orgData,
      currentUserRole: profile.role,
      members: membersWithOccupancy,
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

    // Verify actor authentication & permissions
    const { data: profileData } = await supabase
      .from('profiles')
      .select('id, organization_id, role, active')
      .eq('id', user.id)
      .single();

    const actorProfile = profileData as { id?: string; organization_id?: string; role?: string; active?: boolean } | null;

    if (
      !actorProfile ||
      !actorProfile.organization_id ||
      !actorProfile.role ||
      actorProfile.active === false ||
      !['admin', 'manager'].includes(actorProfile.role)
    ) {
      return NextResponse.json({ error: 'Forbidden. Active Admin or Manager role required.' }, { status: 403 });
    }

    const body = await request.json();
    const { action, userId, role, extension, active, routingStrategy } = body;

    const adminSupabase = createAdminClient();

    // 1. Action: update_routing (ADMIN ONLY)
    if (action === 'update_routing') {
      if (actorProfile.role !== 'admin') {
        return NextResponse.json({ error: 'Forbidden. Routing strategy can only be updated by Admins.' }, { status: 403 });
      }
      if (!['ring_all', 'round_robin'].includes(routingStrategy)) {
        return NextResponse.json({ error: 'Invalid routing strategy' }, { status: 400 });
      }

      await (adminSupabase as any)
        .from('organizations')
        .update({ routing_strategy: routingStrategy, updated_at: new Date().toISOString() })
        .eq('id', actorProfile.organization_id);

      return NextResponse.json({ success: true, routingStrategy });
    }

    // 2. Action: update_member
    if (action === 'update_member' && userId) {
      // Fetch target user profile by userId AND same organization_id
      const { data: targetData } = await (adminSupabase as any)
        .from('profiles')
        .select('id, organization_id, role, active, full_name')
        .eq('id', userId)
        .eq('organization_id', actorProfile.organization_id)
        .maybeSingle();

      if (!targetData) {
        return NextResponse.json({ error: 'Target user not found in your organization.' }, { status: 404 });
      }

      const targetProfile = targetData as { id: string; organization_id: string; role: string; active: boolean; full_name: string };

      // --- MANAGER AUTHORIZATION RULES ---
      if (actorProfile.role === 'manager') {
        // Manager may NOT modify themselves via this API endpoint
        if (userId === user.id) {
          return NextResponse.json({ error: 'Forbidden. Managers cannot modify their own profile or role via team management.' }, { status: 403 });
        }

        // Target MUST be an agent
        if (targetProfile.role !== 'agent') {
          return NextResponse.json({ error: 'Forbidden. Managers can only manage Agent accounts.' }, { status: 403 });
        }

        // Manager may NOT assign role='admin' or role='manager'
        if (role && role !== 'agent') {
          return NextResponse.json({ error: 'Forbidden. Managers cannot assign Manager or Admin roles.' }, { status: 403 });
        }
      }

      // --- ADMIN AUTHORIZATION RULES & SAFEGUARDS ---
      if (actorProfile.role === 'admin') {
        const isTargetAdmin = targetProfile.role === 'admin';
        const isDeactivatingAdmin = isTargetAdmin && typeof active === 'boolean' && active === false;
        const isDemotingAdmin = isTargetAdmin && role && role !== 'admin';

        if (isDeactivatingAdmin || isDemotingAdmin) {
          // Prevent self-deactivation and self-demotion
          if (userId === user.id) {
            return NextResponse.json({ error: 'Forbidden. Admins cannot deactivate or demote their own account.' }, { status: 403 });
          }

          // Verify at least one OTHER active admin exists in the organization
          const { data: activeAdmins } = await (adminSupabase as any)
            .from('profiles')
            .select('id')
            .eq('organization_id', actorProfile.organization_id)
            .eq('role', 'admin')
            .eq('active', true)
            .neq('id', userId);

          if (!activeAdmins || activeAdmins.length === 0) {
            return NextResponse.json(
              { error: 'Forbidden. Cannot deactivate or demote the last active Admin in the organization.' },
              { status: 403 }
            );
          }
        }
      }

      // Construct updates object
      const { fullName } = body;
      const updates: Record<string, any> = { updated_at: new Date().toISOString() };
      if (fullName && typeof fullName === 'string') updates.full_name = fullName.trim();
      if (role && ['admin', 'manager', 'agent'].includes(role)) {
        if (actorProfile.role === 'admin') {
          updates.role = role;
        }
      }
      if (typeof active === 'boolean') updates.active = active;

      if (extension !== undefined) {
        const trimmedExt = String(extension).trim();
        if (trimmedExt) {
          // Check extension uniqueness in org
          const { data: extConflict } = await (adminSupabase as any)
            .from('profiles')
            .select('id')
            .eq('organization_id', actorProfile.organization_id)
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
        .eq('organization_id', actorProfile.organization_id)
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
