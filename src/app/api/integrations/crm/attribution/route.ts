import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  CRMAttributionRule,
  CRMFieldMetadata,
} from '@/lib/integrations/crm/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/integrations/crm/attribution?provider=zoho&module=Leads
 * Retrieves saved organization CRM record attribution rules.
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
      .from('crm_record_attribution_rules')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .eq('provider', provider)
      .eq('external_module', moduleName);

    if (queryError) {
      // Table may not exist yet if migration hasn't run
      return NextResponse.json({
        success: true,
        provider,
        module: moduleName,
        rules: [],
      });
    }

    const rules: CRMAttributionRule[] = (rows || []).map((row: any) => ({
      id: row.id,
      organizationId: row.organization_id,
      provider: row.provider,
      externalModule: row.external_module,
      attributeKey: row.attribute_key,
      externalFieldKey: row.external_field_key,
      configuredValue: row.configured_value,
      isEnabled: row.is_enabled,
    }));

    return NextResponse.json({
      success: true,
      provider,
      module: moduleName,
      rules,
    });
  } catch (err: any) {
    console.error('[CRM Attribution API] Error retrieving attribution rules:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to retrieve attribution rules.' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/integrations/crm/attribution
 * Saves organization CRM record attribution rule. Admin role required.
 * Server-side validated against CRM metadata picklist options.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      provider = 'zoho',
      externalModule = 'Leads',
      attributeKey = 'lead_source',
      externalFieldKey,
      configuredValue,
      isEnabled = true,
    } = body;

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

    if (profile.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden. Admin role required to modify attribution rules.' }, { status: 403 });
    }

    const adminSupabase = createAdminClient();

    // If clearing/disabling attribution rule
    if (!externalFieldKey || !configuredValue || !isEnabled) {
      try {
        await (adminSupabase as any)
          .from('crm_record_attribution_rules')
          .delete()
          .eq('organization_id', profile.organization_id)
          .eq('provider', provider)
          .eq('external_module', externalModule)
          .eq('attribute_key', attributeKey);
      } catch (err) {
        // Table may not exist yet
      }

      return NextResponse.json({
        success: true,
        message: 'CRM record attribution rule cleared successfully.',
      });
    }

    // Validate target field exists in CRM metadata snapshot
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

    const targetField = fieldsMetadata.find((f) => f.fieldKey === externalFieldKey);
    if (!targetField) {
      return NextResponse.json(
        { error: `Target CRM field '${externalFieldKey}' was not found in ${provider.toUpperCase()} ${externalModule} field metadata.` },
        { status: 400 }
      );
    }

    if (!targetField.isWritable) {
      return NextResponse.json(
        { error: `Target CRM field '${targetField.label}' is read-only in ${provider.toUpperCase()}.` },
        { status: 400 }
      );
    }

    // Collision check: Verify target external_field_key is not already used by an enabled Contact Field Mapping
    const { data: existingMapping } = await (adminSupabase as any)
      .from('crm_field_mappings')
      .select('local_field_key')
      .eq('organization_id', profile.organization_id)
      .eq('provider', provider)
      .eq('external_module', externalModule)
      .eq('external_field_key', externalFieldKey)
      .eq('is_enabled', true)
      .maybeSingle();

    if (existingMapping) {
      return NextResponse.json(
        {
          error:
            'This CRM field is already used by Contact Field Mapping. Choose a different attribution field or remove the existing mapping.',
        },
        { status: 400 }
      );
    }

    // Picklist validation: NEVER submit an arbitrary value not permitted by CRM picklist metadata
    if (targetField.dataType === 'picklist' && Array.isArray(targetField.options)) {
      const allowedValues = targetField.options.map((opt) => opt.value);
      if (!allowedValues.includes(configuredValue)) {
        return NextResponse.json(
          {
            error: `"${configuredValue}" is not currently an available value in field '${targetField.label}'. Add "${configuredValue}" to your CRM picklist options and click Refresh CRM Fields.`,
          },
          { status: 400 }
        );
      }
    }

    // Atomic upsert rule using unique constraint (organization_id, provider, external_module, attribute_key)
    const { error: upsertError } = await (adminSupabase as any)
      .from('crm_record_attribution_rules')
      .upsert(
        {
          organization_id: profile.organization_id,
          provider,
          external_module: externalModule,
          attribute_key: attributeKey,
          external_field_key: externalFieldKey,
          configured_value: configuredValue,
          is_enabled: true,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: 'organization_id,provider,external_module,attribute_key',
        }
      );

    if (upsertError) {
      throw upsertError;
    }

    return NextResponse.json({
      success: true,
      message: 'CRM record attribution rule saved successfully.',
    });
  } catch (err: any) {
    console.error('[CRM Attribution API] Error saving attribution rule:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to save attribution rule.' },
      { status: 500 }
    );
  }
}
