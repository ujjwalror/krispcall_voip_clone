import crypto from 'crypto';
import { SupabaseClient } from '@supabase/supabase-js';

export interface HmacVerificationParams {
  supabase: SupabaseClient;
  signatureHeader: string | null;
  rawBody: string;
  secret?: string;
  maxDriftMs?: number; // Defaults to 300,000ms (5 mins)
}

export interface HmacVerificationResult {
  valid: boolean;
  reason?: string;
  timestamp?: number;
  nonce?: string;
}

/**
 * Computes HMAC-SHA256 signature for internal trigger requests.
 * Signed Payload: `${timestamp}.${nonce}.${rawBody}`
 */
export function generateHmacSignature(
  secret: string,
  timestamp: number,
  nonce: string,
  rawBody: string
): string {
  const payload = `${timestamp}.${nonce}.${rawBody}`;
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex').toLowerCase();
}

/**
 * Builds the canonical header value `t=<timestamp>,n=<nonce>,v1=<signature>`.
 */
export function buildHmacHeader(
  secret: string,
  timestamp: number,
  nonce: string,
  rawBody: string
): string {
  const sig = generateHmacSignature(secret, timestamp, nonce, rawBody);
  return `t=${timestamp},n=${nonce},v1=${sig}`;
}

/**
 * Verifies HMAC-SHA256 signature with constant-time comparison, timestamp drift validation,
 * and atomic DB-backed nonce replay protection.
 */
export async function verifyHmacRequest(
  params: HmacVerificationParams
): Promise<HmacVerificationResult> {
  const { supabase, signatureHeader, rawBody, maxDriftMs = 300000 } = params;
  const secret = params.secret || process.env.RECONCILIATION_HMAC_SECRET;

  if (!secret || !secret.trim()) {
    return { valid: false, reason: 'HMAC_SECRET_NOT_CONFIGURED' };
  }

  if (!signatureHeader || !signatureHeader.trim()) {
    return { valid: false, reason: 'MISSING_SIGNATURE_HEADER' };
  }

  // Parse header: t=<timestamp>,n=<nonce>,v1=<signature>
  const parts = signatureHeader.split(',');
  const parsed: Record<string, string> = {};
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx !== -1) {
      const k = part.substring(0, idx).trim();
      const v = part.substring(idx + 1).trim();
      parsed[k] = v;
    }
  }

  const timestampStr = parsed['t'];
  const nonce = parsed['n'];
  const signatureHex = parsed['v1'];

  if (!timestampStr || !nonce || !signatureHex) {
    return { valid: false, reason: 'MALFORMED_SIGNATURE_HEADER' };
  }

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp) || timestamp <= 0) {
    return { valid: false, reason: 'INVALID_TIMESTAMP' };
  }

  // 1. Timestamp drift check
  const now = Date.now();
  const drift = Math.abs(now - timestamp);
  if (drift > maxDriftMs) {
    return { valid: false, reason: `TIMESTAMP_OUT_OF_TOLERANCE: drift ${drift}ms exceeds max ${maxDriftMs}ms` };
  }

  // 2. Re-compute expected signature & perform constant-time comparison
  const expectedSigHex = generateHmacSignature(secret, timestamp, nonce, rawBody);

  const sigBuf = Buffer.from(signatureHex.toLowerCase(), 'hex');
  const expectedBuf = Buffer.from(expectedSigHex.toLowerCase(), 'hex');

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, reason: 'INVALID_SIGNATURE' };
  }

  // 3. Atomic DB-backed nonce replay protection
  const nonceHash = crypto.createHash('sha256').update(nonce.trim(), 'utf8').digest('hex').toLowerCase();

  try {
    const { data: nonceResult, error: nonceErr } = await (supabase as any).rpc(
      'verify_and_claim_hmac_nonce_atomic',
      {
        p_nonce_hash: nonceHash,
        p_ttl_seconds: Math.ceil(maxDriftMs / 1000),
      }
    );

    if (nonceErr || !nonceResult?.valid) {
      return {
        valid: false,
        reason: nonceResult?.reason || `REPLAYED_NONCE: ${nonceErr?.message}`,
      };
    }
  } catch (err: any) {
    return { valid: false, reason: `NONCE_VERIFICATION_EXCEPTION: ${err.message}` };
  }

  return {
    valid: true,
    timestamp,
    nonce,
  };
}
