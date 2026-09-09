import 'server-only';

export interface TwilioConfig {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  phoneNumber?: string;
}

/**
 * Validates and retrieves server-only Twilio configuration from environment variables.
 * Fails safely on the server if credentials are missing or default placeholders.
 */
export function getTwilioConfig(): TwilioConfig {
  if (typeof window !== 'undefined') {
    throw new Error('Security Error: Twilio config must never be accessed in browser context.');
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
  const twimlAppSid = process.env.TWILIO_TWIML_APP_SID;
  const phoneNumber = process.env.TWILIO_PHONE_NUMBER;

  const isPlaceholder = (val?: string) =>
    !val || val.includes('xxxx') || val.includes('your_twilio');

  if (isPlaceholder(accountSid) || isPlaceholder(apiKeySid) || isPlaceholder(apiKeySecret) || isPlaceholder(twimlAppSid)) {
    throw new Error('Twilio Configuration Error: Required server environment variables are missing or unconfigured.');
  }

  return {
    accountSid: accountSid!,
    apiKeySid: apiKeySid!,
    apiKeySecret: apiKeySecret!,
    twimlAppSid: twimlAppSid!,
    phoneNumber,
  };
}

/**
 * Returns safe health status without exposing sensitive API secrets.
 */
export function checkTwilioConfigHealth() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
  const twimlAppSid = process.env.TWILIO_TWIML_APP_SID;
  const phoneNumber = process.env.TWILIO_PHONE_NUMBER;

  const isPlaceholder = (val?: string) =>
    !val || val.includes('xxxx') || val.includes('your_twilio');

  return {
    configured: !isPlaceholder(accountSid) && !isPlaceholder(apiKeySid) && !isPlaceholder(apiKeySecret),
    twimlAppConfigured: !isPlaceholder(twimlAppSid),
    phoneNumberConfigured: !isPlaceholder(phoneNumber),
  };
}
