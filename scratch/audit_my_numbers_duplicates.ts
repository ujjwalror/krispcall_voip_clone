import fs from 'fs';
import path from 'path';

// Parse .env.local manually
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
} catch (err) {
  // Ignore error if env file missing
}

import { createAdminClient } from '../src/lib/supabase/admin';

async function auditDuplicates() {
  console.log('====================================================');
  console.log('READ-ONLY AUDIT: MY NUMBERS DUPLICATE E.164 DISPLAY');
  console.log('====================================================\n');

  const supabase = createAdminClient();

  const targetNumbers = ['+12025550377', '+12025550466'];

  for (const num of targetNumbers) {
    console.log(`--- AUDITING E.164: ${num} ---`);
    const { data: rows, error: fetchErr } = await (supabase as any)
      .from('phone_numbers')
      .select('*')
      .eq('phone_number', num);

    if (fetchErr) {
      console.error(`Error querying phone_numbers for ${num}:`, fetchErr);
    } else {
      console.log(`Physical phone_numbers rows found: ${rows.length}`);
      rows.forEach((r: any, idx: number) => {
        console.log(` Row ${idx + 1}:`);
        console.log(`  - ID: ${r.id}`);
        console.log(`  - Phone Number: ${r.phone_number}`);
        console.log(`  - Status (enum): ${r.status}`);
        console.log(`  - Active (boolean): ${r.active}`);
        console.log(`  - Created At: ${r.created_at}`);
        console.log(`  - Updated At: ${r.updated_at}`);
        console.log(`  - Capabilities: Voice=${r.voice_enabled}, SMS=${r.sms_enabled}, MMS=${r.mms_enabled}`);
        console.log(`  - Provider Sid: ${r.provider_sid || 'None'}`);
      });
    }
    console.log('');
  }

  // Also query all phone_numbers in DB to see if any other duplicates exist
  const { data: allPhoneNumbers, error: allErr } = await (supabase as any)
    .from('phone_numbers')
    .select('id, phone_number, status, active, created_at, updated_at, voice_enabled, sms_enabled');

  if (!allErr && allPhoneNumbers) {
    console.log(`Total phone_numbers in database: ${allPhoneNumbers.length}`);
    const numberCounts: Record<string, any[]> = {};
    allPhoneNumbers.forEach((pn: any) => {
      if (!numberCounts[pn.phone_number]) numberCounts[pn.phone_number] = [];
      numberCounts[pn.phone_number].push(pn);
    });

    Object.entries(numberCounts).forEach(([phone, list]) => {
      if (list.length > 1) {
        console.log(`DUPLICATE FOUND for ${phone}: ${list.length} rows`);
        list.forEach((r) => {
          console.log(`  -> ID: ${r.id} | status: ${r.status} | active: ${r.active} | created_at: ${r.created_at}`);
        });
      }
    });
  }

  // Check remote index definition for idx_phone_numbers_active_ownership via rpc or raw query if possible
  console.log('\n====================================================');
}

auditDuplicates().catch((err) => {
  console.error('Audit error:', err);
  process.exit(1);
});
