import 'server-only';
import net from 'net';

/**
 * ============================================================================
 * PHASE 24D.SEC-5: STANDARDS-COMPLIANT CLIENT ADDRESS NORMALIZATION
 * ============================================================================
 *
 * Normalizes IPv4 and IPv6 client addresses into canonical representations and
 * aggregates IPv6 addresses to prevent trivial subnet-rotation evasion.
 *
 * Requirements:
 * - IPv4: Full /32 address, trimmed, dotted-decimal canonical.
 * - IPv4-mapped IPv6 (::ffff:a.b.c.d): Extracted and canonicalized to IPv4.
 * - IPv6: Parsed into 8 16-bit hextets, canonicalized (RFC 5952).
 * - IPv6 Subnet Aggregation: Configurable prefix (default /64 for test policy).
 * - Preserves flag: AUTH_IPV6_AGGREGATION_POLICY_REQUIRES_VALIDATION
 * - Strictly rejects invalid, malformed, or injected address strings.
 */

export interface NormalizedAddressResult {
  family: 'ipv4' | 'ipv6';
  canonicalAddress: string;
  aggregationKey: string;
}

export interface AddressNormalizationOptions {
  ipv6PrefixBits?: number; // e.g. 64 (default), 48, or 128
}

export class AddressNormalizationService {
  /**
   * Normalizes an IP address string. Throws an Error if the address is invalid.
   */
  static normalize(
    rawAddress: string,
    options?: AddressNormalizationOptions
  ): NormalizedAddressResult {
    if (!rawAddress || typeof rawAddress !== 'string') {
      throw new Error('Invalid IP address: address must be a non-empty string');
    }

    let ip = rawAddress.trim().toLowerCase();

    // Reject control characters, spaces, or URI formatting
    if (/[\s\x00-\x1F\x7F%[\]]/.test(ip)) {
      throw new Error(`Invalid IP address: contains illegal characters: ${rawAddress}`);
    }

    // 1. Detect and normalize IPv4-mapped IPv6 (e.g. ::ffff:192.168.1.1 or ::ffff:c0a8:0101)
    const mappedIpv4Match = ip.match(/^(?:::ffff:)(?:0:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (mappedIpv4Match) {
      ip = mappedIpv4Match[1];
    }

    // 2. Evaluate IP Family
    const familyCode = net.isIP(ip);

    if (familyCode === 4) {
      // Canonicalize IPv4
      const octets = ip.split('.').map((part) => parseInt(part, 10));
      if (octets.length !== 4) {
        throw new Error(`Invalid IPv4 structure: ${rawAddress}`);
      }
      for (const oct of octets) {
        if (isNaN(oct) || oct < 0 || oct > 255) {
          throw new Error(`Invalid IPv4 octet value: ${rawAddress}`);
        }
      }
      const canonical = octets.join('.');
      return {
        family: 'ipv4',
        canonicalAddress: canonical,
        aggregationKey: canonical, // IPv4 uses full /32 address
      };
    }

    if (familyCode === 6) {
      // Parse IPv6 into 8 16-bit words (hextets)
      let words: number[] = [];

      // Check if there is an embedded IPv4 address at the tail (e.g., ::192.168.1.1)
      if (ip.includes('.')) {
        const lastColonIndex = ip.lastIndexOf(':');
        const v4Portion = ip.slice(lastColonIndex + 1);
        const v6Portion = ip.slice(0, lastColonIndex);

        if (net.isIP(v4Portion) !== 4) {
          throw new Error(`Invalid embedded IPv4 inside IPv6 address: ${rawAddress}`);
        }

        const v4Octets = v4Portion.split('.').map((o) => parseInt(o, 10));
        const w6 = (v4Octets[0] << 8) | v4Octets[1];
        const w7 = (v4Octets[2] << 8) | v4Octets[3];

        const parts = v6Portion.split('::');
        if (parts.length > 2) {
          throw new Error(`Multiple '::' groups inside IPv6 address: ${rawAddress}`);
        }

        const left = parts[0] ? parts[0].split(':').map((h) => parseInt(h, 16)) : [];
        const right = parts[1] !== undefined ? parts[1].split(':').map((h) => parseInt(h, 16)) : [];

        const fillCount = 6 - (left.length + right.length);
        if (fillCount < 0) {
          throw new Error(`IPv6 address hextet overflow: ${rawAddress}`);
        }
        words = [...left, ...Array(fillCount).fill(0), ...right, w6, w7];
      } else {
        const parts = ip.split('::');
        if (parts.length > 2) {
          throw new Error(`Multiple '::' groups inside IPv6 address: ${rawAddress}`);
        }

        if (parts.length === 2) {
          const left = parts[0] ? parts[0].split(':').map((h) => parseInt(h, 16)) : [];
          const right = parts[1] ? parts[1].split(':').map((h) => parseInt(h, 16)) : [];
          const fillCount = 8 - (left.length + right.length);
          if (fillCount < 0) {
            throw new Error(`IPv6 address hextet overflow: ${rawAddress}`);
          }
          words = [...left, ...Array(fillCount).fill(0), ...right];
        } else {
          words = ip.split(':').map((h) => parseInt(h, 16));
        }
      }

      if (words.length !== 8 || words.some((w) => isNaN(w) || w < 0 || w > 0xffff)) {
        throw new Error(`Malformed IPv6 address: ${rawAddress}`);
      }

      const canonicalAddress = words.map((w) => w.toString(16)).join(':');

      // Prefix aggregation (e.g. /64 = 4 hextets, /48 = 3 hextets)
      const prefixBits = options?.ipv6PrefixBits ?? 64;
      let aggregationKey: string;

      if (prefixBits === 64) {
        aggregationKey = `${words[0].toString(16)}:${words[1].toString(16)}:${words[2].toString(16)}:${words[3].toString(16)}::/64`;
      } else if (prefixBits === 48) {
        aggregationKey = `${words[0].toString(16)}:${words[1].toString(16)}:${words[2].toString(16)}::/48`;
      } else if (prefixBits === 128) {
        aggregationKey = canonicalAddress;
      } else {
        throw new Error(`Unsupported IPv6 prefix length: ${prefixBits}`);
      }

      return {
        family: 'ipv6',
        canonicalAddress,
        aggregationKey,
      };
    }

    throw new Error(`Invalid IP address string: ${rawAddress}`);
  }
}
