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
const supabaseKey = process.env.SUPABASE_SECRET_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

async function verifyRemote() {
  console.log('==================================================');
  console.log('REMOTE SCHEMA & RPC READ-ONLY VERIFICATION');
  console.log('==================================================\n');

  // 1. Verify remote table existence and columns
  const { data: testSelect, error: selectErr } = await supabase
    .from('telecom_runner_heartbeats')
    .select('id, runner_id, organization_id, authorization_id, destination_fingerprint, status, started_at, last_heartbeat_at, expires_at, created_at, updated_at')
    .limit(0);

  console.log('Table select query status:', selectErr ? `ERROR: ${selectErr.message}` : 'SUCCESS (Table telecom_runner_heartbeats and all 11 columns exist!)');

  // 2. Test RPC definition existence with invalid input (returns json validation error without inserting)
  const { data: rpcData, error: rpcErr } = await supabase.rpc('register_telecom_runner_heartbeat_atomic', {
    p_runner_id: '',
    p_organization_id: '00000000-0000-0000-0000-000000000000',
    p_authorization_id: '00000000-0000-0000-0000-000000000000',
    p_destination_fingerprint: '',
  });

  console.log('RPC check response:', { rpcData, rpcErr: rpcErr?.message || null });
  if (rpcData && rpcData.reason === 'INVALID_RUNNER_ID') {
    console.log('✓ RPC register_telecom_runner_heartbeat_atomic EXISTS and matches expected validation contract!');
  }

  // 3. Test RLS protection by querying with anon key
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const anonClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });

  const { data: anonData, error: anonErr } = await anonClient
    .from('telecom_runner_heartbeats')
    .select('*')
    .limit(1);

  console.log('Anon client query result:', { data: anonData, error: anonErr?.message });
  console.log('✓ RLS verification:', anonData?.length === 0 || anonErr ? 'SUCCESS (Anon/public has zero access)' : 'FAIL');

  // 4. Verify clean baseline on org
  const orgId = '00000000-0000-0000-0000-000000000001';
  const nowIso = new Date().toISOString();

  const { data: armedAuths } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'armed')
    .gt('expires_at', nowIso);

  const { data: activeClaims } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'claimed')
    .gt('claim_expires_at', nowIso);

  const { data: activeRes } = await supabase
    .from('telecom_usage_reservations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'active');

  const { data: pendingOps } = await supabase
    .from('telecom_usage_reservations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'pending');

  console.log('\n--- CURRENT EXPERIMENT SAFETY STATE ---');
  console.log('Usable Armed Auths:', armedAuths?.length || 0);
  console.log('Currently Active Claimed Auths:', activeClaims?.length || 0);
  console.log('Active Protected Exposure:', activeRes?.length || 0);
  console.log('Unresolved Financial Operations:', pendingOps?.length || 0);
}

verifyRemote().catch(console.error);
