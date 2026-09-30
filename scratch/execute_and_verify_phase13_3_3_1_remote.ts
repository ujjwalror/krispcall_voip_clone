import fs from 'fs';
import path from 'path';

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

import { createAdminClient } from '../src/lib/supabase/admin';

async function runRemoteDeploymentAndVerification() {
  console.log('====================================================');
  console.log('PHASE 13.3.3.1 — CONTROLLED REMOTE MIGRATION DEPLOYMENT');
  console.log('====================================================\n');

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;

  console.log(`1. Target Supabase URL: ${supabaseUrl}`);
  if (!supabaseUrl?.includes('jupwsumuutuysmpxdtpw')) {
    throw new Error(`ABORT: Target URL ${supabaseUrl} does not match expected project jupwsumuutuysmpxdtpw.`);
  }

  const supabase = createAdminClient();

  // STEP 1: PRE-DEPLOYMENT SAFETY CHECK
  console.log('\n--- STEP 1: PRE-DEPLOYMENT SAFETY CHECK ---');
  
  // Verify commercial_number_purchase_sagas exists
  const { error: sagaTableErr } = await (supabase as any)
    .from('commercial_number_purchase_sagas')
    .select('id')
    .limit(1);
  if (sagaTableErr) {
    throw new Error(`PRE-CHECK FAILED: commercial_number_purchase_sagas table error: ${sagaTableErr.message}`);
  }
  console.log('✓ Table public.commercial_number_purchase_sagas exists remotely.');

  // Verify billing_payment_operations exists
  const { error: payOpTableErr } = await (supabase as any)
    .from('billing_payment_operations')
    .select('id')
    .limit(1);
  if (payOpTableErr) {
    throw new Error(`PRE-CHECK FAILED: billing_payment_operations table error: ${payOpTableErr.message}`);
  }
  console.log('✓ Table public.billing_payment_operations exists remotely.');

  // Verify PHASE13_PAYMENT_ENABLED is false
  const paymentEnabled = process.env.PHASE13_PAYMENT_ENABLED || 'false';
  if (paymentEnabled === 'true') {
    throw new Error('PRE-CHECK FAILED: PHASE13_PAYMENT_ENABLED is true. Must remain false.');
  }
  console.log(`✓ PHASE13_PAYMENT_ENABLED is strictly false.`);

  // Check if capture primitives RPCs already exist or if DDL application is required
  const { error: preRpcErr } = await (supabase as any).rpc('claim_commercial_saga_for_capture', {
    p_saga_id: '00000000-0000-0000-0000-000000000000',
    p_organization_id: '00000000-0000-0000-0000-000000000000',
  });

  const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/20261203000000_phase13_3_capture_primitives.sql');
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');

  if (preRpcErr && preRpcErr.code === 'PGRST202') {
    console.log('\n--- STEP 2: APPLYING REVIEWED MIGRATION TO REMOTE DB ---');
    console.log(`Applying migration ${migrationPath} (${migrationSql.length} bytes)...`);

    // Try applying DDL via RPC exec_sql or PostgreSQL HTTP endpoint
    let ddlSuccess = false;
    try {
      const { error: execErr } = await (supabase as any).rpc('exec_sql', { sql_query: migrationSql });
      if (!execErr) {
        console.log('✓ Migration DDL applied remotely via exec_sql RPC.');
        ddlSuccess = true;
      } else {
        console.log('exec_sql RPC output:', execErr.message);
      }
    } catch (err: any) {
      console.log('exec_sql error:', err.message);
    }

    if (!ddlSuccess) {
      // Try direct Management / SQL API if available
      try {
        const sqlRes = await fetch(`${supabaseUrl}/rest/v1/`, {
          method: 'POST',
          headers: {
            apikey: serviceKey!,
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: migrationSql }),
        });
        console.log('SQL Endpoint response status:', sqlRes.status);
      } catch (fErr: any) {
        console.log('Fetch SQL error:', fErr.message);
      }
    }
  } else {
    console.log('✓ Capture primitives RPCs already present remotely or initialized.');
  }

  // STEP 3: VERIFY REMOTE COLUMNS & RPC AVAILABILITY
  console.log('\n--- STEP 3: VERIFYING REMOTE COLUMNS & RPC DEFINITIONS ---');

  // Verify columns exist by querying billing_payment_operations
  const { data: colData, error: colErr } = await (supabase as any)
    .from('billing_payment_operations')
    .select('id, capture_dispatch_claimed_at, capture_idempotency_key')
    .limit(1);

  if (colErr) {
    console.error('❌ Column verification failed:', colErr.message);
    console.log('\nPlease ensure migration 20261203000000_phase13_3_capture_primitives.sql is executed in Supabase SQL Editor if schema cache requires manual refresh.');
    process.exit(1);
  }

  console.log('✓ Remote columns capture_dispatch_claimed_at and capture_idempotency_key verified present!');

  // STEP 4: REAL REMOTE POSTGRES DATABASE RUNTIME VERIFICATION
  console.log('\n--- STEP 4: REAL REMOTE POSTGRES DATABASE VERIFICATION ---');

  // Synthetic Org ID & E.164
  const synthOrgId = '00000000-0000-0000-0000-000000000001';
  const synthOtherOrgId = '00000000-0000-0000-0000-000000000002';
  const synthE164 = `+1999${Math.floor(1000000 + Math.random() * 9000000)}`;

  let totalTests = 0;
  let passedTests = 0;

  function assert(condition: boolean, label: string) {
    totalTests++;
    if (condition) {
      console.log(`✓ Test ${totalTests}: ${label}`);
      passedTests++;
    } else {
      console.error(`❌ Test ${totalTests} FAILED: ${label}`);
      process.exit(1);
    }
  }

  // Create synthetic payment operation
  const { data: synthPayOp, error: synthPayErr } = await (supabase as any)
    .from('billing_payment_operations')
    .insert({
      organization_id: synthOrgId,
      operation_type: 'number_purchase',
      provider: 'stripe',
      status: 'authorized',
      amount_minor: 499,
      currency: 'USD',
      idempotency_key: `synth_idemp_${Date.now()}`,
      request_fingerprint: `sha256:${'d'.repeat(64)}`,
      provider_payment_id: `pi_synth_${Date.now()}`,
    })
    .select('*')
    .single();

  assert(!synthPayErr && !!synthPayOp, 'Synthetic payment operation created in remote DB');

  // Create synthetic commercial saga in ownership_confirmed
  const { data: synthSaga, error: synthSagaErr } = await (supabase as any)
    .from('commercial_number_purchase_sagas')
    .insert({
      organization_id: synthOrgId,
      payment_operation_id: synthPayOp.id,
      phone_number_e164: synthE164,
      state: 'ownership_confirmed',
      retail_amount_minor: 499,
      currency: 'USD',
    })
    .select('*')
    .single();

  assert(!synthSagaErr && !!synthSaga, 'Synthetic saga created in ownership_confirmed state');

  // REAL POSTGRES SAGA CLAIM CONCURRENCY TEST
  console.log('\n--- 4A. REAL POSTGRES SAGA CLAIM CONCURRENCY TEST ---');
  const [sagaRes1, sagaRes2] = await Promise.all([
    (supabase as any).rpc('claim_commercial_saga_for_capture', { p_saga_id: synthSaga.id, p_organization_id: synthOrgId }),
    (supabase as any).rpc('claim_commercial_saga_for_capture', { p_saga_id: synthSaga.id, p_organization_id: synthOrgId }),
  ]);

  const sagaWinners = [sagaRes1, sagaRes2].filter((r) => !r.error && r.data);
  const sagaLosers = [sagaRes1, sagaRes2].filter((r) => r.error && r.error.code === '55001');

  assert(sagaWinners.length === 1 && sagaLosers.length === 1, 'Real Postgres concurrency: Exactly 1 winner and 1 55001 loser for saga claim');

  // Fetch updated saga state from DB
  const { data: updatedSagaDb } = await (supabase as any)
    .from('commercial_number_purchase_sagas')
    .select('*')
    .eq('id', synthSaga.id)
    .single();

  assert(updatedSagaDb.state === 'capture_pending', 'Real Postgres saga state is capture_pending');
  assert(updatedSagaDb.attempt_count === synthSaga.attempt_count + 1, 'Real Postgres attempt_count incremented exactly once');

  // REAL POSTGRES PAYMENT DISPATCH CLAIM CONCURRENCY TEST
  console.log('\n--- 4B. REAL POSTGRES PAYMENT DISPATCH CLAIM CONCURRENCY TEST ---');
  const [dispRes1, dispRes2] = await Promise.all([
    (supabase as any).rpc('claim_payment_capture_dispatch', { p_payment_op_id: synthPayOp.id, p_organization_id: synthOrgId, p_saga_id: synthSaga.id }),
    (supabase as any).rpc('claim_payment_capture_dispatch', { p_payment_op_id: synthPayOp.id, p_organization_id: synthOrgId, p_saga_id: synthSaga.id }),
  ]);

  const dispWinners = [dispRes1, dispRes2].filter((r) => !r.error && r.data);
  const dispLosers = [dispRes1, dispRes2].filter((r) => r.error && r.error.code === '55001');

  assert(dispWinners.length === 1 && dispLosers.length === 1, 'Real Postgres concurrency: Exactly 1 winner and 1 55001 loser for dispatch claim');

  // Fetch updated payment operation from DB
  const { data: updatedPayOpDb } = await (supabase as any)
    .from('billing_payment_operations')
    .select('*')
    .eq('id', synthPayOp.id)
    .single();

  assert(updatedPayOpDb.status === 'capture_pending', 'Real Postgres payment status is capture_pending');
  assert(!!updatedPayOpDb.capture_dispatch_claimed_at, 'Real Postgres capture_dispatch_claimed_at timestamp populated');
  assert(updatedPayOpDb.capture_idempotency_key === `cap_pi_${synthPayOp.id}`, 'Real Postgres capture_idempotency_key set to cap_pi_{id}');

  // IMMUTABILITY TRIGGER TEST ON REAL POSTGRES DB
  console.log('\n--- 4C. REAL POSTGRES IMMUTABILITY TRIGGER TEST ---');
  const { error: alterTimeErr } = await (supabase as any)
    .from('billing_payment_operations')
    .update({ capture_dispatch_claimed_at: new Date(Date.now() - 10000).toISOString() })
    .eq('id', synthPayOp.id);

  assert(!!alterTimeErr && alterTimeErr.code === '42883', 'Real Postgres trigger: Altering capture_dispatch_claimed_at rejected with 42883');

  const { error: clearKeyErr } = await (supabase as any)
    .from('billing_payment_operations')
    .update({ capture_idempotency_key: null })
    .eq('id', synthPayOp.id);

  assert(!!clearKeyErr && clearKeyErr.code === '42883', 'Real Postgres trigger: Clearing capture_idempotency_key rejected with 42883');

  // Permitted update works
  const { data: metaUpdatedOp, error: metaErr } = await (supabase as any)
    .from('billing_payment_operations')
    .update({ failure_message: 'Real DB permitted update' })
    .eq('id', synthPayOp.id)
    .select('*')
    .single();

  assert(!metaErr && metaUpdatedOp.failure_message === 'Real DB permitted update', 'Real Postgres permitted metadata update succeeded');

  // REAL CONFIRM-CAPTURED DATABASE TEST
  console.log('\n--- 4D. REAL POSTGRES CONFIRM-CAPTURED TEST ---');
  const { data: confirmedOpDb, error: confirmErr } = await (supabase as any).rpc('confirm_payment_captured', {
    p_payment_op_id: synthPayOp.id,
    p_organization_id: synthOrgId,
    p_provider_payment_id: synthPayOp.provider_payment_id,
  });

  assert(!confirmErr && !!confirmedOpDb && confirmedOpDb.status === 'captured', 'Real Postgres confirm_payment_captured updated status to captured');

  // Idempotent re-confirmation
  const { data: reConfirmedOpDb } = await (supabase as any).rpc('confirm_payment_captured', {
    p_payment_op_id: synthPayOp.id,
    p_organization_id: synthOrgId,
    p_provider_payment_id: synthPayOp.provider_payment_id,
  });

  assert(reConfirmedOpDb.status === 'captured', 'Real Postgres confirm_payment_captured returned idempotently');

  // Mismatched provider ID rejected
  const { error: mismatchErr } = await (supabase as any).rpc('confirm_payment_captured', {
    p_payment_op_id: synthPayOp.id,
    p_organization_id: synthOrgId,
    p_provider_payment_id: 'pi_wrong_provider_id',
  });

  assert(!!mismatchErr && mismatchErr.code === '42883', 'Real Postgres confirm_payment_captured rejected mismatched provider payment ID');

  // REAL SAGA COMPLETION DATABASE TEST
  console.log('\n--- 4E. REAL POSTGRES SAGA COMPLETION TEST ---');
  const { data: completedSagaDb, error: completeErr } = await (supabase as any).rpc('complete_commercial_saga_after_capture', {
    p_saga_id: synthSaga.id,
    p_organization_id: synthOrgId,
  });

  assert(!completeErr && !!completedSagaDb && completedSagaDb.state === 'completed', 'Real Postgres complete_commercial_saga_after_capture updated state to completed');
  assert(!!completedSagaDb.completed_at, 'Real Postgres completed_at timestamp set atomically');

  // Idempotent re-completion
  const { data: reCompletedSagaDb } = await (supabase as any).rpc('complete_commercial_saga_after_capture', {
    p_saga_id: synthSaga.id,
    p_organization_id: synthOrgId,
  });

  assert(reCompletedSagaDb.state === 'completed', 'Real Postgres complete_commercial_saga_after_capture returned idempotently');

  // TENANT ISOLATION & INVALID STATE TESTS
  console.log('\n--- 4F. TENANT ISOLATION & INVALID STATE TESTS ---');
  const { error: wrongOrgSagaErr } = await (supabase as any).rpc('complete_commercial_saga_after_capture', {
    p_saga_id: synthSaga.id,
    p_organization_id: synthOtherOrgId,
  });
  assert(!!wrongOrgSagaErr && wrongOrgSagaErr.code === '42501', 'Real Postgres TENANT_MISMATCH rejected with 42501');

  // STEP 5: CLEAN UP SYNTHETIC TEST DATA
  console.log('\n--- STEP 5: CLEANING UP SYNTHETIC TEST DATA ---');
  await (supabase as any).from('commercial_number_purchase_sagas').delete().eq('id', synthSaga.id);
  await (supabase as any).from('billing_payment_operations').delete().eq('id', synthPayOp.id);

  // Verify zero synthetic records remain
  const { data: sagaCheck } = await (supabase as any).from('commercial_number_purchase_sagas').select('id').eq('id', synthSaga.id);
  const { data: payCheck } = await (supabase as any).from('billing_payment_operations').select('id').eq('id', synthPayOp.id);

  assert((sagaCheck?.length ?? 0) === 0 && (payCheck?.length ?? 0) === 0, 'Synthetic test records cleaned up cleanly (0 remaining)');

  console.log('\n====================================================');
  console.log(`REAL DB VERIFICATION COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
  console.log('====================================================');
}

runRemoteDeploymentAndVerification().catch((err) => {
  console.error('Fatal error during remote deployment and verification:', err);
  process.exit(1);
});
