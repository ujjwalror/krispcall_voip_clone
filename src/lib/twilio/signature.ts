import 'server-only';
import twilio from 'twilio';

/**
 * Structural helper to validate incoming Twilio Webhook HTTP Signatures.
 * Requires TWILIO_AUTH_TOKEN to be set in environment variables.
 * In Phase 4/5, if TWILIO_AUTH_TOKEN is not configured, signature validation
 * is bypassed safely without blocking development.
 */
export async function validateTwilioRequest(
  request: Request,
  params: Record<string, string>
): Promise<boolean> {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    // Auth token not configured yet in Phase 4/5 foundation; skip signature check safely
    return true;
  }

  const signature = request.headers.get('x-twilio-signature');
  if (!signature) {
    return false;
  }

  const url = request.url;
  return twilio.validateRequest(authToken, signature, url, params);
}
