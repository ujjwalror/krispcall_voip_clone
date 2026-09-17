import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/**
 * POST /api/integrations/crm/link
 * Links a local VoIP Hub contact to an external CRM record.
 * Server-side validated tenant ownership and DB uniqueness enforcement.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      contactId,
      provider = 'zoho',
      externalModule,
      externalRecordId,
      externalDisplayName,
      externalEmail,
      externalPhone,
    } = body;

    if (!contactId || !externalModule || !externalRecordId) {
      return NextResponse.json(
        { error: 'Missing required payload parameters: contactId, externalModule, externalRecordId' },
        { status: 400 }
      );
    }

    if (!['Leads', 'Contacts'].includes(externalModule)) {
      return NextResponse.json({ error: 'Invalid externalModule. Must be Leads or Contacts.' }, { status: 400 });
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
      .select('id, organization_id')
      .eq('id', contactId)
      .eq('organization_id', profile.organization_id)
      .single();

    if (contactError || !contact) {
      return NextResponse.json({ error: 'Contact not found or access denied.' }, { status: 404 });
    }

    // Upsert or insert into crm_record_links
    const { data: insertedLink, error: insertError } = await (adminSupabase as any)
      .from('crm_record_links')
      .insert({
        organization_id: profile.organization_id,
        provider,
        contact_id: contactId,
        external_module: externalModule,
        external_record_id: String(externalRecordId),
        external_display_name: externalDisplayName || null,
        external_email: externalEmail || null,
        external_phone: externalPhone || null,
        created_by_user_id: user.id,
      })
      .select()
      .single();

    if (insertError) {
      // Check for unique constraint violation
      if (insertError.code === '23505' || insertError.message?.includes('unique')) {
        if (insertError.message?.includes('unique_org_provider_contact')) {
          return NextResponse.json(
            { error: 'This contact is already linked to a record in this CRM provider. Unlink the existing record first.' },
            { status: 409 }
          );
        }
        if (insertError.message?.includes('unique_org_provider_external_record')) {
          return NextResponse.json(
            { error: 'This external CRM record is already linked to another contact in your organization.' },
            { status: 409 }
          );
        }
        return NextResponse.json(
          { error: 'A duplicate CRM link constraint prevented saving.' },
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
    console.error('[CRM Link API] Error creating link:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to link CRM record.' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/integrations/crm/link?contactId={id}&provider=zoho
 * Unlinks a local contact from an external CRM record.
 */
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const contactId = searchParams.get('contactId');
    const provider = searchParams.get('provider') || 'zoho';

    if (!contactId) {
      return NextResponse.json({ error: 'Missing query parameter: contactId' }, { status: 400 });
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
      .select('id, organization_id')
      .eq('id', contactId)
      .eq('organization_id', profile.organization_id)
      .single();

    if (contactError || !contact) {
      return NextResponse.json({ error: 'Contact not found or access denied.' }, { status: 404 });
    }

    const { error: deleteError } = await (adminSupabase as any)
      .from('crm_record_links')
      .delete()
      .eq('organization_id', profile.organization_id)
      .eq('provider', provider)
      .eq('contact_id', contactId);

    if (deleteError) {
      throw deleteError;
    }

    return NextResponse.json({
      success: true,
      message: 'CRM record unlinked successfully.',
    });
  } catch (err: any) {
    console.error('[CRM Unlink API] Error unlinking CRM record:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to unlink CRM record.' },
      { status: 500 }
    );
  }
}
