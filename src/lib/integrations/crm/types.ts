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

export type CRMFieldDataType =
  | 'text'
  | 'phone'
  | 'email'
  | 'textarea'
  | 'picklist'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'other';

export interface CRMFieldOption {
  label: string;
  value: string;
}

export interface CRMFieldMetadata {
  fieldKey: string;
  label: string;
  dataType: CRMFieldDataType;
  isRequired: boolean;
  isWritable: boolean;
  isCustom: boolean;
  isSourceField?: boolean;
  options?: CRMFieldOption[];
}

export interface CRMFieldMapping {
  id?: string;
  organizationId?: string;
  provider: CRMProviderId;
  externalModule: 'Leads' | 'Contacts';
  localFieldKey: string;
  externalFieldKey: string;
  isEnabled?: boolean;
}

export interface CRMAttributionRule {
  id?: string;
  organizationId?: string;
  provider: CRMProviderId;
  externalModule: 'Leads' | 'Contacts';
  attributeKey: string;
  externalFieldKey: string;
  configuredValue: string;
  isEnabled?: boolean;
}

/**
 * Application-level metadata cache schema version.
 * Increment when provider adapter field normalization logic or data type classifications update.
 * Automatically invalidates legacy DB cached metadata snapshots without needing DB migrations.
 */
export const CRM_FIELD_METADATA_CACHE_VERSION = 3;

export interface CRMFieldMetadataCache {
  id?: string;
  organizationId: string;
  provider: CRMProviderId;
  externalModule: 'Leads' | 'Contacts';
  fields: CRMFieldMetadata[];
  fetchedAt: string;
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
  createLead(credentials: CRMStoredCredentials, lead: CRMLeadInput & { dynamicFields?: Record<string, any> }): Promise<{ externalRecordId: string; externalModule: 'Leads' }>;
  getRecordUrl(apiDomain: string, module: 'Leads' | 'Contacts', recordId: string): string;
  getModuleFields(credentials: CRMStoredCredentials, module: 'Leads' | 'Contacts'): Promise<CRMFieldMetadata[]>;
  getDefaultFieldMappings(module: 'Leads' | 'Contacts'): Array<{ localFieldKey: string; externalFieldKey: string }>;
}

export interface LocalCRMFieldDefinition {
  key: string;
  label: string;
  dataType: CRMFieldDataType;
}

export const LOCAL_VOIP_HUB_FIELDS: LocalCRMFieldDefinition[] = [
  { key: 'first_name', label: 'First Name', dataType: 'text' },
  { key: 'last_name', label: 'Last Name', dataType: 'text' },
  { key: 'full_name', label: 'Full Name', dataType: 'text' },
  { key: 'phone', label: 'Phone Number', dataType: 'phone' },
  { key: 'email', label: 'Email Address', dataType: 'email' },
  { key: 'company', label: 'Company / Organization', dataType: 'text' },
  { key: 'notes', label: 'Notes & Remarks', dataType: 'textarea' },
];

/**
 * Single provider-neutral field compatibility function.
 * Enforces safe field mapping rules between local VoIP Hub fields and external CRM fields.
 * Disallows incompatible mappings (e.g. email -> date, phone -> boolean, text -> read-only/other).
 */
export function isFieldMappingCompatible(
  localDataType: CRMFieldDataType,
  externalField: CRMFieldMetadata
): boolean {
  if (!externalField || !externalField.isWritable) {
    return false;
  }

  const extType = externalField.dataType;

  switch (localDataType) {
    case 'text':
      return extType === 'text' || extType === 'textarea';
    case 'textarea':
      return extType === 'textarea' || extType === 'text';
    case 'phone':
      return extType === 'phone' || extType === 'text';
    case 'email':
      return extType === 'email' || extType === 'text';
    default:
      return false;
  }
}



