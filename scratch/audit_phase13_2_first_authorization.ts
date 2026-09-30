import fs from 'fs';
import path from 'path';

// Load .env.local variables
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
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
}

import { createAdminClient } from '../src/lib/supabase/admin';
import { getStripeClient } from '../src/lib/billing/providers/stripe/stripeClient';

async function auditFirstAuthorization() {
  console.log('==================================================');
  console.log('PHASE 13.2 — READ-ONLY DEPLOYED AUTHORIZATION AUDIT');
  console.log('==================================================\n');

  const supabase = createAdminClient();

  // 1. Inspect billing_payment_operations for +14788004516
  const targetPhone = '+14788004516';
  const { data: op, error: opErr } = await (supabase as any)
    .from('billing_payment_operations')
    .select('*')
    .filter('metadata->selectionContext->>phoneNumber', 'eq', targetPhone)
    .order('created_at', { ascending: false })
    .maybeSingle();

  if (opErr || !op) {
    console.log('Querying all recent operations...');
    const { data: recentOps } = await (supabase as any)
      .from('billing_payment_operations')
      .select('id, provider, status, amount_minor, currency, provider_payment_id, request_fingerprint, created_at')
      .order('created_at', { ascending: false })
      .limit(5);
    console.log('Recent operations in DB:', recentOps);
  } else {
    console.log('Found Payment Operation Row in DB:');
    console.log(`- ID: ${op.id}`);
    console.log(`- Organization ID: ${op.organization_id}`);
    console.log(`- Operation Type: ${op.operation_type}`);
    console.log(`- Provider: ${op.provider}`);
    console.log(`- Status: ${op.status}`);
    console.log(`- Amount Minor: ${op.amount_minor} (${op.currency})`);
    console.log(`- Idempotency Key: ${op.idempotency_key}`);
    console.log(`- Request Fingerprint: ${op.request_fingerprint}`);
    console.log(`- Provider Payment ID: ${op.provider_payment_id}`);
    console.log(`- Created At: ${op.created_at}`);

    const satisfiesRegex = /^sha256:[a-f0-9]{64}$/.test(op.request_fingerprint);
    console.log(`- Fingerprint satisfies ^sha256:[a-f0-9]{64}$ regex? ${satisfiesRegex ? 'YES' : 'NO'}`);

    // 2. Stripe PaymentIntent inspection (if STRIPE_SECRET_KEY available)
    if (process.env.STRIPE_SECRET_KEY && op.provider_payment_id) {
      try {
        const stripe = getStripeClient();
        const pi = await stripe.paymentIntents.retrieve(op.provider_payment_id);
        console.log('\nStripe PaymentIntent (API Retrieval):');
        console.log(`- ID: ${pi.id}`);
        console.log(`- Livemode: ${pi.livemode} (Test Mode: ${!pi.livemode})`);
        console.log(`- Status: ${pi.status}`);
        console.log(`- Amount: ${pi.amount} (${pi.currency.toUpperCase()})`);
        console.log(`- Capture Method: ${pi.capture_method}`);
        console.log(`- Amount Capturable: ${pi.amount_capturable}`);
        console.log(`- Amount Received: ${pi.amount_received}`);
        console.log(`- Setup Future Usage: ${pi.setup_future_usage || 'null/undefined (Unchecked)'}`);
      } catch (err: any) {
        console.log('\nStripe API query skipped or credentials unconfigured in local env:', err.message);
      }
    }
  }

  // 3. Inspect billing_webhook_events
  const { data: webhooks } = await (supabase as any)
    .from('billing_webhook_events')
    .select('id, provider, provider_event_id, event_type, status, created_at')
    .eq('provider', 'stripe')
    .order('created_at', { ascending: false })
    .limit(5);

  console.log('\nRecent Webhook Events in DB:');
  console.log(webhooks || []);

  // 4. Telecom Safety Verification
  const { count: telecomOpCount } = await (supabase as any)
    .from('provider_number_operations')
    .select('*', { count: 'exact', head: true })
    .eq('phone_number_e164', targetPhone);

  const { data: phoneRow } = await (supabase as any)
    .from('phone_numbers')
    .select('id, phone_number')
    .eq('phone_number', targetPhone)
    .maybeSingle();

  console.log('\nTelecom Safety Checks:');
  console.log(`- provider_number_operations count for ${targetPhone}: ${telecomOpCount || 0}`);
  console.log(`- phone_numbers ownership row for ${targetPhone} exists? ${phoneRow ? 'YES' : 'NO'}`);

  // 5. Credit & Billing Ledger Safety Verification
  const { count: creditLedgerCount } = await (supabase as any)
    .from('billing_credit_ledger')
    .select('*', { count: 'exact', head: true });

  const { count: billableResourceCount } = await (supabase as any)
    .from('organization_billable_resources')
    .select('*', { count: 'exact', head: true });

  console.log('\nCredit & Billing Safety Checks:');
  console.log(`- Credit Ledger Mutations: ${creditLedgerCount || 0}`);
  console.log(`- Organization Billable Resources: ${billableResourceCount || 0}`);
  console.log(`- PHASE13_PAYMENT_ENABLED: ${process.env.PHASE13_PAYMENT_ENABLED || 'false'}`);

  console.log('\n==================================================');
  console.log('AUDIT COMPLETE');
  console.log('==================================================');
}

auditFirstAuthorization().catch((err) => {
  console.error('Audit execution error:', err);
});
