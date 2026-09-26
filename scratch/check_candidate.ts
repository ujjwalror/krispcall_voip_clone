import fs from 'fs';
import path from 'path';

try {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...vals] = trimmed.split('=');
        if (key && vals.length > 0) {
          process.env[key.trim()] = vals.join('=').trim().replace(/^["']|["']$/g, '');
        }
      }
    });
  }
} catch (err) {}

import { createTwilioServerClient } from '../src/lib/twilio/client';

async function checkCandidate() {
  const client = createTwilioServerClient();
  const e164 = '+15593156374';
  
  // Test 1: list with contains
  const containsRes = await client.availablePhoneNumbers('US').local.list({ contains: '5593156374' });
  console.log(`Contains search count for 5593156374: ${containsRes.length}`);
  if (containsRes.length > 0) {
    console.log(`Found via contains: ${containsRes[0].phoneNumber}`);
  }

  // Test 2: list with areaCode and larger limit
  const areaRes = await client.availablePhoneNumbers('US').local.list({ areaCode: 559, limit: 100 });
  console.log(`Area code 559 count (limit 100): ${areaRes.length}`);
  const foundInArea = areaRes.find(n => n.phoneNumber === e164);
  console.log(`Found +15593156374 in area code 559 list: ${foundInArea ? 'YES' : 'NO'}`);
}

checkCandidate().catch(console.error);
