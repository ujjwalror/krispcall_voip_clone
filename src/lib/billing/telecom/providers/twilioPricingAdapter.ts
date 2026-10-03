import {
  TelecomProviderPricingAdapter,
  NormalizedWholesaleQuote,
  GetWholesaleQuoteParams,
  SyncPricingResult,
  FreshnessState,
} from './providerPricingInterface';
import { parseTwilioWholesalePrice } from '../wholesaleMoneyParser';
import { FreshnessPolicy, FreshnessPolicyConfig } from '../freshnessPolicy';

export interface TwilioCountryVoiceResponse {
  country: string;
  isoCountry: string;
  priceUnit: string;
  outboundCallPrices?: Array<{
    title?: string;
    friendlyName?: string;
    basePrice?: string;
    currentPrice?: string;
    originationPrefixes?: string[];
    destinationPrefixes?: string[];
  }>;
  inboundCallPrices?: Array<{
    numberType?: string;
    basePrice?: string;
    currentPrice?: string;
  }>;
}

export interface TwilioNumberVoiceResponse {
  number: string;
  country: string;
  isoCountry: string;
  priceUnit: string;
  outboundCallPrice?: {
    basePrice?: string;
    currentPrice?: string;
  };
  inboundCallPrice?: {
    numberType?: string;
    basePrice?: string;
    currentPrice?: string;
  };
}

export interface ParsedWholesalePricingRecord {
  providerKey: string;
  providerAccountId: string;
  serviceType: 'voice_outbound' | 'voice_inbound';
  direction: 'outbound' | 'inbound';
  isoCountry: string;
  destinationPrefix: string;
  originationPrefix: string | null;
  numberType: 'local' | 'mobile' | 'national' | 'toll_free' | 'any' | null;
  currency: string;
  currentPriceMicro: bigint;
  basePriceMicro: bigint | null;
  priceUnit: string;
  billingIncrementSeconds: number;
  minChargeableUnits: number;
  fetchedAt: string;
  softStaleAt: string;
  hardExpiresAt: string;
  freshnessState: FreshnessState;
  sourceApiVersion: string;
  pricingFingerprint: string;
  isZero: boolean;
  isValid: boolean;
  failureReason?: string;
}

export class TwilioPricingAdapter implements TelecomProviderPricingAdapter {
  public readonly providerKey = 'twilio';
  private twilioClientFactory: () => any;
  private freshnessConfig?: Partial<FreshnessPolicyConfig>;

  constructor(
    customClientFactory?: () => any,
    freshnessConfig?: Partial<FreshnessPolicyConfig>
  ) {
    this.twilioClientFactory = customClientFactory || (() => {
      const { createTwilioServerClient } = require('../../twilio/client');
      return createTwilioServerClient();
    });
    this.freshnessConfig = freshnessConfig;
  }

