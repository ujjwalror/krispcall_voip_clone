import { parseMonetaryDecimal, ParsedMonetaryDecimal } from './monetaryParser';

export interface ParsedWholesalePriceResult {
  success: boolean;
  priceMicroBig: bigint;
  basePriceMicroBig: bigint | null;
  rawCurrentPriceText: string | null;
  rawBasePriceText: string | null;
  isZero: boolean;
  rawSign: 'positive' | 'negative' | 'zero';
  failureReason?: string;
  fingerprint: string;
}

/**
 * Normalizes raw Twilio wholesale pricing strings into micro-units using exact decimal string parsing.
 * NO parseFloat(), NO floating-point arithmetic, NO Math.round().
 * 
 * Rules:
 * - currentPrice is the authoritative pricing input.
 * - basePrice is audit/informational only.
 * - Negative prices -> FAIL CLOSED (failureReason: 'NEGATIVE_WHOLESALE_RATE').
 * - Malformed/null/empty currentPrice -> FAIL CLOSED (failureReason: 'MALFORMED_CURRENT_PRICE').
 * - Zero prices ("0.00") -> Valid zero-cost rate, modeled distinctly (isZero: true, priceMicroBig: 0n).
 */
export function parseTwilioWholesalePrice(
  rawCurrentPrice: string | null | undefined,
  rawBasePrice?: string | null | undefined,
  contextTag: string = 'wholesale_ingestion'
): ParsedWholesalePriceResult {
  if (rawCurrentPrice === null || rawCurrentPrice === undefined) {
    return {
      success: false,
      priceMicroBig: BigInt(0),
      basePriceMicroBig: null,
      rawCurrentPriceText: null,
      rawBasePriceText: rawBasePrice || null,
      isZero: false,
      rawSign: 'zero',
      failureReason: 'MISSING_CURRENT_PRICE',
      fingerprint: `${contextTag}:missing`,
    };
  }

  const parsedCurrent = parseMonetaryDecimal(rawCurrentPrice);
  if (!parsedCurrent || !parsedCurrent.success) {
    return {
      success: false,
      priceMicroBig: BigInt(0),
      basePriceMicroBig: null,
      rawCurrentPriceText: String(rawCurrentPrice),
      rawBasePriceText: rawBasePrice || null,
      isZero: false,
      rawSign: 'zero',
      failureReason: 'MALFORMED_CURRENT_PRICE',
      fingerprint: `${contextTag}:malformed:${rawCurrentPrice}`,
    };
  }

  // Reject negative wholesale rates
  if (parsedCurrent.rawSign === 'negative') {
    return {
      success: false,
      priceMicroBig: BigInt(0),
      basePriceMicroBig: null,
      rawCurrentPriceText: parsedCurrent.rawString,
      rawBasePriceText: rawBasePrice || null,
      isZero: false,
      rawSign: 'negative',
      failureReason: 'NEGATIVE_WHOLESALE_RATE',
      fingerprint: `${contextTag}:negative:${parsedCurrent.rawString}`,
    };
  }

  // Parse basePrice if present (for audit only)
  let basePriceMicroBig: bigint | null = null;
  if (rawBasePrice !== undefined && rawBasePrice !== null) {
    const parsedBase = parseMonetaryDecimal(rawBasePrice);
    if (parsedBase && parsedBase.success && parsedBase.rawSign !== 'negative') {
      basePriceMicroBig = parsedBase.magnitudeMicroBig;
    }
  }

  const isZero = parsedCurrent.rawSign === 'zero';
  const priceMicroBig = parsedCurrent.magnitudeMicroBig;

  const fingerprint = `${contextTag}:${parsedCurrent.rawString}:${basePriceMicroBig !== null ? basePriceMicroBig.toString() : 'null'}`;

  return {
    success: true,
    priceMicroBig,
    basePriceMicroBig,
    rawCurrentPriceText: parsedCurrent.rawString,
    rawBasePriceText: rawBasePrice || null,
    isZero,
    rawSign: parsedCurrent.rawSign,
    fingerprint,
  };
}
