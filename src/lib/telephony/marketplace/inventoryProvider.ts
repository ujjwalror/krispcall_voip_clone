import 'server-only';
import { createTwilioServerClient } from '@/lib/twilio/client';

export type NumberCategory = 'local' | 'mobile' | 'toll_free';

export interface InventoryCountryItem {
  countryCode: string; // ISO-2 country code (e.g., 'US', 'AU', 'GB')
  countryName: string;
  supportedTypes: NumberCategory[];
}

export interface FilterCapabilityMap {
  contains: boolean;
  areaCode: boolean;
  locality: boolean;
  region: boolean;
  postalCode: boolean;
  voiceCapabilities: boolean;
  smsCapabilities: boolean;
  mmsCapabilities: boolean;
}

export interface InventorySearchQuery {
  countryCode: string;
  numberType?: NumberCategory;
  contains?: string;
  areaCode?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
  voiceEnabled?: boolean;
  smsEnabled?: boolean;
  mmsEnabled?: boolean;
  limit?: number;
}

export interface InventoryNumberItem {
  provider: 'twilio';
  providerReference: string;
  phoneNumber: string;
  friendlyDisplay: string;
  countryCode: string;
  numberType: NumberCategory;
  locality: string | null;
  region: string | null;
  postalCode: string | null;
  addressRequirements: string | null;
  capabilities: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
  beta: boolean | null;
  regulatoryMetadata: {
    addressRequirements: string | null;
    bundleStatus: 'not_evaluated';
  } | null;
  providerMetadata?: Record<string, any>;
}

export interface ProviderPricingAuditResult {
  provider: 'twilio';
  countryCode: string;
  currency: string;
  phoneNumberPrices: Array<{
    numberType: string;
    basePrice: number | null;
    currentPrice: number | null;
  }>;
  note: string;
}

/**
 * Provider-Neutral Inventory Adapter implementation for Twilio.
 * Enforces server-only execution, factual data mapping, and dynamic filter capabilities.
 */
export class TwilioInventoryProvider {
  /**
   * Fetches supported countries dynamically from Twilio AvailablePhoneNumbers resource.
   * Fails closed returning empty array if live provider discovery fails.
   */
  async getAvailableCountries(): Promise<InventoryCountryItem[]> {
    try {
      const client = createTwilioServerClient();
      let rawCountries: any[] = [];
      try {
        rawCountries = await client.availablePhoneNumbers.list({ limit: 100 });
      } catch (innerErr: any) {
        console.warn('[TwilioInventoryProvider] Primary country discovery failed, attempting unconstrained list():', innerErr.message || innerErr);
        rawCountries = await client.availablePhoneNumbers.list();
      }

      if (!rawCountries || rawCountries.length === 0) {
        return [];
      }

      return rawCountries.map((c: any) => {
        const uris = c.subresourceUris || {};
        const supportedTypes: NumberCategory[] = [];
        if (uris.local) supportedTypes.push('local');
        if (uris.mobile) supportedTypes.push('mobile');
        if (uris.tollFree || uris.toll_free) supportedTypes.push('toll_free');
        if (supportedTypes.length === 0) supportedTypes.push('local');

        return {
          countryCode: (c.countryCode || '').toUpperCase(),
          countryName: c.country || c.countryCode || 'Unknown Country',
          supportedTypes,
        };
      });
    } catch (err: any) {
      console.warn('[TwilioInventoryProvider] Live country discovery unavailable:', err.message || err);
      return [];
    }
  }

  /**
   * Evaluates which search filters are valid/applicable for a given country and number type.
   */
  getFilterCapabilities(countryCode: string, numberType: NumberCategory): FilterCapabilityMap {
    const cc = (countryCode || '').toUpperCase();

    if (numberType === 'toll_free') {
      return {
        contains: true,
        areaCode: false,
        locality: false,
        region: false,
        postalCode: false,
        voiceCapabilities: true,
        smsCapabilities: true,
        mmsCapabilities: cc === 'US' || cc === 'CA',
      };
    }

    if (numberType === 'mobile') {
      return {
        contains: true,
        areaCode: false,
        locality: false,
        region: false,
        postalCode: false,
        voiceCapabilities: true,
        smsCapabilities: true,
        mmsCapabilities: cc === 'US' || cc === 'CA',
      };
    }

    // Local number category
    const supportsGeoLocality = ['US', 'CA', 'AU', 'GB'].includes(cc);
    const supportsRegion = ['US', 'CA', 'AU'].includes(cc);
    const supportsPostal = ['US', 'CA', 'GB'].includes(cc);
    const supportsAreaCode = ['US', 'CA'].includes(cc);

    return {
      contains: true,
      areaCode: supportsAreaCode,
      locality: supportsGeoLocality,
      region: supportsRegion,
      postalCode: supportsPostal,
      voiceCapabilities: true,
      smsCapabilities: true,
      mmsCapabilities: cc === 'US' || cc === 'CA',
    };
  }

