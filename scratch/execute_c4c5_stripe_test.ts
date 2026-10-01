import assert from 'assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

(globalThis as any).WebSocket = class {};

import { createClient } from '@supabase/supabase-js';
import { CreditTopupService } from '../src/lib/billing/creditTopupService';
import { getStripeClient } from '../src/lib/billing/providers/stripe/stripeClient';

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

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
if (!stripeSecretKey || !stripeSecretKey.startsWith('sk_test_')) {
  console.error('PREFLIGHT FAIL: STRIPE_SECRET_KEY must be a valid test key starting with sk_test_');
  process.exit(1);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY!;
const adminSupabase = createClient(supabaseUrl, supabaseSecretKey, { auth: { persistSession: false } });
const stripe = getStripeClient();

async function runC4C5ControlledStripeTest() {
  console.log('================================================================');
  console.log('PHASE 13.4.3C.4C.5 — CONTROLLED STRIPE TEST-MODE PAYMENT CREATION');
  console.log('================================================================\n');

  console.log('STRIPE_MODE = test');

  const testOrgId = '00000000-0000-0000-0000-000000000001';
  const testUserId = '00000000-0000-0000-0000-000000000099';

  // 1. Pre-test wallet and ledger state
  const { data: preWallet, error: preWalletErr } = await (adminSupabase as any).rpc(
    'get_telecom_wallet_summary_atomic',
    { p_organization_id: testOrgId }
  );
  assert.strictEqual(preWalletErr, null);
  
  const { count: preLedgerCount } = await adminSupabase
    .from('billing_credit_ledger')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', testOrgId);

  const { count: preOpCount } = await adminSupabase
    .from('billing_payment_operations')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', testOrgId);

  console.log(`PRE-TEST WALLET: funded=${preWallet.funded_balance_minor}, available=${preWallet.available_balance_minor}, currency=${preWallet.currency}`);
  console.log(`PRE-TEST LEDGER COUNT: ${preLedgerCount}`);
  console.log(`PRE-TEST OPERATION COUNT: ${preOpCount}`);

  // 2. Test Amount and Attempt Token Generation
  const testAmountMinor = 50; // lowest valid Stripe USD charge ($0.50 = 50 cents)
  const testCurrency = 'USD';
  const attemptToken = crypto.randomUUID();

  console.log(`\nTEST_AMOUNT_MINOR: ${testAmountMinor}`);
  console.log(`TEST_CURRENCY: ${testCurrency}`);
  console.log(`WHY_THIS_AMOUNT_IS_TECHNICALLY_VALID: Stripe requires a minimum charge of $0.50 (50 cents) for USD PaymentIntents.`);
  console.log(`ATTEMPT_TOKEN: ${attemptToken}`);
  console.log(`APPLICATION_PATH_EXERCISED: CreditTopupService.createOrRecoverCheckoutSession`);

  // 3. STEP 1: First Checkout Invocation (LIVE STRIPE TEST MODE MUTATION)
  console.log('\n--- STEP 1: Executing First Checkout Invocation against Stripe Test Mode ---');
  const res1 = await CreditTopupService.createOrRecoverCheckoutSession(adminSupabase, {
    organizationId: testOrgId,
    userId: testUserId,
    attemptToken,
    amountMinor: testAmountMinor,
  });

  assert.strictEqual(res1.success, true, `First checkout failed: ${res1.error?.message}`);
  assert.strictEqual(res1.reusedAttempt, false);
  assert.strictEqual(res1.currency, testCurrency);
  assert.strictEqual(res1.amountMinor, testAmountMinor);
  assert.strictEqual(typeof res1.paymentOperationId, 'string');
  assert.strictEqual(typeof res1.clientSecret, 'string');

  const opId = res1.paymentOperationId!;
  console.log(`LOCAL_PAYMENT_OPERATION_ID: ${opId}`);
  console.log(`LOCAL_OPERATION_STATUS: ${res1.paymentStatus} / ${res1.fundingStatus}`);

  // 4. STEP 2: Local Payment Operation Row Verification
  console.log('\n--- STEP 2: Verifying Local billing_payment_operations Row ---');
  const { data: opRow, error: opErr } = await (adminSupabase as any)
    .from('billing_payment_operations')
    .select('*')
    .eq('id', opId)
    .single();

  assert.strictEqual(opErr, null);
  assert.strictEqual(opRow.provider, 'stripe');
  assert.strictEqual(opRow.operation_type, 'credit_topup');
  assert.strictEqual(opRow.status, 'pending');
  assert.strictEqual(Number(opRow.amount_minor), testAmountMinor);
  assert.strictEqual(opRow.currency, testCurrency);
  assert.strictEqual(typeof opRow.provider_payment_id, 'string');

  const piId = opRow.provider_payment_id;
  console.log(`LOCAL_OPERATION_BOUND_PROVIDER_ID: ${piId}`);
  console.log(`LOCAL_OPERATION_CAPTURED: ${opRow.status === 'captured' ? 'YES' : 'NO'}`);

  // 5. STEP 3: Stripe Test-Mode Read Proofs for PaymentIntent & Customer
  console.log('\n--- STEP 3: Reading Stripe Test-Mode Objects directly from Stripe API ---');
  const stripePI = await stripe.paymentIntents.retrieve(piId);
  assert.strictEqual(stripePI.id, piId);
  assert.strictEqual(stripePI.amount, testAmountMinor);
  assert.strictEqual(stripePI.currency.toUpperCase(), testCurrency);
  assert.strictEqual(stripePI.status, 'requires_payment_method');
  assert.deepStrictEqual(stripePI.payment_method_types, ['card']);
  assert.strictEqual(stripePI.setup_future_usage || null, null);
  assert.strictEqual(stripePI.livemode, false);
  assert.strictEqual(stripePI.metadata.organization_id, testOrgId);
  assert.strictEqual(stripePI.metadata.payment_operation_id, opId);
  assert.strictEqual(stripePI.metadata.operation_type, 'credit_topup');

  const stripeCusId = typeof stripePI.customer === 'string' ? stripePI.customer : (stripePI.customer as any)?.id;
  assert.strictEqual(typeof stripeCusId, 'string');

  const stripeCus = await stripe.customers.retrieve(stripeCusId);
  assert.strictEqual(stripeCus.deleted || false, false);
  assert.strictEqual((stripeCus as any).livemode, false);

  console.log(`STRIPE_PAYMENTINTENT_ID: ${piId}`);
  console.log(`STRIPE_PAYMENTINTENT_STATUS: ${stripePI.status}`);
  console.log(`STRIPE_PAYMENTINTENT_LIVEMODE: ${stripePI.livemode}`);
  console.log(`STRIPE_CUSTOMER_ID: ${stripeCusId}`);
  console.log(`STRIPE_CUSTOMER_LIVEMODE: ${(stripeCus as any).livemode}`);

  // 6. STEP 4: Same-Attempt Retry (Idempotency Verification)
  console.log('\n--- STEP 4: Executing Same-Attempt Retry (Same attemptToken & amount) ---');
  const res2 = await CreditTopupService.createOrRecoverCheckoutSession(adminSupabase, {
    organizationId: testOrgId,
    userId: testUserId,
    attemptToken,
    amountMinor: testAmountMinor,
  });

  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.paymentOperationId, opId);
  assert.strictEqual(res2.reusedAttempt, true);

  // Check DB count of operations created for this organization
  const { count: postOpCount } = await adminSupabase
    .from('billing_payment_operations')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', testOrgId);

  assert.strictEqual(postOpCount! - preOpCount!, 1, 'Exactly ONE operation row MUST be created for the attempt');
  console.log('✓ SAME_ATTEMPT_RETRY_IDEMPOTENT: Reused identical local payment operation and Stripe PaymentIntent.');

  // 7. STEP 5: Same-Attempt Different-Amount Negative Test
  console.log('\n--- STEP 5: Executing Same-Attempt Different-Amount Negative Test ---');
  const resMismatch = await CreditTopupService.createOrRecoverCheckoutSession(adminSupabase, {
    organizationId: testOrgId,
    userId: testUserId,
    attemptToken,
    amountMinor: 1000, // different amount!
  });

  assert.strictEqual(resMismatch.success, false);
  assert.strictEqual(resMismatch.error?.code, 'ATTEMPT_PARAMETER_MISMATCH');
  console.log('✓ ATTEMPT_PARAMETER_MISMATCH: Rejected before Stripe mutation.');

  // 8. STEP 6: Invalid Attempt Token Negative Test
  console.log('\n--- STEP 6: Executing Invalid Token Negative Test ---');
  const resInvalid = await CreditTopupService.createOrRecoverCheckoutSession(adminSupabase, {
    organizationId: testOrgId,
    userId: testUserId,
    attemptToken: 'invalid_loose_token_123',
    amountMinor: testAmountMinor,
  });

  assert.strictEqual(resInvalid.success, false);
  assert.strictEqual(resInvalid.error?.code, 'INVALID_ATTEMPT_TOKEN');
  console.log('✓ INVALID_ATTEMPT_TOKEN: Rejected before Stripe mutation.');

  // 9. STEP 7: Post-Test Wallet & Ledger Safety Verification
  console.log('\n--- STEP 7: Post-Test Wallet & Ledger Safety Verification ---');
  const { data: postWallet, error: postWalletErr } = await (adminSupabase as any).rpc(
    'get_telecom_wallet_summary_atomic',
    { p_organization_id: testOrgId }
  );
  assert.strictEqual(postWalletErr, null);

  const { count: postLedgerCount } = await adminSupabase
    .from('billing_credit_ledger')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', testOrgId);

  assert.strictEqual(postWallet.funded_balance_minor, preWallet.funded_balance_minor);
  assert.strictEqual(postWallet.available_balance_minor, preWallet.available_balance_minor);
  assert.strictEqual(postWallet.active_reservations_minor, preWallet.active_reservations_minor);
  assert.strictEqual(postLedgerCount, preLedgerCount);

  console.log(`POST-TEST WALLET: funded=${postWallet.funded_balance_minor}, available=${postWallet.available_balance_minor}, currency=${postWallet.currency}`);
  console.log(`POST-TEST LEDGER COUNT: ${postLedgerCount}`);
  console.log(`✓ WALLET UNMUTATED: 0 ledger rows added, 0 financial balance changes.`);

  console.log('\n================================================================');
  console.log('CONTROLLED STRIPE TEST-MODE PAYMENT CREATION PROOF COMPLETED SUCCESSFULLY');
  console.log('================================================================\n');

  // Return non-secret summary object for reporting
  return {
    testOrgId,
    testUserId,
    attemptToken,
    testAmountMinor,
    testCurrency,
    preWallet,
    postWallet,
    preLedgerCount,
    postLedgerCount,
    opId,
    piId,
    stripeCusId,
    stripePIMode: stripePI.livemode ? 'live' : 'test',
    stripePIStatus: stripePI.status,
    stripeCusMode: (stripeCus as any).livemode ? 'live' : 'test',
    opCountDelta: postOpCount! - preOpCount!,
  };
}

runC4C5ControlledStripeTest()
  .then((summary) => {
    console.log('TEST_SUMMARY_DONE');
  })
  .catch((err) => {
    console.error('C.4C.5 Test Execution Failed:', err);
    process.exit(1);
  });
