import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';

/**
 * Workspace User Management API for Admins and Managers.
 * Allows viewing workspace members, updating roles, extensions, active state, and routing strategy.
 */
export async function GET() {
  try {
    // Enforce active session authority
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

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
      .select('id, name, slug, routing_strategy, prefer_assigned_agent')
      .eq('id', profile.organization_id)
      .single();

    // Fetch all workspace users
    const { data: members } = await (adminSupabase as any)
      .from('profiles')
      .select('id, full_name, email, role, active, extension, twilio_identity, availability_status, last_seen_at, created_at')
      .eq('organization_id', profile.organization_id)
      .order('created_at', { ascending: true });

    // Fetch active calls in organization to determine automatic call occupancy per user
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
    // Enforce active session authority
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

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
      !['owner', 'admin'].includes(actorProfile.role)
    ) {
      return NextResponse.json({ error: 'Forbidden. Member management requires active Owner or Admin role.' }, { status: 403 });
    }

    const body = await request.json();
    const { action, userId, role, extension, active, routingStrategy, preferAssignedAgent } = body;

    const adminSupabase = createAdminClient();

    // 1. Action: update_routing (OWNER & ADMIN ONLY)
    if (action === 'update_routing') {
      const updateData: Record<string, any> = {
        updated_at: new Date().toISOString(),
      };

      if (routingStrategy !== undefined) {
        if (!['ring_all', 'round_robin'].includes(routingStrategy)) {
          return NextResponse.json({ error: 'Invalid routing strategy' }, { status: 400 });
        }
        updateData.routing_strategy = routingStrategy;
      }

      if (preferAssignedAgent !== undefined) {
        if (typeof preferAssignedAgent !== 'boolean') {
          return NextResponse.json({ error: 'preferAssignedAgent must be a boolean' }, { status: 400 });
        }
        updateData.prefer_assigned_agent = preferAssignedAgent;
      }

      await (adminSupabase as any)
        .from('organizations')
        .update(updateData)
        .eq('id', actorProfile.organization_id);

      return NextResponse.json({
        success: true,
        routingStrategy: updateData.routing_strategy || routingStrategy,
        preferAssignedAgent: updateData.prefer_assigned_agent !== undefined ? updateData.prefer_assigned_agent : preferAssignedAgent,
      });
    }

    // 2. Action: update_member (OWNER & ADMIN ONLY)
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

      // Reject any attempt to assign 'owner' role via member management
      if (role === 'owner') {
        return NextResponse.json({ error: 'Forbidden. Owner role cannot be assigned via role changes.' }, { status: 403 });
      }

      // Safeguards for Workspace Owner target
      if (targetProfile.role === 'owner') {
        if (role && role !== 'owner') {
          return NextResponse.json({ error: 'Forbidden. Workspace Owner role cannot be changed.' }, { status: 403 });
        }
        if (typeof active === 'boolean' && active === false) {
          return NextResponse.json({ error: 'Forbidden. Workspace Owner cannot be deactivated.' }, { status: 403 });
        }
      }

      // Safeguards for Admin actor
      if (actorProfile.role === 'admin') {
        if (targetProfile.role === 'owner') {
          return NextResponse.json({ error: 'Forbidden. Admins cannot modify Workspace Owner.' }, { status: 403 });
        }
        if (targetProfile.role === 'admin' && targetProfile.id !== actorProfile.id) {
          return NextResponse.json({ error: 'Forbidden. Admins cannot modify other Admins.' }, { status: 403 });
        }
        if (role && !['manager', 'agent'].includes(role)) {
          return NextResponse.json({ error: 'Forbidden. Admins can only assign Manager or Agent roles.' }, { status: 403 });
        }
      }

      // Prevent self-deactivation
      if (typeof active === 'boolean' && active === false && userId === user.id) {
        return NextResponse.json({ error: 'Forbidden. You cannot deactivate your own account.' }, { status: 403 });
      }

      // Construct updates object
      const { fullName } = body;
      const updates: Record<string, any> = { updated_at: new Date().toISOString() };
      if (fullName && typeof fullName === 'string') updates.full_name = fullName.trim();
      if (role && ['owner', 'admin', 'manager', 'agent'].includes(role)) {
        if (['owner', 'admin'].includes(actorProfile.role)) {
          updates.role = role;
        }
      }
      if (typeof active === 'boolean') updates.active = active;

      if (extension !== undefined) {
        const trimmedExt = String(extension).trim();
        if (trimmedExt) {
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
