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

export async function verifyHumanGoReadiness() {
  const orgId = '00000000-0000-0000-0000-000000000001';
  const nowMs = Date.now();
  const nowIso = new Date().toISOString();

  // 1. Armed Authorization
  const { data: armedAuths } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'armed')
    .gt('expires_at', nowIso);

  const activeAuth = armedAuths?.[0];
  const isAuthValid = armedAuths?.length === 1 && activeAuth;

  // 2. Active Runner Heartbeat
  let isRunnerActive = false;
  let heartbeatRow: any = null;
  let hbAgeSeconds = 999;

  if (activeAuth) {
    const { data: hbs } = await supabase
      .from('telecom_runner_heartbeats')
      .select('*')
      .eq('organization_id', orgId)
      .eq('authorization_id', activeAuth.id)
      .eq('status', 'WAITING_FOR_CALL')
      .gt('expires_at', nowIso)
      .order('last_heartbeat_at', { ascending: false })
      .limit(1);

    if (hbs && hbs.length > 0) {
      heartbeatRow = hbs[0];
      const hbTime = new Date(heartbeatRow.last_heartbeat_at).getTime();
      hbAgeSeconds = Math.floor((nowMs - hbTime) / 1000);
      if (hbAgeSeconds <= 10) {
        isRunnerActive = true;
      }
    }
  }

  // 3. Baseline & Accounting Checks
  const { data: ledgerRows } = await supabase
    .from('billing_credit_ledger')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });
  const fundedBalance = ledgerRows?.[0]?.balance_after_minor || 0;

  const { data: activeRes } = await supabase
    .from('telecom_usage_reservations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'active');
  const activeExposure = activeRes?.length || 0;

  const { data: pendingOps } = await supabase
    .from('telecom_usage_reservations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'pending');
  const unresolvedOps = pendingOps?.length || 0;

  const isBaselineClean = fundedBalance === 100 && activeExposure === 0 && unresolvedOps === 0;

  const isReady = isAuthValid && isRunnerActive && isBaselineClean;

  console.log('=== MACHINE-VERIFIABLE HUMAN GO READINESS CHECK ===');
  console.log(`- Armed Authorization Present: ${isAuthValid ? 'YES' : 'NO'} (ID: ${activeAuth?.id || 'NONE'})`);
  console.log(`- Runner Heartbeat Active: ${isRunnerActive ? 'YES' : 'NO'} (Age: ${hbAgeSeconds}s, Status: ${heartbeatRow?.status || 'NONE'})`);
  console.log(`- Baseline Clean: ${isBaselineClean ? 'YES' : 'NO'} (Balance: ${fundedBalance}c, Exposure: ${activeExposure}c, Unresolved: ${unresolvedOps})`);
  console.log(`- READY_FOR_HUMAN_CALL = ${isReady ? 'YES' : 'NO'}\n`);

  return {
    isReady,
    authId: activeAuth?.id,
    hbAgeSeconds,
    fundedBalance,
  };
}

if (require.main === module) {
  verifyHumanGoReadiness().catch(console.error);
}
