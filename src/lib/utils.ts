import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Utility for combining Tailwind CSS classes cleanly.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Formats seconds into HH:MM:SS or MM:SS format.
 */
export function formatDuration(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Returns raw/literal phone string to preserve keystrokes during dialing.
 */
export function formatPhoneNumber(phone: string): string {
  if (!phone) return '';
  return phone;
}

/**
 * Formats E.164 phone numbers into clean, provider-neutral display strings.
 * Example: +61348328472 -> +61 3 4832 8472
 */
export function formatDisplayPhoneNumber(phone: string): string {
  if (!phone) return '';
  const trimmed = phone.trim();

  // Australian landline (+613XXXXXXXX -> +61 3 XXXX XXXX)
  if (/^\+61[2378]\d{8}$/.test(trimmed)) {
    return `${trimmed.slice(0, 3)} ${trimmed.slice(3, 4)} ${trimmed.slice(4, 8)} ${trimmed.slice(8)}`;
  }
  // Australian mobile (+614XXXXXXXX -> +61 4XX XXX XXX)
  if (/^\+614\d{8}$/.test(trimmed)) {
    return `${trimmed.slice(0, 3)} ${trimmed.slice(3, 6)} ${trimmed.slice(6, 9)} ${trimmed.slice(9)}`;
  }
  // US/Canada (+1XXXXXXXXXX -> +1 (XXX) XXX-XXXX)
  if (/^\+1\d{10}$/.test(trimmed)) {
    return `+1 (${trimmed.slice(2, 5)}) ${trimmed.slice(5, 8)}-${trimmed.slice(8)}`;
  }

  return trimmed;
}

/**
 * Safely resolves the current browser's IANA time zone identifier.
 */
export function getBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export interface TimeZoneOption {
  iana: string;
  label: string;
}

export const COMMON_TIMEZONES: TimeZoneOption[] = [
  { iana: 'Asia/Kolkata', label: 'Asia/Kolkata (India)' },
  { iana: 'Australia/Melbourne', label: 'Australia/Melbourne' },
  { iana: 'Australia/Sydney', label: 'Australia/Sydney' },
  { iana: 'Australia/Brisbane', label: 'Australia/Brisbane' },
  { iana: 'Asia/Singapore', label: 'Asia/Singapore' },
  { iana: 'Asia/Manila', label: 'Asia/Manila' },
  { iana: 'Asia/Tokyo', label: 'Asia/Tokyo' },
  { iana: 'Pacific/Auckland', label: 'Pacific/Auckland (New Zealand)' },
  { iana: 'Europe/London', label: 'Europe/London (UK)' },
  { iana: 'Europe/Paris', label: 'Europe/Paris (Central Europe)' },
  { iana: 'America/New_York', label: 'America/New_York (US Eastern)' },
  { iana: 'America/Chicago', label: 'America/Chicago (US Central)' },
  { iana: 'America/Denver', label: 'America/Denver (US Mountain)' },
  { iana: 'America/Los_Angeles', label: 'America/Los_Angeles (US Pacific)' },
  { iana: 'UTC', label: 'UTC (Coordinated Universal Time)' },
];

/**
 * Returns formatted time zone label with dynamic UTC offset calculated for current date.
 * Example: "(UTC+05:30) Asia/Kolkata (India)"
 */
export function getFormattedTimeZoneLabel(iana: string, baseLabel?: string): string {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: iana,
      timeZoneName: 'shortOffset',
    });
    const parts = formatter.formatToParts(now);
    const offsetPart = parts.find((p) => p.type === 'timeZoneName')?.value || 'UTC';
    const cleanOffset = offsetPart.replace('GMT', 'UTC');
    const displayLabel = baseLabel || iana;
    return `(${cleanOffset}) ${displayLabel}`;
  } catch {
    return iana;
  }
}

/**
 * Centralized date/time formatter that formats ISO timestamps into user's selected
 * time zone & 12h/24h time format. Calculates 'Today' / 'Yesterday' relative to user's time zone.
 */
export function formatUserDateTime(
  isoString: string,
  timeZone?: string,
  timeFormat: '12h' | '24h' | string = '12h'
): string {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';

  const targetZone = timeZone || getBrowserTimeZone();
  const hour12 = timeFormat !== '24h';

  try {
    const dateParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: targetZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);

    const nowParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: targetZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    const isToday = dateParts === nowParts;

    const timeString = new Intl.DateTimeFormat('en-US', {
      timeZone: targetZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: hour12,
    }).format(date);

    if (isToday) {
      return timeString;
    }

    const dateString = new Intl.DateTimeFormat('en-US', {
      timeZone: targetZone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: hour12,
    }).format(date);

    return dateString;
  } catch (err) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}

/**
 * Formats ISO timestamps into friendly relative/absolute dates using user timezone preferences.
 */
export function formatCallTime(isoString: string, timeZone?: string, timeFormat: string = '12h'): string {
  return formatUserDateTime(isoString, timeZone, timeFormat);
}

/**
 * Normalizes phone numbers to E.164 format for Twilio PSTN dialing.
 * Trims input, strips illegal characters, and enforces '+' prefix.
 */
export function normalizeE164PhoneNumber(phone: string): { isValid: boolean; normalized: string; error?: string } {
  if (!phone || typeof phone !== 'string') {
    return { isValid: false, normalized: '', error: 'Destination number is required.' };
  }

  const trimmed = phone.trim();
  if (trimmed.length === 0) {
    return { isValid: false, normalized: '', error: 'Destination number cannot be blank.' };
  }

  // Remove whitespace, dashes, parentheses, dots
  const stripped = trimmed.replace(/[\s\-\(\)\.]/g, '');

  let normalized = stripped;
  if (!normalized.startsWith('+')) {
    if (/^\d{7,15}$/.test(normalized)) {
      normalized = `+${normalized}`;
    } else {
      return { isValid: false, normalized: '', error: 'Phone number must be a valid E.164 format (e.g. +61412345678 or +15550199).' };
    }
  }

  // Validate E.164 regex: + followed by 7 to 15 digits
  const e164Regex = /^\+[1-9]\d{6,14}$/;
  if (!e164Regex.test(normalized)) {
    return { isValid: false, normalized: '', error: 'Invalid E.164 phone number format.' };
  }

  return { isValid: true, normalized };
}

