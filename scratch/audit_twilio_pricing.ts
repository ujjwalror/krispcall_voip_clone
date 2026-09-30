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

async function testTwilioPricingAndNumber() {
  console.log('=== READ-ONLY TWILIO PRICING & NUMBER AUDIT ===');
  
  // 1. Candidate Number Metadata Fetch
  const numbers = await client.incomingPhoneNumbers.list({ limit: 5 });
  console.log('1. Owned Numbers List:');
  for (const n of numbers) {
    console.log({
      sid: n.sid,
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
      capabilities: n.capabilities,
      addressRequirements: n.addressRequirements,
      voiceUrl: n.voiceUrl,
      // Check all available properties on n
      keys: Object.keys(n).filter(k => !k.startsWith('_')),
    });
  }

  // 2. Twilio Pricing API Audit (v2.voice or v1.voice)
  try {
    console.log('\n2. Testing client.pricing.v2.voice.countries("AU"):');
    const auPricing = await client.pricing.v2.voice.countries('AU').fetch();
    console.log('AU Pricing Country:', {
      country: auPricing.country,
      isoCountry: auPricing.isoCountry,
      outboundPrefixPrices: auPricing.outboundPrefixPrices?.slice(0, 3),
      inboundCallPrices: auPricing.inboundCallPrices,
      priceUnit: auPricing.priceUnit,
    });
  } catch (e: any) {
    console.log('AU Pricing Country Error:', e.message);
  }

  try {
    console.log('\n3. Testing client.pricing.v2.voice.numbers("+61348328472"):');
    const numPricing = await client.pricing.v2.voice.numbers('+61348328472').fetch();
    console.log('Number Pricing:', {
      number: numPricing.number,
      country: numPricing.country,
      isoCountry: numPricing.isoCountry,
      outboundCallPrice: numPricing.outboundCallPrice,
      inboundCallPrice: numPricing.inboundCallPrice,
      priceUnit: numPricing.priceUnit,
    });
  } catch (e: any) {
    console.log('Number Pricing Error:', e.message);
  }
}

testTwilioPricingAndNumber().catch(console.error);
