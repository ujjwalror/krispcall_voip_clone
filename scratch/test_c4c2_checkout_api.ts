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

async function runC4C4Tests() {
  console.log('================================================================');
  console.log('PHASE 13.4.3C.4C.4 — PRE-STRIPE CONTRACT REMEDIATION TESTS');
  console.log('================================================================\n');

  const testOrgId = '00000000-0000-0000-0000-000000000001';
  const testUserId = '00000000-0000-0000-0000-000000000099';

  // TEST 1: Strict Attempt Token Validation (UUID v4 Only!)
  console.log('--- TEST 1: Strict UUID Attempt Token Validation ---');

  // Loose 8-char token -> REJECTED
  const resLoose = await CreditTopupService.createOrRecoverCheckoutSession(adminSupabase, {
    organizationId: testOrgId,
    userId: testUserId,
    attemptToken: 'short123',
    amountMinor: 2000,
  });
  assert.strictEqual(resLoose.success, false);
  assert.strictEqual(resLoose.error?.code, 'INVALID_ATTEMPT_TOKEN');

  // Arbitrary alphanumeric non-UUID -> REJECTED
  const resAlpha = await CreditTopupService.createOrRecoverCheckoutSession(adminSupabase, {
    organizationId: testOrgId,
    userId: testUserId,
    attemptToken: 'not_a_uuid_v4_attempt_token_string_12345',
    amountMinor: 2000,
  });
  assert.strictEqual(resAlpha.success, false);
  assert.strictEqual(resAlpha.error?.code, 'INVALID_ATTEMPT_TOKEN');

  // Valid RFC UUID v4 -> ACCEPTED
  const validUUID = 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d';
  const mockStripe = createMockStripeClient();
  const resValid = await CreditTopupService.createOrRecoverCheckoutSession(
    adminSupabase,
    {
      organizationId: testOrgId,
      userId: testUserId,
      attemptToken: validUUID,
      amountMinor: 2000,
    },
    { stripeOverride: mockStripe }
  );

  assert.strictEqual(resValid.success, true);
  assert.strictEqual(typeof resValid.paymentOperationId, 'string');
  console.log('✓ TEST 1 PASS: Loose tokens rejected; strict UUID v4 required and accepted.');

  // TEST 2: Authoritative Wallet Currency Resolution (No Silent USD Fallback!)
  console.log('\n--- TEST 2: Authoritative Wallet Currency Resolution ---');

  // Test Org with 0 ledger rows & 0 resource rows -> Fails closed with CURRENCY_UNAVAILABLE
  const emptyOrgId = '00000000-0000-0000-0000-000000000099';
  const resEmpty = await CreditTopupService.createOrRecoverCheckoutSession(
    adminSupabase,
    {
      organizationId: emptyOrgId,
      userId: testUserId,
      attemptToken: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      amountMinor: 2000,
    },
    { stripeOverride: mockStripe }
  );

  assert.strictEqual(resEmpty.success, false);
  assert.strictEqual(resEmpty.error?.code, 'CURRENCY_UNAVAILABLE');
  assert.strictEqual(resEmpty.error?.message.includes('No authoritative wallet currency'), true);
  console.log('✓ TEST 2 PASS: Organization with no ledger/resource history fails closed without silent USD fallback.');

  // Clean up temporary test payment op row created in TEST 1
  if (resValid.paymentOperationId) {
    await adminSupabase.from('billing_payment_operations').delete().eq('id', resValid.paymentOperationId);
  }
  console.log('\n✓ Cleaned up test payment operation rows.');

  console.log('\n================================================================');
  console.log('ALL PHASE 13.4.3C.4C.4 REMEDIATION TESTS PASSED');
  console.log('================================================================\n');
}

runC4C4Tests().catch((err) => {
  console.error('C.4C.4 Remediation Test Suite Failed:', err);
  process.exit(1);
});
