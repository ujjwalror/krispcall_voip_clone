/**
 * PHASE 23D.9B — CANONICAL FIXED-POINT FINANCIAL MATHEMATICS ENGINE
 * 
 * Strict Distributed Financial Invariants:
 * 1. ZERO IEEE-754 floating-point operations in financial calculations (ZERO Number multiplication/division).
 * 2. Currency minor units (cents) stored as signed 64-bit integer BIGINT.
 * 3. Telephony wholesale/retail unit rates calculated in micro-units (1 major unit = 1,000,000 micro-units).
 * 4. Deterministic rounding:
 *    - Customer retail charges use integer CEIL rounding (+1 minor unit on fractional cents).
 *    - Provider wholesale costs use integer FLOOR rounding on cost estimates, CEIL on liabilities.
 * 5. DB BIGINT overflow bounds checked on all arithmetic operations.
 * 
 * Preserved Architectural Flags:
 * - RATE_PRECISION_SCALE_REQUIRES_VALIDATION: Documented 6-decimal micro-unit scale covers
 *   USD/EUR/AUD/GBP/CAD. Higher-exponent or extreme micro-cost wholesale feeds require controlled re-validation.
 */

export const PG_BIGINT_MIN = BigInt("-9223372036854775808");
export const PG_BIGINT_MAX = BigInt("9223372036854775807");

export const DEFAULT_RATE_SCALE = BigInt(1000000); // 10^6 micro-units per major currency unit
export const DEFAULT_CURRENCY_EXPONENT = 2; // e.g. 100 cents per USD

export type RoundingMode = 'CEIL' | 'FLOOR' | 'TRUNC';

export interface CurrencyExponentConfig {
  exponent: number;
  minorScale: bigint;
}

export const CURRENCY_EXPONENTS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  AUD: 2,
  CAD: 2,
  NZD: 2,
  SGD: 2,
  JPY: 0,
  KRW: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
};

export class FixedPointMoney {
  /**
   * Returns exponent and scale factor for a 3-letter currency code.
   */
  static getCurrencyConfig(currency: string = 'USD'): CurrencyExponentConfig {
    const code = currency.toUpperCase().trim();
    if (CURRENCY_EXPONENTS[code] === undefined) {
      throw new Error(`UNSUPPORTED_CURRENCY: Currency "${code}" is not supported. Supported currencies: ${Object.keys(CURRENCY_EXPONENTS).join(', ')}`);
    }
    const exponent = CURRENCY_EXPONENTS[code];
    const minorScale = BigInt(10) ** BigInt(exponent);
    return { exponent, minorScale };
  }

  /**
   * Validates that a BigInt value does not exceed PostgreSQL BIGINT limits.
   */
  static assertSafeBigInt(val: bigint, label: string = 'amount'): bigint {
    if (val < PG_BIGINT_MIN || val > PG_BIGINT_MAX) {
      throw new RangeError(`FINANCIAL_OVERFLOW: ${label} value ${val} exceeds PostgreSQL BIGINT bounds.`);
    }
    return val;
  }

  /**
   * Converts sub-cent micro-units (scale 10^6) to currency minor units (e.g. cents).
   * Default rounding for customer retail charges is CEIL.
   */
  static microUnitsToMinorUnits(
    microUnits: bigint,
    currency: string = 'USD',
    mode: RoundingMode = 'CEIL'
  ): bigint {
    this.assertSafeBigInt(microUnits, 'microUnits');
    const { exponent } = this.getCurrencyConfig(currency);
    
    // microUnits has scale 10^6 (major * 1,000,000)
    // minorUnits has scale 10^exponent (major * 10^exponent)
    // conversion divisor = 10^(6 - exponent)
    const powerDiff = 6 - exponent;
    if (powerDiff < 0) {
      // Exponent > 6: scale up
      const factor = BigInt(10) ** BigInt(-powerDiff);
      return this.assertSafeBigInt(microUnits * factor, 'minorUnits');
    }

    const divisor = BigInt(10) ** BigInt(powerDiff);
    if (divisor === BigInt(1)) {
      return microUnits;
    }

    const sign = microUnits < BigInt(0) ? BigInt(-1) : BigInt(1);
    const absVal = microUnits < BigInt(0) ? -microUnits : microUnits;
    const quotient = absVal / divisor;
    const remainder = absVal % divisor;

    if (remainder === BigInt(0)) {
      return this.assertSafeBigInt(sign * quotient, 'minorUnits');
    }

    if (mode === 'CEIL') {
      // Ceiling rounds towards +infinity: if positive and remainder exists, add 1
      const roundedAbs = sign > BigInt(0) ? quotient + BigInt(1) : quotient;
      return this.assertSafeBigInt(sign * roundedAbs, 'minorUnits');
    } else if (mode === 'FLOOR') {
      // Floor rounds towards -infinity: if negative and remainder exists, subtract 1
      const roundedAbs = sign < BigInt(0) ? quotient + BigInt(1) : quotient;
      return this.assertSafeBigInt(sign * roundedAbs, 'minorUnits');
    } else {
      // TRUNC rounds towards zero
      return this.assertSafeBigInt(sign * quotient, 'minorUnits');
    }
  }

