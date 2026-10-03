import twilio from 'twilio';

export interface ExactNumberFallbackResult {
  success: boolean;
  destinationPhoneNumber: string;
  isoCountry: string;
  currentPriceMicro: bigint;
  basePriceMicro: bigint | null;
  currency: string;
  priceUnit: string;
  sourceApiVersion: string;
  errorMessage?: string;
  errorCode?: string;
}

export interface CountryInboundFallbackResult {
  success: boolean;
  isoCountry: string;
  inboundCallPrices: Array<{
    numberType: string;
    currentPriceMicro: bigint;
    basePriceMicro: bigint | null;
    currency: string;
  }>;
  errorMessage?: string;
}

/**
 * Converts exact decimal price string/number (e.g. "0.014") to integer micro-units (14,000 BigInt).
 * 1 minor unit (cent) = 10,000 micro-units. $1.00 = 1,000,000 micro-units.
 */
export function parseDecimalToMicroUnits(price: string | number | null | undefined): bigint {
  if (price === null || price === undefined) {
    return BigInt(0);
  }
  const str = String(price).trim();
  if (!str || str === 'null' || str === 'undefined') {
    return BigInt(0);
  }
  const parsed = parseFloat(str);
  if (isNaN(parsed) || parsed < 0) {
    throw new Error(`INVALID_PRICE_DECIMAL: Unable to parse decimal price '${str}'`);
  }

  // Use precise decimal splitting to avoid floating point inaccuracies
  const parts = str.split('.');
  const whole = BigInt(parts[0] || '0') * BigInt(1000000);

  if (parts.length < 2 || !parts[1]) {
    return whole;
  }

  let decimals = parts[1].slice(0, 6);
  while (decimals.length < 6) {
    decimals += '0';
  }

  const decimalMicro = BigInt(decimals);
  return whole + decimalMicro;
}

export class TwilioExactNumberFallback {
  /**
   * Performs server-side READ-ONLY exact-number Voice Pricing lookup against Twilio Pricing API.
   */
  public static async fetchExactNumberPricing(
    destinationPhoneNumber: string,
    options?: { accountSid?: string; authToken?: string; clientOverride?: any }
  ): Promise<ExactNumberFallbackResult> {
    const cleanDest = (destinationPhoneNumber || '').trim();
    if (!cleanDest || !cleanDest.startsWith('+')) {
      return {
        success: false,
        destinationPhoneNumber: cleanDest,
        isoCountry: 'US',
        currentPriceMicro: BigInt(0),
        basePriceMicro: null,
        currency: 'USD',
        priceUnit: 'minute',
        sourceApiVersion: 'v2',
        errorMessage: 'Invalid E.164 phone number format',
        errorCode: 'INVALID_DESTINATION_FORMAT',
      };
    }

    try {
      let phoneRes: any;
      if (options?.clientOverride) {
        phoneRes = await options.clientOverride.pricing.v2.voice.numbers(cleanDest).fetch();
      } else {
        const accountSid = options?.accountSid || process.env.TWILIO_ACCOUNT_SID;
        const authToken = options?.authToken || process.env.TWILIO_AUTH_TOKEN;

        if (!accountSid || !authToken) {
          return {
            success: false,
            destinationPhoneNumber: cleanDest,
            isoCountry: 'US',
            currentPriceMicro: BigInt(0),
            basePriceMicro: null,
            currency: 'USD',
            priceUnit: 'minute',
            sourceApiVersion: 'v2',
            errorMessage: 'Missing Twilio provider credentials',
            errorCode: 'MISSING_CREDENTIALS',
          };
        }

        const client = twilio(accountSid, authToken);
        phoneRes = await client.pricing.v2.voice.numbers(cleanDest).fetch();
      }

      if (!phoneRes || !phoneRes.outboundCallPrices || phoneRes.outboundCallPrices.length === 0) {
        return {
          success: false,
          destinationPhoneNumber: cleanDest,
          isoCountry: phoneRes?.isoCountry || 'US',
          currentPriceMicro: BigInt(0),
          basePriceMicro: null,
          currency: phoneRes?.priceUnit || 'USD',
          priceUnit: 'minute',
          sourceApiVersion: 'v2',
          errorMessage: 'No outbound call prices returned by provider',
          errorCode: 'EMPTY_PROVIDER_RESPONSE',
        };
      }

      const match = phoneRes.outboundCallPrices[0];
      const currency = (phoneRes.priceUnit || 'USD').toUpperCase();

      if (currency !== 'USD') {
        return {
          success: false,
          destinationPhoneNumber: cleanDest,
          isoCountry: phoneRes.isoCountry || 'US',
          currentPriceMicro: BigInt(0),
          basePriceMicro: null,
          currency,
          priceUnit: 'minute',
          sourceApiVersion: 'v2',
          errorMessage: `Currency mismatch: provider returned ${currency}, wallet requires USD`,
          errorCode: 'CURRENCY_MISMATCH',
        };
      }

      const currentPriceMicro = parseDecimalToMicroUnits(match.currentPrice);
      const basePriceMicro = match.basePrice !== null && match.basePrice !== undefined
        ? parseDecimalToMicroUnits(match.basePrice)
        : null;

      return {
        success: true,
        destinationPhoneNumber: cleanDest,
        isoCountry: (phoneRes.isoCountry || 'US').toUpperCase(),
        currentPriceMicro,
        basePriceMicro,
        currency: 'USD',
        priceUnit: 'minute',
        sourceApiVersion: 'v2',
      };
    } catch (err: any) {
      return {
        success: false,
        destinationPhoneNumber: cleanDest,
        isoCountry: 'US',
        currentPriceMicro: BigInt(0),
        basePriceMicro: null,
        currency: 'USD',
        priceUnit: 'minute',
        sourceApiVersion: 'v2',
        errorMessage: err.message || 'Provider lookup failed',
        errorCode: 'PROVIDER_LOOKUP_EXCEPTION',
      };
    }
  }