  /**
   * Searches live Twilio available phone number inventory using applicable filters only.
   * Strict integrity: Never broadens search or strips user filters if provider query fails or returns zero matches.
   */
  async searchAvailableNumbers(query: InventorySearchQuery): Promise<InventoryNumberItem[]> {
    const countryCode = (query.countryCode || 'US').toUpperCase();
    const numberType: NumberCategory = query.numberType || 'local';
    const limit = Math.min(Math.max(query.limit || 20, 1), 50);

    const capabilitiesMap = this.getFilterCapabilities(countryCode, numberType);

    // Build Twilio API search params using ONLY applicable filters
    const searchParams: Record<string, any> = { limit };

    if (capabilitiesMap.contains && query.contains && query.contains.trim()) {
      searchParams.contains = query.contains.trim();
    }
    if (capabilitiesMap.areaCode && query.areaCode && query.areaCode.trim()) {
      searchParams.areaCode = query.areaCode.trim();
    }
    if (capabilitiesMap.locality && query.locality && query.locality.trim()) {
      searchParams.inLocality = query.locality.trim();
    }
    if (capabilitiesMap.region && query.region && query.region.trim()) {
      searchParams.inRegion = query.region.trim();
    }
    if (capabilitiesMap.postalCode && query.postalCode && query.postalCode.trim()) {
      searchParams.inPostalCode = query.postalCode.trim();
    }
    if (capabilitiesMap.voiceCapabilities && typeof query.voiceEnabled === 'boolean') {
      searchParams.voiceEnabled = query.voiceEnabled;
    }
    if (capabilitiesMap.smsCapabilities && typeof query.smsEnabled === 'boolean') {
      searchParams.smsEnabled = query.smsEnabled;
    }
    if (capabilitiesMap.mmsCapabilities && typeof query.mmsEnabled === 'boolean') {
      searchParams.mmsEnabled = query.mmsEnabled;
    }

    try {
      const client = createTwilioServerClient();

      // Map internal category name to Twilio SDK resource method
      let twilioCategory: 'local' | 'mobile' | 'tollFree' = 'local';
      if (numberType === 'mobile') twilioCategory = 'mobile';
      if (numberType === 'toll_free') twilioCategory = 'tollFree';

      const countryResource = client.availablePhoneNumbers(countryCode);
      const subResource = (countryResource as any)[twilioCategory];

      if (!subResource || typeof subResource.list !== 'function') {
        console.warn(`[TwilioInventoryProvider] Subresource ${twilioCategory} not available for ${countryCode}`);
        return [];
      }

      // Execute search strictly with user-specified search parameters
      const rawResults = await subResource.list(searchParams);

      return (rawResults || []).map((item: any): InventoryNumberItem => {
        const rawCap = item.capabilities || {};
        return {
          provider: 'twilio',
          providerReference: item.phoneNumber || item.friendlyName || '',
          phoneNumber: item.phoneNumber || '',
          friendlyDisplay: item.friendlyName || item.phoneNumber || '',
          countryCode: (item.isoCountry || countryCode).toUpperCase(),
          numberType,
          locality: item.locality || null,
          region: item.region || null,
          postalCode: item.postalCode || null,
          addressRequirements: item.addressRequirements || 'none',
          capabilities: {
            voice: Boolean(rawCap.voice),
            sms: Boolean(rawCap.sms),
            mms: Boolean(rawCap.mms),
          },
          beta: item.beta !== undefined ? Boolean(item.beta) : null,
          regulatoryMetadata: {
            addressRequirements: item.addressRequirements || 'none',
            bundleStatus: 'not_evaluated',
          },
          providerMetadata: {
            lata: item.lata || null,
            rateCenter: item.rateCenter || null,
          },
        };
      });
    } catch (err: any) {
      console.error('[TwilioInventoryProvider] Live inventory search error:', err.message || err);
      // Return clean empty array rather than failing tenant search request or returning unconstrained results
      return [];
    }
  }

  /**
   * Audits provider pricing for a specific country via Twilio Pricing API.
   * Returns provider wholesale pricing data for architecture reporting without exposing wholesale costs directly to clients.
   */
  async auditProviderPricing(countryCode: string): Promise<ProviderPricingAuditResult> {
    const cc = (countryCode || 'US').toUpperCase();
    try {
      const client = createTwilioServerClient();
      const pricingApi = (client as any).pricing;
      const pricingObj = pricingApi?.v1?.phoneNumbers?.countries
        ? await pricingApi.v1.phoneNumbers.countries(cc).fetch()
        : await pricingApi?.v2?.phoneNumbers?.countries(cc).fetch();

      return {
        provider: 'twilio',
        countryCode: cc,
        currency: pricingObj.priceUnit || 'USD',
        phoneNumberPrices: (pricingObj.phoneNumberPrices || []).map((p: any) => ({
          numberType: p.numberType || 'unknown',
          basePrice: p.basePrice ? Number(p.basePrice) : null,
          currentPrice: p.currentPrice ? Number(p.currentPrice) : null,
        })),
        note: 'Twilio wholesale provider pricing. Customer retail pricing requires application commercial markup layer.',
      };
    } catch (err: any) {
      return {
        provider: 'twilio',
        countryCode: cc,
        currency: 'USD',
        phoneNumberPrices: [],
        note: `Provider pricing audit unavailable or unconfigured: ${err.message || err}`,
      };
    }
  }
}

export const inventoryProvider = new TwilioInventoryProvider();
