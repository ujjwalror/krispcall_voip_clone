import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { SeatBillingService } from '@/lib/billing/seatBillingService';

/**
 * GET /api/phone-numbers/[id]/assignments
 * Retrieves workspace member assignments for a given phone number.
 * - Owner/Admin: Returns assigned members, unassigned active members (for picker), and seat metrics.
 * - Manager/Agent: Returns assignment status for the authenticated user only.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: phoneNumberId } = await params;
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    const { data: profile, error: profileErr } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileErr || !profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'forbidden', message: 'Forbidden. Active organization profile required.' },
        { status: 403 }
      );
    }

    const adminSupabase = createAdminClient();

    // Verify phone number ownership & active status
    const { data: phoneNumber, error: phoneErr } = await (adminSupabase as any)
      .from('phone_numbers')
      .select('id, organization_id, active, status, phone_number, friendly_name')
      .eq('id', phoneNumberId)
      .eq('organization_id', profile.organization_id)
      .maybeSingle();

    if (phoneErr || !phoneNumber) {
      return NextResponse.json(
        { error: 'not_found', message: 'Phone number record not found or access denied.' },
        { status: 404 }
      );
    }

    const isOwnerOrAdmin = ['owner', 'admin'].includes(profile.role);

    if (isOwnerOrAdmin) {
      // Fetch seat metrics for the workspace
      const seatMetrics = await SeatBillingService.calculateSeats(profile.organization_id, adminSupabase);

      // Fetch all ACTIVE workspace members for the organization
      const { data: members, error: membersErr } = await (adminSupabase as any)
        .from('profiles')
        .select('id, full_name, email, role, active, avatar_url')
        .eq('organization_id', profile.organization_id)
        .eq('active', true)
        .order('full_name', { ascending: true });

      if (membersErr) {
        console.error('[GET assignments] Error fetching members:', membersErr);
        return NextResponse.json(
          { error: 'internal_error', message: 'Failed to fetch workspace members.' },
          { status: 500 }
        );
      }

      // Fetch all current assignments for this phone number
      const { data: assignments, error: assignmentsErr } = await (adminSupabase as any)
        .from('user_phone_assignments')
        .select('user_id, created_at')
        .eq('phone_number_id', phoneNumberId)
        .eq('organization_id', profile.organization_id);

      if (assignmentsErr) {
        console.error('[GET assignments] Error fetching assignments:', assignmentsErr);
        return NextResponse.json(
          { error: 'internal_error', message: 'Failed to fetch assignments.' },
          { status: 500 }
        );
      }

      const assignedUserIds = new Set((assignments || []).map((a: any) => a.user_id));

      const memberAssignments = (members || []).map((member: any) => ({
        id: member.id,
        full_name: member.full_name,
        email: member.email,
        role: member.role,
        active: member.active,
        avatar_url: member.avatar_url,
        is_assigned: assignedUserIds.has(member.id),
      }));

      const assignedMembers = memberAssignments.filter((m: any) => m.is_assigned);
      const unassignedMembers = memberAssignments.filter((m: any) => !m.is_assigned);

      return NextResponse.json({
        success: true,
        canManage: true,
        isNumberOperational: phoneNumber.active === true && phoneNumber.status === 'active',
        members: memberAssignments,
        assignedMembers,
        unassignedMembers,
        seatMetrics: {
          usedOrReservedSeats: seatMetrics.usedOrReservedSeats,
          activeMembers: seatMetrics.activeMembers,
          pendingInvitations: seatMetrics.pendingInvitations,
          maxActiveUsersLimit: seatMetrics.maxActiveUsersLimit,
          canAddMoreSeats: seatMetrics.canAddMoreSeats,
        },
      });
    } else {
      // Manager/Agent read-only check for own assignment
      const { data: myAssignment } = await (adminSupabase as any)
        .from('user_phone_assignments')
        .select('id')
        .eq('phone_number_id', phoneNumberId)
        .eq('user_id', user.id)
        .eq('organization_id', profile.organization_id)
        .maybeSingle();

      return NextResponse.json({
        success: true,
        canManage: false,
        isAssigned: Boolean(myAssignment),
        isNumberOperational: phoneNumber.active === true && phoneNumber.status === 'active',
      });
    }
  } catch (error: any) {
    console.error('[GET assignments] Exception:', error.message || error);
    return NextResponse.json(
      { error: 'internal_error', message: 'Internal server error fetching assignments.' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/phone-numbers/[id]/assignments
 * Assigns one or multiple active workspace members to a phone number.
 * Supports single (`userId: string`) or multi-select (`userIds: string[]`).
 * Access: Owners and Admins only.
 * Note: Assigning existing workspace members does NOT consume extra workspace seats.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: phoneNumberId } = await params;
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    const { data: profile, error: profileErr } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileErr || !profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'forbidden', message: 'Forbidden. Active organization profile required.' },
        { status: 403 }
      );
    }

    if (!['owner', 'admin'].includes(profile.role)) {
      return NextResponse.json(
        { error: 'forbidden', message: 'Forbidden. Only workspace Owner or Admin users can assign numbers.' },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    let targetUserIds: string[] = [];

    if (Array.isArray(body.userIds) && body.userIds.length > 0) {
      targetUserIds = body.userIds.map((u: any) => String(u).trim()).filter(Boolean);
    } else if (body.userId || body.user_id) {
      const u = String(body.userId || body.user_id).trim();
      if (u) targetUserIds = [u];
    }

    if (targetUserIds.length === 0) {
      return NextResponse.json(
        { error: 'invalid_input', message: 'At least one target userId or userIds array is required.' },
        { status: 400 }
      );
    }

    const adminSupabase = createAdminClient();

    // 1. Verify phone number eligibility
    const { data: phoneNumber, error: phoneErr } = await (adminSupabase as any)
      .from('phone_numbers')
      .select('id, organization_id, active, status')
      .eq('id', phoneNumberId)
      .eq('organization_id', profile.organization_id)
      .maybeSingle();

    if (phoneErr || !phoneNumber) {
      return NextResponse.json(
        { error: 'not_found', message: 'Phone number record not found or access denied.' },
        { status: 404 }
      );
    }

    const isOperational = phoneNumber.active === true && phoneNumber.status === 'active';
    if (!isOperational) {
      return NextResponse.json(
        {
          error: 'invalid_number_state',
          message: 'Cannot assign team members to an inactive, suspended, or non-operational phone number.',
        },
        { status: 400 }
      );
    }

    // 2. Verify target users eligibility (same org + active members)
    const { data: targetProfiles, error: targetErr } = await (adminSupabase as any)
      .from('profiles')
      .select('id, organization_id, active')
      .in('id', targetUserIds)
      .eq('organization_id', profile.organization_id)
      .eq('active', true);

    if (targetErr || !targetProfiles || targetProfiles.length === 0) {
      return NextResponse.json(
        {
          error: 'invalid_target_user',
          message: 'None of the specified users are active members of your organization.',
        },
        { status: 400 }
      );
    }

    const validUserIds = targetProfiles.map((p: any) => p.id);

    // 3. Upsert assignments safely (idempotent, no seat limit consumed)
    const upsertRows = validUserIds.map((uId: string) => ({
      organization_id: profile.organization_id,
      user_id: uId,
      phone_number_id: phoneNumberId,
    }));

    const { data: assignments, error: insertErr } = await (adminSupabase as any)
      .from('user_phone_assignments')
      .upsert(upsertRows, { onConflict: 'user_id, phone_number_id' })
      .select();

    if (insertErr) {
      console.error('[POST assignments] Error inserting assignments:', insertErr);
      return NextResponse.json(
        { error: 'internal_error', message: 'Failed to create user phone assignment.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      assignedUserIds: validUserIds,
      assignments,
    });
  } catch (error: any) {
    console.error('[POST assignments] Exception:', error.message || error);
    return NextResponse.json(
      { error: 'internal_error', message: 'Internal server error creating assignment.' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/phone-numbers/[id]/assignments
 * Removes one or multiple team members' assignment from a phone number.
 * Supports single (`userId: string`) or batch (`userIds: string[]`).
 * Access: Owners and Admins only.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: phoneNumberId } = await params;
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    const { data: profile, error: profileErr } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileErr || !profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'forbidden', message: 'Forbidden. Active organization profile required.' },
        { status: 403 }
      );
    }

    if (!['owner', 'admin'].includes(profile.role)) {
      return NextResponse.json(
        { error: 'forbidden', message: 'Forbidden. Only workspace Owner or Admin users can remove assignments.' },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    let targetUserIds: string[] = [];

    if (Array.isArray(body.userIds) && body.userIds.length > 0) {
      targetUserIds = body.userIds.map((u: any) => String(u).trim()).filter(Boolean);
    } else if (body.userId || body.user_id) {
      const u = String(body.userId || body.user_id).trim();
      if (u) targetUserIds = [u];
    }

    if (targetUserIds.length === 0) {
      return NextResponse.json(
        { error: 'invalid_input', message: 'Target userId or userIds array is required.' },
        { status: 400 }
      );
    }

    const adminSupabase = createAdminClient();

    // Verify phone number ownership
    const { data: phoneNumber } = await (adminSupabase as any)
      .from('phone_numbers')
      .select('id, organization_id')
      .eq('id', phoneNumberId)
      .eq('organization_id', profile.organization_id)
      .maybeSingle();

    if (!phoneNumber) {
      return NextResponse.json(
        { error: 'not_found', message: 'Phone number record not found or access denied.' },
        { status: 404 }
      );
    }

    // Delete assignments safely
    const { error: deleteErr } = await (adminSupabase as any)
      .from('user_phone_assignments')
      .delete()
      .eq('phone_number_id', phoneNumberId)
      .eq('organization_id', profile.organization_id)
      .in('user_id', targetUserIds);

    if (deleteErr) {
      console.error('[DELETE assignments] Error deleting assignment:', deleteErr);
      return NextResponse.json(
        { error: 'internal_error', message: 'Failed to remove user phone assignment.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      removedUserIds: targetUserIds,
      message: 'Assignment(s) removed successfully.',
    });
  } catch (error: any) {
    console.error('[DELETE assignments] Exception:', error.message || error);
    return NextResponse.json(
      { error: 'internal_error', message: 'Internal server error removing assignment.' },
      { status: 500 }
    );
  }
}
