import fs from 'fs';
import path from 'path';
import twilio from 'twilio';

// Load .env.local
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
const twilioClient = twilio(apiKeySid, apiKeySecret, { accountSid });

async function checkTwilioChildLegs() {
  const parentSid = 'CA1dd4d33a74dfe9470f29021a6d32bdab';
  console.log('--- Detailed Twilio Call Inspection ---');
  const parentCall = await twilioClient.calls(parentSid).fetch();
  console.log('Parent Call Details:', parentCall);

  // List calls around 2026-09-30T04:24:00Z
  const callsAround = await twilioClient.calls.list({
    startTimeAfter: new Date('2026-09-30T04:20:00Z'),
    limit: 20
  });

  console.log('\nCalls around 04:20-04:30 UTC:');
  for (const c of callsAround) {
    console.log(`- SID: ${c.sid}, ParentSID: ${c.parentCallSid}, From: ${c.from}, To: ${c.to}, Status: ${c.status}, Duration: ${c.duration}, Price: ${c.price}`);
  }
}

checkTwilioChildLegs().catch(console.error);
