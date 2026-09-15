import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { normalizeE164PhoneNumber } from '@/lib/utils';

/**
 * GET /api/contacts/[contactId]
 * Fetches contact details + recent calls and messages for communication history.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ contactId: string }> }
) {
  try {
    const { contactId } = await params;
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
      .select('organization_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile || !profile.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden. User organization unconfigured.' },
        { status: 403 }
      );
    }

    // Fetch contact record
    const { data: contact, error: contactError } = await (supabase as any)
      .from('contacts')
      .select('*, assigned_user:profiles!assigned_user_id(id, full_name, email, role, avatar_url)')
      .eq('id', contactId)
      .eq('organization_id', profile.organization_id)
      .is('archived_at', null)
      .single();

    if (contactError || !contact) {
      return NextResponse.json(
        { error: 'Contact not found or access denied.' },
        { status: 404 }
      );
    }

    // Fetch recent call history for this contact's phone
    const { data: recentCalls } = await (supabase as any)
      .from('calls')
      .select('id, direction, from_number, to_number, status, duration_seconds, created_at, started_at')
      .eq('organization_id', profile.organization_id)
      .or(`from_number.eq.${contact.phone},to_number.eq.${contact.phone},contact_id.eq.${contact.id}`)
      .order('created_at', { ascending: false })
      .limit(10);

    // Fetch recent message history for this contact's phone
    const { data: recentMessages } = await (supabase as any)
      .from('messages')
      .select('id, direction, from_number, to_number, body, status, created_at')
      .eq('organization_id', profile.organization_id)
      .or(`from_number.eq.${contact.phone},to_number.eq.${contact.phone},contact_id.eq.${contact.id}`)
      .order('created_at', { ascending: false })
      .limit(10);

    return NextResponse.json({
      success: true,
      contact,
      history: {
        calls: recentCalls || [],
        messages: recentMessages || [],
      },
    });
  } catch (error: any) {
    console.error('Error in GET /api/contacts/[contactId]:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error fetching contact details.' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/contacts/[contactId]
 * Updates an existing contact securely within the user's organization.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ contactId: string }> }
) {
  try {
    const { contactId } = await params;
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
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile || !profile.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden. User organization unconfigured.' },
        { status: 403 }
      );
    }

    // Verify existing contact ownership
    const { data: existingContact } = await (supabase as any)
      .from('contacts')
      .select('id, phone, assigned_user_id')
      .eq('id', contactId)
      .eq('organization_id', profile.organization_id)
      .is('archived_at', null)
      .single();

    if (!existingContact) {
      return NextResponse.json(
        { error: 'Contact not found or access denied.' },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const updates: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    // Handle assigned_user_id update validation
    if (body.assigned_user_id !== undefined || body.assignedUserId !== undefined) {
      if (!['admin', 'manager'].includes(profile.role)) {
        return NextResponse.json(
          { error: 'Forbidden. Agents cannot assign or reassign contacts.' },
          { status: 403 }
        );
      }

      const rawAssigned = body.assigned_user_id !== undefined ? body.assigned_user_id : body.assignedUserId;
      const targetAssignedUserId = (typeof rawAssigned === 'string' ? rawAssigned.trim() : '') || null;

      if (targetAssignedUserId) {
        const { data: targetProfile } = await (supabase as any)
          .from('profiles')
          .select('id, organization_id, active, role')
          .eq('id', targetAssignedUserId)
          .single();

        if (
          !targetProfile ||
          targetProfile.organization_id !== profile.organization_id ||
          !targetProfile.active ||
          !['manager', 'agent'].includes(targetProfile.role)
        ) {
          return NextResponse.json(
            { error: 'Invalid assigned user. Contacts can only be assigned to active Managers or Agents in your organization.' },
            { status: 400 }
          );
        }
      }

      updates.assigned_user_id = targetAssignedUserId;
    }

    if (body.firstName !== undefined || body.first_name !== undefined) {
      updates.first_name = (body.firstName ?? body.first_name ?? '').trim() || null;
    }
    if (body.lastName !== undefined || body.last_name !== undefined) {
      updates.last_name = (body.lastName ?? body.last_name ?? '').trim() || null;
    }
    if (body.company !== undefined) {
      updates.company = (body.company ?? '').trim() || null;
    }
    if (body.email !== undefined) {
      const email = (body.email ?? '').trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return NextResponse.json(
          { error: 'Invalid email address format.' },
          { status: 400 }
        );
      }
      updates.email = email || null;
    }
    if (body.notes !== undefined) {
      updates.notes = (body.notes ?? '').trim() || null;
    }

    // If phone is being updated, validate & run duplicate check
    if (body.phone !== undefined && body.phone !== null) {
      const rawPhone = String(body.phone).trim();
      const phoneValidation = normalizeE164PhoneNumber(rawPhone);
      if (!phoneValidation.isValid || !phoneValidation.normalized) {
        return NextResponse.json(
          { error: phoneValidation.error || 'Invalid phone number format.' },
          { status: 400 }
        );
      }
      const normalizedPhone = phoneValidation.normalized;

      if (normalizedPhone !== existingContact.phone) {
        const { data: duplicate } = await (supabase as any)
          .from('contacts')
          .select('id, full_name')
          .eq('organization_id', profile.organization_id)
          .eq('phone', normalizedPhone)
          .neq('id', contactId)
          .is('archived_at', null)
          .maybeSingle();

        if (duplicate) {
          return NextResponse.json(
            {
              error: `Phone number ${normalizedPhone} is already assigned to another contact (${duplicate.full_name}).`,
            },
            { status: 409 }
          );
        }

        updates.phone = normalizedPhone;
      }
    }

    // Compute updated full_name
    const finalFirstName = updates.first_name !== undefined ? updates.first_name : (existingContact as any).first_name;
    const finalLastName = updates.last_name !== undefined ? updates.last_name : (existingContact as any).last_name;
    const finalPhone = updates.phone || existingContact.phone;

    let computedFullName = `${finalFirstName || ''} ${finalLastName || ''}`.trim();
    if (!computedFullName) {
      computedFullName = (body.fullName || body.full_name || '').trim() || finalPhone;
    }
    updates.full_name = computedFullName;

    const { data: updatedContact, error: updateError } = await (supabase as any)
      .from('contacts')
      .update(updates)
      .eq('id', contactId)
      .eq('organization_id', profile.organization_id)
      .select('*, assigned_user:profiles!assigned_user_id(id, full_name, email, role, avatar_url)')
      .single();

    if (updateError || !updatedContact) {
      console.error('Error updating contact:', updateError);
      return NextResponse.json(
        { error: 'Failed to update contact record.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      contact: updatedContact,
    });
  } catch (error: any) {
    console.error('Error in PATCH /api/contacts/[contactId]:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error updating contact.' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/contacts/[contactId]
 * Soft-deletes contact (archived_at = now) to preserve call/message history.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ contactId: string }> }
) {
  try {
    const { contactId } = await params;
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
      .select('organization_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile || !profile.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden. User organization unconfigured.' },
        { status: 403 }
      );
    }

    // Soft delete to protect historical call, message, and recording logs
    const { error: archiveError } = await (supabase as any)
      .from('contacts')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', contactId)
      .eq('organization_id', profile.organization_id);

    if (archiveError) {
      console.error('Error archiving contact:', archiveError);
      return NextResponse.json(
        { error: 'Failed to delete contact record.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Contact deleted successfully.',
    });
  } catch (error: any) {
    console.error('Error in DELETE /api/contacts/[contactId]:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error deleting contact.' },
      { status: 500 }
    );
  }
}
