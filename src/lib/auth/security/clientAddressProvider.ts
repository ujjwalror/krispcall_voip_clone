import 'server-only';

/**
 * ============================================================================
 * PHASE 24D.SEC-5: AUTHORITATIVE CLIENT ADDRESS BOUNDARY
 * ============================================================================
 *
 * Invariant AUTH-ABUSE-006:
 * Application code must never independently promote an arbitrary request
 * forwarding header (X-Forwarded-For, X-Real-IP, Forwarded) to authoritative
 * source identity before the VPS trusted-proxy topology is securely provisioned.
 *
 * Preserves flag:
 * VPS_TRUSTED_PROXY_SECURITY_REQUIRES_CONFIGURATION
 * FRESH_FULL_POST_VPS_PRODUCTION_VALIDATION_MANDATORY
 */

export interface AuthoritativeClientAddressProvider {
  getClientAddress(request?: Request | any): string;
}

/**
 * Production placeholder provider that refuses to blindly trust client-supplied
 * forwarding headers until the VPS trusted reverse proxy is configured to strip
 * untrusted headers and inject authoritative socket-derived IP metadata.
 */
export class DirectSocketAddressProvider implements AuthoritativeClientAddressProvider {
  getClientAddress(_request?: Request | any): string {
    throw new Error(
      'VPS_TRUSTED_PROXY_SECURITY_REQUIRES_CONFIGURATION: Authoritative client IP resolution is withheld until VPS reverse-proxy header stripping is configured.'
    );
  }
}

/**
 * Explicit test/synthetic address provider for local certification.
 * Allows safe injection of synthetic IPv4 and IPv6 test fixtures without network calls.
 */
export class SyntheticTestAddressProvider implements AuthoritativeClientAddressProvider {
  constructor(private readonly syntheticIp: string) {}

  getClientAddress(_request?: Request | any): string {
    return this.syntheticIp;
  }
}
