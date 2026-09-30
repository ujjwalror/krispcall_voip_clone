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

async function inspectSchema() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  const supabase = createAdminClient();

  console.log('Fetching PostgREST OpenAPI spec from remote Supabase instance...');
  const res = await fetch(`${supabaseUrl}/rest/v1/?apikey=${serviceKey}`);
  if (res.ok) {
    const json = await res.json();
    const paths = Object.keys(json.paths || {});
    console.log('Registered PostgREST Table Endpoints:', paths.filter(p => !p.startsWith('/rpc/')));
    console.log('Registered PostgREST RPC Endpoints:', paths.filter(p => p.startsWith('/rpc/')));
  } else {
    console.log('OpenAPI fetch failed status:', res.status);
  }

  // Also query billing_payment_operations
  const { data: payOpData, error: payOpErr } = await (supabase as any)
    .from('billing_payment_operations')
    .select('id, status, capture_dispatch_claimed_at, capture_idempotency_key')
    .limit(1);

  if (payOpErr) {
    console.log('billing_payment_operations query error:', payOpErr);
  } else {
    console.log('billing_payment_operations query success:', payOpData);
  }
}

inspectSchema();
