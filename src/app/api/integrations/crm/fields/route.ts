import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getValidCRMCredentials } from '@/lib/integrations/crm/service';
import { getCRMAdapter } from '@/lib/integrations/crm/registry';
import { CRMFieldMetadata, CRM_FIELD_METADATA_CACHE_VERSION } from '@/lib/integrations/crm/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/integrations/crm/fields?provider=zoho&module=Leads&refresh=false
 * Persistent metadata snapshot retrieval endpoint.
 * Serves cached fields snapshot from Supabase DB (0 CRM API calls) unless refresh=true is explicitly requested
 * or cached payload is legacy/stale relative to CRM_FIELD_METADATA_CACHE_VERSION.
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

      if (cacheRow && cacheRow.fields_json) {
        const rawJson = cacheRow.fields_json;
        let isVersionValid = false;
        let cachedFields: CRMFieldMetadata[] = [];

        if (
          typeof rawJson === 'object' &&
          !Array.isArray(rawJson) &&
          rawJson !== null &&
          rawJson._version === CRM_FIELD_METADATA_CACHE_VERSION
        ) {
          isVersionValid = true;
          cachedFields = rawJson.fields || [];
        }

        if (isVersionValid && cachedFields.length > 0) {
          return NextResponse.json({
            success: true,
            provider,
            module: moduleName,
            fields: cachedFields,
            fetchedAt: cacheRow.fetched_at,
            cached: true,
          });
        }
      }
    }

    // 2. Fetch fresh metadata from CRM adapter (cache missing, legacy version, or forceRefresh requested)
    const credentials = await getValidCRMCredentials(profile.organization_id, provider);
    const adapter = getCRMAdapter(provider);
    const freshFields = await adapter.getModuleFields(credentials, moduleName);

    const nowIso = new Date().toISOString();

    // 3. Persist metadata snapshot to Supabase DB with current cache version
    await (adminSupabase as any)
      .from('crm_field_metadata_cache')
      .upsert(
        {
          organization_id: profile.organization_id,
          provider,
          external_module: moduleName,
          fields_json: {
            _version: CRM_FIELD_METADATA_CACHE_VERSION,
            fields: freshFields,
          },
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
