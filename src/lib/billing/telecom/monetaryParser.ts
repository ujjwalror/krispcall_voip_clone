export interface ParsedMonetaryDecimal {
  /** Syntactic validity of input string */
  success: boolean;
  /** Non-negative magnitude in sub-cent micro-units (1 USD = 1,000,000 micro-units) */
  magnitudeMicroBig: bigint;
  /** Raw sign extracted from text */
  rawSign: 'positive' | 'negative' | 'zero';
  /** Total count of fractional digits present in raw input */
  fractionalDigitsCount: number;
  /** True if non-zero fractional digits exist beyond 6 decimal places */
  hasExcessPrecision: boolean;
  /** Raw input text string preserved for audit evidence */
  rawString: string;
}

export interface NormalizedProviderPriceResult {
  success: boolean;
  parsedDecimal: ParsedMonetaryDecimal | null;
  sourceAuthority: 'preliminary_callback' | 'finalized_api_fetch' | 'invoice_reconciled' | 'manual_adjustment';
  economicEffect: 'charge' | 'credit' | 'correction_increase' | 'correction_decrease' | 'unknown';
  providerCostMicroBig: bigint;
  providerCostMinor: number;
  rawSign: 'positive' | 'negative' | 'zero';
  costComponent: string;
  rawPriceText: string | null;
  fingerprint: string;
}

/**
 * Deterministically parses a monetary decimal string into exact integer micro-units (1 USD = 1,000,000 micro-units).
 * Pure string parsing algorithm. ZERO parseFloat(), ZERO Number multiplication, ZERO Math.round().
 */
export function parseMonetaryDecimal(rawStr: string | null | undefined): ParsedMonetaryDecimal | null {
  if (!rawStr || typeof rawStr !== 'string') {
    return null;
  }

  const trimmed = rawStr.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') {
    return null;
  }

  // Regex for optional leading sign, integer digits, and optional decimal point with fractional digits
  const match = trimmed.match(/^([+-])?(\d+)(\.(\d+))?$/);
  if (!match) {
    return null; // Malformed string -> fail closed
  }

  const signChar = match[1] || '+';
  const intPart = match[2];
  const fracPart = match[4] || '';

  const rawSign: 'positive' | 'negative' | 'zero' =
    intPart === '0' && (/^0*$/).test(fracPart)
      ? 'zero'
      : signChar === '-'
      ? 'negative'
      : 'positive';

  let hasExcessPrecision = false;
  let normalizedFrac = fracPart;

  if (fracPart.length > 6) {
    const excessDigits = fracPart.slice(6);
    if (!/^0+$/.test(excessDigits)) {
      hasExcessPrecision = true;
    }
    normalizedFrac = fracPart.slice(0, 6);
  } else {
    normalizedFrac = fracPart.padEnd(6, '0');
  }

  // Convert concatenated integer and 6-digit fractional string directly to BigInt
  let magnitudeMicroBig = BigInt(`${intPart}${normalizedFrac}`);

  // Safe Precision Policy: If non-zero fractional digits exist beyond 6 decimals,
  // apply deterministic ceiling rounding (+1 micro-unit) so provider cost is NEVER understated.
  if (hasExcessPrecision) {
    magnitudeMicroBig += BigInt(1);
  }

  return {
    success: true,
    magnitudeMicroBig,
    rawSign,
    fractionalDigitsCount: fracPart.length,
    hasExcessPrecision,
    rawString: trimmed,
  };
}

/**
 * Normalizes a raw Twilio price payload string into explicit economic effect and micro-units.
 * Implements reviewed Stage C.6B-R2 Twilio sign semantics & component identity.
 */
export function normalizeTwilioProviderPrice(
  rawPriceStr: string | null | undefined,
  sourceAuthority: 'preliminary_callback' | 'finalized_api_fetch' | 'invoice_reconciled' | 'manual_adjustment' = 'preliminary_callback',
  resourceId?: string,
  costComponent: string = 'base_usage'
): NormalizedProviderPriceResult | null {
  const parsed = parseMonetaryDecimal(rawPriceStr);
  if (!parsed || !parsed.success) {
    return null;
  }

  let economicEffect: 'charge' | 'credit' | 'correction_increase' | 'correction_decrease' | 'unknown' = 'unknown';

  // Twilio Callback Sign Semantics:
  // Negative price (e.g. "-0.0150") = Account Charge of 15,000 micro-units
  // Zero price ("0.00") = Charge of 0 micro-units
  // Positive price = Unknown / Requires provider API verification (Never assumed as credit automatically)
  if (parsed.rawSign === 'negative' || parsed.rawSign === 'zero') {
    economicEffect = 'charge';
  } else if (parsed.rawSign === 'positive') {
    economicEffect = 'unknown';
  }

  const providerCostMicroBig = parsed.magnitudeMicroBig;
  
  // Calculate minor unit cents via BigInt ceiling division: (micro + 9999) / 10000
  const providerCostMinorBig = (providerCostMicroBig + BigInt(9999)) / BigInt(10000);
  const providerCostMinor = Number(providerCostMinorBig);

  // Deterministic Fingerprint for Idempotency
  const fingerprint = `${costComponent}:${sourceAuthority}:${economicEffect}:${parsed.rawString}:${resourceId || 'no_res'}`;

  return {
    success: true,
    parsedDecimal: parsed,
    sourceAuthority,
    economicEffect,
    providerCostMicroBig,
    providerCostMinor,
    rawSign: parsed.rawSign,
    costComponent,
    rawPriceText: parsed.rawString,
    fingerprint,
  };
}
