import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getValidCRMCredentials } from '@/lib/integrations/crm/service';
import { getCRMAdapter } from '@/lib/integrations/crm/registry';
import { CRMFieldMetadata } from '@/lib/integrations/crm/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/integrations/crm/fields?provider=zoho&module=Leads&refresh=false
 * Persistent metadata snapshot retrieval endpoint.
 * Serves cached fields snapshot from Supabase DB (0 CRM API calls) unless refresh=true is explicitly requested.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = (searchParams.get('provider') || 'zoho') as 'zoho';
    const moduleName = (searchParams.get('module') || 'Leads') as 'Leads' | 'Contacts';
    const forceRefresh = searchParams.get('refresh') === 'true';

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

    // 1. Check persistent Supabase snapshot cache if forceRefresh is false
    if (!forceRefresh) {
      const { data: cacheRow } = await (adminSupabase as any)
        .from('crm_field_metadata_cache')
        .select('*')
        .eq('organization_id', profile.organization_id)
        .eq('provider', provider)
        .eq('external_module', moduleName)
        .maybeSingle();

      if (cacheRow && cacheRow.fields_json && Array.isArray(cacheRow.fields_json) && cacheRow.fields_json.length > 0) {
        return NextResponse.json({
          success: true,
          provider,
          module: moduleName,
          fields: cacheRow.fields_json as CRMFieldMetadata[],
          fetchedAt: cacheRow.fetched_at,
          cached: true,
        });
      }
    }

    // 2. Fetch fresh metadata from CRM adapter
    const credentials = await getValidCRMCredentials(profile.organization_id, provider);
    const adapter = getCRMAdapter(provider);
    const freshFields = await adapter.getModuleFields(credentials, moduleName);

    const nowIso = new Date().toISOString();

    // 3. Persist metadata snapshot to Supabase DB
    await (adminSupabase as any)
      .from('crm_field_metadata_cache')
      .upsert(
        {
          organization_id: profile.organization_id,
          provider,
          external_module: moduleName,
          fields_json: freshFields,
          fetched_at: nowIso,
          updated_at: nowIso,
        },
        { onConflict: 'organization_id,provider,external_module' }
      );

    return NextResponse.json({
      success: true,
      provider,
      module: moduleName,
      fields: freshFields,
      fetchedAt: nowIso,
      cached: false,
    });
  } catch (err: any) {
    console.error('[CRM Fields API] Error retrieving field metadata:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to retrieve CRM field metadata.' },
      { status: 500 }
    );
  }
}
