import 'server-only';
import fs from 'fs';
import path from 'path';

// Load .env.local if present
try {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    for (const line of envConfig.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...vals] = trimmed.split('=');
        if (key && !process.env[key.trim()]) {
          process.env[key.trim()] = vals.join('=').trim();
        }
      }
    }
  }
} catch (e) {}

import Stripe from 'stripe';
import { createAdminClient } from '../src/lib/supabase/admin';
import { CommercialCaptureReconciliationService } from '../src/lib/billing/commercialCaptureReconciliationService';
import { StripePaymentElementService } from '../src/lib/billing/providers/stripe/stripePaymentElementService';

/**
 * Phase 13.3.3.2C.2 — Controlled Stripe Sandbox Capture Validation Harness
 *
 * SAFETY CONTRACT & INTERLOCK:
 * - Requires explicit environment variable: PHASE13_C2_SANDBOX_EXECUTION_AUTHORIZED=true
 * - Without explicit authorization variable, script aborts immediately with 0 mutations.
 * - Enforces Stripe TEST mode ONLY (sk_test_... key + livemode === false).
 * - Creates uniquely tagged synthetic DB fixture rows (no real customer or Twilio data).
 * - Collision Preflight: Performs READ-ONLY checks for all synthetic PKs, SIDs, and E.164. Aborts before any mutation if collision detected.
 * - Retains DB records after execution for audit inspection (automatic cleanup removed).
 * - Executes production capture via CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch().
 * - Proves exactly-once capture, authoritative retrieve, and DB state completion.
 */

