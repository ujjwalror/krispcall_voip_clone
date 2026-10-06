import 'server-only';

/**
 * Timezone-aware renewal deadline formatter.
 * Ensures customer deadlines ALWAYS display localized Date + Time + Timezone Name
 * to prevent date-only timezone misinterpretation (e.g., UTC vs local cutoffs).
 */
export function formatRenewalDeadline(
  isoTimestamp: string | Date | null | undefined,
  storedTimeZone?: string | null
): string {
  if (!isoTimestamp) {
    return 'N/A';
  }

  const date = typeof isoTimestamp === 'string' ? new Date(isoTimestamp) : isoTimestamp;
  if (isNaN(date.getTime())) {
    return 'Invalid Date';
  }

  // Determine timezone source: stored user profile timezone or explicit UTC fallback
  let targetZone = 'UTC';
  if (storedTimeZone && storedTimeZone.trim().length > 0 && storedTimeZone.trim() !== 'AUTO') {
    const cleanTz = storedTimeZone.trim() === 'Asia/Calcutta' ? 'Asia/Kolkata' : storedTimeZone.trim();
    try {
      // Test validity of timezone identifier
      Intl.DateTimeFormat(undefined, { timeZone: cleanTz });
      targetZone = cleanTz;
    } catch {
      targetZone = 'UTC';
    }
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: targetZone,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });

    const parts = formatter.formatToParts(date);
    const month = parts.find((p) => p.type === 'month')?.value || '';
    const day = parts.find((p) => p.type === 'day')?.value || '';
    const year = parts.find((p) => p.type === 'year')?.value || '';
    const hour = parts.find((p) => p.type === 'hour')?.value || '';
    const minute = parts.find((p) => p.type === 'minute')?.value || '';
    const dayPeriod = parts.find((p) => p.type === 'dayPeriod')?.value || '';
    const tzName = parts.find((p) => p.type === 'timeZoneName')?.value || targetZone;

    const timeStr = `${hour}:${minute} ${dayPeriod}`.trim();
    return `${day} ${month} ${year} at ${timeStr} ${tzName}`;
  } catch {
    // Ultimate safe fallback with explicit UTC tag
    return `${date.toUTCString()} (UTC)`;
  }
}
