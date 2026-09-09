import 'server-only';
import twilio from 'twilio';
import { getTwilioConfig } from './config';

/**
 * Initializes a server-only Twilio REST client using API Key SID and API Key Secret.
 */
export function createTwilioServerClient() {
  const config = getTwilioConfig();
  return twilio(config.apiKeySid, config.apiKeySecret, {
    accountSid: config.accountSid,
  });
}