  /**
   * Pure deterministic parser for Twilio GET /v2/Voice/Countries/{ISO} API response.
   * Parses outbound destination prefixes and inbound number types without making network calls.
   */
  public parseCountryVoiceResponse(
    payload: TwilioCountryVoiceResponse,
    providerAccountId: string = 'default',
    fetchedAtIso: string = new Date().toISOString()
  ): ParsedWholesalePricingRecord[] {
    const records: ParsedWholesalePricingRecord[] = [];
    const isoCountry = (payload.isoCountry || payload.country || 'US').toUpperCase().trim();
    const currency = (payload.priceUnit || 'USD').toUpperCase().trim();
    const { softStaleAtIso, hardExpiresAtIso } = FreshnessPolicy.calculateTimestamps(fetchedAtIso, this.freshnessConfig);

    // 1. Parse Outbound Prefix Call Prices
    if (payload.outboundCallPrices && Array.isArray(payload.outboundCallPrices)) {
      for (const item of payload.outboundCallPrices) {
        const parsedPrice = parseTwilioWholesalePrice(item.currentPrice, item.basePrice, `twilio:outbound:${isoCountry}`);
        if (!parsedPrice.success) {
          continue; // Skip malformed/negative entries safely
        }

        const destPrefixes = item.destinationPrefixes && item.destinationPrefixes.length > 0
          ? item.destinationPrefixes
          : ['*'];
        const origPrefixes = item.originationPrefixes && item.originationPrefixes.length > 0
          ? item.originationPrefixes
          : ['*'];

        for (const destPrefix of destPrefixes) {
          for (const origPrefix of origPrefixes) {
            const cleanDest = destPrefix.trim() || '*';
            const cleanOrig = origPrefix.trim() || '*';
            const fingerprint = `twilio:${providerAccountId}:voice_outbound:${isoCountry}:${cleanDest}:${cleanOrig}:${parsedPrice.priceMicroBig.toString()}`;

            records.push({
              providerKey: this.providerKey,
              providerAccountId,
              serviceType: 'voice_outbound',
              direction: 'outbound',
              isoCountry,
              destinationPrefix: cleanDest,
              originationPrefix: cleanOrig,
              numberType: null,
              currency,
              currentPriceMicro: parsedPrice.priceMicroBig,
              basePriceMicro: parsedPrice.basePriceMicroBig,
              priceUnit: 'minute',
              billingIncrementSeconds: 60,
              minChargeableUnits: 1,
              fetchedAt: fetchedAtIso,
              softStaleAt: softStaleAtIso,
              hardExpiresAt: hardExpiresAtIso,
              freshnessState: 'FRESH',
              sourceApiVersion: 'v2',
              pricingFingerprint: fingerprint,
              isZero: parsedPrice.isZero,
              isValid: true,
            });
          }
        }
      }
    }

    // 2. Parse Inbound Number Type Call Prices
    if (payload.inboundCallPrices && Array.isArray(payload.inboundCallPrices)) {
      for (const item of payload.inboundCallPrices) {
        const parsedPrice = parseTwilioWholesalePrice(item.currentPrice, item.basePrice, `twilio:inbound:${isoCountry}`);
        if (!parsedPrice.success) {
          continue;
        }

        const rawType = (item.numberType || 'any').toLowerCase().trim();
        let normalizedType: 'local' | 'mobile' | 'national' | 'toll_free' | 'any' = 'any';
        if (rawType.includes('local')) normalizedType = 'local';
        else if (rawType.includes('mobile')) normalizedType = 'mobile';
        else if (rawType.includes('national')) normalizedType = 'national';
        else if (rawType.includes('toll')) normalizedType = 'toll_free';

        const fingerprint = `twilio:${providerAccountId}:voice_inbound:${isoCountry}:${normalizedType}:${parsedPrice.priceMicroBig.toString()}`;

        records.push({
          providerKey: this.providerKey,
          providerAccountId,
          serviceType: 'voice_inbound',
          direction: 'inbound',
          isoCountry,
          destinationPrefix: '*',
          originationPrefix: '*',
          numberType: normalizedType,
          currency,
          currentPriceMicro: parsedPrice.priceMicroBig,
          basePriceMicro: parsedPrice.basePriceMicroBig,
          priceUnit: 'minute',
          billingIncrementSeconds: 60,
          minChargeableUnits: 1,
          fetchedAt: fetchedAtIso,
          softStaleAt: softStaleAtIso,
          hardExpiresAt: hardExpiresAtIso,
          freshnessState: 'FRESH',
          sourceApiVersion: 'v2',
          pricingFingerprint: fingerprint,
          isZero: parsedPrice.isZero,
          isValid: true,
        });
      }
    }

    return records;
  }

  /**
   * Pure deterministic parser for Twilio GET /v2/Voice/Numbers/{DestinationNumber} API response.
   */
  public parseNumberVoiceResponse(
    payload: TwilioNumberVoiceResponse,
    providerAccountId: string = 'default',
    fetchedAtIso: string = new Date().toISOString()
  ): ParsedWholesalePricingRecord | null {
    const isoCountry = (payload.isoCountry || payload.country || 'US').toUpperCase().trim();
    const currency = (payload.priceUnit || 'USD').toUpperCase().trim();
    const { softStaleAtIso, hardExpiresAtIso } = FreshnessPolicy.calculateTimestamps(fetchedAtIso, this.freshnessConfig);

    if (payload.outboundCallPrice && payload.outboundCallPrice.currentPrice !== undefined) {
      const parsedPrice = parseTwilioWholesalePrice(
        payload.outboundCallPrice.currentPrice,
        payload.outboundCallPrice.basePrice,
        `twilio:number_outbound:${payload.number}`
      );

      if (!parsedPrice.success) {
        return null;
      }

      const destNum = payload.number.trim();
      const fingerprint = `twilio:${providerAccountId}:voice_outbound_number:${destNum}:${parsedPrice.priceMicroBig.toString()}`;

      return {
        providerKey: this.providerKey,
        providerAccountId,
        serviceType: 'voice_outbound',
        direction: 'outbound',
        isoCountry,
        destinationPrefix: destNum,
        originationPrefix: '*',
        numberType: null,
        currency,
        currentPriceMicro: parsedPrice.priceMicroBig,
        basePriceMicro: parsedPrice.basePriceMicroBig,
        priceUnit: 'minute',
        billingIncrementSeconds: 60,
        minChargeableUnits: 1,
        fetchedAt: fetchedAtIso,
        softStaleAt: softStaleAtIso,
        hardExpiresAt: hardExpiresAtIso,
        freshnessState: 'FRESH',
        sourceApiVersion: 'v2',
        pricingFingerprint: fingerprint,
        isZero: parsedPrice.isZero,
        isValid: true,
      };
    }

    return null;
  }

