import fs from 'fs';
import path from 'path';
import twilio from 'twilio';

const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key && !process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const apiKeySid = process.env.TWILIO_API_KEY_SID!;
const apiKeySecret = process.env.TWILIO_API_KEY_SECRET!;

const client = twilio(apiKeySid, apiKeySecret, { accountSid });

async function testOriginPricing() {
  console.log('=== READ-ONLY AUDIT: ORIGIN-AWARE TWILIO PRICING API ===\n');

  const originNumber = '+61348328472';
  // Test candidate origin with an Australian mobile / local destination prefix (e.g. +61412345678 or +61399999999)
  const destNumber = '+61412345678';

  try {
    console.log(`Querying client.pricing.v2.voice.numbers("${destNumber}") with origin "${originNumber}":`);
    const numPricing = await (client.pricing.v2.voice.numbers(destNumber) as any).fetch({
      originationNumber: originNumber,
    });
    console.log('Origin-aware pricing result:', {
      country: numPricing.country,
      isoCountry: numPricing.isoCountry,
      outboundCallPrices: numPricing.outboundCallPrices,
      inboundCallPrice: numPricing.inboundCallPrice,
      priceUnit: numPricing.priceUnit,
    });
  } catch (err: any) {
    console.log('Origin-aware pricing fetch error:', err.message);
  }
}

testOriginPricing().catch(console.error);
