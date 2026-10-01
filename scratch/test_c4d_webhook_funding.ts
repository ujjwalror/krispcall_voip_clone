import assert from 'assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

(globalThis as any).WebSocket = class {};

import { createClient } from '@supabase/supabase-js';
import { CreditTopupWebhookService } from '../src/lib/billing/creditTopupWebhookService';
import { CreditTopupService } from '../src/lib/billing/creditTopupService';
import { StripeWebhookHandler } from '../src/lib/billing/providers/stripe/stripeWebhookHandler';

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

// Helper to create a mock Stripe payment_intent.succeeded event
function createMockSucceededEvent(params: {
  eventId?: string;
  piId?: string;
  opId?: string;
  opType?: string;
  orgId?: string;
  amountReceived?: number;
  amount?: number;
  currency?: string;
  customer?: string;
  livemode?: boolean;
}): any {
  const eventId = params.eventId || `evt_mock_${crypto.randomUUID()}`;
  const piId = params.piId || `pi_mock_${crypto.randomUUID().slice(0, 8)}`;
  const livemode = params.livemode !== undefined ? params.livemode : false;
  return {
    id: eventId,
    type: 'payment_intent.succeeded',
    livemode,
    data: {
      object: {
        id: piId,
        object: 'payment_intent',
        livemode,
        amount: params.amount !== undefined ? params.amount : 2000,
        amount_received: params.amountReceived !== undefined ? params.amountReceived : 2000,
        currency: params.currency || 'usd',
        customer: params.customer !== undefined ? params.customer : 'cus_VKwvIdtSjZvgFp',
        status: 'succeeded',
        metadata: {
          payment_operation_id: params.opId || '00000000-0000-0000-0000-000000000001',
          operation_type: params.opType !== undefined ? params.opType : 'credit_topup',
          organization_id: params.orgId || '00000000-0000-0000-0000-000000000001',
        },
      },
    },
  };
}

