export type CRMProviderId = 'zoho' | 'hubspot' | 'salesforce' | 'pipedrive' | 'clickup';

export type CRMConnectionStatus = 'connected' | 'disconnected' | 'error' | 'reauthorization_required';

export interface CRMConnectionSummary {
  provider: CRMProviderId;
  name: string;
  description: string;
  status: CRMConnectionStatus | 'coming_soon';
  externalAccountDisplay?: string;
  externalOrgName?: string;
  connectedByName?: string;
  connectedAt?: string;
  lastRefreshedAt?: string;
  lastError?: string;
  isAvailable: boolean;
}

export interface CRMStoredCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  apiDomain: string;
  accountsDomain: string;
  scopes: string[];
}

export interface CRMAdapter {
  providerId: CRMProviderId;
  displayName: string;
  description: string;
  isAvailable: boolean;

  getAuthorizationUrl(params: { state: string; redirectUri: string }): string;
  exchangeCode(params: { code: string; redirectUri: string; accountsServer?: string }): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    apiDomain: string;
    accountsDomain: string;
    scopes: string[];
    externalAccountId?: string;
    externalOrgName?: string;
    externalUserEmail?: string;
  }>;
  refreshToken(params: { refreshToken: string; accountsDomain: string }): Promise<{
    accessToken: string;
    expiresIn: number;
  }>;
  testConnection(credentials: CRMStoredCredentials): Promise<{
    success: boolean;
    message: string;
    orgName?: string;
    userEmail?: string;
  }>;
  revokeToken?(params: { refreshToken: string; accountsDomain: string }): Promise<void>;
}
