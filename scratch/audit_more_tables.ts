import fs from 'fs';
import path from 'path';
(globalThis as any).WebSocket = class {};
import { createClient } from '@supabase/supabase-js';

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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

async function checkMoreTables() {
  const { data: userOrgs, error: userOrgsErr } = await supabase
    .from('user_organizations')
    .select('*')
    .limit(1);
  console.log('user_organizations:', { userOrgs, userOrgsErr });

  const { data: profiles, error: profilesErr } = await supabase
    .from('profiles')
    .select('*')
    .limit(1);
  console.log('profiles:', { profiles, profilesErr });
}

checkMoreTables().catch(console.error);