  /**
   * Resolves wholesale quote via Twilio API (or mocked client factory).
   * Note: In test mode, customClientFactory will supply mocked API responses.
   */
  public async getWholesaleQuote(params: GetWholesaleQuoteParams): Promise<NormalizedWholesaleQuote> {
    const client = this.twilioClientFactory();
    const fetchedAt = params.timestamp || new Date().toISOString();
    const isoCountry = (params.isoCountry || 'US').toUpperCase();
    const providerAccountId = params.providerAccountId || 'default';

    const { softStaleAtIso, hardExpiresAtIso } = FreshnessPolicy.calculateTimestamps(fetchedAt, this.freshnessConfig);

    if (params.serviceType === 'voice_outbound' && params.destinationPhoneNumber) {
      // Call Twilio Numbers pricing API if destination number provided
      const numberRes = await client.pricing.v2.voice.numbers(params.destinationPhoneNumber).fetch({
        originationNumber: params.originationPhoneNumber || undefined,
      });

      const record = this.parseNumberVoiceResponse(numberRes, providerAccountId, fetchedAt);
      if (!record) {
        throw new Error(`TWILIO_PRICING_ERROR: Failed to parse valid currentPrice for number ${params.destinationPhoneNumber}`);
      }

      return {
        providerKey: this.providerKey,
        providerAccountId,
        serviceType: record.serviceType,
        direction: record.direction,
        isoCountry: record.isoCountry,
        destinationPrefix: record.destinationPrefix,
        originationPrefix: record.originationPrefix,
        numberType: record.numberType,
        currency: record.currency,
        currentPriceMicro: record.currentPriceMicro,
        wholesaleRateMicro: record.currentPriceMicro,
        basePriceMicro: record.basePriceMicro,
        priceUnit: record.priceUnit,
        billingIncrementSeconds: record.billingIncrementSeconds,
        minChargeableUnits: record.minChargeableUnits,
        fetchedAt: record.fetchedAt,
        softStaleAt: record.softStaleAt,
        hardExpiresAt: record.hardExpiresAt,
        freshnessState: record.freshnessState,
        sourceApiVersion: record.sourceApiVersion,
        pricingFingerprint: record.pricingFingerprint,
        version: 1,
        isZero: record.isZero,
      };
    }

    // Default to country voice pricing API
    const countryRes = await client.pricing.v2.voice.countries(isoCountry).fetch();
    const records = this.parseCountryVoiceResponse(countryRes, providerAccountId, fetchedAt);

    if (!records || records.length === 0) {
      throw new Error(`TWILIO_PRICING_ERROR: No valid pricing records returned for country ${isoCountry}`);
    }

    const first = records[0];
    return {
      providerKey: this.providerKey,
      providerAccountId,
      serviceType: first.serviceType,
      direction: first.direction,
      isoCountry: first.isoCountry,
      destinationPrefix: first.destinationPrefix,
      originationPrefix: first.originationPrefix,
      numberType: first.numberType,
      currency: first.currency,
      currentPriceMicro: first.currentPriceMicro,
      wholesaleRateMicro: first.currentPriceMicro,
      basePriceMicro: first.basePriceMicro,
      priceUnit: first.priceUnit,
      billingIncrementSeconds: first.billingIncrementSeconds,
      minChargeableUnits: first.minChargeableUnits,
      fetchedAt: first.fetchedAt,
      softStaleAt: first.softStaleAt,
      hardExpiresAt: first.hardExpiresAt,
      freshnessState: first.freshnessState,
      sourceApiVersion: first.sourceApiVersion,
      pricingFingerprint: first.pricingFingerprint,
      version: 1,
      isZero: first.isZero,
    };
  }

  /**
   * Synchronizes country voice pricing via Twilio Pricing API v2.
   */
  public async syncCountryPricing(isoCountry: string, providerAccountId: string = 'default'): Promise<SyncPricingResult> {
    const client = this.twilioClientFactory();
    const cleanIso = isoCountry.toUpperCase().trim();
    const fetchedAt = new Date().toISOString();
    const syncRunId = `sync_${cleanIso}_${Date.now()}`;

    try {
      const countryRes = await client.pricing.v2.voice.countries(cleanIso).fetch();
      const records = this.parseCountryVoiceResponse(countryRes, providerAccountId, fetchedAt);

      return {
        success: true,
        providerKey: this.providerKey,
        providerAccountId,
        isoCountry: cleanIso,
        recordsObserved: records.length,
        recordsInserted: records.length,
        recordsUpdated: 0,
        recordsVersioned: 0,
        syncRunId,
        fingerprint: `sync:twilio:${cleanIso}:${records.length}`,
      };
    } catch (err: any) {
      return {
        success: false,
        providerKey: this.providerKey,
        providerAccountId,
        isoCountry: cleanIso,
        recordsObserved: 0,
        recordsInserted: 0,
        recordsUpdated: 0,
        recordsVersioned: 0,
        syncRunId,
        fingerprint: `sync:twilio:${cleanIso}:failed`,
        errorMessage: err.message || 'Twilio Pricing API fetch failed',
      };
    }
  }
}
