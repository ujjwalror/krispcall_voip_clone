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
      skipDuplicateCheck = false,
    } = body;

    if (!contactId || !lastName) {
      return NextResponse.json(
        { error: 'Missing required payload parameters: contactId and lastName are required.' },
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
      .select('id, organization_id, phone, email')
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

    // 2. Create Lead in Zoho CRM
    const created = await adapter.createLead(credentials, {
      firstName: firstName || undefined,
      lastName: lastName.trim(),
      phone: phone || contact.phone || undefined,
      email: email || contact.email || undefined,
      company: company || undefined,
      description: description || undefined,
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
