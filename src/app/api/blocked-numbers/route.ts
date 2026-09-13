import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { normalizeE164PhoneNumber } from '@/lib/utils';

/**
 * GET /api/blocked-numbers
 * Fetches all blocked numbers for the authenticated user's organization.
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
      .from('blocked_numbers')
      .select('*, contacts:contact_id(id, full_name, email, company, phone)')
      .eq('organization_id', profile.organization_id)
      .order('created_at', { ascending: false });

    if (queryStr) {
      query = query.or(`phone_number.ilike.%${queryStr}%,normalized_phone.ilike.%${queryStr}%`);
    }

    // Safe Backfill: Sync any contacts where is_blocked = true that don't have a blocked_numbers row yet
    const { data: blockedContacts } = await (supabase as any)
      .from('contacts')
      .select('id, phone, full_name, created_by')
      .eq('organization_id', profile.organization_id)
      .eq('is_blocked', true)
      .is('archived_at', null);

    if (blockedContacts && blockedContacts.length > 0) {
      for (const c of blockedContacts) {
        if (c.phone) {
          const v = normalizeE164PhoneNumber(c.phone);
          const normPhone = v.normalized || c.phone;

          await (supabase as any)
            .from('blocked_numbers')
            .upsert(
              {
                organization_id: profile.organization_id,
                phone_number: c.phone,
                normalized_phone: normPhone,
                contact_id: c.id,
                created_by: c.created_by || user.id,
              },
              { onConflict: 'organization_id,normalized_phone' }
            );
        }
      }
    }

    const { data: blockedNumbers, error: fetchError } = await query;

    if (fetchError) {
      console.error('Error fetching blocked numbers:', fetchError);
      return NextResponse.json(
        {
          error: `Failed to retrieve blocked numbers directory: ${fetchError.message || fetchError.details || fetchError.code}`,
          details: fetchError,
        },
        { status: 500 }
      );
    }

    // Also enrich with matching contact if contact_id was null but phone matches
    const enrichedList = await Promise.all(
      (blockedNumbers || []).map(async (item: any) => {
        if (!item.contacts && item.normalized_phone) {
          const { data: matchingContact } = await (supabase as any)
            .from('contacts')
            .select('id, full_name, email, company, phone')
            .eq('organization_id', profile.organization_id)
            .eq('phone', item.normalized_phone)
            .is('archived_at', null)
            .maybeSingle();

          if (matchingContact) {
            return { ...item, contacts: matchingContact };
          }
        }
        return item;
      })
    );

    return NextResponse.json({
      success: true,
      blockedNumbers: enrichedList,
    });
  } catch (error: any) {
    console.error('Error in GET /api/blocked-numbers:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error fetching blocked numbers.' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/blocked-numbers
 * Blocks a phone number (saved contact or unsaved number) for the authenticated user's organization.
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
      .select('organization_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile || !profile.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden. User organization unconfigured.' },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const rawPhone = (body.phoneNumber || body.phone || '').trim();
    const reason = (body.reason || '').trim();
    let contactId = body.contactId || null;

    if (!rawPhone) {
      return NextResponse.json(
        { error: 'Phone number is required to block.' },
        { status: 400 }
      );
    }

    const validation = normalizeE164PhoneNumber(rawPhone);
    if (!validation.isValid || !validation.normalized) {
      return NextResponse.json(
        { error: validation.error || 'Invalid phone number format.' },
        { status: 400 }
      );
    }

    const normalizedPhone = validation.normalized;

    // Check if contact exists by contactId or normalizedPhone
    let matchingContact: any = null;
    if (contactId) {
      const { data: c } = await (supabase as any)
        .from('contacts')
        .select('id, phone, full_name')
        .eq('id', contactId)
        .eq('organization_id', profile.organization_id)
        .maybeSingle();
      matchingContact = c;
    }

    if (!matchingContact) {
      const { data: c } = await (supabase as any)
        .from('contacts')
        .select('id, phone, full_name')
        .eq('organization_id', profile.organization_id)
        .eq('phone', normalizedPhone)
        .is('archived_at', null)
        .maybeSingle();
      matchingContact = c;
    }

    if (matchingContact) {
      contactId = matchingContact.id;
    }

    // Insert or upsert into public.blocked_numbers
    const { data: blockedRecord, error: insertError } = await (supabase as any)
      .from('blocked_numbers')
      .upsert(
        {
          organization_id: profile.organization_id,
          phone_number: rawPhone,
          normalized_phone: normalizedPhone,
          contact_id: contactId || null,
          reason: reason || null,
          created_by: user.id,
          created_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id,normalized_phone' }
      )
      .select()
      .single();

    if (insertError) {
      console.error('Error inserting blocked number record:', insertError);
      return NextResponse.json(
        {
          error: `Database error creating blocked number entry: ${insertError.message || insertError.details || insertError.code || 'Table or permissions unconfigured'}`,
          details: insertError,
        },
        { status: 500 }
      );
    }

    // Synchronize contacts.is_blocked = true if matching contact exists
    if (matchingContact) {
      await (supabase as any)
        .from('contacts')
        .update({
          is_blocked: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', matchingContact.id)
        .eq('organization_id', profile.organization_id);
    }

    return NextResponse.json({
      success: true,
      blockedNumber: blockedRecord,
      message: `${matchingContact?.full_name || normalizedPhone} blocked successfully.`,
    });
  } catch (error: any) {
    console.error('Error in POST /api/blocked-numbers:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error blocking phone number.' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/blocked-numbers
 * Removes a phone number from the organization block list.
 */
