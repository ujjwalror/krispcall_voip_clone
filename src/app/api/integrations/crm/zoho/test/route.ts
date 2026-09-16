import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptToken, encryptToken } from '@/lib/integrations/crm/crypto';
import { getCRMAdapter } from '@/lib/integrations/crm/registry';

export const dynamic = 'force-dynamic';

/**
 * POST /api/integrations/crm/zoho/test
 * Admin-only endpoint to verify active Zoho CRM authorization.
 * Automatically handles server-side token refresh if expired.
 */
export async function POST() {
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

    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return NextResponse.json(
        { error: 'User profile not found.' },
        { status: 404 }
      );
    }

    if (profile.role !== 'admin') {
      return NextResponse.json(
        { error: 'Forbidden. Only organization Admins can test CRM connections.' },
        { status: 403 }
      );
    }

    const adminSupabase = createAdminClient();
    const { data: conn, error: connError } = await (adminSupabase as any)
      .from('crm_connections')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .eq('provider', 'zoho')
      .single();

    if (connError || !conn || conn.status === 'disconnected') {
      return NextResponse.json({
        success: false,
        message: 'Zoho CRM is not connected.',
      });
    }

    let accessToken = decryptToken(conn.encrypted_access_token);
    const refreshToken = decryptToken(conn.encrypted_refresh_token);

    const isExpired = new Date(conn.access_token_expires_at).getTime() < Date.now() + 60000;
    const zohoAdapter = getCRMAdapter('zoho');

    // Auto-refresh token if expired
    if (isExpired) {
      try {
        const refreshResult = await zohoAdapter.refreshToken({
          refreshToken,
          accountsDomain: conn.accounts_domain,
        });

        accessToken = refreshResult.accessToken;
        const newExpiresAt = new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString();
        const newEncryptedAccess = encryptToken(accessToken);

        await (adminSupabase as any)
          .from('crm_connections')
          .update({
            encrypted_access_token: newEncryptedAccess,
            access_token_expires_at: newExpiresAt,
            last_refreshed_at: new Date().toISOString(),
            status: 'connected',
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', conn.id);
      } catch (refreshErr: any) {
        console.error('[Zoho Test API] Refresh token error:', refreshErr);
        await (adminSupabase as any)
          .from('crm_connections')
          .update({
            status: 'reauthorization_required',
            last_error: refreshErr.message || 'Token refresh failed',
            updated_at: new Date().toISOString(),
          })
          .eq('id', conn.id);

        return NextResponse.json({
          success: false,
          message: 'Authorization expired — please reconnect Zoho CRM.',
        });
      }
    }

    // Execute test ping to Zoho CRM API
    const testResult = await zohoAdapter.testConnection({
      accessToken,
      refreshToken,
      expiresAt: conn.access_token_expires_at,
      apiDomain: conn.api_domain,
      accountsDomain: conn.accounts_domain,
      scopes: conn.scopes || [],
    });

    if (testResult.success) {
      await (adminSupabase as any)
        .from('crm_connections')
        .update({
          status: 'connected',
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', conn.id);

      return NextResponse.json({
        success: true,
        message: 'Connection successful',
        userEmail: testResult.userEmail || conn.external_user_email,
        orgName: conn.external_org_name,
      });
    } else {
      await (adminSupabase as any)
        .from('crm_connections')
        .update({
          status: 'error',
          last_error: testResult.message,
          updated_at: new Date().toISOString(),
        })
        .eq('id', conn.id);

      return NextResponse.json({
        success: false,
        message: `Connection issue: ${testResult.message}`,
      });
    }
  } catch (err: any) {
    console.error('[Zoho Test API] Unexpected error:', err);
    return NextResponse.json(
      { error: 'Internal server error testing Zoho connection.' },
      { status: 500 }
    );
  }
}