  /**
   * Performs server-side READ-ONLY Country Inbound Voice Pricing lookup against Twilio Pricing API.
   */
  public static async fetchCountryInboundPricing(
    isoCountry: string,
    options?: { accountSid?: string; authToken?: string; clientOverride?: any }
  ): Promise<CountryInboundFallbackResult> {
    const cleanCountry = (isoCountry || 'US').toUpperCase().trim();
    try {
      let countryRes: any;
      if (options?.clientOverride) {
        countryRes = await options.clientOverride.pricing.v2.voice.countries(cleanCountry).fetch();
      } else {
        const accountSid = options?.accountSid || process.env.TWILIO_ACCOUNT_SID;
        const authToken = options?.authToken || process.env.TWILIO_AUTH_TOKEN;

        if (!accountSid || !authToken) {
          return {
            success: false,
            isoCountry: cleanCountry,
            inboundCallPrices: [],
            errorMessage: 'Missing Twilio provider credentials',
          };
        }

        const client = twilio(accountSid, authToken);
        countryRes = await client.pricing.v2.voice.countries(cleanCountry).fetch();
      }

      const rawInbound = countryRes?.inboundCallPrices || [];
      const inboundCallPrices = rawInbound.map((item: any) => ({
        numberType: (item.numberType || 'any').toLowerCase().trim(),
        currentPriceMicro: parseDecimalToMicroUnits(item.currentPrice),
        basePriceMicro: item.basePrice ? parseDecimalToMicroUnits(item.basePrice) : null,
        currency: (countryRes.priceUnit || 'USD').toUpperCase(),
      }));

      return {
        success: true,
        isoCountry: cleanCountry,
        inboundCallPrices,
      };
    } catch (err: any) {
      return {
        success: false,
        isoCountry: cleanCountry,
        inboundCallPrices: [],
        errorMessage: err.message || 'Country inbound pricing fetch failed',
      };
    }
  }
}
