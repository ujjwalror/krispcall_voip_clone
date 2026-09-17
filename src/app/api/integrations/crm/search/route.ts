import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getValidCRMCredentials } from '@/lib/integrations/crm/service';
import { getCRMAdapter } from '@/lib/integrations/crm/registry';

export const dynamic = 'force-dynamic';

/**
 * GET /api/integrations/crm/search?contactId={id}&provider=zoho
 * Authenticated endpoint: Searches CRM Leads & Contacts matching local Contact phone/email.
 * Zero incoming call impact. Explicit user action only.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const contactId = searchParams.get('contactId');
    const provider = (searchParams.get('provider') || 'zoho') as 'zoho';

    if (!contactId) {
      return NextResponse.json({ error: 'Missing required query parameter: contactId' }, { status: 400 });
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

    // Fetch contact and verify organization ownership
    const { data: contact, error: contactError } = await (adminSupabase as any)
      .from('contacts')
      .select('id, organization_id, first_name, last_name, full_name, phone, email')
      .eq('id', contactId)
      .eq('organization_id', profile.organization_id)
      .single();

    if (contactError || !contact) {
      return NextResponse.json({ error: 'Contact not found or access denied.' }, { status: 404 });
    }

    // Get decrypted credentials (auto-refreshes if needed)
    const credentials = await getValidCRMCredentials(profile.organization_id, provider);

    const adapter = getCRMAdapter(provider);
    const results = await adapter.searchPerson(credentials, {
      phone: contact.phone,
      email: contact.email || undefined,
    });

    return NextResponse.json({
      success: true,
      provider,
      contactId,
      results,
    });
  } catch (err: any) {
    console.error('[CRM Search API] Error executing CRM search:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to search CRM records.' },
      { status: 500 }
    );
  }
}
