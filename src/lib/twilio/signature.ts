import 'server-only';
import twilio from 'twilio';

/**
 * Structural helper to validate incoming Twilio Webhook HTTP Signatures.
 * Requires TWILIO_AUTH_TOKEN to be set in environment variables.
 * Can be explicitly bypassed in dev/testing using TWILIO_SKIP_SIGNATURE_VALIDATION=true.
 */
export async function validateTwilioRequest(
  request: Request,
  params: Record<string, string>
): Promise<boolean> {
  // 1. Check development safety override
  if (process.env.TWILIO_SKIP_SIGNATURE_VALIDATION === 'true') {
    console.log('[Twilio Signature Debug] TWILIO_SKIP_SIGNATURE_VALIDATION is true. Bypassing signature validation.');
    return true;
  }

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.warn('[Twilio Signature Debug] TWILIO_AUTH_TOKEN is not configured in environment variables. Bypassing signature validation.');
    return true;
  }

  const signature = request.headers.get('x-twilio-signature');
  const xForwardedHost = request.headers.get('x-forwarded-host') || '';
  const rawHost = request.headers.get('host') || '';
  const xForwardedProto = request.headers.get('x-forwarded-proto') || '';
  const parsedUrl = new URL(request.url);

  if (!signature) {
    console.warn('[Twilio Signature Failed]', {
      'Request URL': request.url,
      'Constructed URL': '(none)',
      'Signature Header': '(missing)',
      'x-forwarded-host': xForwardedHost || '(none)',
      'x-forwarded-proto': xForwardedProto || '(none)',
      'Request pathname': parsedUrl.pathname,
      'Request search params': parsedUrl.search,
    });
    return false;
  }

  // Build candidate URL variants to validate in order
  const host = (xForwardedHost || rawHost).split(',')[0].trim();
  const cleanHost = host.replace(/:\d+$/, '');
  const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
  const proto = (xForwardedProto || (isLocal ? 'http' : 'https')).split(',')[0].trim();

  // Variant 1: Forwarded proto + host (standard Vercel/reverse proxy)
  const variant1 = `${proto}://${host}${parsedUrl.pathname}${parsedUrl.search}`;

  // Variant 2: Forwarded proto + cleanHost (without port)
  const variant2 = `${proto}://${cleanHost}${parsedUrl.pathname}${parsedUrl.search}`;

  // Variant 3: HTTPS + host
  const variant3 = `https://${cleanHost}${parsedUrl.pathname}${parsedUrl.search}`;

  // Variant 4: NEXT_PUBLIC_APP_URL + pathname + search
  let variant4: string | null = null;
  if (process.env.NEXT_PUBLIC_APP_URL) {
    const appUrlClean = process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');
    variant4 = `${appUrlClean}${parsedUrl.pathname}${parsedUrl.search}`;
  }

  // Variant 5: request.url as-is
  const variant5 = request.url;

  // Variant 6: request.url converted to https://
  const variant6 = request.url.startsWith('http://')
    ? request.url.replace(/^http:\/\//, 'https://')
    : null;

  // Test URL variants in order
  const urlVariants: string[] = Array.from(
    new Set([variant1, variant2, variant3, variant4, variant5, variant6].filter(Boolean) as string[])
  );

  let matchedUrl: string | null = null;

  for (const candidateUrl of urlVariants) {
    if (twilio.validateRequest(authToken, signature, candidateUrl, params)) {
      matchedUrl = candidateUrl;
      break;
    }
  }

  if (matchedUrl) {
    console.log('[Twilio Signature Verification]', {
      'Request URL': request.url,
      'Constructed Validation URL': matchedUrl,
      Host: rawHost || '(none)',
      'Forwarded Host': xForwardedHost || '(none)',
      'Forwarded Proto': xForwardedProto || '(none)',
      'Signature Present': true,
      'Validation Result': true,
    });
    return true;
  }

  // Safe logging before returning validation failure
  console.warn('[Twilio Signature Failed]', {
    'Request URL': request.url,
    'Constructed URL': variant1,
    'Signature Header': signature ? `${signature.substring(0, 8)}...` : '(missing)',
    'x-forwarded-host': xForwardedHost || '(none)',
    'x-forwarded-proto': xForwardedProto || '(none)',
    'Request pathname': parsedUrl.pathname,
    'Request search params': parsedUrl.search,
  });

  return false;
}

