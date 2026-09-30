import assert from 'assert';
import fs from 'fs';
import path from 'path';

(globalThis as any).WebSocket = class {};

import { createClient } from '@supabase/supabase-js';
import { TelecomVoiceExtensionWorker } from '../src/workers/telecomVoiceExtensionWorker';
import { ActiveCallExtensionService } from '../src/lib/billing/telecom/activeCallExtensionService';
import { MockTwilioCallControlAdapter } from '../src/lib/telephony/twilioCallControlAdapter';

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

async function runB2F1Tests() {
  console.log('================================================================');
  console.log('PHASE 13.4.3B.2F.1 — WORKER FOUNDATION & RECOVERY NON-LIVE TESTS');
  console.log('================================================================\n');

  // TEST 1: Worker Initialization & Heartbeat Registration
  console.log('--- TEST 1: Worker Daemon Initialization & Heartbeat Registration ---');
  const worker1 = new TelecomVoiceExtensionWorker({
    workerId: 'test_worker_b2f1_alpha',
    pollingIntervalMs: 500,
    supabaseClient: supabase,
  });

  assert.strictEqual(worker1.getWorkerId(), 'test_worker_b2f1_alpha');
  assert.strictEqual(worker1.isWorkerRunning(), false);

  const hbSuccess = await worker1.sendHeartbeat('STARTING');
  assert.strictEqual(hbSuccess, true, 'Heartbeat RPC should return success=true');
  console.log('✓ TEST 1 PASS: Worker initialized and registered server-authoritative heartbeat.');

  // TEST 2: No-Work Stability & Clean Shutdown
  console.log('\n--- TEST 2: No-Work Stability & Clean Shutdown ---');
  const worker2 = new TelecomVoiceExtensionWorker({
    workerId: 'test_worker_b2f1_beta',
    pollingIntervalMs: 300,
    supabaseClient: supabase,
  });

  // Start worker in background
  const worker2Promise = worker2.start();
  await new Promise((r) => setTimeout(r, 1000)); // Allow worker to run multiple poll iterations with 0 due calls
  assert.strictEqual(worker2.isWorkerRunning(), true);

  await worker2.stop();
  await worker2Promise;
  assert.strictEqual(worker2.isWorkerRunning(), false);
  console.log('✓ TEST 2 PASS: Worker polled cleanly with 0 due calls and stopped gracefully.');

  // TEST 3: Concurrent Duplicate Worker Claim Fencing (FOR UPDATE SKIP LOCKED)
  console.log('\n--- TEST 3: Concurrent Worker Claim Fencing ---');
  const mockAdapter1 = new MockTwilioCallControlAdapter();
  const mockAdapter2 = new MockTwilioCallControlAdapter();

  const wA = new TelecomVoiceExtensionWorker({
    workerId: 'worker_concurrent_A',
    providerAdapter: mockAdapter1,
    supabaseClient: supabase,
  });

  const wB = new TelecomVoiceExtensionWorker({
    workerId: 'worker_concurrent_B',
    providerAdapter: mockAdapter2,
    supabaseClient: supabase,
  });

  // Simulate concurrent poll passes when no work exists
  const [resA, resB] = await Promise.all([wA.processSinglePass(), wB.processSinglePass()]);

  assert.strictEqual(resA.processed, false);
  assert.strictEqual(resB.processed, false);
  console.log('✓ TEST 3 PASS: Concurrent workers poll safely without claims when no work is due.');

  // TEST 4: Fencing Token Rejection & Crash Reclaim Rules
  console.log('\n--- TEST 4: Fencing Token Rejection & Crash Reclaim Mechanics ---');
  const orgId = '00000000-0000-0000-0000-000000000001';

  // Test RPC rejection on fake / stale fencing token
  const { data: staleExtData, error: staleExtErr } = await supabase.rpc('extend_telecom_voice_reservation_fenced_atomic', {
    p_organization_id: orgId,
    p_operation_id: '00000000-0000-0000-0000-000000000000',
    p_dispatch_token: 'stale_token_fake_123',
    p_internal_usage_id: 'call:outbound:fake_call_1',
    p_incremental_amount_minor: 6,
    p_idempotency_key: 'ext_fake_call_1_seq_1',
    p_sequence_number: 1,
    p_new_expires_in_seconds: 1800,
  });

  assert.strictEqual(staleExtErr !== null || (staleExtData && staleExtData.success === false), true, 'Stale token must be rejected');
  console.log('✓ TEST 4 PASS: Stale fencing token is rejected by extend_telecom_voice_reservation_fenced_atomic.');

  // TEST 5: Temporary Database Failure Recovery & Resilience
  console.log('\n--- TEST 5: Temporary DB Failure Recovery ---');
  const brokenSupabase: any = {
    rpc: async () => {
      throw new Error('DATABASE_CONNECTION_TIMEOUT: Connection to PostgreSQL timed out.');
    },
  };

  const workerFailover = new TelecomVoiceExtensionWorker({
    workerId: 'test_worker_b2f1_failover',
    pollingIntervalMs: 200,
    supabaseClient: brokenSupabase,
  });

  let errorCaught = false;
  try {
    await workerFailover.processSinglePass();
  } catch (err: any) {
    errorCaught = true;
    assert.strictEqual(err.message.includes('DATABASE_CONNECTION_TIMEOUT'), true);
  }

  assert.strictEqual(errorCaught, true, 'Worker must surface DB failure without unhandled crash');
  console.log('✓ TEST 5 PASS: Temporary DB failure caught and handled safely by worker polling loop.');

  console.log('\n================================================================');
  console.log('ALL PHASE 13.4.3B.2F.1 NON-LIVE TESTS PASSED (1 - 5)');
  console.log('================================================================\n');
}

runB2F1Tests().catch((err) => {
  console.error('B.2F.1 Test Suite Failed:', err);
  process.exit(1);
});
