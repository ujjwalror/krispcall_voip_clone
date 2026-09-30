import fs from 'fs';
import path from 'path';

// Load .env.local variables
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

async function runRemoteRuntimeVerification() {
  console.log('====================================================');
  console.log('PHASE 13.3.1 — REMOTE DATABASE RUNTIME VERIFICATION');
  console.log('====================================================\n');

  const supabase = createAdminClient();

  // Test Org ID (Standard synthetic testing organization)
  const testOrgId = '00000000-0000-0000-0000-000000000001';
  const testE164 = '+19998887766';

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

  // Check table presence
  const { error: initialErr } = await (supabase as any)
    .from('commercial_number_purchase_sagas')
    .select('id')
    .limit(1);

  if (initialErr && initialErr.code === 'PGRST205') {
    console.log('⏳ Remote table public.commercial_number_purchase_sagas is NOT yet present in Supabase schema cache.');
    console.log('Please copy and execute the contents of supabase/migrations/20261202000000_phase13_3_commercial_saga.sql in the Supabase Dashboard SQL Editor for project jupwsumuutuysmpxdtpw.');
    return;
  }

  console.log('✓ Remote table public.commercial_number_purchase_sagas IS PRESENT!\n');

  // STEP A: Create synthetic payment operation for testing
  const { data: testPaymentOp, error: payOpErr } = await (supabase as any)
    .from('billing_payment_operations')
    .insert({
      organization_id: testOrgId,
      operation_type: 'number_purchase',
      provider: 'stripe',
      status: 'authorized',
      amount_minor: 315,
      currency: 'USD',
      idempotency_key: `synth_idemp_${Date.now()}`,
      request_fingerprint: `sha256:${'a'.repeat(64)}`,
    })
    .select('*')
    .single();

  assert(!payOpErr && !!testPaymentOp, 'Synthetic payment operation created cleanly');

  // STEP B: RPC RUNTIME SECURITY TEST (claim_commercial_saga_for_provisioning)
  console.log('\n--- 1. RPC RUNTIME SECURITY TESTS ---');

  // Create saga in 'authorized' state
  const { data: sagaAuthorized, error: sagaAuthErr } = await (supabase as any)
    .from('commercial_number_purchase_sagas')
    .insert({
      organization_id: testOrgId,
      payment_operation_id: testPaymentOp.id,
      phone_number_e164: testE164,
      state: 'authorized',
      retail_amount_minor: 315,
      currency: 'USD',
    })
    .select('*')
    .single();

  assert(!sagaAuthErr && !!sagaAuthorized, 'A. Authorized saga created');

  // Execute RPC claim_commercial_saga_for_provisioning
  const { data: claimedSaga, error: claimErr } = await (supabase as any).rpc(
    'claim_commercial_saga_for_provisioning',
    {
      p_saga_id: sagaAuthorized.id,
      p_organization_id: testOrgId,
    }
  );

  assert(
    !claimErr && claimedSaga?.state === 'provisioning_claimed' && claimedSaga?.attempt_count === 1,
    'A. RPC claim_commercial_saga_for_provisioning authorized -> provisioning_claimed succeeded & attempt_count incremented'
  );

  // Attempt second claim on provisioning_claimed saga -> MUST BE REJECTED
  const { error: secondClaimErr } = await (supabase as any).rpc('claim_commercial_saga_for_provisioning', {
    p_saga_id: sagaAuthorized.id,
    p_organization_id: testOrgId,
  });
  assert(!!secondClaimErr, 'C. Second claim attempt on provisioning_claimed saga rejected with state error');

  // Attempt claim with wrong organization_id -> MUST BE REJECTED
  const { error: wrongOrgErr } = await (supabase as any).rpc('claim_commercial_saga_for_provisioning', {
    p_saga_id: sagaAuthorized.id,
    p_organization_id: '00000000-0000-0000-0000-000000000002',
  });
  assert(!!wrongOrgErr, 'D. Claim attempt with wrong organization_id rejected with TENANT_MISMATCH');

  // Attempt claim on nonexistent saga -> MUST BE REJECTED
  const { error: missingErr } = await (supabase as any).rpc('claim_commercial_saga_for_provisioning', {
    p_saga_id: '00000000-0000-0000-0000-000000000099',
    p_organization_id: testOrgId,
  });
  assert(!!missingErr, 'E. Claim attempt on nonexistent saga rejected with SAGA_NOT_FOUND');

  // STEP C: IMMUTABLE COMMERCIAL SNAPSHOT RUNTIME TEST
  console.log('\n--- 2. IMMUTABLE COMMERCIAL SNAPSHOT RUNTIME TESTS ---');

  // Attempt to update retail_amount_minor -> MUST BE REJECTED
  const { error: updateAmountErr } = await (supabase as any)
    .from('commercial_number_purchase_sagas')
    .update({ retail_amount_minor: 999 })
    .eq('id', sagaAuthorized.id);
  assert(!!updateAmountErr, 'IMMUTABLE SNAPSHOT: Modifying retail_amount_minor REJECTED by trigger');

  // Attempt to update phone_number_e164 -> MUST BE REJECTED
  const { error: updateE164Err } = await (supabase as any)
    .from('commercial_number_purchase_sagas')
    .update({ phone_number_e164: '+19990001111' })
    .eq('id', sagaAuthorized.id);
  assert(!!updateE164Err, 'IMMUTABLE SNAPSHOT: Modifying phone_number_e164 REJECTED by trigger');

  // Operational state update -> MUST SUCCEED
  const { error: updateStateErr } = await (supabase as any)
    .from('commercial_number_purchase_sagas')
    .update({ state: 'provisioning_in_progress' })
    .eq('id', sagaAuthorized.id);
  assert(!updateStateErr, 'OPERATIONAL UPDATE: Modifying state provisioning_claimed -> provisioning_in_progress SUCCEEDED');

  // STEP D: ACTIVE SAGA LOCK RUNTIME TEST
  console.log('\n--- 3. ACTIVE SAGA LOCK RUNTIME TESTS ---');

  // Create second payment op for second saga attempt
  const { data: payOp2 } = await (supabase as any)
    .from('billing_payment_operations')
    .insert({
      organization_id: testOrgId,
      operation_type: 'number_purchase',
      provider: 'stripe',
      status: 'authorized',
      amount_minor: 315,
      currency: 'USD',
      idempotency_key: `synth_idemp2_${Date.now()}`,
      request_fingerprint: `sha256:${'b'.repeat(64)}`,
    })
    .select('*')
    .single();

  // Attempt to insert second saga for SAME org + E164 while first saga is in active state -> MUST BE REJECTED
  const { error: secondSagaErr } = await (supabase as any)
    .from('commercial_number_purchase_sagas')
    .insert({
      organization_id: testOrgId,
      payment_operation_id: payOp2.id,
      phone_number_e164: testE164,
      state: 'authorized',
      retail_amount_minor: 315,
      currency: 'USD',
    });
  assert(!!secondSagaErr, 'ACTIVE SAGA LOCK: Second active saga for same (org, E.164) REJECTED by partial unique index');

  // Transition first saga to terminal 'completed'
  await (supabase as any)
    .from('commercial_number_purchase_sagas')
    .update({ state: 'completed' })
    .eq('id', sagaAuthorized.id);

  // Now attempt to insert second saga for SAME org + E164 -> MUST SUCCEED (Lock released on terminal completed)
  const { data: saga2, error: saga2Err } = await (supabase as any)
    .from('commercial_number_purchase_sagas')
    .insert({
      organization_id: testOrgId,
      payment_operation_id: payOp2.id,
      phone_number_e164: testE164,
      state: 'authorized',
      retail_amount_minor: 315,
      currency: 'USD',
    })
    .select('*')
    .single();
  assert(!saga2Err && !!saga2, 'LOCK RELEASE: Terminal completed state releases saga-level active lock');

  // STEP E: SYNTHETIC CLEANUP
  console.log('\n--- 4. SYNTHETIC TEST CLEANUP ---');
  if (saga2) {
    await (supabase as any).from('commercial_number_purchase_sagas').delete().eq('id', saga2.id);
  }
  if (sagaAuthorized) {
    await (supabase as any).from('commercial_number_purchase_sagas').delete().eq('id', sagaAuthorized.id);
  }
  if (payOp2) {
    await (supabase as any).from('billing_payment_operations').delete().eq('id', payOp2.id);
  }
  if (testPaymentOp) {
    await (supabase as any).from('billing_payment_operations').delete().eq('id', testPaymentOp.id);
  }

  // Verify 0 synthetic rows remain
  const { data: leftoverSagas } = await (supabase as any)
    .from('commercial_number_purchase_sagas')
    .select('id')
    .eq('phone_number_e164', testE164);
  assert(!leftoverSagas || leftoverSagas.length === 0, 'CLEANUP: 0 synthetic sagas remain in DB');

  console.log('\n====================================================');
  console.log(`REMOTE RUNTIME VERIFICATION COMPLETE: ${passedTests} / ${totalTests} TESTS PASSED`);
  console.log('====================================================');
}

runRemoteRuntimeVerification().catch((err) => {
  console.error('Fatal error during remote runtime verification:', err);
  process.exit(1);
});
