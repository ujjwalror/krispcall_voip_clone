import fs from 'fs';
import path from 'path';

(globalThis as any).WebSocket = class {};

import { createClient } from '@supabase/supabase-js';

// Load .env.local
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
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const anonClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });

async function checkPermissions() {
  console.log('==================================================');
  console.log('ANON / PUBLIC RPC EXECUTE SECURITY AUDIT');
  console.log('==================================================\n');

  // Test calling register_telecom_runner_heartbeat_atomic with ANON client
  const { data: anonRpcData, error: anonRpcErr } = await anonClient.rpc('register_telecom_runner_heartbeat_atomic', {
    p_runner_id: 'anon_test_runner',
    p_organization_id: '00000000-0000-0000-0000-000000000001',
    p_authorization_id: null,
    p_destination_fingerprint: 'test_anon_fingerprint',
  });

  console.log('Anon RPC Execution Result:', { anonRpcData, error: anonRpcErr?.message });
}

checkPermissions().catch(console.error);
