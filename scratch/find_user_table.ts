import fs from 'fs';
import path from 'path';

const envPath = path.resolve('.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.substring(0, idx).trim();
      const val = trimmed.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
      process.env[key] = val;
    }
  }
}

import { createAdminClient } from '../src/lib/supabase/admin';

async function findUserProfileTable() {
  const supabase = createAdminClient();

  const { data: uData, error: uErr } = await supabase.from('users').select('*').limit(1);
  console.log('users table:', uData, uErr?.message);

  const { data: pData, error: pErr } = await supabase.from('profiles').select('*').limit(1);
  console.log('profiles table:', pData, pErr?.message);
}

findUserProfileTable().catch(console.error);
