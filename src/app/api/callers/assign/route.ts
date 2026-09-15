import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeE164PhoneNumber } from '@/lib/utils';

/**
 * GET /api/callers/assign?phoneNumber=...
 * Resolves current Assigned Agent for a phone number within the user's organization.
 * Checks saved contacts first, then caller_assignments.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id, active')
      .eq('id', user.id)
      .single();

    if (profileError || !profile || !profile.organization_id || !profile.active) {
      return NextResponse.json(
        { error: 'Forbidden. User organization unconfigured or inactive.' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const rawPhone = searchParams.get('phoneNumber') || searchParams.get('phone') || '';

    if (!rawPhone) {
      return NextResponse.json({ error: 'phoneNumber parameter is required.' }, { status: 400 });
    }

    const phoneValidation = normalizeE164PhoneNumber(rawPhone);
    const normalizedPhone = phoneValidation.normalized || rawPhone.trim();

    const adminSupabase = createAdminClient();

    // 1. Check saved contact
    const { data: contact } = await (adminSupabase as any)
      .from('contacts')
      .select('id, assigned_user_id, assigned_user:profiles!assigned_user_id(id, full_name, email, role, avatar_url)')
      .eq('organization_id', profile.organization_id)
      .eq('phone', normalizedPhone)
      .is('archived_at', null)
      .maybeSingle();

    if (contact) {
      return NextResponse.json({
        success: true,
        isContact: true,
        contactId: contact.id,
        assignedUserId: contact.assigned_user_id,
        assignedUser: contact.assigned_user || null,
        source: 'contact',
      });
    }

    // 2. Check caller_assignments
    const { data: assignment } = await (adminSupabase as any)
      .from('caller_assignments')
      .select('id, assigned_user_id, assignment_source, assigned_by_user_id, assigned_user:profiles!assigned_user_id(id, full_name, email, role, avatar_url)')
      .eq('organization_id', profile.organization_id)
      .eq('phone_number', normalizedPhone)
      .maybeSingle();

    if (assignment) {
      return NextResponse.json({
        success: true,
        isContact: false,
        assignmentId: assignment.id,
        assignedUserId: assignment.assigned_user_id,
        assignedUser: assignment.assigned_user || null,
        source: assignment.assignment_source,
      });
    }

    return NextResponse.json({
      success: true,
      isContact: false,
      assignedUserId: null,
      assignedUser: null,
      source: null,
    });
  } catch (error: any) {
    console.error('Error in GET /api/callers/assign:', error.message || error);
    return NextResponse.json({ error: 'Internal server error resolving caller assignment.' }, { status: 500 });
  }
}

/**
 * POST /api/callers/assign
 * Manually assigns or reassigns an unsaved caller or saved contact.
 * Payload: { phoneNumber: string, assignedUserId: string | null }
 */
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id, role, active')
      .eq('id', user.id)
      .single();

    if (profileError || !profile || !profile.organization_id || !profile.active) {
      return NextResponse.json(
        { error: 'Forbidden. User organization unconfigured or inactive.' },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const rawPhone = (body.phoneNumber || body.phone || '').trim();
    const rawAssignedUserId = body.assignedUserId !== undefined ? body.assignedUserId : body.assigned_user_id;
    const targetAssignedUserId = rawAssignedUserId ? String(rawAssignedUserId).trim() : null;

    if (!rawPhone) {
      return NextResponse.json({ error: 'phoneNumber is required.' }, { status: 400 });
    }

    const phoneValidation = normalizeE164PhoneNumber(rawPhone);
    if (!phoneValidation.isValid || !phoneValidation.normalized) {
      return NextResponse.json({ error: phoneValidation.error || 'Invalid phone number format.' }, { status: 400 });
    }

    const normalizedPhone = phoneValidation.normalized;
    const adminSupabase = createAdminClient();

    // Validate target assigned user if provided
    if (targetAssignedUserId !== null) {
      const { data: targetProfile } = await (adminSupabase as any)
        .from('profiles')
        .select('id, organization_id, active, role')
        .eq('id', targetAssignedUserId)
        .maybeSingle();

      if (
        !targetProfile ||
        targetProfile.organization_id !== profile.organization_id ||
        !targetProfile.active ||
        !['manager', 'agent'].includes(targetProfile.role)
      ) {
        return NextResponse.json(
          { error: 'Invalid assigned user. Callers can only be assigned to active Managers or Agents in your organization.' },
          { status: 400 }
        );
      }
    }

    // Invoke race-safe SECURITY DEFINER RPC with advisory transaction lock
    const { data: rpcRes, error: rpcErr } = await (adminSupabase as any).rpc('manually_assign_caller', {
      p_organization_id: profile.organization_id,
      p_phone: normalizedPhone,
      p_assigned_user_id: targetAssignedUserId,
      p_assigned_by_user_id: profile.id, // Strictly derived server-side
    });

    if (rpcErr || !rpcRes || rpcRes.length === 0) {
      console.error('Error in manually_assign_caller RPC:', rpcErr);
      return NextResponse.json(
        { error: rpcErr?.message || 'Failed to assign caller.' },
        { status: rpcErr?.message?.includes('Forbidden') || rpcErr?.message?.includes('Agents can only') ? 403 : 400 }
      );
    }

    const result = rpcRes[0];

    return NextResponse.json({
      success: true,
      isContact: result.is_contact,
      contactId: result.contact_id || null,
      assignedUserId: result.assigned_user_id,
    });
  } catch (error: any) {
    console.error('Error in POST /api/callers/assign:', error.message || error);
    return NextResponse.json({ error: 'Internal server error processing caller assignment.' }, { status: 500 });
  }
}