export async function DELETE(request: Request) {
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
    const body = await request.json().catch(() => ({}));
    const id = searchParams.get('id') || body.id;
    const rawPhone = searchParams.get('phone') || body.phone || body.phoneNumber;

    let normalizedPhone = '';
    if (rawPhone) {
      const v = normalizeE164PhoneNumber(rawPhone);
      if (v.isValid && v.normalized) {
        normalizedPhone = v.normalized;
      }
    }

    if (!id && !normalizedPhone) {
      return NextResponse.json(
        { error: 'Block record ID or valid phone number required to unblock.' },
        { status: 400 }
      );
    }

    let recordToUnblock: any = null;
    if (id) {
      const { data: rec } = await (supabase as any)
        .from('blocked_numbers')
        .select('*')
        .eq('id', id)
        .eq('organization_id', profile.organization_id)
        .maybeSingle();
      recordToUnblock = rec;
    } else if (normalizedPhone) {
      const { data: rec } = await (supabase as any)
        .from('blocked_numbers')
        .select('*')
        .eq('normalized_phone', normalizedPhone)
        .eq('organization_id', profile.organization_id)
        .maybeSingle();
      recordToUnblock = rec;
    }

    let deleteQuery = (supabase as any)
      .from('blocked_numbers')
      .delete()
      .eq('organization_id', profile.organization_id);

    if (id) {
      deleteQuery = deleteQuery.eq('id', id);
    } else if (normalizedPhone) {
      deleteQuery = deleteQuery.eq('normalized_phone', normalizedPhone);
    }

    const { error: deleteError } = await deleteQuery;

    if (deleteError) {
      console.error('Error deleting blocked number record:', deleteError);
      return NextResponse.json(
        { error: `Database error removing blocked number entry: ${deleteError.message || deleteError.details || deleteError.code}` },
        { status: 500 }
      );
    }

    // Synchronize contacts.is_blocked = false if contact matches
    const targetNormPhone = recordToUnblock?.normalized_phone || normalizedPhone;
    const targetContactId = recordToUnblock?.contact_id;

    if (targetContactId) {
      await (supabase as any)
        .from('contacts')
        .update({
          is_blocked: false,
          updated_at: new Date().toISOString(),
        })
        .eq('id', targetContactId)
        .eq('organization_id', profile.organization_id);
    }

    if (targetNormPhone) {
      await (supabase as any)
        .from('contacts')
        .update({
          is_blocked: false,
          updated_at: new Date().toISOString(),
        })
        .eq('organization_id', profile.organization_id)
        .eq('phone', targetNormPhone);
    }

    return NextResponse.json({
      success: true,
      message: 'Number unblocked successfully.',
    });
  } catch (error: any) {
    console.error('Error in DELETE /api/blocked-numbers:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error unblocking number.' },
      { status: 500 }
    );
  }
}
