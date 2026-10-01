import assert from 'assert';
import fs from 'fs';
import path from 'path';

(globalThis as any).WebSocket = class {};

import { createClient } from '@supabase/supabase-js';
import { CreditTopupService } from '../src/lib/billing/creditTopupService';

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
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY!;
const adminSupabase = createClient(supabaseUrl, supabaseSecretKey, { auth: { persistSession: false } });

// MOCK STRIPE CLIENT (STRIPE_API_MUTATIONS = 0!)
function createMockStripeClient(statusOverride: string = 'requires_payment_method') {
  return {
    paymentIntents: {
      create: async (params: any, options: any) => {
        const opId = params.metadata.payment_operation_id;
        return {
          id: `pi_mock_${opId.slice(0, 8)}`,
          client_secret: `pi_mock_${opId.slice(0, 8)}_secret_mock123`,
          amount: params.amount,
          currency: params.currency,
          status: statusOverride,
          customer: params.customer,
          metadata: params.metadata,
        };
      },
    },
    customers: {
      create: async (params: any, options: any) => {
        return {
          id: `cus_mock_${Date.now()}`,
        };
      },
    },
  } as any;
}

async function runC4C2Tests() {
  console.log('================================================================');
  console.log('PHASE 13.4.3C.4C.2 — SERVER CHECKOUT ENDPOINT NON-LIVE MOCK TESTS');
  console.log('================================================================\n');

  const testOrgId = '00000000-0000-0000-0000-000000000001';
  const testUserId = '00000000-0000-0000-0000-000000000099';

  // TEST 1: Technical Input Validation (Invalid Token / Amount <= 0 / Non-integer)
  console.log('--- TEST 1: Technical Request Input Validation ---');

  const res1 = await CreditTopupService.createOrRecoverCheckoutSession(adminSupabase, {
    organizationId: testOrgId,
    userId: testUserId,
    attemptToken: 'short', // Invalid!
    amountMinor: 2000,
  });
  assert.strictEqual(res1.success, false);
  assert.strictEqual(res1.error?.code, 'INVALID_ATTEMPT_TOKEN');

  const res2 = await CreditTopupService.createOrRecoverCheckoutSession(adminSupabase, {
    organizationId: testOrgId,
    userId: testUserId,
    attemptToken: 'c1b623a1-e656-4ea9-9c3e-30d15e597705',
    amountMinor: -100, // Invalid <= 0!
  });
  assert.strictEqual(res2.success, false);
  assert.strictEqual(res2.error?.code, 'INVALID_AMOUNT');
  console.log('✓ TEST 1 PASS: Technical request validation rejects invalid tokens & non-positive amounts.');

  // TEST 2: Local Operation Creation & Stripe Mock PaymentIntent Creation
  console.log('\n--- TEST 2: Local Operation Creation & Stripe Mock PaymentIntent ---');
  const attemptToken = `c1b623a1-e656-4ea9-9c3e-${Math.random().toString(36).slice(2, 14).padEnd(12, '0')}`;
  const mockStripe = createMockStripeClient();

  const res3 = await CreditTopupService.createOrRecoverCheckoutSession(
    adminSupabase,
    {
      organizationId: testOrgId,
      userId: testUserId,
      attemptToken,
      amountMinor: 2500,
    },
    { stripeOverride: mockStripe }
  );

  assert.strictEqual(res3.success, true);
  assert.strictEqual(typeof res3.paymentOperationId, 'string');
  assert.strictEqual(res3.clientSecret?.includes('secret_mock'), true);
  assert.strictEqual(res3.amountMinor, 2500);
  assert.strictEqual(res3.formattedAmount, '$25.00 USD');
  assert.strictEqual(res3.currency, 'USD');
  assert.strictEqual(res3.paymentStatus, 'requires_payment_method');
  assert.strictEqual(res3.fundingStatus, 'pending_payment');
  assert.strictEqual(res3.reusedAttempt, false);
  console.log(`✓ TEST 3 PASS: Local operation created & mocked clientSecret generated cleanly:
    - Payment Operation ID: ${res3.paymentOperationId}
    - Client Secret: ${res3.clientSecret}
    - Formatted Amount: ${res3.formattedAmount} (${res3.currency})`);

  // TEST 3: Retry Same Attempt (Idempotent Recovery)
  console.log('\n--- TEST 3: Same-Attempt Idempotent Recovery ---');
  const res4 = await CreditTopupService.createOrRecoverCheckoutSession(
    adminSupabase,
    {
      organizationId: testOrgId,
      userId: testUserId,
      attemptToken, // SAME token!
      amountMinor: 2500, // SAME amount!
    },
    { stripeOverride: mockStripe }
  );

  assert.strictEqual(res4.success, true);
  assert.strictEqual(res4.paymentOperationId, res3.paymentOperationId);
  assert.strictEqual(res4.clientSecret, res3.clientSecret);
  assert.strictEqual(res4.reusedAttempt, true);
  console.log('✓ TEST 3 PASS: Retry of same attemptToken returned identical local operation and clientSecret.');

  // TEST 4: Same Attempt Token with Parameter Mismatch (Amount/Currency Conflict)
  console.log('\n--- TEST 4: Attempt Parameter Mismatch Rejection ---');
  const res5 = await CreditTopupService.createOrRecoverCheckoutSession(
    adminSupabase,
    {
      organizationId: testOrgId,
      userId: testUserId,
      attemptToken, // SAME token!
      amountMinor: 5000, // DIFFERENT amount!
    },
    { stripeOverride: mockStripe }
  );

  assert.strictEqual(res5.success, false);
  assert.strictEqual(res5.error?.code, 'ATTEMPT_PARAMETER_MISMATCH');
  console.log('✓ TEST 4 PASS: Reusing attemptToken with a different amount correctly rejected with 409 ATTEMPT_PARAMETER_MISMATCH.');

  // TEST 5: Stripe Succeeded Status Does NOT Mark Local Operation Captured
  console.log('\n--- TEST 5: Succeeded PaymentIntent Funding Status Safety ---');
  const attemptTokenSucceeded = `d2b623a1-e656-4ea9-9c3e-${Math.random().toString(36).slice(2, 14).padEnd(12, '0')}`;
  const mockStripeSucceeded = createMockStripeClient('succeeded');

  const res6 = await CreditTopupService.createOrRecoverCheckoutSession(
    adminSupabase,
    {
      organizationId: testOrgId,
      userId: testUserId,
      attemptToken: attemptTokenSucceeded,
      amountMinor: 1000,
    },
    { stripeOverride: mockStripeSucceeded }
  );

  assert.strictEqual(res6.success, true);
  assert.strictEqual(res6.paymentStatus, 'succeeded');
  assert.strictEqual(res6.fundingStatus, 'pending_confirmation'); // MUST NOT BE 'funded'!
  console.log(`✓ TEST 5 PASS: Stripe PaymentIntent status='succeeded' correctly returned fundingStatus='pending_confirmation' without claiming wallet funding!`);

  // Clean up test operation rows
  if (res3.paymentOperationId) {
    await adminSupabase.from('billing_payment_operations').delete().eq('id', res3.paymentOperationId);
  }
  if (res6.paymentOperationId) {
    await adminSupabase.from('billing_payment_operations').delete().eq('id', res6.paymentOperationId);
  }
  console.log('\n✓ Cleaned up test payment operation rows.');

  console.log('\n================================================================');
  console.log('ALL PHASE 13.4.3C.4C.2 MOCK TESTS PASSED (1 - 5)');
  console.log('================================================================\n');
}

runC4C2Tests().catch((err) => {
  console.error('C.4C.2 Test Suite Failed:', err);
  process.exit(1);
});
