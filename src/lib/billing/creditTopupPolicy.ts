import { getCurrencyFractionDigits, formatMinorUnitsToCurrency } from './currencyFormatter';

export const MIN_TOPUP_MAJOR = 10;
export const MAX_TOPUP_MAJOR = 500;
export const PRESET_TOPUP_MAJOR = [10, 25, 50, 100];
export const DEFAULT_TOPUP_MAJOR = 25;

/**
 * Converts a major unit amount (e.g., $25.00) into integer minor units (cents/sen/etc.)
 * taking into account the authoritative ISO currency fraction digits.
 */
export function majorToMinorUnits(majorAmount: number, currencyCode: string = 'USD'): number {
  const fractionDigits = getCurrencyFractionDigits(currencyCode);
  const multiplier = Math.pow(10, fractionDigits);
  return Math.round(majorAmount * multiplier);
}

/**
 * Converts integer minor units into major unit float/number.
 */
export function minorToMajorUnits(minorAmount: number, currencyCode: string = 'USD'): number {
  const fractionDigits = getCurrencyFractionDigits(currencyCode);
  const divisor = Math.pow(10, fractionDigits);
  return minorAmount / divisor;
}

export interface ValidationResult {
  valid: boolean;
  code?: string;
  message?: string;
  amountMinor?: number;
  amountMajor?: number;
}

/**
 * Validates a top-up amount against commercial min ($10 major equivalent) and max ($500 major equivalent) rules.
 */
export function validateTopupAmountMajor(majorAmount: number, currencyCode: string = 'USD'): ValidationResult {
  if (typeof majorAmount !== 'number' || isNaN(majorAmount) || !isFinite(majorAmount) || majorAmount <= 0) {
    return {
      valid: false,
      code: 'INVALID_AMOUNT',
      message: 'Please enter a valid positive top-up amount.',
    };
  }

  if (majorAmount < MIN_TOPUP_MAJOR) {
    const minFormatted = formatMinorUnitsToCurrency(majorToMinorUnits(MIN_TOPUP_MAJOR, currencyCode), currencyCode);
    return {
      valid: false,
      code: 'AMOUNT_BELOW_MINIMUM',
      message: `Minimum top-up amount is ${minFormatted}.`,
    };
  }

  if (majorAmount > MAX_TOPUP_MAJOR) {
    const maxFormatted = formatMinorUnitsToCurrency(majorToMinorUnits(MAX_TOPUP_MAJOR, currencyCode), currencyCode);
    return {
      valid: false,
      code: 'AMOUNT_EXCEEDS_MAXIMUM',
      message: `Maximum top-up amount per transaction is ${maxFormatted}.`,
    };
  }

  const amountMinor = majorToMinorUnits(majorAmount, currencyCode);
  return {
    valid: true,
    amountMajor: majorAmount,
    amountMinor,
  };
}

/**
 * Validates a minor unit top-up amount against commercial min and max rules.
 */
export function validateTopupAmountMinor(minorAmount: number, currencyCode: string = 'USD'): ValidationResult {
  if (typeof minorAmount !== 'number' || !Number.isSafeInteger(minorAmount) || minorAmount <= 0) {
    return {
      valid: false,
      code: 'INVALID_AMOUNT',
      message: 'Top-up amount must be a positive integer in minor units.',
    };
  }

  const majorAmount = minorToMajorUnits(minorAmount, currencyCode);

  if (majorAmount < MIN_TOPUP_MAJOR) {
    const minFormatted = formatMinorUnitsToCurrency(majorToMinorUnits(MIN_TOPUP_MAJOR, currencyCode), currencyCode);
    return {
      valid: false,
      code: 'AMOUNT_BELOW_MINIMUM',
      message: `Minimum top-up amount is ${minFormatted}.`,
    };
  }

  if (majorAmount > MAX_TOPUP_MAJOR) {
    const maxFormatted = formatMinorUnitsToCurrency(majorToMinorUnits(MAX_TOPUP_MAJOR, currencyCode), currencyCode);
    return {
      valid: false,
      code: 'AMOUNT_EXCEEDS_MAXIMUM',
      message: `Maximum top-up amount per transaction is ${maxFormatted}.`,
    };
  }

  return {
    valid: true,
    amountMajor: majorAmount,
    amountMinor: minorAmount,
  };
}
