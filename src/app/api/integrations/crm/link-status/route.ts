import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getCRMAdapter } from '@/lib/integrations/crm/registry';
import { CRMRecordLink } from '@/lib/integrations/crm/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/integrations/crm/link-status?contactId={id}&provider=zoho
 * Retrieves current CRM record link for a local contact and dynamically generates navigation URL.
 * ZERO search API calls to Zoho. Pure local DB lookup + adapter URL generator.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const contactId = searchParams.get('contactId');
    const provider = (searchParams.get('provider') || 'zoho') as 'zoho';

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

    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id, role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile?.organization_id) {
      return NextResponse.json({ error: 'Failed to resolve organization profile.' }, { status: 403 });
    }

    const adminSupabase = createAdminClient();

    // Verify contact organization ownership
    const { data: contact, error: contactError } = await (adminSupabase as any)
      .from('contacts')
      .select('id, organization_id')
      .eq('id', contactId)
      .eq('organization_id', profile.organization_id)
      .single();

    if (contactError || !contact) {
      return NextResponse.json({ error: 'Contact not found or access denied.' }, { status: 404 });
    }

    // Query active link
    const { data: link, error: linkError } = await (adminSupabase as any)
      .from('crm_record_links')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .eq('provider', provider)
      .eq('contact_id', contactId)
      .maybeSingle();

    if (linkError) {
      console.warn('[CRM Link Status API] Query error (table may be pending migration):', linkError);
    }

    if (!link) {
      return NextResponse.json({
        success: true,
        isLinked: false,
        link: null,
      });
    }

    // Query connection api_domain to generate accurate regional deep link URL
    const { data: conn } = await (adminSupabase as any)
      .from('crm_connections')
      .select('api_domain, accounts_domain')
      .eq('organization_id', profile.organization_id)
      .eq('provider', provider)
      .maybeSingle();

    const apiDomain = conn?.api_domain || 'https://www.zohoapis.com';
    const adapter = getCRMAdapter(provider);

    const recordUrl = adapter.getRecordUrl(apiDomain, link.external_module as 'Leads' | 'Contacts', link.external_record_id);

    const formattedLink: CRMRecordLink = {
      id: link.id,
      organizationId: link.organization_id,
      provider: link.provider,
      contactId: link.contact_id,
      externalModule: link.external_module,
      externalRecordId: link.external_record_id,
      externalDisplayName: link.external_display_name,
      externalEmail: link.external_email,
      externalPhone: link.external_phone,
      createdByUserId: link.created_by_user_id,
      createdAt: link.created_at,
      updatedAt: link.updated_at,
      recordUrl,
    };

    return NextResponse.json({
      success: true,
      isLinked: true,
      link: formattedLink,
    });
  } catch (err: any) {
    console.error('[CRM Link Status API] Internal server error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to fetch CRM link status.' },
      { status: 500 }
    );
  }
}
