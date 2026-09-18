import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getValidCRMCredentials } from '@/lib/integrations/crm/service';
import { getCRMAdapter } from '@/lib/integrations/crm/registry';

export const dynamic = 'force-dynamic';

/**
 * POST /api/integrations/crm/create-lead
 * Duplicate check & explicit Zoho Lead creation.
 * Server-side validated tenant ownership and DB uniqueness enforcement.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      contactId,
      provider = 'zoho',
      firstName,
      lastName,
      phone,
      email,
      company,
      description,
      customFields = {},
      skipDuplicateCheck = false,
    } = body;

    if (!contactId || (!lastName && !customFields.Last_Name)) {
      return NextResponse.json(
        { error: 'Missing required payload parameter: Last Name is required.' },
        { status: 400 }
      );
    }

    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized. Authenticated session required.' }, { status: 401 });
    }

    // Get user profile
    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id, role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile?.organization_id) {
      return NextResponse.json({ error: 'Failed to resolve organization profile.' }, { status: 403 });
    }

    const adminSupabase = createAdminClient();

    // Verify contact belongs to same organization
    const { data: contact, error: contactError } = await (adminSupabase as any)
      .from('contacts')
      .select('id, organization_id, phone, email, notes, company, first_name, last_name')
      .eq('id', contactId)
      .eq('organization_id', profile.organization_id)
      .single();

    if (contactError || !contact) {
      return NextResponse.json({ error: 'Contact not found or access denied.' }, { status: 404 });
    }

    // Get valid decrypted credentials
    const credentials = await getValidCRMCredentials(profile.organization_id, provider);
    const adapter = getCRMAdapter(provider);

    // 1. Perform conservative duplicate check if not explicitly bypassed
    if (!skipDuplicateCheck) {
      const candidates = await adapter.searchPerson(credentials, {
        phone: phone || contact.phone,
        email: email || contact.email || undefined,
      });

      if (candidates.length > 0) {
        return NextResponse.json({
          success: false,
          duplicateCheckFailed: true,
          message: `Found ${candidates.length} matching record(s) in Zoho CRM. You may link an existing record instead of creating a duplicate.`,
          candidates,
        });
      }
    }

    // 2. Resolve single authoritative effective mapping (Saved mappings OR In-memory adapter defaults)
    let effectiveMappings: Array<{ localFieldKey: string; externalFieldKey: string }> = [];

    const { data: savedMappings } = await (adminSupabase as any)
      .from('crm_field_mappings')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .eq('provider', provider)
      .eq('external_module', 'Leads')
      .eq('is_enabled', true);

    if (savedMappings && Array.isArray(savedMappings) && savedMappings.length > 0) {
      // A. Use saved org field mappings
      effectiveMappings = savedMappings.map((m: any) => ({
        localFieldKey: m.local_field_key,
        externalFieldKey: m.external_field_key,
      }));
    } else {
      // B. If NO saved mappings exist, use in-memory adapter recommended defaults for this request
      effectiveMappings = adapter.getDefaultFieldMappings('Leads');
    }

    const dynamicFieldsPayload: Record<string, any> = {};

    // Step 1 & 2: Map actual Contact values using effective mappings
    for (const map of effectiveMappings) {
      const localKey = map.localFieldKey;
      const extKey = map.externalFieldKey;
      if (!localKey || !extKey) continue;

      let val: any = undefined;
      if (localKey === 'first_name') val = firstName || contact.first_name;
      else if (localKey === 'last_name') val = lastName || contact.last_name;
      else if (localKey === 'full_name') val = `${firstName || contact.first_name || ''} ${lastName || contact.last_name || ''}`.trim();
      else if (localKey === 'phone') val = phone || contact.phone;
      else if (localKey === 'email') val = email || contact.email;
      else if (localKey === 'company') val = company || contact.company;
      else if (localKey === 'notes') val = description || contact.notes;

      if (val !== undefined && val !== null && String(val).trim() !== '') {
        dynamicFieldsPayload[extKey] = typeof val === 'string' ? val.trim() : val;
      }
    }

    // Step 3: Merge explicitly entered customer-specific required values
    if (customFields && typeof customFields === 'object') {
      for (const [key, val] of Object.entries(customFields)) {
        if (val !== undefined && val !== null && val !== '') {
          dynamicFieldsPayload[key] = val;
        }
      }
    }

    // Step 4: Merge configured CRM record attribution if valid, enabled, and field is not already populated
    try {
      const { data: attributionRows } = await (adminSupabase as any)
        .from('crm_record_attribution_rules')
        .select('*')
        .eq('organization_id', profile.organization_id)
        .eq('provider', provider)
        .eq('external_module', 'Leads')
        .eq('is_enabled', true);

      if (attributionRows && Array.isArray(attributionRows) && attributionRows.length > 0) {
        for (const attr of attributionRows) {
          if (attr.external_field_key && attr.configured_value) {
            // Guard: Attribution MUST NEVER overwrite a field already populated by Contact Mapping or Required Fields
            if (!Object.prototype.hasOwnProperty.call(dynamicFieldsPayload, attr.external_field_key)) {
              dynamicFieldsPayload[attr.external_field_key] = String(attr.configured_value).trim();
            }
          }
        }
      }
    } catch (err) {
      // Non-fatal if attribution table not yet created
    }

    // 3. Create Lead in Zoho CRM using single authoritative effective payload
    const created = await adapter.createLead(credentials, {
      lastName: lastName?.trim() || dynamicFieldsPayload.Last_Name || '',
      dynamicFields: dynamicFieldsPayload,
    });


    // 3. Save link mapping in crm_record_links
    const displayName = `${firstName || ''} ${lastName}`.trim();

    const { data: insertedLink, error: insertError } = await (adminSupabase as any)
      .from('crm_record_links')
      .insert({
        organization_id: profile.organization_id,
        provider,
        contact_id: contactId,
        external_module: created.externalModule,
        external_record_id: created.externalRecordId,
        external_display_name: displayName,
        external_email: email || contact.email || null,
        external_phone: phone || contact.phone || null,
        created_by_user_id: user.id,
      })
      .select()
      .single();

    if (insertError) {
      console.error('[CRM Create Lead API] Lead created in Zoho but failed to save local DB link:', insertError);

      if (insertError.code === '23505' || insertError.message?.includes('unique')) {
        return NextResponse.json(
          {
            error:
              'The Lead was created in Zoho CRM, but this contact or external record is already linked locally. Please refresh to see the updated link.',
            createdRecordId: created.externalRecordId,
          },
          { status: 409 }
        );
      }

      throw insertError;
    }

    return NextResponse.json({
      success: true,
      link: insertedLink,
    });
  } catch (err: any) {
    console.error('[CRM Create Lead API] Error creating Zoho Lead:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to create Lead in Zoho CRM.' },
      { status: 500 }
    );
  }
}
