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

async function updatePhoneSid() {
  const supabase = createAdminClient();
  const e164 = '+15593156374';
  const sid = 'PN56fe03d6b495c766c3ea15906dde2d69';

  const { data: row } = await (supabase as any)
    .from('phone_numbers')
    .select('*')
    .eq('phone_number', e164)
    .single();

  console.log('Current phone row:', row);

  // Set provider_sid / twilio_phone_number_sid on phone_numbers if missing
  const updatePayload: any = {};
  if ('provider_sid' in row) updatePayload.provider_sid = sid;
  if ('twilio_phone_number_sid' in row) updatePayload.twilio_phone_number_sid = sid;

  const { data: updated, error } = await (supabase as any)
    .from('phone_numbers')
    .update(updatePayload)
    .eq('id', row.id)
    .select('*')
    .single();

  console.log('Updated phone row error:', error);
  console.log('Updated phone row:', updated);
}

updatePhoneSid().catch(console.error);
