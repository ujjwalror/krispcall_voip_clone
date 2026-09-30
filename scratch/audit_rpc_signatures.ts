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

async function auditRemoteRPCs() {
  const supabase = createAdminClient();

  const rpcNames = [
    'create_telecom_usage_reservation_atomic',
    'record_telecom_usage_reservation_atomic',
    'extend_telecom_usage_reservation_atomic',
    'settle_telecom_usage_reservation_atomic',
    'release_telecom_usage_reservation_atomic',
    'reverse_telecom_usage_atomic'
  ];

  console.log('Auditing RPC existence and signatures via Supabase RPC probes...');
  for (const name of rpcNames) {
    const { data, error } = await supabase.rpc(name as any, {} as any);
    console.log(`\nRPC [${name}]:`);
    if (error) {
      console.log(`  Message: ${error.message}`);
      console.log(`  Code: ${error.code}`);
      console.log(`  Details: ${error.details}`);
      console.log(`  Hint: ${error.hint}`);
    } else {
      console.log(`  Data:`, data);
    }
  }
}

auditRemoteRPCs().catch(console.error);
