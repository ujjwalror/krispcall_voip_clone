import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { normalizeE164PhoneNumber } from '@/lib/utils';

interface RawImportItem {
  first_name?: string;
  last_name?: string;
  full_name?: string;
  phone?: string;
  email?: string;
  company?: string;
  notes?: string;
}

/**
 * POST /api/contacts/import
 * Bulk imports contacts for the authenticated user's organization.
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
    const rawItems: RawImportItem[] = Array.isArray(body.contacts) ? body.contacts : [];

    if (rawItems.length === 0) {
      return NextResponse.json(
        { error: 'No contacts provided for bulk import.' },
        { status: 400 }
      );
    }

    // Enforce maximum batch limit (500 rows)
    if (rawItems.length > 500) {
      return NextResponse.json(
        { error: 'Maximum 500 contacts can be imported in a single upload batch.' },
        { status: 400 }
      );
    }

    // 1. Fetch existing contacts for this organization to perform duplicate checks
    const { data: existingContacts } = await (supabase as any)
      .from('contacts')
      .select('phone')
      .eq('organization_id', profile.organization_id)
      .is('archived_at', null);

    const existingPhoneSet = new Set<string>();
    (existingContacts || []).forEach((c: any) => {
      if (c && c.phone) {
        existingPhoneSet.add(String(c.phone).trim());
      }
    });

    const toInsert: any[] = [];
    const seenInBatchSet = new Set<string>();
    let skippedDuplicatesCount = 0;
    let invalidCount = 0;

    for (const item of rawItems) {
      const rawPhone = (item.phone || '').trim();
      const firstName = (item.first_name || '').trim();
      const lastName = (item.last_name || '').trim();
      const company = (item.company || '').trim();
      const email = (item.email || '').trim();
      const notes = (item.notes || '').trim();

      if (!rawPhone) {
        invalidCount++;
        continue;
      }

      // Validate/normalize phone
      const phoneValidation = normalizeE164PhoneNumber(rawPhone);
      if (!phoneValidation.isValid || !phoneValidation.normalized) {
        invalidCount++;
        continue;
      }

      const normalizedPhone = phoneValidation.normalized;

      // Validate email format if present
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        invalidCount++;
        continue;
      }

      // Duplicate check against existing DB records and current batch
      if (existingPhoneSet.has(normalizedPhone) || seenInBatchSet.has(normalizedPhone)) {
        skippedDuplicatesCount++;
        continue;
      }

      seenInBatchSet.add(normalizedPhone);

      let fullName = `${firstName} ${lastName}`.trim();
      if (!fullName) {
        fullName = (item.full_name || '').trim() || normalizedPhone;
      }

      toInsert.push({
        organization_id: profile.organization_id,
        first_name: firstName || null,
        last_name: lastName || null,
        full_name: fullName,
        phone: normalizedPhone,
        email: email || null,
        company: company || null,
        notes: notes || null,
        created_by: user.id,
      });
    }

    if (toInsert.length === 0) {
      return NextResponse.json({
        success: true,
        importedCount: 0,
        skippedDuplicatesCount,
        invalidCount,
        message: 'No new unique valid contacts to import.',
      });
    }

    // 2. Perform bulk insert in database
    const { data: insertedRecords, error: bulkInsertError } = await (supabase as any)
      .from('contacts')
      .insert(toInsert)
      .select('id');

    if (bulkInsertError) {
      console.error('Error in bulk contact insert:', bulkInsertError);
      return NextResponse.json(
        { error: 'Database failure during bulk contact import.' },
        { status: 500 }
      );
    }

    const importedCount = Array.isArray(insertedRecords) ? insertedRecords.length : toInsert.length;

    return NextResponse.json({
      success: true,
      importedCount,
      skippedDuplicatesCount,
      invalidCount,
    });
  } catch (error: any) {
    console.error('Error in POST /api/contacts/import:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error processing CSV contact import.' },
      { status: 500 }
    );
  }
}
