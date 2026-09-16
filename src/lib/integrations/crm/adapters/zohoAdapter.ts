import { CRMAdapter, CRMProviderId, CRMStoredCredentials } from '../types';

/**
 * Zoho CRM Adapter
 * Implements Zoho CRM OAuth 2.0 flow, regional data-center (DC) resolution,
 * token exchange, token refresh, connection verification, and token revocation.
 * Uses Zoho CRM API v8.
 */
export class ZohoCRMAdapter implements CRMAdapter {
  readonly providerId: CRMProviderId = 'zoho';
  readonly displayName = 'Zoho CRM';
  readonly description = 'CRM synchronization for leads, contacts, calls and customer context.';
  readonly isAvailable = true;

  private getClientId(): string {
    const id = process.env.ZOHO_CLIENT_ID;
    if (!id) {
      throw new Error('Configuration Error: ZOHO_CLIENT_ID is not configured in environment variables.');
    }
    return id;
  }

  private getClientSecret(): string {
    const secret = process.env.ZOHO_CLIENT_SECRET;
    if (!secret) {
      throw new Error('Configuration Error: ZOHO_CLIENT_SECRET is not configured in environment variables.');
    }
    return secret;
  }

  /**
   * Returns the registered OAuth application's home accounts domain.
   * Specified via ZOHO_ACCOUNTS_DOMAIN (e.g., https://accounts.zoho.com.au for AU console,
   * or https://accounts.zoho.com for US console).
   */
  private getAccountsDomain(): string {
    const domain = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com';
    return domain.replace(/\/$/, '');
  }

  /**
   * Returns requested scopes for Zoho CRM.
   * Uses least privilege required for connection validation, org info,
   * plus future leads/contacts/calls/notes operations.
   */
  public getScopes(): string[] {
    return [
      'ZohoCRM.users.READ',
      'ZohoCRM.org.READ',
      'ZohoCRM.modules.leads.ALL',
      'ZohoCRM.modules.contacts.ALL',
      'ZohoCRM.modules.calls.ALL',
      'ZohoCRM.modules.notes.ALL',
    ];
  }

  getAuthorizationUrl(params: { state: string; redirectUri: string }): string {
    const clientId = this.getClientId();
    const scopes = this.getScopes().join(',');

    const accountsDomain = this.getAccountsDomain();
    const baseUrl = `${accountsDomain}/oauth/v2/auth`;

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: scopes,
      redirect_uri: params.redirectUri,
      state: params.state,
      access_type: 'offline',
      prompt: 'consent',
    });

    return `${baseUrl}?${query.toString()}`;
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
    accountsServer?: string;
  }): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    apiDomain: string;
    accountsDomain: string;
    scopes: string[];
    externalAccountId?: string;
    externalOrgName?: string;
    externalUserEmail?: string;
  }> {
    const clientId = this.getClientId();
    const clientSecret = this.getClientSecret();
    const accountsDomain = (params.accountsServer || this.getAccountsDomain()).replace(/\/$/, '');

    const tokenEndpoint = `${accountsDomain}/oauth/v2/token`;

    const bodyParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: params.redirectUri,
      code: params.code,
    });

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyParams.toString(),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      const errorMsg = data.error || data.message || 'Failed to exchange authorization code with Zoho.';
      throw new Error(`Zoho OAuth Error: ${errorMsg}`);
    }

    const accessToken = data.access_token;
    const refreshToken = data.refresh_token;
    const expiresIn = Number(data.expires_in) || 3600;
    const apiDomain = (data.api_domain || 'https://www.zohoapis.com').replace(/\/$/, '');

    if (!accessToken || !refreshToken) {
      throw new Error('Zoho OAuth Error: Missing access_token or refresh_token in response.');
    }

    // Fetch org details & user email from Zoho CRM API v8
    let externalOrgName: string | undefined;
    let externalUserEmail: string | undefined;
    let externalAccountId: string | undefined;

    try {
      const orgRes = await fetch(`${apiDomain}/crm/v8/org`, {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      });
      if (orgRes.ok) {
        const orgData = await orgRes.json();
        if (orgData.org && orgData.org.length > 0) {
          externalOrgName = orgData.org[0].company_name || orgData.org[0].zgid;
          externalAccountId = String(orgData.org[0].zgid || orgData.org[0].id || '');
        }
      }

      const userRes = await fetch(`${apiDomain}/crm/v8/users?type=CurrentUser`, {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      });
      if (userRes.ok) {
        const userData = await userRes.json();
        if (userData.users && userData.users.length > 0) {
          externalUserEmail = userData.users[0].email;
          if (!externalAccountId) {
            externalAccountId = String(userData.users[0].id || '');
          }
        }
      }
    } catch (err) {
      console.warn('[ZohoAdapter] Non-fatal error fetching Zoho account metadata:', err);
    }

    return {
      accessToken,
      refreshToken,
      expiresIn,
      apiDomain,
      accountsDomain,
      scopes: this.getScopes(),
      externalAccountId,
      externalOrgName,
      externalUserEmail,
    };
  }

  async refreshToken(params: {
    refreshToken: string;
    accountsDomain: string;
  }): Promise<{ accessToken: string; expiresIn: number }> {
    const clientId = this.getClientId();
    const clientSecret = this.getClientSecret();
    const accountsDomain = (params.accountsDomain || this.getAccountsDomain()).replace(/\/$/, '');

    const tokenEndpoint = `${accountsDomain}/oauth/v2/token`;

    const bodyParams = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: params.refreshToken,
    });

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyParams.toString(),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(`Zoho Token Refresh Error: ${data.error || 'Failed to refresh token'}`);
    }

    return {
      accessToken: data.access_token,
      expiresIn: Number(data.expires_in) || 3600,
    };
  }

  async testConnection(credentials: CRMStoredCredentials): Promise<{
    success: boolean;
    message: string;
    orgName?: string;
    userEmail?: string;
  }> {
    try {
      const apiDomain = credentials.apiDomain.replace(/\/$/, '');
      const res = await fetch(`${apiDomain}/crm/v8/users?type=CurrentUser`, {
        headers: { Authorization: `Zoho-oauthtoken ${credentials.accessToken}` },
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        return {
          success: false,
          message: errData.message || `Zoho API returned HTTP ${res.status}`,
        };
      }

      const userData = await res.json();
      const user = userData.users && userData.users[0];

      return {
        success: true,
        message: 'Connection active',
        userEmail: user?.email,
      };
    } catch (err: any) {
      return {
        success: false,
        message: err.message || 'Connection test failed',
      };
    }
  }

  async revokeToken(params: { refreshToken: string; accountsDomain: string }): Promise<void> {
    try {
      const accountsDomain = (params.accountsDomain || this.getAccountsDomain()).replace(/\/$/, '');
      const revokeEndpoint = `${accountsDomain}/oauth/v2/token/revoke`;
      const bodyParams = new URLSearchParams({
        token: params.refreshToken,
      });

      await fetch(revokeEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: bodyParams.toString(),
      });
    } catch (err) {
      console.warn('[ZohoAdapter] Token revocation failed (may already be revoked):', err);
    }
  }
}
