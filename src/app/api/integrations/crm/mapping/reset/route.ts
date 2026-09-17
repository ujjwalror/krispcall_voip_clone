import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getCRMAdapter } from '@/lib/integrations/crm/registry';

export const dynamic = 'force-dynamic';

/**
 * POST /api/integrations/crm/mapping/reset
 * Clears saved organization mappings for a module and returns adapter recommended default suggestions.
 * Admin role required.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { provider = 'zoho', externalModule = 'Leads' } = body;

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
      return NextResponse.json({ error: 'Forbidden. Admin role required to reset field mappings.' }, { status: 403 });
    }

    const adminSupabase = createAdminClient();

    // Clear saved mappings for this module
    await (adminSupabase as any)
      .from('crm_field_mappings')
      .delete()
      .eq('organization_id', profile.organization_id)
      .eq('provider', provider)
      .eq('external_module', externalModule);

    // Get adapter defaults
    const adapter = getCRMAdapter(provider as any);
    const defaults = adapter.getDefaultFieldMappings(externalModule);

    return NextResponse.json({
      success: true,
      provider,
      module: externalModule,
      defaults,
      message: 'Field mappings reset to recommended suggestions. Click Save Mapping to persist.',
    });
  } catch (err: any) {
    console.error('[CRM Reset Mapping API] Error resetting field mappings:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to reset field mappings.' },
      { status: 500 }
    );
  }
}
