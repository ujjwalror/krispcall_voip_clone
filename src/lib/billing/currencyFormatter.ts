/**
 * Canonical ISO-Aware Currency Minor-Unit Display Formatter for VoIP Hub.
 *
 * Requirements:
 * 1. Financial accounting values remain integer minor units (e.g. cents).
 * 2. Uses Intl.NumberFormat to derive the authoritative ISO currency's minor-unit fraction digits:
 *    - USD, EUR, GBP, CAD, AUD: 2 fraction digits (e.g., 100 minor USD -> "$1.00 USD")
 *    - JPY, KRW, VND, CLP: 0 fraction digits (e.g., 100 minor JPY -> "¥100 JPY")
 *    - KWD, BHD, OMR, TND: 3 fraction digits (e.g., 1000 minor KWD -> "KWD 1.000 KWD")
 * 3. Conversion is strictly for DISPLAY ONLY. Stored/accounting values remain integer minor units.
 * 4. Invalid or unparseable currency codes fail safely without crashing the dashboard.
 */

export function getCurrencyFractionDigits(currencyCode: string): number {
  try {
    const cleanCode = (currencyCode || 'USD').trim().toUpperCase();
    const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: cleanCode });
    const resolved = formatter.resolvedOptions();
    return resolved.maximumFractionDigits ?? 2;
  } catch (err) {
    // If currency code is invalid or unsupported by Intl, fallback to 2
    return 2;
  }
}

export function formatMinorUnitsToCurrency(minorUnits: number, currencyCode: string = 'USD'): string {
  let safeMinor = minorUnits;
  if (!Number.isInteger(safeMinor)) {
    safeMinor = Math.round(safeMinor || 0);
  }

  const cleanCode = (currencyCode || 'USD').trim().toUpperCase();

  let fractionDigits = 2;
  try {
    fractionDigits = getCurrencyFractionDigits(cleanCode);
  } catch {
    fractionDigits = 2;
  }

  const divisor = Math.pow(10, fractionDigits);
  const majorAmount = safeMinor / divisor;

  try {
    const formattedAmount = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: cleanCode,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(majorAmount);

    return `${formattedAmount} ${cleanCode}`;
  } catch (err) {
    // Fallback for invalid/unrecognized ISO currency codes (e.g. "INVALID")
    const formattedFallback = (safeMinor / 100).toFixed(2);
    return `$${formattedFallback} ${cleanCode}`;
  }
}