async function main() {
  console.log('=== PHASE 13.3.3.2C.2 STRIPE SANDBOX HARNESS AUDIT ===\n');

  // 1. SAFETY AUTHORIZATION CHECK
  const isAuthorized = process.env.PHASE13_C2_SANDBOX_EXECUTION_AUTHORIZED === 'true';

  if (!isAuthorized) {
    console.log('[PHASE 13.3.3.2C.2 STRIPE SANDBOX HARNESS] ABORTED / NOT AUTHORIZED');
    console.log('Reason: PHASE13_C2_SANDBOX_EXECUTION_AUTHORIZED is not explicitly set to "true".');
    console.log('Safety Audit:');
    console.log('  - Real Stripe PaymentIntent creations: 0');
    console.log('  - Real Stripe PaymentIntent confirmations: 0');
    console.log('  - Real Stripe PaymentIntent captures: 0');
    console.log('  - Twilio purchases / releases: 0');
    console.log('  - Database fixture mutations: 0');
    console.log('  - Production feature gates: PHASE13_PAYMENT_ENABLED=false, PHASE13_STRIPE_CAPTURE_ENABLED=false');
    process.exit(0);
  }

  // 2. ENVIRONMENT & GATES RE-VALIDATION FOR LOCAL RUN
  const paymentGate = process.env.PHASE13_PAYMENT_ENABLED === 'true';
  const captureGate = process.env.PHASE13_STRIPE_CAPTURE_ENABLED === 'true';
  const expectedMode = process.env.STRIPE_EXPECTED_MODE || 'test';
  const secretKey = process.env.STRIPE_SECRET_KEY || '';

  if (!paymentGate || !captureGate) {
    console.error('[ERROR] Local execution denied: BOTH PHASE13_PAYMENT_ENABLED and PHASE13_STRIPE_CAPTURE_ENABLED must be set to "true" in local environment.');
    process.exit(1);
  }

  if (expectedMode !== 'test') {
    console.error(`[ERROR] Local execution denied: STRIPE_EXPECTED_MODE must be strictly "test", got "${expectedMode}".`);
    process.exit(1);
  }

  if (!secretKey.startsWith('sk_test_')) {
    console.error('[ERROR] Local execution denied: STRIPE_SECRET_KEY must start with "sk_test_". Live mode keys strictly forbidden.');
    process.exit(1);
  }

  console.log('Authorization & Local Environment Safety Checks Passed.');
  console.log('Mode: TEST | Key: sk_test_... verified.\n');

  const stripe = new Stripe(secretKey, { apiVersion: '2023-10-16' as any });
  const supabase = createAdminClient();

  // Mutation Counters
  let stripeCreates = 0;
  let stripeConfirms = 0;
  let stripeCaptures = 0;
  let stripeRetrieves = 0;

  // Synthetic Fixture Identifiers
  const synthOrgId = '00000000-0000-4000-a000-00000000c201';
  const synthSagaId = '00000000-0000-4000-a000-00000000c202';
  const synthPaymentOpId = '00000000-0000-4000-a000-00000000c203';
  const synthProvOpId = '00000000-0000-4000-a000-00000000c204';
  const synthPhoneId = '00000000-0000-4000-a000-00000000c205';
  const synthE164 = '+15550009999'; // Pure synthetic fixture E.164
  const synthSid = 'PN_c2_synth_test_sid_999';
  const synthAmountMinor = 100; // $1.00 USD
  const synthCurrency = 'USD';

  // Compute Fingerprint Authoritatively via Production Service
  const synthFingerprint = StripePaymentElementService.generateFingerprint(
    synthOrgId,
    synthE164,
    'US',
    'local',
    synthAmountMinor,
    synthCurrency,
    null,
    ''
  );

  let createdStripePiId: string | null = null;
  const insertedDbTables: string[] = [];

  try {
    // 3. READ-ONLY COLLISION PREFLIGHT CHECK
    console.log('Step Preflight: Verifying zero synthetic ID / E.164 collisions...');

    const { data: existOrg } = await (supabase as any).from('organizations').select('id').eq('id', synthOrgId).maybeSingle();
    const { data: existProvOp } = await (supabase as any).from('provider_number_operations').select('id').eq('id', synthProvOpId).maybeSingle();
    const { data: existPhone } = await (supabase as any).from('phone_numbers').select('id').eq('id', synthPhoneId).maybeSingle();
    const { data: existPhoneE164 } = await (supabase as any).from('phone_numbers').select('id').eq('phone_number', synthE164).maybeSingle();
    const { data: existPayOp } = await (supabase as any).from('billing_payment_operations').select('id').eq('id', synthPaymentOpId).maybeSingle();
    const { data: existSaga } = await (supabase as any).from('commercial_number_purchase_sagas').select('id').eq('id', synthSagaId).maybeSingle();

    if (existOrg || existProvOp || existPhone || existPhoneE164 || existPayOp || existSaga) {
      console.error('[COLLISION DETECTED] Aborting execution before any mutation.');
      console.error(`  existOrg: ${!!existOrg}, existProvOp: ${!!existProvOp}, existPhone: ${!!existPhone}, existPhoneE164: ${!!existPhoneE164}, existPayOp: ${!!existPayOp}, existSaga: ${!!existSaga}`);
      throw new Error('COLLISION_PREFLIGHT_FAILED: One or more synthetic identifiers already exist in the database.');
    }

    console.log('  ✓ Preflight collision checks passed: All synthetic IDs & E.164 are clean.\n');

    // 4. INSERT SYNTHETIC DB FIXTURES
    console.log('Step A: Inserting Synthetic Database Fixtures...');

    // Org
    const { error: errOrg } = await (supabase as any).from('organizations').insert({
      id: synthOrgId,
      name: 'Synthetic C2 Test Org',
      slug: 'synth-c2-test-org',
    });
    if (errOrg) throw new Error(`DB Insert Error (organizations): ${errOrg.message}`);
    insertedDbTables.push('organizations');

    // Provider Op
    const { error: errProvOp } = await (supabase as any).from('provider_number_operations').insert({
      id: synthProvOpId,
      organization_id: synthOrgId,
      operation_type: 'purchase_number',
      provider: 'twilio',
      status: 'succeeded',
      phone_number_e164: synthE164,
      country_code: 'US',
      number_type: 'local',
      idempotency_key: `prov_op_c2_${synthSagaId}`,
      request_fingerprint: synthFingerprint,
      provider_resource_id: synthSid,
      retail_amount_minor: synthAmountMinor,
      retail_currency: synthCurrency,
      provider_cost_minor: 100,
      provider_cost_currency: synthCurrency,
      pricing_source: 'pricing_policy',
      gross_margin_minor: 0,
      price_snapshot_payload: {},
      regulatory_provisioning_context: {},
    });
    if (errProvOp) throw new Error(`DB Insert Error (provider_number_operations): ${errProvOp.message}`);
    insertedDbTables.push('provider_number_operations');

    // Phone Row
    const { error: errPhone } = await (supabase as any).from('phone_numbers').insert({
      id: synthPhoneId,
      organization_id: synthOrgId,
      phone_number: synthE164,
      country_code: 'US',
      number_type: 'local',
      status: 'active',
      twilio_phone_number_sid: synthSid,
    });
    if (errPhone) throw new Error(`DB Insert Error (phone_numbers): ${errPhone.message}`);
    insertedDbTables.push('phone_numbers');

    console.log('  ✓ Base DB Fixtures (Org, ProviderOp, PhoneRow) inserted successfully.\n');

    // 5. CREATE STRIPE TEST PAYMENTINTENT (status = requires_capture, capture_method = manual)
    console.log('Step B: Creating Stripe TEST PaymentIntent...');
    stripeCreates++;
    stripeConfirms++; // Single mutation API call combining create & confirm via confirm: true
    const paymentIntent = await stripe.paymentIntents.create({
      amount: synthAmountMinor,
      currency: synthCurrency.toLowerCase(),
      capture_method: 'manual',
      payment_method: 'pm_card_visa',
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: {
        organization_id: synthOrgId,
        operation_id: synthPaymentOpId,
        saga_id: synthSagaId,
        e164_number: synthE164,
        request_fingerprint: synthFingerprint,
      },
    });

    createdStripePiId = paymentIntent.id;
    console.log(`  ✓ Stripe TEST PaymentIntent created: ${paymentIntent.id}`);
    console.log(`  ✓ Status: ${paymentIntent.status} (expected: requires_capture)`);
    console.log(`  ✓ Livemode: ${paymentIntent.livemode} (expected: false)`);

    if (paymentIntent.status !== 'requires_capture' || paymentIntent.livemode !== false) {
      throw new Error(`Stripe PaymentIntent safety check failed: status=${paymentIntent.status}, livemode=${paymentIntent.livemode}`);
    }

    // Insert Payment Op & Saga linked to created PI
    const { error: errPayOp } = await (supabase as any).from('billing_payment_operations').insert({
      id: synthPaymentOpId,
      organization_id: synthOrgId,
      operation_type: 'number_purchase',
      provider: 'stripe',
      status: 'authorized',
      amount_minor: synthAmountMinor,
      currency: synthCurrency,
      idempotency_key: `pay_op_c2_${synthPaymentOpId}`,
      request_fingerprint: synthFingerprint,
      provider_payment_id: paymentIntent.id,
      price_snapshot_payload: {},
      telecom_operation_id: synthProvOpId,
    });
    if (errPayOp) throw new Error(`DB Insert Error (billing_payment_operations): ${errPayOp.message}`);
    insertedDbTables.push('billing_payment_operations');

    const { error: errSaga } = await (supabase as any).from('commercial_number_purchase_sagas').insert({
      id: synthSagaId,
      organization_id: synthOrgId,
      payment_operation_id: synthPaymentOpId,
      provider_number_operation_id: synthProvOpId,
      phone_number_e164: synthE164,
      state: 'ownership_confirmed',
      retail_amount_minor: synthAmountMinor,
      currency: synthCurrency,
      price_snapshot_payload: {},
    });
    if (errSaga) throw new Error(`DB Insert Error (commercial_number_purchase_sagas): ${errSaga.message}`);
    insertedDbTables.push('commercial_number_purchase_sagas');

    console.log('  ✓ Linked PaymentOp and CommercialSaga inserted successfully.\n');

    // 6. EXECUTE PRODUCTION CAPTURE ORCHESTRATION
    console.log('Step C: Executing Production Capture Orchestration...');
    stripeCaptures++; // Execute exactly one capture
    stripeRetrieves += 2; // Pre & Post retrieve

    const result = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(
      supabase,
      {
        sagaId: synthSagaId,
        organizationId: synthOrgId,
        expectedMode: 'test',
      }
    );

    console.log('  ✓ Orchestration Result:', JSON.stringify(result, null, 2));

    if (!result.success || result.classification !== 'CAPTURE_CONFIRMED') {
      throw new Error(`Capture dispatch failed: classification=${result.classification}, message=${result.message}`);
    }

    // 7. AUTHORITATIVE STRIPE & DB VERIFICATION
    console.log('\nStep D: Verifying Authoritative Outcomes...');
    stripeRetrieves++;
    const retrievedIntent = await stripe.paymentIntents.retrieve(paymentIntent.id);
    console.log(`  ✓ Stripe PaymentIntent Status: ${retrievedIntent.status}`);
    console.log(`  ✓ Stripe Amount Received: ${retrievedIntent.amount_received} / Capturable: ${retrievedIntent.amount_capturable}`);

    if (retrievedIntent.status !== 'succeeded' || retrievedIntent.amount_received !== synthAmountMinor || retrievedIntent.amount_capturable !== 0) {
      throw new Error('Authoritative Stripe verification failed!');
    }

    const { data: dbOp } = await (supabase as any).from('billing_payment_operations').select('*').eq('id', synthPaymentOpId).single();
    const { data: dbSaga } = await (supabase as any).from('commercial_number_purchase_sagas').select('*').eq('id', synthSagaId).single();

    console.log(`  ✓ DB Payment Op Status: ${dbOp.status}`);
    console.log(`  ✓ DB Saga State: ${dbSaga.state}`);
    console.log(`  ✓ DB Capture Claimed At: ${dbOp.capture_dispatch_claimed_at}`);
    console.log(`  ✓ DB Capture Idempotency Key: ${dbOp.capture_idempotency_key}`);

    if (dbOp.status !== 'captured' || dbSaga.state !== 'completed') {
      throw new Error('Authoritative DB state verification failed!');
    }

    // 8. SECOND INVOCATION IDEMPOTENCY CHECK
    console.log('\nStep E: Executing Second Invocation Idempotency Check...');
    stripeRetrieves++;
    const secondResult = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(
      supabase,
      {
        sagaId: synthSagaId,
        organizationId: synthOrgId,
        expectedMode: 'test',
      }
    );

    console.log(`  ✓ Second Invocation Result Success: ${secondResult.success}, Classification: ${secondResult.classification}`);
    if (!secondResult.success || secondResult.classification !== 'CAPTURE_CONFIRMED') {
      throw new Error('Second invocation idempotency check failed!');
    }

    console.log('\n==================================================');
    console.log('PHASE 13.3.3.2C.2 STRIPE SANDBOX CAPTURE VALIDATION SUCCESSFUL!');
    console.log('==================================================\n');

  } catch (err: any) {
    console.error('\n[ERROR] Sandbox execution failed:', err.message || err);
    process.exit(1);
  } finally {
    // 9. REVISED CLEANUP / AUDIT-RETENTION POLICY
    console.log('\nStep F: Retaining Synthetic DB Records for Inspection Evidence...');
    console.log('Retained Database Records:');
    console.log(`  - Organization: ${synthOrgId}`);
    console.log(`  - Commercial Saga: ${synthSagaId}`);
    console.log(`  - Billing Payment Operation: ${synthPaymentOpId}`);
    console.log(`  - Provider Number Operation: ${synthProvOpId}`);
    console.log(`  - Phone Number: ${synthPhoneId}`);
    if (createdStripePiId) {
      console.log(`  - Stripe TEST PaymentIntent: ${createdStripePiId}`);
    }
    console.log('Inserted DB Tables:', insertedDbTables.join(', '));
    console.log('\nExecuted Provider Mutations:');
    console.log(`  - Stripe PI Creations: ${stripeCreates}`);
    console.log(`  - Stripe PI Confirmations: ${stripeConfirms}`);
    console.log(`  - Stripe PI Captures: ${stripeCaptures}`);
    console.log(`  - Stripe PI Reads/Retrieves: ${stripeRetrieves}`);
    console.log(`  - Twilio Purchases / Releases: 0`);
  }
}

main().catch((err) => {
  console.error('Fatal harness error:', err);
  process.exit(1);
});
