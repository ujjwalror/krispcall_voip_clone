import 'server-only';
import twilio from 'twilio';
import { getTwilioConfig } from './config';

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

export interface TokenGenerationResult {
  token: string;
  identity: string;
  expiresInSeconds: number;
}

/**
 * Generates a short-lived Twilio Access Token for WebRTC browser calling.
 * The identity parameter MUST be derived exclusively from the authenticated database profile.
 */
export function generateVoiceAccessToken(
  identity: string,
  ttlSeconds = 3600
): TokenGenerationResult {
  if (!identity || identity.trim() === '') {
    throw new Error('Twilio Token Error: Identity is required.');
  }

  const config = getTwilioConfig();

  // Create short-lived Access Token
  const accessToken = new AccessToken(
    config.accountSid,
    config.apiKeySid,
    config.apiKeySecret,
    {
      identity: identity.trim(),
      ttl: ttlSeconds,
    }
  );

  // Configure VoiceGrant for outgoing application & incoming call allowance
  const grant = new VoiceGrant({
    outgoingApplicationSid: config.twimlAppSid,
    incomingAllow: true,
  });

  accessToken.addGrant(grant);

  return {
    token: accessToken.toJwt(),
    identity: identity.trim(),
    expiresInSeconds: ttlSeconds,
  };
}
