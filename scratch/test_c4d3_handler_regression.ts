import assert from 'assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

(globalThis as any).WebSocket = class {};

import { createClient } from '@supabase/supabase-js';
import { StripeWebhookHandler } from '../src/lib/billing/providers/stripe/stripeWebhookHandler';
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

function createMockPISucceededEvent(params: {
  eventId?: string;
  piId?: string;
  opId?: string;
  amountReceived?: number;
  currency?: string;
  customer?: string;
}): any {
  const eventId = params.eventId || `evt_mock_${crypto.randomUUID()}`;
  const piId = params.piId || `pi_mock_${crypto.randomUUID().slice(0, 8)}`;
  return {
    id: eventId,
    type: 'payment_intent.succeeded',
    livemode: false,
    data: {
      object: {
        id: piId,
        object: 'payment_intent',
        livemode: false,
        amount: 2000,
        amount_received: params.amountReceived !== undefined ? params.amountReceived : 2000,
        currency: params.currency || 'usd',
        customer: params.customer || 'cus_VKwvIdtSjZvgFp',
        status: 'succeeded',
        metadata: {
          payment_operation_id: params.opId || '00000000-0000-0000-0000-000000000001',
          operation_type: 'credit_topup',
          organization_id: '00000000-0000-0000-0000-000000000001',
        },
      },
    },
  };
}

async function runHandlerRegressionTests() {
  console.log('================================================================');
  console.log('PHASE 13.4.3C.4D.3 — HANDLER-LEVEL WEBHOOK REGRESSION TESTS');
  console.log('================================================================\n');

  const testOrgId = '00000000-0000-0000-0000-000000000001';

  // 1. Create temporary payment operation fixture
  const testOpId = crypto.randomUUID();
  const testPiId = `pi_mock_hnd_${testOpId.slice(0, 8)}`;
  const validFingerprint = CreditTopupService.generateFingerprint(testOrgId, 2000, 'USD', testOpId);

  const { error: opInsertErr } = await (adminSupabase as any)
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

  assert.strictEqual(opInsertErr, null, `Op insert failed: ${opInsertErr?.message}`);

  // TEST 1: Handler-Level payment_intent.succeeded Credit Top-Up Processing
  console.log('--- TEST 1: Handler-Level payment_intent.succeeded Credit Top-Up ---');
  const mockEvt1 = createMockPISucceededEvent({ opId: testOpId, piId: testPiId });
  const rawPayload1 = JSON.stringify(mockEvt1);

  const res1 = await StripeWebhookHandler.handleWebhookEvent(
    adminSupabase,
    rawPayload1,
    'mock_sig',
    { skipSignatureVerification: true }
  );

  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.duplicate, false);
  assert.strictEqual(res1.eventId, mockEvt1.id);

  // Check event record in billing_webhook_events
  const { data: webhookEventRow } = await (adminSupabase as any)
    .from('billing_webhook_events')
    .select('*')
    .eq('provider_event_id', mockEvt1.id)
    .single();

  assert.strictEqual(webhookEventRow.status, 'completed');
  assert.strictEqual(webhookEventRow.last_error, null);

  // Check payment operation updated to captured
  const { data: updatedOpRow } = await (adminSupabase as any)
    .from('billing_payment_operations')
    .select('*')
    .eq('id', testOpId)
    .single();

  assert.strictEqual(updatedOpRow.status, 'captured');
  console.log('✓ TEST 1 PASS: StripeWebhookHandler successfully dispatched payment_intent.succeeded to credit top-up funding RPC and updated status to completed.');

  // TEST 2: Handler-Level Duplicate Event Retry (Idempotency)
  console.log('\n--- TEST 2: Handler-Level Duplicate Event Retry ---');
  const res2 = await StripeWebhookHandler.handleWebhookEvent(
    adminSupabase,
    rawPayload1,
    'mock_sig',
    { skipSignatureVerification: true }
  );

  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.duplicate, true);
  console.log('✓ TEST 2 PASS: Handler suppressed duplicate event processing idempotently.');

  // TEST 3: Handler-Level Subscription Event Regression
  console.log('\n--- TEST 3: Subscription Event Handler Regression ---');
  const subEvt = {
    id: `evt_sub_${crypto.randomUUID()}`,
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_mock_nonexistent_123' } },
  };
  const res3 = await StripeWebhookHandler.handleWebhookEvent(
    adminSupabase,
    JSON.stringify(subEvt),
    'mock_sig',
    { skipSignatureVerification: true }
  );
  assert.strictEqual(res3.success, true);
  console.log('✓ TEST 3 PASS: Subscription webhook handler regression passed.');

  // TEST 4: Handler-Level Unhandled Event Regression (e.g. ping)
  console.log('\n--- TEST 4: Unhandled Event Handler Regression ---');
  const pingEvt = {
    id: `evt_ping_${crypto.randomUUID()}`,
    type: 'ping',
    data: { object: {} },
  };
  const res4 = await StripeWebhookHandler.handleWebhookEvent(
    adminSupabase,
    JSON.stringify(pingEvt),
    'mock_sig',
    { skipSignatureVerification: true }
  );
  assert.strictEqual(res4.success, true);
  assert.strictEqual(res4.duplicate, false);

  const { data: pingEventRow } = await (adminSupabase as any)
    .from('billing_webhook_events')
    .select('status')
    .eq('provider_event_id', pingEvt.id)
    .single();
  assert.strictEqual(pingEventRow.status, 'completed');
  console.log('✓ TEST 4 PASS: Unhandled ping event stored cleanly as completed.');

  // CLEANUP FIXTURES
  await adminSupabase.from('billing_payment_operations').delete().eq('id', testOpId);
  await adminSupabase.from('billing_webhook_events').delete().in('provider_event_id', [mockEvt1.id, subEvt.id, pingEvt.id]);

  // Clean up ledger grant entry created by TEST 1
  const { data: ledgerRow } = await (adminSupabase as any)
    .from('billing_credit_ledger')
    .select('id')
    .eq('reference_id', testOpId)
    .maybeSingle();

  if (ledgerRow) {
    await adminSupabase.from('billing_credit_ledger').delete().eq('id', ledgerRow.id);
  }

  console.log('\n✓ Cleaned up test operation, webhook events, and ledger fixture rows.');

  console.log('\n================================================================');
  console.log('ALL PHASE 13.4.3C.4D.3 HANDLER REGRESSION TESTS PASSED');
  console.log('================================================================\n');
}

runHandlerRegressionTests().catch((err) => {
  console.error('C.4D.3 Handler Regression Suite Failed:', err);
  process.exit(1);
});
