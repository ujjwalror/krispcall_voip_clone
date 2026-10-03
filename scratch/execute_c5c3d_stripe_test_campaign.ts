import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { CreditAutoTopupService } from '../src/lib/billing/creditAutoTopupService';
import { CreditAutoTopupExecutionService } from '../src/lib/billing/creditAutoTopupExecutionService';
import { CreditTopupWebhookService } from '../src/lib/billing/creditTopupWebhookService';
import { ProviderCredentialRegistry } from '../src/lib/billing/providers/stripe/providerCredentialRegistry';
import { StripeClientFactory } from '../src/lib/billing/providers/stripe/stripeClientFactory';

(globalThis as any).WebSocket = class {};

const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of envContent.split('\n')) {
    const line = rawLine.trim();
    if (line && !line.startsWith('#') && line.includes('=')) {
      const idx = line.indexOf('=');
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function runControlledStripeTestCampaign() {
  console.log('================================================================');
  console.log('PHASE 13.4.3C STAGE C.5C.3D — CONTROLLED STRIPE TEST CAMPAIGN');
  console.log('================================================================\n');

  const targetOrgId = '00000000-0000-0000-0000-000000000001';

  // --- STAGE 1: PRE-FLIGHT ---
  console.log('--- STAGE 1: PRE-FLIGHT CHECK ---');
  const startingSpendable = await CreditAutoTopupService.getSpendableCreditBalanceMinor(supabase, targetOrgId);
  console.log(`Starting Spendable Balance: ${startingSpendable} minor USD ($${(startingSpendable / 100).toFixed(2)})`);
  assert.strictEqual(startingSpendable, 50200, 'Pre-flight starting spendable balance must be 50200');

  const { data: settingsRow } = await (supabase as any)
    .from('billing_auto_topup_settings')
    .select('*')
    .eq('organization_id', targetOrgId)
    .single();

  console.log(`Auto Top-Up Status      : ${settingsRow.status}`);
  console.log(`Threshold State         : ${settingsRow.threshold_state}`);
  console.log(`Provider Account ID     : ${settingsRow.provider_account_id}`);
  console.log(`Provider Customer ID    : ${settingsRow.provider_customer_id}`);
  console.log(`Provider Payment Method : ${settingsRow.provider_payment_method_id}`);

  assert.strictEqual(settingsRow.status, 'enabled');
  assert.strictEqual(settingsRow.threshold_state, 'ARMED');
  assert(settingsRow.provider_account_id != null);
  assert(settingsRow.provider_customer_id != null);
  assert(settingsRow.provider_payment_method_id != null);

  const env = ProviderCredentialRegistry.resolveServerRuntimeEnvironment();
  const stripe = await StripeClientFactory.getClientForAccount(supabase, settingsRow.provider_account_id);
  console.log('✓ Stripe TEST client successfully initialized for provider account.');

  // Temporarily set threshold_minor = 60000 in settings so 50200 spendable < 60000 threshold allows authorization check to pass cleanly for the controlled test
  await (supabase as any)
    .from('billing_auto_topup_settings')
    .update({ threshold_minor: 60000 })
    .eq('organization_id', targetOrgId);

  // --- STAGE 2: CONTROLLED TRIGGER CLAIM & AUTHORIZATION ---
  console.log('\n--- STAGE 2: CONTROLLED TRIGGER CLAIM & PROVIDER AUTHORIZATION ---');

  const attemptToken = 'f9c24229-4f30-4fda-8480-031f69824391';
  const triggerId = '66666666-6666-4666-a666-666666666666';
  const idempotencyKey = `atu_pi_${triggerId}`;

  // Clean any previous test trigger with this ID
  await supabase.from('billing_payment_operations').delete().eq('organization_id', targetOrgId).filter('metadata->>auto_topup_trigger_id', 'eq', triggerId);
  await supabase.from('billing_auto_topup_triggers').delete().eq('id', triggerId);

  // Insert controlled trigger in claimed status
  const { data: insertedTrigger, error: trigErr } = await (supabase as any)
    .from('billing_auto_topup_triggers')
    .insert({
      id: triggerId,
      organization_id: targetOrgId,
      attempt_token: attemptToken,
      trigger_balance_minor: 50200,
      threshold_minor: 60000,
      recharge_amount_minor: 2500,
      status: 'claimed',
      configuration_generation_snapshot: settingsRow.configuration_generation,
      payment_authorization_generation_snapshot: settingsRow.payment_authorization_generation,
      threshold_minor_snapshot: 60000,
      recharge_amount_minor_snapshot: 2500,
      currency_snapshot: 'USD',
      provider_account_id_snapshot: settingsRow.provider_account_id,
      provider_customer_id_snapshot: settingsRow.provider_customer_id,
      provider_payment_method_id_snapshot: settingsRow.provider_payment_method_id,
      provider_idempotency_key: idempotencyKey,
      lease_owner: 'controlled_test_harness',
      lease_expires_at: new Date(Date.now() + 900000).toISOString(),
      attempt_count: 1,
    })
    .select('*')
    .single();

  if (trigErr) {
    console.error('Trigger insert error:', trigErr.message);
    process.exit(1);
  }

  console.log(`✓ Created controlled trigger: ${insertedTrigger.id}`);

  // Authorize provider mutation atomically
  const authRes = await CreditAutoTopupService.authorizeAutoTopupProviderMutationAtomic(supabase, targetOrgId, triggerId);
  console.log('✓ Provider Mutation Authorization Result:', authRes);
  assert.strictEqual(authRes.success, true);
  assert.strictEqual(authRes.already_authorized, false);
  const paymentOpId = authRes.payment_operation_id;
  console.log(`✓ Linked Payment Operation ID: ${paymentOpId}`);

  // --- STAGE 3: EXECUTE PROVIDER MUTATION AGAINST STRIPE TEST API ---
  console.log('\n--- STAGE 3: EXECUTE STRIPE TEST OFF-SESSION PAYMENTINTENT ---');

  const execRes = await CreditAutoTopupExecutionService.executeAuthorizedTrigger(supabase, targetOrgId, triggerId);
  console.log('✓ Execution Result:', execRes);
  assert.strictEqual(execRes.success, true);
  assert.strictEqual(execRes.status, 'funded');
  assert(execRes.paymentIntentId != null && execRes.paymentIntentId.startsWith('pi_'));

  const piId = execRes.paymentIntentId;
  const retrievedPi = await stripe.paymentIntents.retrieve(piId);
  const chargeId = typeof retrievedPi.latest_charge === 'string' ? retrievedPi.latest_charge : (retrievedPi.latest_charge as any)?.id;

  console.log(`✓ Stripe TEST PaymentIntent ID: ${piId}`);
  console.log(`✓ Stripe TEST Charge ID       : ${chargeId}`);
  console.log(`✓ Stripe Status              : ${retrievedPi.status}`);
  console.log(`✓ Amount Received            : ${retrievedPi.amount_received} minor USD ($${(retrievedPi.amount_received / 100).toFixed(2)})`);

  // --- STAGE 4: ACCOUNTING & FUNDING VERIFICATION ---
  console.log('\n--- STAGE 4: AUTHORITATIVE ACCOUNTING VERIFICATION ---');

  const postFundSpendable = await CreditAutoTopupService.getSpendableCreditBalanceMinor(supabase, targetOrgId);
  console.log(`Post-Funding Spendable Balance: ${postFundSpendable} minor USD ($${(postFundSpendable / 100).toFixed(2)})`);
  assert.strictEqual(postFundSpendable, 52700, 'Spendable balance must increase by exact recharge amount (+2500) to 52700');

  // Verify grants in credit ledger
  const { data: grants } = await (supabase as any)
    .from('billing_credit_ledger')
    .select('*')
    .eq('reference_type', 'payment_operation')
    .eq('reference_id', paymentOpId);

  console.log(`Funding Grants Created for Operation: ${grants?.length || 0}`);
  assert.strictEqual(grants?.length || 0, 1, 'Exactly 1 credit ledger grant must exist');
  assert.strictEqual(Number(grants[0].delta_minor), 2500, 'Grant delta must be +2500');

  // Restore threshold_minor to 1000 in settings
  await (supabase as any)
    .from('billing_auto_topup_settings')
    .update({ threshold_minor: 1000 })
    .eq('organization_id', targetOrgId);

  // --- STAGE 5: DUPLICATE EXECUTION IDEMPOTENCY TEST ---
  console.log('\n--- STAGE 5: DUPLICATE WORKER EXECUTION IDEMPOTENCY ---');
  const dupExecRes = await CreditAutoTopupExecutionService.executeAuthorizedTrigger(supabase, targetOrgId, triggerId);
  console.log('✓ Duplicate Execution Result:', dupExecRes);
  assert.strictEqual(dupExecRes.success, true);
  assert.strictEqual(dupExecRes.alreadyFunded, true);

  const postDupSpendable = await CreditAutoTopupService.getSpendableCreditBalanceMinor(supabase, targetOrgId);
  assert.strictEqual(postDupSpendable, 52700, 'Duplicate execution must NOT grant additional credits');

  // --- STAGE 6: DUPLICATE WEBHOOK IDEMPOTENCY TEST ---
  console.log('\n--- STAGE 6: DUPLICATE WEBHOOK IDEMPOTENCY ---');
  const syntheticEvent: Stripe.Event = {
    id: `evt_test_dup_${piId}`,
    object: 'event',
    api_version: '2023-10-16',
    created: Math.floor(Date.now() / 1000),
    type: 'payment_intent.succeeded',
    data: { object: retrievedPi },
    livemode: false,
    pending_webhooks: 0,
    request: null,
  };

  const dupWebhookRes = await CreditTopupWebhookService.processPaymentIntentSucceeded(supabase, syntheticEvent, {
    providerAccountId: settingsRow.provider_account_id,
  });
  console.log('✓ Duplicate Webhook Result:', dupWebhookRes);
  assert.strictEqual(dupWebhookRes.alreadyFunded, true);

  const postWebSpendable = await CreditAutoTopupService.getSpendableCreditBalanceMinor(supabase, targetOrgId);
  assert.strictEqual(postWebSpendable, 52700, 'Duplicate webhook must NOT grant additional credits');

  // --- STAGE 7: DEFINITIVE CARD DECLINE TEST ---
  console.log('\n--- STAGE 7: DEFINITIVE CARD DECLINE SCENARIO ---');
  const declineTriggerId = '77777777-7777-4777-a777-777777777777';
  const declineIdempotencyKey = `atu_pi_${declineTriggerId}`;

  await supabase.from('billing_payment_operations').delete().eq('organization_id', targetOrgId).filter('metadata->>auto_topup_trigger_id', 'eq', declineTriggerId);
  await supabase.from('billing_auto_topup_triggers').delete().eq('id', declineTriggerId);

  // Set threshold to 60000 temporarily for decline test authorization
  await (supabase as any).from('billing_auto_topup_settings').update({ threshold_minor: 60000 }).eq('organization_id', targetOrgId);

  // Insert controlled trigger pointing to decline test card
  await (supabase as any).from('billing_auto_topup_triggers').insert({
    id: declineTriggerId,
    organization_id: targetOrgId,
    attempt_token: genRandomUuid(),
    trigger_balance_minor: 52700,
    threshold_minor: 60000,
    recharge_amount_minor: 2500,
    status: 'claimed',
    configuration_generation_snapshot: 1,
    payment_authorization_generation_snapshot: 1,
    threshold_minor_snapshot: 60000,
    recharge_amount_minor_snapshot: 2500,
    currency_snapshot: 'USD',
    provider_account_id_snapshot: settingsRow.provider_account_id,
    provider_customer_id_snapshot: settingsRow.provider_customer_id,
    provider_payment_method_id_snapshot: 'pm_card_chargeDeclined', // Stripe test decline card
    provider_idempotency_key: declineIdempotencyKey,
    lease_owner: 'test_harness',
    lease_expires_at: new Date(Date.now() + 900000).toISOString(),
    attempt_count: 1,
  });

  await CreditAutoTopupService.authorizeAutoTopupProviderMutationAtomic(supabase, targetOrgId, declineTriggerId);
  const declineExecRes = await CreditAutoTopupExecutionService.executeAuthorizedTrigger(supabase, targetOrgId, declineTriggerId);

  console.log('✓ Card Decline Execution Result:', declineExecRes);
  assert.strictEqual(declineExecRes.success, false);
  assert.strictEqual(declineExecRes.status, 'failed');
  assert.strictEqual(declineExecRes.errorCode, 'card_declined');

  const postDeclineSpendable = await CreditAutoTopupService.getSpendableCreditBalanceMinor(supabase, targetOrgId);
  assert.strictEqual(postDeclineSpendable, 52700, 'Decline scenario must grant 0 credits');

  // Verify settings status changed to paused_failure
  const { data: pausedSettings } = await (supabase as any).from('billing_auto_topup_settings').select('status').eq('organization_id', targetOrgId).single();
  console.log(`Settings Status After Decline: ${pausedSettings.status}`);
  assert.strictEqual(pausedSettings.status, 'paused_failure');

  // Restore settings status to enabled and threshold to 1000
  await (supabase as any).from('billing_auto_topup_settings').update({ status: 'enabled', threshold_minor: 1000, updated_at: new Date().toISOString() }).eq('organization_id', targetOrgId);

  // --- STAGE 8: SCA / REQUIRES_ACTION TEST ---
  console.log('\n--- STAGE 8: SCA / REQUIRES_ACTION SCENARIO ---');
  const scaTriggerId = '88888888-8888-4888-a888-888888888888';
  const scaIdempotencyKey = `atu_pi_${scaTriggerId}`;

  await supabase.from('billing_payment_operations').delete().eq('organization_id', targetOrgId).filter('metadata->>auto_topup_trigger_id', 'eq', scaTriggerId);
  await supabase.from('billing_auto_topup_triggers').delete().eq('id', scaTriggerId);

  await (supabase as any).from('billing_auto_topup_settings').update({ threshold_minor: 60000 }).eq('organization_id', targetOrgId);

  await (supabase as any).from('billing_auto_topup_triggers').insert({
    id: scaTriggerId,
    organization_id: targetOrgId,
    attempt_token: genRandomUuid(),
    trigger_balance_minor: 52700,
    threshold_minor: 60000,
    recharge_amount_minor: 2500,
    status: 'claimed',
    configuration_generation_snapshot: 1,
    payment_authorization_generation_snapshot: 1,
    threshold_minor_snapshot: 60000,
    recharge_amount_minor_snapshot: 2500,
    currency_snapshot: 'USD',
    provider_account_id_snapshot: settingsRow.provider_account_id,
    provider_customer_id_snapshot: settingsRow.provider_customer_id,
    provider_payment_method_id_snapshot: 'pm_card_authenticationRequired', // Stripe test 3DS card
    provider_idempotency_key: scaIdempotencyKey,
    lease_owner: 'test_harness',
    lease_expires_at: new Date(Date.now() + 900000).toISOString(),
    attempt_count: 1,
  });

  await CreditAutoTopupService.authorizeAutoTopupProviderMutationAtomic(supabase, targetOrgId, scaTriggerId);
  const scaExecRes = await CreditAutoTopupExecutionService.executeAuthorizedTrigger(supabase, targetOrgId, scaTriggerId);

  console.log('✓ SCA Execution Result:', scaExecRes);
  assert.strictEqual(scaExecRes.success, true);
  assert.strictEqual(scaExecRes.status, 'requires_action');
  assert(scaExecRes.clientSecret != null);

  const postScaSpendable = await CreditAutoTopupService.getSpendableCreditBalanceMinor(supabase, targetOrgId);
  assert.strictEqual(postScaSpendable, 52700, 'SCA requires_action must grant 0 credits before authentication');

  // Restore settings status to enabled and threshold to 1000
  await (supabase as any).from('billing_auto_topup_settings').update({ status: 'enabled', threshold_minor: 1000, updated_at: new Date().toISOString() }).eq('organization_id', targetOrgId);

  // Clean test triggers
  await supabase.from('billing_payment_operations').delete().eq('organization_id', targetOrgId).filter('metadata->>auto_topup_trigger_id', 'eq', declineTriggerId);
  await supabase.from('billing_auto_topup_triggers').delete().eq('id', declineTriggerId);
  await supabase.from('billing_payment_operations').delete().eq('organization_id', targetOrgId).filter('metadata->>auto_topup_trigger_id', 'eq', scaTriggerId);
  await supabase.from('billing_auto_topup_triggers').delete().eq('id', scaTriggerId);

  // --- STAGE 21: FINAL ACCOUNTING RECONCILIATION ---
  console.log('\n--- STAGE 21: FINAL ACCOUNTING RECONCILIATION ---');
  const finalSpendable = await CreditAutoTopupService.getSpendableCreditBalanceMinor(supabase, targetOrgId);
  console.log(`Starting Spendable Balance : 50200 minor USD ($502.00)`);
  console.log(`Successful Top-Up #1       : +2500 minor USD ($25.00)`);
  console.log(`Expected Final Balance     : 52700 minor USD ($527.00)`);
  console.log(`Actual Final Balance       : ${finalSpendable} minor USD ($${(finalSpendable / 100).toFixed(2)})`);
  console.log(`Accounting Difference      : 0 minor USD`);

  assert.strictEqual(finalSpendable, 52700, 'Final spendable balance must equal exactly 52700');

  console.log('\n================================================================');
  console.log('C.5C.3D CONTROLLED STRIPE TEST CAMPAIGN PASSED CLEANLY');
  console.log('================================================================\n');
}

function genRandomUuid(): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.map((b, i) => ([4, 6, 8, 10].includes(i) ? '-' : '') + b.toString(16).padStart(2, '0')).join('');
}

runControlledStripeTestCampaign().catch((err) => {
  console.error('Test Campaign Failed:', err);
  process.exit(1);
});
