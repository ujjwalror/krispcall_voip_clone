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

console.log('AccountSid:', accountSid);
console.log('ApiKeySid:', apiKeySid);

async function testAuth() {
  const apiKeyClient = twilio(apiKeySid, apiKeySecret, { accountSid });
  
  // 1. Try incomingPhoneNumbers list with API Key
  try {
    const nums = await apiKeyClient.incomingPhoneNumbers.list({ limit: 1 });
    console.log('1. API Key incomingPhoneNumbers success:', nums.map(n => n.phoneNumber));
  } catch (e: any) {
    console.log('1. API Key incomingPhoneNumbers error:', e.message);
  }

  // 2. Try accounts fetch with API Key vs AuthToken
  try {
    const acc = await apiKeyClient.api.v2010.accounts(accountSid).fetch();
    console.log('2. API Key accounts fetch success:', acc.sid, acc.status);
  } catch (e: any) {
    console.log('2. API Key accounts fetch error:', e.message);
  }
}

testAuth().catch(console.error);
