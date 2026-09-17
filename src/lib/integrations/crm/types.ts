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

export interface CRMSearchResult {
  externalRecordId: string;
  externalModule: 'Leads' | 'Contacts';
  displayName: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  phone?: string;
  email?: string;
  ownerName?: string;
}

export interface CRMLeadInput {
  firstName?: string;
  lastName: string;
  phone?: string;
  email?: string;
  company?: string;
  description?: string;
}

export interface CRMRecordLink {
  id: string;
  organizationId: string;
  provider: CRMProviderId;
  contactId: string;
  externalModule: 'Leads' | 'Contacts';
  externalRecordId: string;
  externalDisplayName?: string;
  externalEmail?: string;
  externalPhone?: string;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
  recordUrl?: string;
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

  searchPerson(credentials: CRMStoredCredentials, query: { phone?: string; email?: string }): Promise<CRMSearchResult[]>;
  createLead(credentials: CRMStoredCredentials, lead: CRMLeadInput): Promise<{ externalRecordId: string; externalModule: 'Leads' }>;
  getRecordUrl(apiDomain: string, module: 'Leads' | 'Contacts', recordId: string): string;
}

