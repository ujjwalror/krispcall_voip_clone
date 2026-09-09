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
 * Standard phone number formatter (E.164 or US/International presentation).
 */
export function formatPhoneNumber(phone: string): string {
  if (!phone) return '';
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  }
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
  }
  return phone.startsWith('+') ? phone : `+${phone}`;
}

/**
 * Formats ISO timestamps into friendly relative/absolute dates.
 */
export function formatCallTime(isoString: string): string {
  if (!isoString) return '';
  const date = new Date(isoString);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return date.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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

