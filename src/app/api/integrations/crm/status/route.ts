import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getComingSoonProviders } from '@/lib/integrations/crm/registry';
import { CRMConnectionSummary } from '@/lib/integrations/crm/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/integrations/crm/status
 * Returns connection statuses for all CRM providers for the authenticated user's organization.
 * STRICT SECURITY: Access/refresh tokens are NEVER returned to the browser.
 * GRACEFUL FALLBACK: Never crashes if crm_connections table is not yet migrated.
 */
export async function GET() {
  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    // Fetch user profile to determine organization_id
    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile?.organization_id) {
      return NextResponse.json(
        { error: 'Failed to retrieve user organization profile.' },
        { status: 403 }
      );
    }

    let connections: any[] = [];
    try {
      const adminSupabase = createAdminClient();
      const { data, error } = await (adminSupabase as any)
        .from('crm_connections')
        .select(
          'provider, status, external_account_id, external_org_name, external_user_email, connected_by_user_name, connected_at, last_refreshed_at, last_error'
        )
        .eq('organization_id', profile.organization_id);

      if (!error && data) {
        connections = data;
      }
    } catch (dbErr) {
      console.warn('[CRM Status API] Non-fatal DB query warning (table may be pending migration):', dbErr);
    }

    const connectionMap = new Map<string, any>();
    for (const conn of connections) {
      connectionMap.set(conn.provider, conn);
    }

    // Build Zoho summary
    const zohoConn = connectionMap.get('zoho');
    const zohoSummary: CRMConnectionSummary = {
      provider: 'zoho',
      name: 'Zoho CRM',
      description: 'Connect your Zoho CRM account to sync leads, contacts, calls and customer context.',
      status: zohoConn ? zohoConn.status : 'disconnected',
      externalAccountDisplay: zohoConn?.external_user_email || zohoConn?.external_account_id,
      externalOrgName: zohoConn?.external_org_name,
      connectedByName: zohoConn?.connected_by_user_name,
      connectedAt: zohoConn?.connected_at,
      lastRefreshedAt: zohoConn?.last_refreshed_at,
      lastError: zohoConn?.last_error,
      isAvailable: true,
    };

    const summaries: CRMConnectionSummary[] = [
      zohoSummary,
      ...getComingSoonProviders(),
    ];

    return NextResponse.json({
      success: true,
      integrations: summaries,
      userRole: profile.role,
    });
  } catch (err: any) {
    console.error('[CRM Status API] Internal server error:', err);
    return NextResponse.json(
      { error: 'Internal server error checking CRM status.' },
      { status: 500 }
    );
  }
}
