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

import { createAdminClient } from '../src/lib/supabase/admin';
import { createTwilioServerClient } from '../src/lib/twilio/client';

async function checkActualState() {
  const supabase = createAdminClient();
  const twilio = createTwilioServerClient();
  const e164 = '+15593156374';

  console.log('=== CHECKING TWILIO INCOMING NUMBERS ===');
  const incoming = await twilio.incomingPhoneNumbers.list({ phoneNumber: e164 });
  console.log(`Matching Twilio Incoming Phone Numbers for ${e164}: ${incoming.length}`);
  if (incoming.length > 0) {
    console.log(`Twilio SID: ${incoming[0].sid}`);
    console.log(`Twilio Capabilities:`, incoming[0].capabilities);
    console.log(`Twilio Date Created:`, incoming[0].dateCreated);
  }

  console.log('\n=== CHECKING SUPABASE PHONE_NUMBERS TABLE ===');
  const { data: phoneRows } = await (supabase as any)
    .from('phone_numbers')
    .select('*')
    .eq('phone_number', e164);
  console.log(`Supabase phone_numbers rows for ${e164}:`, phoneRows);

  console.log('\n=== CHECKING SUPABASE PROVIDER_NUMBER_OPERATIONS TABLE ===');
  const { data: opRows } = await (supabase as any)
    .from('provider_number_operations')
    .select('*')
    .eq('phone_number_e164', e164);
  console.log(`Supabase provider_number_operations rows for ${e164}:`, opRows);
}

checkActualState().catch(console.error);
