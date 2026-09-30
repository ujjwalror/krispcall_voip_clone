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
const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

const anonClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
const serviceClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

async function checkPermissions() {
  console.log('==================================================');
  console.log('POST-APPLY REMOTE RPC EXECUTE SECURITY VERIFICATION');
  console.log('==================================================\n');

  // 1. Test ANON RPC Execution (MUST FAIL WITH PERMISSION DENIED)
  const { data: anonRpcData, error: anonRpcErr } = await anonClient.rpc('register_telecom_runner_heartbeat_atomic', {
    p_runner_id: 'anon_test_runner',
    p_organization_id: '00000000-0000-0000-0000-000000000001',
    p_authorization_id: null,
    p_destination_fingerprint: 'test_anon_fingerprint',
  });

  const isAnonBlocked = anonRpcErr && (anonRpcErr.message.includes('permission denied') || anonRpcErr.code === '42501');

  console.log('1. Anon Direct RPC Execution Test:');
  console.log('   - Response Data:', anonRpcData);
  console.log('   - Error Message:', anonRpcErr?.message || 'NONE');
  console.log('   - Status:', isAnonBlocked ? 'PASS (BLOCKED)' : 'FAIL (UNBLOCKED)');

  // 2. Test SERVICE ROLE RPC Execution (MUST SUCCEED)
  const { data: serviceRpcData, error: serviceRpcErr } = await serviceClient.rpc('register_telecom_runner_heartbeat_atomic', {
    p_runner_id: 'service_test_runner_verify',
    p_organization_id: '00000000-0000-0000-0000-000000000001',
    p_authorization_id: null,
    p_destination_fingerprint: 'test_service_fingerprint',
    p_status: 'WAITING_FOR_CALL',
    p_ttl_seconds: 10,
  });

  const isServiceAllowed = serviceRpcData && serviceRpcData.success === true;

  console.log('\n2. Service Role RPC Execution Test:');
  console.log('   - Response Data:', serviceRpcData);
  console.log('   - Error Message:', serviceRpcErr?.message || 'NONE');
  console.log('   - Status:', isServiceAllowed ? 'PASS (ALLOWED)' : 'FAIL (BLOCKED)');

  // 3. Clean up test synthetic heartbeat row if created
  if (serviceRpcData?.heartbeat_id) {
    await serviceClient
      .from('telecom_runner_heartbeats')
      .delete()
      .eq('id', serviceRpcData.heartbeat_id);
    console.log('\n✓ Synthetic test heartbeat row cleaned up from remote DB.');
  }

  const isFullySecure = isAnonBlocked && isServiceAllowed;
  console.log('\n==================================================');
  console.log(`REMOTE RPC SECURITY VERIFICATION: ${isFullySecure ? 'PASS' : 'FAIL'}`);
  console.log('==================================================\n');

  if (!isFullySecure) {
    process.exit(1);
  }
}

checkPermissions().catch((err) => {
  console.error('Permission Verification Failed:', err);
  process.exit(1);
});
