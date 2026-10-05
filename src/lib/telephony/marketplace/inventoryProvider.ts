import 'server-only';
import crypto from 'crypto';
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
  pageToken?: string;
}

export interface InventorySearchResult {
  numbers: InventoryNumberItem[];
  hasMore: boolean;
  continuationToken?: string;
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

export class InvalidContinuationTokenError extends Error {
  public code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'InvalidContinuationTokenError';
    this.code = code;
  }
}

function computeQueryHash(query: InventorySearchQuery): string {
  const parts = [
    (query.countryCode || 'US').toUpperCase(),
    query.numberType || 'local',
    (query.contains || '').trim(),
    (query.areaCode || '').trim(),
    (query.locality || '').trim(),
    (query.region || '').trim(),
    (query.postalCode || '').trim(),
    query.voiceEnabled === true ? 'v1' : query.voiceEnabled === false ? 'v0' : 'vX',
    query.smsEnabled === true ? 's1' : query.smsEnabled === false ? 's0' : 'sX',
    query.mmsEnabled === true ? 'm1' : query.mmsEnabled === false ? 'm0' : 'mX',
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').substring(0, 16);
}

function getContinuationHmacKey(): string {
  return (
    process.env.TELECOM_EXPERIMENT_HMAC_KEY ||
    process.env.TWILIO_API_KEY_SECRET ||
    process.env.TWILIO_AUTH_TOKEN ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    'krispcall-marketplace-continuation-v1'
  );
}

function computeTokenHmac(version: number, pageNumber: number, filterHash: string, expiry: number): string {
  const secret = getContinuationHmacKey();
  const canonicalString = `v=${version}&p=${pageNumber}&h=${filterHash}&e=${expiry}`;
  return crypto.createHmac('sha256', secret).update(canonicalString).digest('hex').substring(0, 16);
}

export function encodeContinuationToken(pageNumber: number, query: InventorySearchQuery): string {
  const version = 1;
  const filterHash = computeQueryHash(query);
  const expiry = Date.now() + 24 * 60 * 60 * 1000; // 24-hour expiry
  const sig = computeTokenHmac(version, pageNumber, filterHash, expiry);

  const payload = {
    v: version,
    p: pageNumber,
    h: filterHash,
    e: expiry,
    sig,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeContinuationToken(token: string | undefined, currentQuery: InventorySearchQuery): number {
  if (!token) return 0;

  let parsed: any;
  try {
    const jsonStr = Buffer.from(token, 'base64url').toString('utf8');
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new InvalidContinuationTokenError('MALFORMED_TOKEN', 'Malformed continuation token structure.');
  }

  if (!parsed || typeof parsed !== 'object' || typeof parsed.p !== 'number' || parsed.p < 0) {
    throw new InvalidContinuationTokenError('MALFORMED_TOKEN', 'Invalid continuation token fields.');
  }

  if (parsed.v !== 1) {
    throw new InvalidContinuationTokenError('UNSUPPORTED_VERSION', 'Unsupported continuation token version.');
  }

  if (typeof parsed.e !== 'number' || Date.now() > parsed.e) {
    throw new InvalidContinuationTokenError('EXPIRED_TOKEN', 'Expired continuation token.');
  }

  const expectedHash = computeQueryHash(currentQuery);
  if (typeof parsed.h !== 'string' || parsed.h !== expectedHash) {
    throw new InvalidContinuationTokenError('FILTER_MISMATCH', 'Continuation token does not match active search filters.');
  }

  const expectedSig = computeTokenHmac(parsed.v, parsed.p, parsed.h, parsed.e);
  if (typeof parsed.sig !== 'string' || parsed.sig.length !== expectedSig.length) {
    throw new InvalidContinuationTokenError('TAMPERED_TOKEN', 'Invalid continuation token signature.');
  }

  const sigBuffer = Buffer.from(parsed.sig, 'utf8');
  const expectedBuffer = Buffer.from(expectedSig, 'utf8');
  if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    throw new InvalidContinuationTokenError('TAMPERED_TOKEN', 'Invalid continuation token signature.');
  }

  return parsed.p;
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
   * Searches live Twilio available phone number inventory using provider-native pagination.
   * Strict integrity: Never broadens search or strips user filters if provider query fails or returns zero matches.
   */
  async searchAvailableNumbers(query: InventorySearchQuery): Promise<InventorySearchResult> {
    const countryCode = (query.countryCode || 'US').toUpperCase();
    const numberType: NumberCategory = query.numberType || 'local';
    const targetPageSize = Math.min(Math.max(query.limit || 50, 1), 100);

    const targetPageNumber = decodeContinuationToken(query.pageToken, query);
    const capabilitiesMap = this.getFilterCapabilities(countryCode, numberType);

    // Build Twilio API search params using ONLY applicable filters
    const searchParams: Record<string, any> = {
      pageNumber: targetPageNumber,
      pageSize: targetPageSize,
    };

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

      if (!subResource || typeof subResource.page !== 'function') {
        console.warn(`[TwilioInventoryProvider] Subresource ${twilioCategory} not available for ${countryCode}`);
        return { numbers: [], hasMore: false };
      }

      // Execute provider-native page query strictly with user search parameters
      const pageResult = await subResource.page(searchParams);
      const rawInstances = pageResult?.instances || pageResult?.availablePhoneNumbers || [];

      const rawMapped = (rawInstances || []).map((item: any): InventoryNumberItem => {
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
            voice: Boolean(rawCap.voice ?? rawCap.Voice),
            sms: Boolean(rawCap.sms ?? rawCap.SMS ?? rawCap.Sms),
            mms: Boolean(rawCap.mms ?? rawCap.MMS ?? rawCap.Mms),
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

      // Deduplicate numbers by normalized E.164 within returned page
      const seenE164 = new Set<string>();
      const deduplicatedNumbers: InventoryNumberItem[] = [];
      for (const num of rawMapped) {
        if (num.phoneNumber && !seenE164.has(num.phoneNumber)) {
          seenE164.add(num.phoneNumber);
          deduplicatedNumbers.push(num);
        }
      }

      // Determine hasMore:
      // Twilio AvailablePhoneNumbers returns batches of up to 30 items per page.
      // If items were returned and page count matches/exceeds batch threshold, or nextPageUrl exists, hasMore is true.
      const hasMore = (rawInstances.length > 0 && rawInstances.length >= 30) || Boolean(pageResult?.nextPageUrl);
      const continuationToken = hasMore ? encodeContinuationToken(targetPageNumber + 1, query) : undefined;

      return {
        numbers: deduplicatedNumbers,
        hasMore,
        continuationToken,
      };
    } catch (err: any) {
      console.error('[TwilioInventoryProvider] Live inventory search error:', err.message || err);
      return { numbers: [], hasMore: false };
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