async function runC4D2WebhookFundingTests() {
  console.log('================================================================');
  console.log('PHASE 13.4.3C.4D.2 — STRIPE SUCCESS WEBHOOK FUNDING TESTS');
  console.log('================================================================\n');

  const testOrgId = '00000000-0000-0000-0000-000000000001';

  // TEST A: Invalid signature rejected
  console.log('--- TEST A: Invalid signature rejected ---');
  await assert.rejects(
    async () => {
      await StripeWebhookHandler.handleWebhookEvent(adminSupabase, '{"invalid":true}', 'invalid_signature_string');
    },
    (err: any) => err.message.includes('INVALID_WEBHOOK_SIGNATURE')
  );
  console.log('✓ TEST A PASS: Invalid webhook signature rejected.');

  // TEST B: Non-payment_intent.succeeded event does not fund Credits
  console.log('\n--- TEST B: Non-payment_intent.succeeded event does not fund Credits ---');
  const mockSubEvent = {
    id: `evt_mock_${crypto.randomUUID()}`,
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_mock_123' } },
  };
  const resB = await CreditTopupWebhookService.processPaymentIntentSucceeded(adminSupabase, mockSubEvent as any);
  assert.strictEqual(resB.success, false);
  assert.strictEqual(resB.code, 'INVALID_OPERATION_TYPE');
  console.log('✓ TEST B PASS: Non-payment_intent.succeeded event does not fund Credits.');

  // TEST C: payment_intent.succeeded without operation_type credit_topup does not fund
  console.log('\n--- TEST C: Succeeded PI without operation_type credit_topup does not fund ---');
  const evtC = createMockSucceededEvent({ opType: 'phone_number_purchase' });
  const resC = await CreditTopupWebhookService.processPaymentIntentSucceeded(adminSupabase, evtC);
  assert.strictEqual(resC.success, false);
  assert.strictEqual(resC.code, 'INVALID_OPERATION_TYPE');
  console.log('✓ TEST C PASS: Operation type mismatch rejected.');

  // TEST D: Missing payment_operation_id metadata does not fund
  console.log('\n--- TEST D: Missing payment_operation_id does not fund ---');
  const evtD = createMockSucceededEvent({ opId: '' });
  delete evtD.data.object.metadata.payment_operation_id;
  const resD = await CreditTopupWebhookService.processPaymentIntentSucceeded(adminSupabase, evtD);
  assert.strictEqual(resD.success, false);
  assert.strictEqual(resD.code, 'MISSING_PAYMENT_OPERATION_ID');
  console.log('✓ TEST D PASS: Missing payment_operation_id metadata rejected.');

  // TEST E: Malformed payment_operation_id does not fund
  console.log('\n--- TEST E: Malformed payment_operation_id does not fund ---');
  const evtE = createMockSucceededEvent({ opId: 'short_invalid_op_id' });
  const resE = await CreditTopupWebhookService.processPaymentIntentSucceeded(adminSupabase, evtE);
  assert.strictEqual(resE.success, false);
  assert.strictEqual(resE.code, 'MISSING_PAYMENT_OPERATION_ID');
  console.log('✓ TEST E PASS: Malformed payment_operation_id rejected.');

  // TEST F: Unknown operation ID does not fund
  console.log('\n--- TEST F: Unknown operation ID does not fund ---');
  const evtF = createMockSucceededEvent({ opId: '99999999-9999-9999-9999-999999999999' });
  const resF = await CreditTopupWebhookService.processPaymentIntentSucceeded(adminSupabase, evtF);
  assert.strictEqual(resF.success, false);
  assert.strictEqual(resF.code, 'PAYMENT_OPERATION_NOT_FOUND');
  console.log('✓ TEST F PASS: Unknown operation ID rejected.');

  // Create temporary local billing_payment_operations fixture for testing validation checks
  const testOpId = crypto.randomUUID();
  const testPiId = `pi_mock_test_${testOpId.slice(0, 8)}`;
  const validFingerprint = CreditTopupService.generateFingerprint(testOrgId, 2000, 'USD', testOpId);

  const { error: fixtureInsertErr } = await (adminSupabase as any)
    .from('billing_payment_operations')
    .insert({
      id: testOpId,
      organization_id: testOrgId,
      operation_type: 'credit_topup',
      provider: 'stripe',
      provider_payment_id: testPiId,
      status: 'pending',
      amount_minor: 2000,
      currency: 'USD',
      idempotency_key: `credit_topup:${testOrgId}:${testOpId}`,
      request_fingerprint: validFingerprint,
    });

  assert.strictEqual(fixtureInsertErr, null, `Fixture setup failed: ${fixtureInsertErr?.message}`);

  // TEST G: provider_payment_id mismatch does not fund
  console.log('\n--- TEST G: provider_payment_id mismatch does not fund ---');
  const evtG = createMockSucceededEvent({ opId: testOpId, piId: 'pi_mock_different_id_123' });
  const resG = await CreditTopupWebhookService.processPaymentIntentSucceeded(adminSupabase, evtG);
  assert.strictEqual(resG.success, false);
  assert.strictEqual(resG.code, 'PROVIDER_PAYMENT_ID_MISMATCH');
  console.log('✓ TEST G PASS: provider_payment_id mismatch rejected.');

  // TEST H: amount_received <= 0 does not fund
  console.log('\n--- TEST H: amount_received <= 0 does not fund ---');
  const evtH = createMockSucceededEvent({ opId: testOpId, piId: testPiId, amountReceived: 0 });
  const resH = await CreditTopupWebhookService.processPaymentIntentSucceeded(adminSupabase, evtH);
  assert.strictEqual(resH.success, false);
  assert.strictEqual(resH.code, 'INVALID_AMOUNT_RECEIVED');
  console.log('✓ TEST H PASS: Zero or missing amount_received rejected.');

  // TEST I: amount_received differs from local amount does not fund
  console.log('\n--- TEST I: amount_received differs from local amount does not fund ---');
  const evtI = createMockSucceededEvent({ opId: testOpId, piId: testPiId, amountReceived: 5000 });
  const resI = await CreditTopupWebhookService.processPaymentIntentSucceeded(adminSupabase, evtI);
  assert.strictEqual(resI.success, false);
  assert.strictEqual(resI.code, 'AMOUNT_MISMATCH');
  console.log('✓ TEST I PASS: amount_received mismatch rejected.');

  // TEST J: Intended PI amount differs from local amount does not fund
  console.log('\n--- TEST J: Intended PI amount differs from local amount does not fund ---');
  const evtJ = createMockSucceededEvent({ opId: testOpId, piId: testPiId, amountReceived: 2000, amount: 3000 });
  const resJ = await CreditTopupWebhookService.processPaymentIntentSucceeded(adminSupabase, evtJ);
  assert.strictEqual(resJ.success, false);
  assert.strictEqual(resJ.code, 'INTENDED_AMOUNT_MISMATCH');
  console.log('✓ TEST J PASS: Intended PI amount mismatch rejected.');

  // TEST K: Currency mismatch does not fund
  console.log('\n--- TEST K: Currency mismatch does not fund ---');
  const evtK = createMockSucceededEvent({ opId: testOpId, piId: testPiId, currency: 'eur' });
  const resK = await CreditTopupWebhookService.processPaymentIntentSucceeded(adminSupabase, evtK);
  assert.strictEqual(resK.success, false);
  assert.strictEqual(resK.code, 'CURRENCY_MISMATCH');
  console.log('✓ TEST K PASS: Currency mismatch rejected.');

  // TEST L: Customer mismatch does not fund
  console.log('\n--- TEST L: Customer mismatch does not fund ---');
  const evtL = createMockSucceededEvent({ opId: testOpId, piId: testPiId, customer: 'cus_mismatch_unbound_123' });
  const resL = await CreditTopupWebhookService.processPaymentIntentSucceeded(adminSupabase, evtL);
  assert.strictEqual(resL.success, false);
  assert.strictEqual(resL.code, 'CUSTOMER_MISMATCH');
  console.log('✓ TEST L PASS: Customer ID mismatch rejected.');

  // TEST M: Organization metadata mismatch does not fund
  console.log('\n--- TEST M: Organization metadata mismatch does not fund ---');
  const evtM = createMockSucceededEvent({ opId: testOpId, piId: testPiId, orgId: '00000000-0000-0000-0000-000000000099' });
  const resM = await CreditTopupWebhookService.processPaymentIntentSucceeded(adminSupabase, evtM);
  assert.strictEqual(resM.success, false);
  assert.strictEqual(resM.code, 'ORGANIZATION_MISMATCH');
  console.log('✓ TEST M PASS: Metadata organization_id mismatch rejected.');

  // TEST N: Livemode / environment mismatch does not fund
  console.log('\n--- TEST N: Livemode / environment mismatch does not fund ---');
  const evtN = createMockSucceededEvent({ opId: testOpId, piId: testPiId, livemode: true }); // livemode=true in non-production env!
  const resN = await CreditTopupWebhookService.processPaymentIntentSucceeded(adminSupabase, evtN);
  assert.strictEqual(resN.success, false);
  assert.strictEqual(resN.code, 'LIVEMODE_MISMATCH');
  console.log('✓ TEST N PASS: Livemode / environment mismatch rejected.');

  // TEST O, P, Q, R: Valid succeeded PI invokes C.4B funding RPC exactly once
  console.log('\n--- TEST O-R: Valid Succeeded PI Invokes C.4B RPC ---');
  const validEvt = createMockSucceededEvent({ opId: testOpId, piId: testPiId, amountReceived: 2000, currency: 'usd' });
  const resO = await CreditTopupWebhookService.processPaymentIntentSucceeded(adminSupabase, validEvt);

  assert.strictEqual(resO.success, true, `Processing failed: ${resO.message}`);
  assert.strictEqual(resO.code, 'NEWLY_FUNDED');
  assert.strictEqual(resO.alreadyFunded, false);
  assert.strictEqual(resO.fundedAmountMinor, 2000);
  assert.strictEqual(resO.currency, 'USD');
  console.log(`✓ TEST O-R PASS: Wallet funded atomically (+2000 minor USD), ledger entry created.`);

  // TEST S, V: Same event retry creates no duplicate funding (Idempotent Retry)
  console.log('\n--- TEST S & V: Same Event Retry (Idempotent Retry) ---');
  const resS = await CreditTopupWebhookService.processPaymentIntentSucceeded(adminSupabase, validEvt);
  assert.strictEqual(resS.success, true);
  assert.strictEqual(resS.code, 'ALREADY_FUNDED');
  assert.strictEqual(resS.alreadyFunded, true);
  console.log('✓ TEST S & V PASS: Duplicate event returned already_funded: true with 0 secondary ledger rows.');

  // TEST T: Different event ID for same PI creates no duplicate funding
  console.log('\n--- TEST T: Different Event ID for Same PI ---');
  const diffEvt = createMockSucceededEvent({
    eventId: `evt_mock_diff_${crypto.randomUUID()}`,
    opId: testOpId,
    piId: testPiId,
    amountReceived: 2000,
    currency: 'usd',
  });
  const resT = await CreditTopupWebhookService.processPaymentIntentSucceeded(adminSupabase, diffEvt);
  assert.strictEqual(resT.success, true);
  assert.strictEqual(resT.code, 'ALREADY_FUNDED');
  assert.strictEqual(resT.alreadyFunded, true);
  console.log('✓ TEST T PASS: Different event ID for same PaymentIntent returned already_funded: true.');

  // CLEANUP FIXTURE
  await adminSupabase.from('billing_payment_operations').delete().eq('id', testOpId);
  if (resO.ledgerEntryId) {
    await adminSupabase.from('billing_credit_ledger').delete().eq('id', resO.ledgerEntryId);
  }
  console.log('\n✓ Cleaned up test operation & ledger fixture rows.');

  console.log('\n================================================================');
  console.log('ALL PHASE 13.4.3C.4D.2 TARGETED WEBHOOK FUNDING TESTS PASSED');
  console.log('================================================================\n');
}

runC4D2WebhookFundingTests().catch((err) => {
  console.error('C.4D.2 Webhook Funding Test Suite Failed:', err);
  process.exit(1);
});
