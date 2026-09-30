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

async function auditAuthorizationsCleanliness() {
  const supabase = createAdminClient();
  console.log('=== AUDITING TELECOM EXPERIMENT AUTHORIZATIONS (READ-ONLY) ===\n');

  const { data: auths, error: authErr } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .order('created_at', { ascending: false });

  if (authErr) {
    console.error('Error fetching authorizations:', authErr);
    process.exit(1);
  }

  console.log(`Total Authorizations Count: ${auths?.length || 0}`);
  let usableCount = 0;
  for (const a of auths || []) {
    const isExpired = new Date(a.expires_at).getTime() <= Date.now();
    const isUsable = a.consumed_at === null && !isExpired;
    if (isUsable) usableCount++;
    console.log(`- ID: ${a.id}`);
    console.log(`  Consumed At: ${a.consumed_at || 'NULL'}`);
    console.log(`  Expires At: ${a.expires_at} (Expired: ${isExpired})`);
    console.log(`  Status Usable: ${isUsable}`);
  }

  console.log(`\nUsable Armed Authorizations Count: ${usableCount}`);
}

auditAuthorizationsCleanliness().catch(console.error);
