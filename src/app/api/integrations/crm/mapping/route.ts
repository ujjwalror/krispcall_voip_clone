import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  CRMFieldMapping,
  CRMFieldMetadata,
  LOCAL_VOIP_HUB_FIELDS,
  isFieldMappingCompatible,
} from '@/lib/integrations/crm/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/integrations/crm/mapping?provider=zoho&module=Leads
 * Retrieves saved organization field mappings.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = (searchParams.get('provider') || 'zoho') as 'zoho';
    const moduleName = (searchParams.get('module') || 'Leads') as 'Leads' | 'Contacts';

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

    const { data: rows, error: queryError } = await (adminSupabase as any)
      .from('crm_field_mappings')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .eq('provider', provider)
      .eq('external_module', moduleName);

    if (queryError) {
      console.warn('[CRM Mapping API] Non-fatal query error (table may be pending migration):', queryError);
    }

    const mappings: CRMFieldMapping[] = (rows || []).map((row: any) => ({
      id: row.id,
      organizationId: row.organization_id,
      provider: row.provider,
      externalModule: row.external_module,
      localFieldKey: row.local_field_key,
      externalFieldKey: row.external_field_key,
      isEnabled: row.is_enabled,
    }));

    return NextResponse.json({
      success: true,
      provider,
      module: moduleName,
      mappings,
      userRole: profile.role,
    });
  } catch (err: any) {
    console.error('[CRM Mapping API] Error retrieving field mappings:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to retrieve field mappings.' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/integrations/crm/mapping
 * Saves organization field mappings. Admin role required.
 * Server-side enforced field compatibility validation.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { provider = 'zoho', externalModule = 'Leads', mappings } = body;

    if (!Array.isArray(mappings)) {
      return NextResponse.json({ error: 'Invalid payload: mappings must be an array.' }, { status: 400 });
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

    // Role check: Only Admin can mutate field mappings
    if (profile.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden. Admin role required to modify field mappings.' }, { status: 403 });
    }

    const adminSupabase = createAdminClient();

    // Fetch cached field metadata snapshot to enforce compatibility server-side
    const { data: cacheRow } = await (adminSupabase as any)
      .from('crm_field_metadata_cache')
      .select('fields_json')
      .eq('organization_id', profile.organization_id)
      .eq('provider', provider)
      .eq('external_module', externalModule)
      .maybeSingle();

    const rawCache = cacheRow?.fields_json;
    const fieldsMetadata: CRMFieldMetadata[] = Array.isArray(rawCache)
      ? rawCache
      : rawCache && typeof rawCache === 'object' && Array.isArray(rawCache.fields)
      ? rawCache.fields
      : [];

    // Fetch active attribution rules to prevent field collisions BEFORE deleting existing mappings
    let activeAttributionRules: any[] = [];
    try {
      const { data: attrRows } = await (adminSupabase as any)
        .from('crm_record_attribution_rules')
        .select('external_field_key')
        .eq('organization_id', profile.organization_id)
        .eq('provider', provider)
        .eq('external_module', externalModule)
        .eq('is_enabled', true);

      if (attrRows && Array.isArray(attrRows)) {
        activeAttributionRules = attrRows;
      }
    } catch (err) {
      // Table may not exist yet
    }

    const activeAttrKeys = new Set<string>(
      activeAttributionRules.map((r: any) => r.external_field_key).filter(Boolean)
    );

    // Server-side compatibility & attribution collision check BEFORE deleting existing mappings
    for (const m of mappings) {
      if (!m.localFieldKey || !m.externalFieldKey) continue;

      if (activeAttrKeys.has(m.externalFieldKey)) {
        const targetMetadata = fieldsMetadata.find((f) => f.fieldKey === m.externalFieldKey);
        const label = targetMetadata?.label || m.externalFieldKey;
        return NextResponse.json(
          {
            error: `CRM field '${label}' is currently configured as a CRM Record Attribution field. Remove attribution or select another field.`,
          },
          { status: 400 }
        );
      }

      const localDef = LOCAL_VOIP_HUB_FIELDS.find((f) => f.key === m.localFieldKey);
      if (!localDef) {
        return NextResponse.json(
          { error: `Invalid payload: Unknown local field key '${m.localFieldKey}'.` },
          { status: 400 }
        );
      }

      const targetMetadata = fieldsMetadata.find((f) => f.fieldKey === m.externalFieldKey);
      if (targetMetadata) {
        if (!isFieldMappingCompatible(localDef.dataType, targetMetadata)) {
          return NextResponse.json(
            {
              error: `Incompatible field mapping: Local field '${localDef.label}' (${localDef.dataType}) cannot be mapped to CRM field '${targetMetadata.label}' (${targetMetadata.dataType}).`,
            },
            { status: 400 }
          );
        }
      }
    }

    // 1. Clear existing mappings for this org, provider, module
    await (adminSupabase as any)
      .from('crm_field_mappings')
      .delete()
      .eq('organization_id', profile.organization_id)
      .eq('provider', provider)
      .eq('external_module', externalModule);

    // 2. Insert new valid mappings
    if (mappings.length > 0) {
      const rowsToInsert = mappings
        .filter((m: any) => m.localFieldKey && m.externalFieldKey)
        .map((m: any) => ({
          organization_id: profile.organization_id,
          provider,
          external_module: externalModule,
          local_field_key: m.localFieldKey,
          external_field_key: m.externalFieldKey,
          is_enabled: m.isEnabled !== false,
        }));

      if (rowsToInsert.length > 0) {
        const { error: insertError } = await (adminSupabase as any)
          .from('crm_field_mappings')
          .insert(rowsToInsert);

        if (insertError) {
          throw insertError;
        }
      }
    }

    return NextResponse.json({
      success: true,
      message: 'CRM field mappings saved successfully.',
    });
  } catch (err: any) {
    console.error('[CRM Mapping API] Error saving field mappings:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to save field mappings.' },
      { status: 500 }
    );
  }
}
