import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { normalizeE164PhoneNumber } from '@/lib/utils';

/**
 * GET /api/contacts
 * Fetches authenticated user's organization contacts.
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
      .select('organization_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile || !profile.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden. User organization unconfigured.' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const queryStr = searchParams.get('query')?.trim() || '';

    let query = (supabase as any)
      .from('contacts')
      .select('*, assigned_user:profiles!assigned_user_id(id, full_name, email, role, avatar_url)')
      .eq('organization_id', profile.organization_id)
      .is('archived_at', null)
      .order('full_name', { ascending: true });

    if (queryStr) {
      query = query.or(
        `full_name.ilike.%${queryStr}%,phone.ilike.%${queryStr}%,company.ilike.%${queryStr}%,email.ilike.%${queryStr}%`
      );
    }

    const { data: contacts, error: contactsError } = await query;

    if (contactsError) {
      console.error('Error fetching contacts:', contactsError);
      return NextResponse.json(
        { error: 'Failed to retrieve contacts directory.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      contacts: contacts || [],
    });
  } catch (error: any) {
    console.error('Error in GET /api/contacts:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error fetching contacts.' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/contacts
 * Creates a single contact for the authenticated user's organization.
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
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile || !profile.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden. User organization unconfigured.' },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const rawPhone = (body.phone || '').trim();
    const firstName = (body.firstName || body.first_name || '').trim();
    const lastName = (body.lastName || body.last_name || '').trim();
    const company = (body.company || '').trim();
    const email = (body.email || '').trim();
    const notes = (body.notes || '').trim();
    const assignedUserIdRaw = (body.assigned_user_id || body.assignedUserId || '').trim();
    const assignedUserId = assignedUserIdRaw || null;

    if (!rawPhone) {
      return NextResponse.json(
        { error: 'Phone number is required to create a contact.' },
        { status: 400 }
      );
    }

    // Validate assigned_user_id assignment permissions
    if (assignedUserId) {
      if (!['admin', 'manager'].includes(profile.role)) {
        return NextResponse.json(
          { error: 'Forbidden. Agents cannot assign contacts to team members.' },
          { status: 403 }
        );
      }

      const { data: targetProfile } = await (supabase as any)
        .from('profiles')
        .select('id, organization_id, active, role')
        .eq('id', assignedUserId)
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

    // Validate and normalize phone number
    const phoneValidation = normalizeE164PhoneNumber(rawPhone);
    if (!phoneValidation.isValid || !phoneValidation.normalized) {
      return NextResponse.json(
        { error: phoneValidation.error || 'Invalid phone number format.' },
        { status: 400 }
      );
    }

    const normalizedPhone = phoneValidation.normalized;

    // Validate email format if provided
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { error: 'Invalid email address format.' },
        { status: 400 }
      );
    }

    // Compute full_name
    let fullName = `${firstName} ${lastName}`.trim();
    if (!fullName) {
      fullName = (body.fullName || body.full_name || '').trim() || normalizedPhone;
    }

    // Check for duplicate phone in same organization
    const { data: existingContact } = await (supabase as any)
      .from('contacts')
      .select('id, full_name, phone')
      .eq('organization_id', profile.organization_id)
      .eq('phone', normalizedPhone)
      .is('archived_at', null)
      .maybeSingle();

    if (existingContact) {
      return NextResponse.json(
        {
          error: `A contact with phone number ${normalizedPhone} already exists in your organization (${existingContact.full_name}).`,
        },
        { status: 409 }
      );
    }

    // Check if phone number is already on organization block list
    const { data: blockedEntry } = await (supabase as any)
      .from('blocked_numbers')
      .select('id')
      .eq('organization_id', profile.organization_id)
      .eq('normalized_phone', normalizedPhone)
      .maybeSingle();

    const isBlocked = Boolean(blockedEntry);

    // Insert new contact securely attaching organization_id from server
    const { data: newContact, error: insertError } = await (supabase as any)
      .from('contacts')
      .insert({
        organization_id: profile.organization_id,
        first_name: firstName || null,
        last_name: lastName || null,
        full_name: fullName,
        phone: normalizedPhone,
        email: email || null,
        company: company || null,
        notes: notes || null,
        is_blocked: isBlocked,
        created_by: user.id,
        assigned_user_id: assignedUserId,
      })
      .select('*, assigned_user:profiles!assigned_user_id(id, full_name, email, role, avatar_url)')
      .single();

    if (insertError || !newContact) {
      console.error('Error inserting contact:', insertError);
      return NextResponse.json(
        { error: 'Database error creating contact record.' },
        { status: 500 }
      );
    }

    // Link contact_id in blocked_numbers if record exists
    if (blockedEntry && newContact) {
      await (supabase as any)
        .from('blocked_numbers')
        .update({ contact_id: newContact.id })
        .eq('id', blockedEntry.id);
    }

    return NextResponse.json({
      success: true,
      contact: newContact,
    });
  } catch (error: any) {
    console.error('Error in POST /api/contacts:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error creating contact.' },
      { status: 500 }
    );
  }
}
