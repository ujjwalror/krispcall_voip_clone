import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * GET /api/phone-numbers/[id]/assignments
 * Retrieves workspace member assignments for a given phone number.
 * - Owner/Admin: Returns list of active org members with their assignment status.
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

    const isOwnerOrAdmin = ['owner', 'admin'].includes(profile.role);

    if (isOwnerOrAdmin) {
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

      return NextResponse.json({
        success: true,
        canManage: true,
        isNumberOperational: phoneNumber.active === true && phoneNumber.status === 'active',
        members: memberAssignments,
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
 * Creates a new assignment for an active team member.
 * Access: Owners and Admins only.
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
    const targetUserId = (body.userId || body.user_id || '').trim();

    if (!targetUserId) {
      return NextResponse.json(
        { error: 'invalid_input', message: 'Target userId is required.' },
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

    // 2. Verify target user eligibility (same org + active member)
    const { data: targetProfile, error: targetErr } = await (adminSupabase as any)
      .from('profiles')
      .select('id, organization_id, active')
      .eq('id', targetUserId)
      .maybeSingle();

    if (
      targetErr ||
      !targetProfile ||
      targetProfile.organization_id !== profile.organization_id ||
      targetProfile.active === false
    ) {
      return NextResponse.json(
        {
          error: 'invalid_target_user',
          message: 'Target user is not an active member of your organization.',
        },
        { status: 400 }
      );
    }

    // 3. Upsert assignment safely (idempotent)
    const { data: assignment, error: insertErr } = await (adminSupabase as any)
      .from('user_phone_assignments')
      .upsert(
        {
          organization_id: profile.organization_id,
          user_id: targetUserId,
          phone_number_id: phoneNumberId,
        },
        { onConflict: 'user_id, phone_number_id' }
      )
      .select()
      .single();

    if (insertErr) {
      console.error('[POST assignments] Error inserting assignment:', insertErr);
      return NextResponse.json(
        { error: 'internal_error', message: 'Failed to create user phone assignment.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      assignment,
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
 * Removes a team member's assignment from a phone number.
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
    const targetUserId = (body.userId || body.user_id || '').trim();

    if (!targetUserId) {
      return NextResponse.json(
        { error: 'invalid_input', message: 'Target userId is required.' },
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

    // Delete assignment safely
    const { error: deleteErr } = await (adminSupabase as any)
      .from('user_phone_assignments')
      .delete()
      .eq('phone_number_id', phoneNumberId)
      .eq('user_id', targetUserId)
      .eq('organization_id', profile.organization_id);

    if (deleteErr) {
      console.error('[DELETE assignments] Error deleting assignment:', deleteErr);
      return NextResponse.json(
        { error: 'internal_error', message: 'Failed to remove user phone assignment.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Assignment removed successfully.',
    });
  } catch (error: any) {
    console.error('[DELETE assignments] Exception:', error.message || error);
    return NextResponse.json(
      { error: 'internal_error', message: 'Internal server error removing assignment.' },
      { status: 500 }
    );
  }
}
