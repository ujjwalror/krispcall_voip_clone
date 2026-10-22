/**
 * Strict internal redirect validator and sanitizer for authentication callbacks and navigation.
 * Enforces Invariant AUTH-REDIRECT-001:
 * Authentication callbacks may redirect only to authorized internal application paths.
 *
 * Rejects:
 * - Scheme-relative / protocol-relative paths (//host, ///host)
 * - Backslash-prefixed paths (\host, /\host)
 * - Fully qualified URLs with scheme (http://, https://, javascript:, data:)
 * - Encoded protocol-relative or backslash variants (%2f%2f, %5c%5c)
 * - Control characters (\0, \r, \n, etc.)
 * - Redirect loops back to login/signup
 */
export function sanitizeInternalRedirect(
  next: string | null | undefined,
  fallback: string = '/dashboard'
): string {
  if (!next || typeof next !== 'string') return fallback;

  const trimmed = next.trim();
  if (!trimmed) return fallback;

  // 1. Reject any ASCII control characters (0x00 - 0x1F, 0x7F)
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return fallback;

  // 2. Reject any backslashes anywhere in the target string
  if (trimmed.includes('\\')) return fallback;

  // 3. Must start with exactly one forward slash, not two or more
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback;

  // 4. Test URL resolution against an isolated synthetic origin
  try {
    const dummyOrigin = 'https://voiphub.internal.validation';
    const resolved = new URL(trimmed, dummyOrigin);

    // Origin must remain strictly identical to dummyOrigin (guarantees relative path)
    if (resolved.origin !== dummyOrigin) return fallback;

    // Protocol must remain https
    if (resolved.protocol !== 'https:') return fallback;

    // Pathname must start with '/' and not '//'
    if (!resolved.pathname.startsWith('/') || resolved.pathname.startsWith('//')) return fallback;

    // Decode pathname to verify no hidden encoded slashes or backslashes
    const decodedPath = decodeURIComponent(resolved.pathname);
    if (decodedPath.includes('\\') || decodedPath.startsWith('//')) return fallback;

    // Reject redirection loops back to login or signup
    if (resolved.pathname.startsWith('/login') || resolved.pathname.startsWith('/signup')) {
      return fallback;
    }

    // Return safe relative path with search params and hash preserved
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}
