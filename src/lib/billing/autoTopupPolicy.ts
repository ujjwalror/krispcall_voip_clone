import { getCurrencyFractionDigits, formatMinorUnitsToCurrency } from './currencyFormatter';
import { majorToMinorUnits, minorToMajorUnits } from './creditTopupPolicy';

/**
 * Subphase C.5B Policy Centralization
 * NOTE: The numerical limits below ($5 min threshold, $100 max threshold, $10 min recharge, $500 max recharge)
 * are explicitly classified as TEMPORARY C.5 DEVELOPMENT POLICY.
 * They can be modified server-side without database schema redesign.
 */

export const CURRENT_CONSENT_TERMS_VERSION = 'v1.0';

// Minimum & Maximum threshold policy (in major units)
export const MIN_AUTO_TOPUP_THRESHOLD_MAJOR = 5;    // $5.00 min threshold
export const MAX_AUTO_TOPUP_THRESHOLD_MAJOR = 100;  // $100.00 max threshold

// Minimum & Maximum recharge policy (in major units)
export const MIN_AUTO_TOPUP_RECHARGE_MAJOR = 10;    // $10.00 min recharge
export const MAX_AUTO_TOPUP_RECHARGE_MAJOR = 500;   // $500.00 max recharge

// Commercial UI Presets
export const PRESET_AUTO_TOPUP_THRESHOLDS_MAJOR = [10, 20, 50];
export const PRESET_AUTO_TOPUP_RECHARGES_MAJOR = [25, 50, 100];

// Default UI choices
export const DEFAULT_AUTO_TOPUP_THRESHOLD_MAJOR = 10;
export const DEFAULT_AUTO_TOPUP_RECHARGE_MAJOR = 25;

// Safety Rate Limits & Abuse Controls
export const MAX_AUTO_TOPUPS_PER_24H = 5;
export const MAX_AUTO_TOPUP_VOLUME_PER_24H_MAJOR = 1000;
export const MIN_AUTO_TOPUP_COOLDOWN_MINUTES = 15;

export interface AutoTopupValidationResult {
  valid: boolean;
  code?: string;
  message?: string;
  thresholdMajor?: number;
  thresholdMinor?: number;
  rechargeAmountMajor?: number;
  rechargeAmountMinor?: number;
}

/**
 * Validates Auto Top-Up threshold and recharge configuration (in major currency units).
 * Uses ISO-aware fraction digits (USD=2, JPY=0, KWD=3).
 */
export function validateAutoTopupConfigMajor(
  thresholdMajor: number,
  rechargeAmountMajor: number,
  currencyCode: string = 'USD'
): AutoTopupValidationResult {
  if (typeof thresholdMajor !== 'number' || isNaN(thresholdMajor) || !isFinite(thresholdMajor) || thresholdMajor <= 0) {
    return {
      valid: false,
      code: 'INVALID_THRESHOLD',
      message: 'Please enter a valid positive threshold amount.',
    };
  }

  if (typeof rechargeAmountMajor !== 'number' || isNaN(rechargeAmountMajor) || !isFinite(rechargeAmountMajor) || rechargeAmountMajor <= 0) {
    return {
      valid: false,
      code: 'INVALID_RECHARGE_AMOUNT',
      message: 'Please enter a valid positive recharge amount.',
    };
  }

  if (thresholdMajor < MIN_AUTO_TOPUP_THRESHOLD_MAJOR) {
    const minFormatted = formatMinorUnitsToCurrency(majorToMinorUnits(MIN_AUTO_TOPUP_THRESHOLD_MAJOR, currencyCode), currencyCode);
    return {
      valid: false,
      code: 'THRESHOLD_BELOW_MINIMUM',
      message: `Minimum Auto Top-Up threshold is ${minFormatted}.`,
    };
  }

  if (thresholdMajor > MAX_AUTO_TOPUP_THRESHOLD_MAJOR) {
    const maxFormatted = formatMinorUnitsToCurrency(majorToMinorUnits(MAX_AUTO_TOPUP_THRESHOLD_MAJOR, currencyCode), currencyCode);
    return {
      valid: false,
      code: 'THRESHOLD_EXCEEDS_MAXIMUM',
      message: `Maximum Auto Top-Up threshold is ${maxFormatted}.`,
    };
  }

  if (rechargeAmountMajor < MIN_AUTO_TOPUP_RECHARGE_MAJOR) {
    const minFormatted = formatMinorUnitsToCurrency(majorToMinorUnits(MIN_AUTO_TOPUP_RECHARGE_MAJOR, currencyCode), currencyCode);
    return {
      valid: false,
      code: 'RECHARGE_BELOW_MINIMUM',
      message: `Minimum Auto Top-Up recharge amount is ${minFormatted}.`,
    };
  }

  if (rechargeAmountMajor > MAX_AUTO_TOPUP_RECHARGE_MAJOR) {
    const maxFormatted = formatMinorUnitsToCurrency(majorToMinorUnits(MAX_AUTO_TOPUP_RECHARGE_MAJOR, currencyCode), currencyCode);
    return {
      valid: false,
      code: 'RECHARGE_EXCEEDS_MAXIMUM',
      message: `Maximum Auto Top-Up recharge amount is ${maxFormatted}.`,
    };
  }

  const thresholdMinor = majorToMinorUnits(thresholdMajor, currencyCode);
  const rechargeAmountMinor = majorToMinorUnits(rechargeAmountMajor, currencyCode);

  return {
    valid: true,
    thresholdMajor,
    thresholdMinor,
    rechargeAmountMajor,
    rechargeAmountMinor,
  };
}

/**
 * Validates Auto Top-Up threshold and recharge configuration (in minor currency units).
 */
export function validateAutoTopupConfigMinor(
  thresholdMinor: number,
  rechargeAmountMinor: number,
  currencyCode: string = 'USD'
): AutoTopupValidationResult {
  if (typeof thresholdMinor !== 'number' || !Number.isSafeInteger(thresholdMinor) || thresholdMinor <= 0) {
    return {
      valid: false,
      code: 'INVALID_THRESHOLD',
      message: 'Threshold must be a positive integer in minor units.',
    };
  }

  if (typeof rechargeAmountMinor !== 'number' || !Number.isSafeInteger(rechargeAmountMinor) || rechargeAmountMinor <= 0) {
    return {
      valid: false,
      code: 'INVALID_RECHARGE_AMOUNT',
      message: 'Recharge amount must be a positive integer in minor units.',
    };
  }

  const thresholdMajor = minorToMajorUnits(thresholdMinor, currencyCode);
  const rechargeAmountMajor = minorToMajorUnits(rechargeAmountMinor, currencyCode);

  return validateAutoTopupConfigMajor(thresholdMajor, rechargeAmountMajor, currencyCode);
}
