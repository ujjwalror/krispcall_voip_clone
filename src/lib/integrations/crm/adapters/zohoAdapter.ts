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
   * Returns required OAuth authorization scopes for Zoho CRM API v8.
   * Grants least privilege required for connection validation, org info,
   * and future leads, contacts, calls, and notes operations.
   */
  public getScopes(): string[] {
    return [
      'ZohoCRM.users.READ',
      'ZohoCRM.org.READ',
      'ZohoCRM.settings.fields.READ',
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

  /**
   * Generates direct navigation URL for a linked Zoho record based on regional data-center.
   * Zero API requests required. Zero access tokens in URL.
   */
  getRecordUrl(apiDomain: string, module: 'Leads' | 'Contacts', recordId: string): string {
    const domain = (apiDomain || '').toLowerCase();
    let baseCrmDomain = 'https://crm.zoho.com';

    if (domain.includes('.zoho.com.au') || domain.includes('.zohoapis.com.au')) {
      baseCrmDomain = 'https://crm.zoho.com.au';
    } else if (domain.includes('.zoho.eu') || domain.includes('.zohoapis.eu')) {
      baseCrmDomain = 'https://crm.zoho.eu';
    } else if (domain.includes('.zoho.in') || domain.includes('.zohoapis.in')) {
      baseCrmDomain = 'https://crm.zoho.in';
    } else if (domain.includes('.zoho.com.cn') || domain.includes('.zohoapis.com.cn')) {
      baseCrmDomain = 'https://crm.zoho.com.cn';
    }

    return `${baseCrmDomain}/crm/tab/${module}/${encodeURIComponent(recordId)}`;
  }

  /**
   * Safe phone search variant helper.
   * Generates safe phone search strings (e.g. E.164 "+61412345678" and local "0412345678").
   */
  private getPhoneVariants(phoneRaw: string): string[] {
    const cleaned = phoneRaw.trim();
    if (!cleaned) return [];
    const variants = new Set<string>();
    variants.add(cleaned);

    // E.164 Australian variant
    if (cleaned.startsWith('+614') && cleaned.length === 12) {
      variants.add('04' + cleaned.slice(4));
    } else if (cleaned.startsWith('04') && cleaned.length === 10) {
      variants.add('+614' + cleaned.slice(2));
    }
    return Array.from(variants);
  }

  /**
   * Normalizes phone numbers for complete-number comparison.
   * Handles Australian international (+61 4...) and local (04...) equivalence.
   */
  private normalizePhoneForComparison(phoneRaw: string): string {
    const digitsOnly = phoneRaw.replace(/\D/g, '');
    if (digitsOnly.startsWith('614') && digitsOnly.length === 11) {
      return '04' + digitsOnly.slice(3);
    }
    return digitsOnly;
  }

  /**
   * Verifies if candidate phone/mobile represents the exact same complete phone number.
   * Zero last-4 or partial/fuzzy matching.
   */
  private isPhoneMatch(requestedPhone: string, candidatePhone?: string): boolean {
    if (!candidatePhone) return false;
    const normReq = this.normalizePhoneForComparison(requestedPhone);
    const normCand = this.normalizePhoneForComparison(candidatePhone);
    return normReq.length > 0 && normReq === normCand;
  }

  /**
   * Verifies exact case-insensitive email match.
   */
  private isEmailMatch(requestedEmail: string, candidateEmail?: string): boolean {
    if (!candidateEmail || !requestedEmail) return false;
    return requestedEmail.trim().toLowerCase() === candidateEmail.trim().toLowerCase();
  }

  /**
   * Searches Zoho CRM Contacts and Leads modules using verified v8 search endpoint.
   * Performs post-search normalization & verification on returned candidates.
   * Conservative matching only. Handles HTTP 204 (No Content) normally.
   */
  async searchPerson(
    credentials: CRMStoredCredentials,
    query: { phone?: string; email?: string }
  ): Promise<import('../types').CRMSearchResult[]> {
    const apiDomain = credentials.apiDomain.replace(/\/$/, '');
    const results: import('../types').CRMSearchResult[] = [];
    const seenIds = new Set<string>();

    const modules: Array<'Contacts' | 'Leads'> = ['Contacts', 'Leads'];

    // Helper to query a single endpoint and verify candidate matches
    const queryEndpoint = async (
      moduleName: 'Contacts' | 'Leads',
      searchParamKey: 'phone' | 'email',
      searchVal: string,
      targetRequestedVal: string
    ) => {
      try {
        const url = `${apiDomain}/crm/v8/${moduleName}/search?${searchParamKey}=${encodeURIComponent(searchVal)}`;
        const res = await fetch(url, {
          headers: { Authorization: `Zoho-oauthtoken ${credentials.accessToken}` },
        });

        // 204 No Content means 0 records matched
        if (res.status === 204 || !res.ok) {
          return;
        }

        const data = await res.json();
        if (data && Array.isArray(data.data)) {
          for (const item of data.data) {
            const id = String(item.id || '');
            if (!id || seenIds.has(`${moduleName}:${id}`)) continue;

            const phoneVal = item.Phone || item.Mobile || undefined;
            const emailVal = item.Email || undefined;

            // Post-search Verification
            if (searchParamKey === 'phone') {
              const matchesPhone =
                (item.Phone && this.isPhoneMatch(targetRequestedVal, item.Phone)) ||
                (item.Mobile && this.isPhoneMatch(targetRequestedVal, item.Mobile));
              if (!matchesPhone) {
                // Reject candidate returned by broad/imprecise Zoho search
                continue;
              }
            } else if (searchParamKey === 'email') {
              const matchesEmail = this.isEmailMatch(targetRequestedVal, emailVal);
              if (!matchesEmail) {
                continue;
              }
            }

            seenIds.add(`${moduleName}:${id}`);

            const firstName = item.First_Name || '';
            const lastName = item.Last_Name || item.Full_Name || '';
            const displayName = item.Full_Name || `${firstName} ${lastName}`.trim() || 'Zoho Record';
            const company = item.Company || (item.Account_Name && item.Account_Name.name) || undefined;
            const ownerName = item.Owner && item.Owner.name ? String(item.Owner.name) : undefined;

            results.push({
              externalRecordId: id,
              externalModule: moduleName,
              displayName,
              firstName,
              lastName,
              company,
              phone: phoneVal,
              email: emailVal,
              ownerName,
            });
          }
        }
      } catch (err) {
        console.warn(`[ZohoAdapter] Error searching ${moduleName} with ${searchParamKey}=${searchVal}:`, err);
      }
    };

    // 1. Phone search with safe variants and post-verification
    if (query.phone && query.phone.trim()) {
      const phoneVariants = this.getPhoneVariants(query.phone);
      for (const mod of modules) {
        for (const phoneVar of phoneVariants) {
          await queryEndpoint(mod, 'phone', phoneVar, query.phone.trim());
        }
      }
    }

    // 2. Email search (if phone returned no matches or phone is empty)
    if (results.length === 0 && query.email && query.email.trim()) {
      const cleanEmail = query.email.trim();
      for (const mod of modules) {
        await queryEndpoint(mod, 'email', cleanEmail, cleanEmail);
      }
    }

    return results;
  }

  /**
   * Returns recommended default field mappings for Zoho CRM.
   * Suggested only — Admin must explicitly save configuration.
   */
  getDefaultFieldMappings(module: 'Leads' | 'Contacts'): Array<{ localFieldKey: string; externalFieldKey: string }> {
    return [
      { localFieldKey: 'first_name', externalFieldKey: 'First_Name' },
      { localFieldKey: 'last_name', externalFieldKey: 'Last_Name' },
      { localFieldKey: 'phone', externalFieldKey: 'Phone' },
      { localFieldKey: 'email', externalFieldKey: 'Email' },
      { localFieldKey: 'company', externalFieldKey: 'Company' },
      { localFieldKey: 'notes', externalFieldKey: 'Description' },
    ];
  }

  /**
   * Fetches normalized field metadata for a Zoho module using GET /crm/v8/settings/fields.
   * Discovers standard and custom fields dynamically.
   */
  async getModuleFields(
    credentials: CRMStoredCredentials,
    module: 'Leads' | 'Contacts'
  ): Promise<import('../types').CRMFieldMetadata[]> {
    const apiDomain = credentials.apiDomain.replace(/\/$/, '');
    const url = `${apiDomain}/crm/v8/settings/fields?module=${encodeURIComponent(module)}&type=all`;

    const res = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${credentials.accessToken}` },
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(`Failed to fetch Zoho CRM field metadata: ${errData.message || `HTTP ${res.status}`}`);
    }

    const data = await res.json();
    const fieldsRaw = data.fields || [];
    const results: import('../types').CRMFieldMetadata[] = [];

    for (const f of fieldsRaw) {
      const fieldKey = String(f.api_name || '');
      if (!fieldKey) continue;

      const label = String(f.field_label || f.display_label || fieldKey);
      const isRequired = Boolean(f.system_mandatory || f.mandatory);
      const isWritable = !f.read_only;
      const isCustom = Boolean(f.custom_field);

      let dataType: import('../types').CRMFieldDataType = 'text';
      const rawType = String(f.data_type || '').toLowerCase();

      if (['text', 'string', 'varchar', 'name', 'company', 'company_name', 'website', 'url', 'domain'].includes(rawType)) {
        dataType = 'text';
      } else if (['phone', 'mobile', 'fax'].includes(rawType)) {
        dataType = 'phone';
      } else if (rawType === 'email') {
        dataType = 'email';
      } else if (['textarea', 'multiline'].includes(rawType)) {
        dataType = 'textarea';
      } else if (['picklist', 'multiselect'].includes(rawType)) {
        dataType = 'picklist';
      } else if (['integer', 'double', 'currency', 'bigint', 'percent', 'autonumber', 'auto number'].includes(rawType)) {
        dataType = 'number';
      } else if (rawType === 'boolean') {
        dataType = 'boolean';
      } else if (rawType === 'date') {
        dataType = 'date';
      } else if (rawType === 'datetime') {
        dataType = 'datetime';
      } else {
        dataType = 'other';
      }

      let options: import('../types').CRMFieldOption[] | undefined;

      if (dataType === 'picklist' && Array.isArray(f.pick_list_values)) {
        options = f.pick_list_values
          .filter((opt: any) => opt && opt.actual_value !== undefined)
          .map((opt: any) => ({
            label: String(opt.display_value || opt.actual_value),
            value: String(opt.actual_value),
          }));
      }

      results.push({
        fieldKey,
        label,
        dataType,
        isRequired,
        isWritable,
        isCustom,
        options,
      });
    }

    return results;
  }

  /**
   * Creates a Zoho Lead using POST /crm/v8/Leads with standard and mapped custom fields.
   * Last Name is strictly validated without fabricated fallbacks.
   * Handles customer-specific layout validation errors cleanly.
   */
  async createLead(
    credentials: CRMStoredCredentials,
    lead: import('../types').CRMLeadInput & { dynamicFields?: Record<string, any> }
  ): Promise<{ externalRecordId: string; externalModule: 'Leads' }> {
    const apiDomain = credentials.apiDomain.replace(/\/$/, '');
    const url = `${apiDomain}/crm/v8/Leads`;

    const payloadItem: Record<string, any> = {};

    // Populate payload strictly from effective dynamicFields mapping
    if (lead.dynamicFields && typeof lead.dynamicFields === 'object') {
      for (const [key, val] of Object.entries(lead.dynamicFields)) {
        if (val !== undefined && val !== null && val !== '') {
          payloadItem[key] = val;
        }
      }
    }

    // Ensure Zoho Lead Last_Name requirement is satisfied without fabricating dummy values
    if (!payloadItem.Last_Name && lead.lastName && lead.lastName.trim()) {
      payloadItem.Last_Name = lead.lastName.trim();
    }

    const lastNameClean = payloadItem.Last_Name ? String(payloadItem.Last_Name).trim() : '';
    if (!lastNameClean) {
      throw new Error('Last Name is required to create a Zoho Lead.');
    }
    payloadItem.Last_Name = lastNameClean;

    const body = { data: [payloadItem] };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!res.ok || !data.data || !Array.isArray(data.data) || data.data.length === 0) {
      const mainError = data.message || `HTTP ${res.status} from Zoho CRM API`;
      throw new Error(`Failed to create Lead in Zoho CRM: ${mainError}`);
    }

    const firstResult = data.data[0];

    if (firstResult.status === 'error') {
      const code = firstResult.code || 'CREATION_FAILED';
      const details = firstResult.details || {};
      const fieldName = details.api_name || details.field_label || '';

      if (code === 'MANDATORY_NOT_FOUND') {
        throw new Error(
          `Unable to create Lead in Zoho CRM: Your Zoho layout requires mandatory field '${fieldName || 'unknown'}'. Please complete this field in Zoho CRM or update layout requirements.`
        );
      } else if (code === 'INVALID_DATA') {
        throw new Error(
          `Unable to create Lead in Zoho CRM: Invalid data for field '${fieldName || 'unknown'}'. Message: ${firstResult.message}`
        );
      } else {
        throw new Error(`Zoho CRM Error (${code}): ${firstResult.message || 'Lead creation rejected by Zoho.'}`);
      }
    }

    const recordId = String(firstResult.details?.id || firstResult.details?.ID || '');

    if (!recordId) {
      throw new Error('Zoho CRM returned success status but omitted record ID.');
    }

    return {
      externalRecordId: recordId,
      externalModule: 'Leads',
    };
  }
}



