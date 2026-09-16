import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyOAuthState, encryptToken } from '@/lib/integrations/crm/crypto';
import { getCRMAdapter } from '@/lib/integrations/crm/registry';

export const dynamic = 'force-dynamic';

/**
 * GET /api/integrations/crm/zoho/callback
 * OAuth callback handler for Zoho CRM.
 * Validates state, exchanges authorization code server-side, encrypts tokens,
 * saves connection to crm_connections via service role client, and redirects to Settings.
 */
export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const state = requestUrl.searchParams.get('state');
  const accountsServer = requestUrl.searchParams.get('accounts-server') || undefined;
  const errorParam = requestUrl.searchParams.get('error');

  const settingsUrl = new URL('/settings?tab=integrations', request.url);

  if (errorParam) {
    console.error('[Zoho Callback API] OAuth error received from Zoho:', errorParam);
    settingsUrl.searchParams.set('error', `Zoho authorization declined: ${errorParam}`);
    return NextResponse.redirect(settingsUrl);
  }

  if (!code || !state) {
    settingsUrl.searchParams.set('error', 'Missing authorization code or state parameter.');
    return NextResponse.redirect(settingsUrl);
  }

  try {
    const cookieStore = await cookies();
    const storedState = cookieStore.get('crm_oauth_state')?.value;

    if (!storedState || storedState !== state) {
      settingsUrl.searchParams.set('error', 'OAuth state mismatch (CSRF protection activated).');
      return NextResponse.redirect(settingsUrl);
    }

    // Verify cryptographic signature & expiration of state
    const statePayload = verifyOAuthState(state);

    // Verify current authenticated session matches state
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user || user.id !== statePayload.userId) {
      settingsUrl.searchParams.set('error', 'Session mismatch during OAuth callback.');
      return NextResponse.redirect(settingsUrl);
    }

    // Fetch user profile to verify organization & role
    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('organization_id, full_name, role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile || profile.organization_id !== statePayload.organizationId) {
      settingsUrl.searchParams.set('error', 'Organization tenant mismatch during OAuth callback.');
      return NextResponse.redirect(settingsUrl);
    }

    if (profile.role !== 'admin') {
      settingsUrl.searchParams.set('error', 'Only Admins can establish CRM connections.');
      return NextResponse.redirect(settingsUrl);
    }

    // Determine redirect URI used during connect
    let redirectUri = process.env.ZOHO_REDIRECT_URI;
    if (!redirectUri) {
      redirectUri = `${requestUrl.protocol}//${requestUrl.host}/api/integrations/crm/zoho/callback`;
    }

    // Exchange authorization code with Zoho
    const zohoAdapter = getCRMAdapter('zoho');
    const tokenResult = await zohoAdapter.exchangeCode({
      code,
      redirectUri,
      accountsServer,
    });

    // Encrypt sensitive tokens server-side
    const encryptedAccess = encryptToken(tokenResult.accessToken);
    const encryptedRefresh = encryptToken(tokenResult.refreshToken);
    const expiresAt = new Date(Date.now() + tokenResult.expiresIn * 1000).toISOString();

    // Upsert crm_connections record using createAdminClient (Service Role)
    const adminSupabase = createAdminClient();
    const { error: upsertError } = await (adminSupabase as any)
      .from('crm_connections')
      .upsert(
        {
          organization_id: profile.organization_id,
          provider: 'zoho',
          status: 'connected',
          external_account_id: tokenResult.externalAccountId || null,
          external_org_name: tokenResult.externalOrgName || null,
          external_user_email: tokenResult.externalUserEmail || null,
          api_domain: tokenResult.apiDomain,
          accounts_domain: tokenResult.accountsDomain,
          scopes: tokenResult.scopes,
          encrypted_access_token: encryptedAccess,
          encrypted_refresh_token: encryptedRefresh,
          access_token_expires_at: expiresAt,
          connected_by_user_id: user.id,
          connected_by_user_name: profile.full_name || 'Admin',
          connected_at: new Date().toISOString(),
          last_refreshed_at: new Date().toISOString(),
          last_error: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id,provider' }
      );

    if (upsertError) {
      console.error('[Zoho Callback API] Error saving crm_connection record:', upsertError);
      settingsUrl.searchParams.set('error', 'Failed to store secure CRM integration authorization.');
      return NextResponse.redirect(settingsUrl);
    }

    // Clear state cookie
    cookieStore.delete('crm_oauth_state');

    settingsUrl.searchParams.set('connected', 'zoho');
    return NextResponse.redirect(settingsUrl);
  } catch (err: any) {
    console.error('[Zoho Callback API] Internal error processing callback:', err);
    settingsUrl.searchParams.set('error', err.message || 'Failed to complete Zoho OAuth callback.');
    return NextResponse.redirect(settingsUrl);
  }
}