  /**
   * Converts currency minor units (e.g. cents) to micro-units (scale 10^6).
   */
  static minorUnitsToMicroUnits(minorUnits: bigint, currency: string = 'USD'): bigint {
    this.assertSafeBigInt(minorUnits, 'minorUnits');
    const { exponent } = this.getCurrencyConfig(currency);
    const powerDiff = 6 - exponent;
    if (powerDiff >= 0) {
      const factor = BigInt(10) ** BigInt(powerDiff);
      return this.assertSafeBigInt(minorUnits * factor, 'microUnits');
    } else {
      const divisor = BigInt(10) ** BigInt(-powerDiff);
      return this.assertSafeBigInt(minorUnits / divisor, 'microUnits');
    }
  }

  /**
   * Multiplies a quantity/units by a micro-unit rate, returning micro-units.
   * e.g. 5 minutes * rate 15,000 micro-units/min = 75,000 micro-units.
   */
  static multiplyRate(units: bigint, rateMicroUnits: bigint): bigint {
    this.assertSafeBigInt(units, 'units');
    this.assertSafeBigInt(rateMicroUnits, 'rateMicroUnits');
    const product = units * rateMicroUnits;
    return this.assertSafeBigInt(product, 'rateMultiplication');
  }

  /**
   * Calculates customer retail charge in minor units from units and micro-rate with deterministic CEIL rounding.
   */
  static calculateCustomerChargeMinor(
    billableUnits: bigint,
    unitRateMicroUnits: bigint,
    currency: string = 'USD'
  ): bigint {
    const totalMicro = this.multiplyRate(billableUnits, unitRateMicroUnits);
    return this.microUnitsToMinorUnits(totalMicro, currency, 'CEIL');
  }

  /**
   * Calculates provider wholesale cost in minor units with deterministic FLOOR rounding on estimates.
   */
  static calculateProviderCostEstimateMinor(
    billableUnits: bigint,
    unitCostMicroUnits: bigint,
    currency: string = 'USD'
  ): bigint {
    const totalMicro = this.multiplyRate(billableUnits, unitCostMicroUnits);
    return this.microUnitsToMinorUnits(totalMicro, currency, 'FLOOR');
  }

  /**
   * Deterministically parses a decimal string (e.g. "0.0125" or "15.50") into micro-units (scale 10^6).
   */
  static parseDecimalToMicroUnits(rawStr: string | null | undefined): bigint {
    if (!rawStr || typeof rawStr !== 'string') {
      throw new TypeError('INVALID_DECIMAL: Input must be a non-empty string.');
    }
    const trimmed = rawStr.trim();
    const match = trimmed.match(/^([+-])?(\d+)(\.(\d+))?$/);
    if (!match) {
      throw new Error(`INVALID_DECIMAL_SYNTAX: Cannot parse monetary decimal '${rawStr}'.`);
    }

    const sign = match[1] === '-' ? BigInt(-1) : BigInt(1);
    const intPart = match[2];
    const fracPart = match[4] || '';

    let normalizedFrac: string;
    let excessCarry = BigInt(0);

    if (fracPart.length > 6) {
      const excess = fracPart.slice(6);
      if (!/^0+$/.test(excess)) {
        excessCarry = BigInt(1); // Round excess up
      }
      normalizedFrac = fracPart.slice(0, 6);
    } else {
      normalizedFrac = fracPart.padEnd(6, '0');
    }

    let magnitude = BigInt(`${intPart}${normalizedFrac}`) + excessCarry;
    return this.assertSafeBigInt(sign * magnitude, 'parsedMicroUnits');
  }

  /**
   * Formats minor units (cents) into a standard decimal currency string (e.g. 1050 -> "10.50").
   */
  static formatMinorToDecimal(minorUnits: bigint, currency: string = 'USD'): string {
    const { exponent } = this.getCurrencyConfig(currency);
    const sign = minorUnits < BigInt(0) ? '-' : '';
    const absVal = minorUnits < BigInt(0) ? -minorUnits : minorUnits;

    if (exponent === 0) {
      return `${sign}${absVal.toString()}`;
    }

    const divisor = BigInt(10) ** BigInt(exponent);
    const intPart = absVal / divisor;
    const fracPart = (absVal % divisor).toString().padStart(exponent, '0');
    return `${sign}${intPart}.${fracPart}`;
  }
}
