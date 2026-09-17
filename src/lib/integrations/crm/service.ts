import { createAdminClient } from '@/lib/supabase/admin';
import { getCRMAdapter } from './registry';
import { decryptToken, encryptToken } from './crypto';
import { CRMProviderId, CRMStoredCredentials } from './types';

/**
 * Retrieves valid decrypted CRM credentials for an organization.
 * Automatically refreshes the access token if it is expired or near expiration.
 */
export async function getValidCRMCredentials(
  organizationId: string,
  provider: CRMProviderId = 'zoho'
): Promise<CRMStoredCredentials> {
  const adminSupabase = createAdminClient();

  const { data: conn, error } = await (adminSupabase as any)
    .from('crm_connections')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('provider', provider)
    .single();

  if (error || !conn) {
    throw new Error(`No active ${provider.toUpperCase()} CRM connection found for your organization.`);
  }

  if (conn.status !== 'connected') {
    throw new Error(
      `Your ${provider.toUpperCase()} CRM connection is in '${conn.status}' status. Please re-authorize in Settings.`
    );
  }

  const adapter = getCRMAdapter(provider);

  const refreshToken = decryptToken(conn.encrypted_refresh_token);
  let accessToken = decryptToken(conn.encrypted_access_token);
  const expiresAtMs = new Date(conn.access_token_expires_at).getTime();

  // Check if token expires within 2 minutes (120,000 ms)
  const isExpiringSoon = Date.now() + 120000 >= expiresAtMs;

  if (isExpiringSoon) {
    try {
      const refreshed = await adapter.refreshToken({
        refreshToken,
        accountsDomain: conn.accounts_domain,
      });

      accessToken = refreshed.accessToken;
      const newExpiresAt = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();
      const newEncryptedAccess = encryptToken(accessToken);

      await (adminSupabase as any)
        .from('crm_connections')
        .update({
          encrypted_access_token: newEncryptedAccess,
          access_token_expires_at: newExpiresAt,
          last_refreshed_at: new Date().toISOString(),
          status: 'connected',
          last_error: null,
        })
        .eq('id', conn.id);
    } catch (refreshErr: any) {
      // Mark connection error
      await (adminSupabase as any)
        .from('crm_connections')
        .update({
          status: 'error',
          last_error: refreshErr.message || 'Token refresh failed',
        })
        .eq('id', conn.id);

      throw new Error(`CRM Authentication Error: Failed to refresh ${provider.toUpperCase()} access token.`);
    }
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: conn.access_token_expires_at,
    apiDomain: conn.api_domain,
    accountsDomain: conn.accounts_domain,
    scopes: conn.scopes || [],
  };
}
