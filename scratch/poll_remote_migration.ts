import fs from 'fs';
import path from 'path';

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

import { createAdminClient } from '../src/lib/supabase/admin';

async function verifyRemoteMigration() {
  const supabase = createAdminClient();

  console.log('Checking remote Supabase schema for public.commercial_number_purchase_sagas...');
  const { data, error } = await (supabase as any)
    .from('commercial_number_purchase_sagas')
    .select('id')
    .limit(1);

  if (error) {
    console.log('Table query error:', error.message);
    return false;
  }

  console.log('✓ Table public.commercial_number_purchase_sagas found remotely!');
  return true;
}

verifyRemoteMigration();
