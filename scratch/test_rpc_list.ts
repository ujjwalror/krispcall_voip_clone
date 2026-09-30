import fs from 'fs';
import path from 'path';

try {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    for (const line of envConfig.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...vals] = trimmed.split('=');
        if (key && !process.env[key.trim()]) {
          process.env[key.trim()] = vals.join('=').trim();
        }
      }
    }
  }
} catch (e) {}

import { createAdminClient } from '../src/lib/supabase/admin';

async function listRpcs() {
  const supabase = createAdminClient();

  // Test calling existing RPC functions created in migrations
  // Let's check if there are RPC functions in public schema
  const rpcs = [
    'claim_commercial_saga_for_provisioning',
    'claim_commercial_saga_for_capture',
    'claim_payment_for_capture_dispatch',
    'confirm_payment_captured',
    'complete_commercial_saga_after_capture'
  ];

  for (const rpc of rpcs) {
    const { error } = await supabase.rpc(rpc as any, {} as any);
    console.log(`RPC '${rpc}' status:`, error ? error.message : 'EXISTS');
  }
}

listRpcs().catch(console.error);
