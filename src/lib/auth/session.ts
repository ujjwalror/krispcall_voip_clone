import { Session } from '@supabase/supabase-js';

/**
 * Safely extracts the authoritative session_id claim from the Supabase JWT access token string.
 * Does NOT rely on session.id, but decodes the verified JWT payload claims issued by Supabase Auth.
 * Returns null if token is missing, malformed, or lacks a valid session_id claim.
 */
export function extractSessionIdFromToken(tokenString: string | null | undefined): string | null {
  if (!tokenString || typeof tokenString !== 'string') return null;

  try {
    const parts = tokenString.split('.');
    if (parts.length !== 3) return null;

    // Base64URL decode payload safely without external dependencies
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );

    const payload = JSON.parse(jsonPayload);
    if (payload && typeof payload.session_id === 'string' && payload.session_id.trim().length > 0) {
      return payload.session_id.trim();
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Helper to extract session_id from a Supabase Session object.
 */
export function getSessionIdFromSession(session: Session | null | undefined): string | null {
  if (!session?.access_token) return null;
  return extractSessionIdFromToken(session.access_token);
}

/**
 * Safely checks if a Supabase JWT access token represents an active password-recovery session.
 * Decodes verified JWT payload claims and inspects the `amr` (Authentication Methods References) claim.
 * Returns true ONLY if `amr` contains an entry with method === 'recovery'.
 * Invariant AUTH-STATE-001 / SEC3-11: Ordinary authenticated sessions cannot claim recovery status.
 */
export function isRecoverySessionToken(tokenString: string | null | undefined): boolean {
  if (!tokenString || typeof tokenString !== 'string') return false;

  try {
    const parts = tokenString.split('.');
    if (parts.length !== 3) return false;

    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );

    const payload = JSON.parse(jsonPayload);
    if (!payload || !Array.isArray(payload.amr)) return false;

    return payload.amr.some((item: any) => {
      if (typeof item === 'string') return item.toLowerCase() === 'recovery';
      if (item && typeof item === 'object') return item.method?.toLowerCase() === 'recovery';
      return false;
    });
  } catch {
    return false;
  }
}

