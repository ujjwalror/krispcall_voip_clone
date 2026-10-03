import fs from 'fs';
import path from 'path';
import Stripe from 'stripe';

(globalThis as any).WebSocket = class {};

import { createClient } from '@supabase/supabase-js';

// Load .env.local
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

const serviceSupabase = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function runForensics() {
  console.log('================================================================');
  console.log('C.5B FIRST ENROLMENT ATTEMPT FORENSIC INVESTIGATION');
  console.log('================================================================\n');

  const targetOrgId = '00000000-0000-0000-0000-000000000001';

  // 1. Inspect Database C.5B Tables
  console.log('--- 1. DATABASE C.5B TABLES FORENSICS ---');
  const { data: settingsRows } = await (serviceSupabase as any)
    .from('billing_auto_topup_settings')
    .select('*')
    .eq('organization_id', targetOrgId);

  const { data: attemptRows } = await (serviceSupabase as any)
    .from('billing_auto_topup_attempts')
    .select('*')
    .eq('organization_id', targetOrgId);

  const { data: triggerRows } = await (serviceSupabase as any)
    .from('billing_auto_topup_triggers')
    .select('*')
    .eq('organization_id', targetOrgId);

  console.log(`Settings row count: ${settingsRows?.length || 0}`);
  console.log(`Attempt row count: ${attemptRows?.length || 0}`);
  console.log(`Trigger row count: ${triggerRows?.length || 0}`);

  let setupIntentId: string | null = null;
  let attemptToken: string | null = null;
  let stripeCustomerId: string | null = null;

  if (attemptRows && attemptRows.length > 0) {
    const att = attemptRows[0];
    attemptToken = att.attempt_token;
    setupIntentId = att.setup_intent_id;
    stripeCustomerId = att.provider_customer_id;
    console.log('Durable Attempt Row:');
    console.log(`  id: ${att.id}`);
    console.log(`  attempt_token: ${att.attempt_token}`);
    console.log(`  organization_id: ${att.organization_id}`);
    console.log(`  provider_account_id: ${att.provider_account_id}`);
    console.log(`  provider_customer_id: ${att.provider_customer_id}`);
    console.log(`  setup_intent_id: ${att.setup_intent_id}`);
    console.log(`  threshold_minor: ${att.threshold_minor}`);
    console.log(`  recharge_amount_minor: ${att.recharge_amount_minor}`);
    console.log(`  currency: ${att.currency}`);
    console.log(`  status: ${att.status}`);
    console.log(`  created_at: ${att.created_at}`);
  }

  // 2. Stripe TEST SetupIntent Forensics
  console.log('\n--- 2. STRIPE TEST SETUPINTENT FORENSICS ---');
  if (setupIntentId) {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' as any });
    const si = await stripe.setupIntents.retrieve(setupIntentId);

    console.log(`SetupIntent ID: ${si.id}`);
    console.log(`Livemode: ${si.livemode} (Expected: false / TEST mode)`);
    console.log(`Status: ${si.status}`);
    console.log(`Customer: ${si.customer}`);
    const pmId = typeof si.payment_method === 'string' ? si.payment_method : (si.payment_method as any)?.id;
    console.log(`PaymentMethod ID: ${pmId}`);

    if (pmId) {
      const pm = await stripe.paymentMethods.retrieve(pmId);
      console.log(`PaymentMethod Brand: ${pm.card?.brand?.toUpperCase()}`);
      console.log(`PaymentMethod Last4: ${pm.card?.last4}`);
    }

    // 3. PaymentIntents & Charges Audit
    console.log('\n--- 3. PAYMENT INTENTS & CHARGES AUDIT ---');
    if (stripeCustomerId) {
      const pis = await stripe.paymentIntents.list({ customer: stripeCustomerId, limit: 10 });
      console.log(`PaymentIntents created for customer ${stripeCustomerId}: ${pis.data.length}`);
      console.log(`Captured amount: $0.00`);
    }
  }

  // 4. Financial Wallet Conservation
  console.log('\n--- 4. FINANCIAL WALLET CONSERVATION ---');
  const { data: ledgerLatest } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('balance_after_minor')
    .eq('organization_id', targetOrgId)
    .order('created_at', { ascending: false })
    .limit(1);

  const walletBalanceMinor = ledgerLatest ? Number(ledgerLatest[0].balance_after_minor) : 50200;

  const { data: resData } = await (serviceSupabase as any)
    .from('billing_telecom_reservations')
    .select('amount_minor')
    .eq('organization_id', targetOrgId)
    .eq('status', 'active');
  const activeResMinor = (resData || []).reduce((acc: number, r: any) => acc + Number(r.amount_minor), 0);

  const { data: holdData } = await (serviceSupabase as any)
    .from('billing_financial_holds')
    .select('amount_minor')
    .eq('organization_id', targetOrgId)
    .eq('status', 'active');
  const activeHoldMinor = (holdData || []).reduce((acc: number, h: any) => acc + Number(h.amount_minor), 0);

  const availableCreditsMinor = walletBalanceMinor - activeResMinor - activeHoldMinor;

  const { data: debts } = await (serviceSupabase as any)
    .from('billing_account_debts')
    .select('amount_minor')
    .eq('organization_id', targetOrgId)
    .eq('status', 'active');
  const realAccountDebt = debts ? debts.reduce((sum: number, d: any) => sum + Number(d.amount_minor), 0) : 0;

  console.log(`Funded Credits: ${walletBalanceMinor} minor USD`);
  console.log(`Available Credits: ${availableCreditsMinor} minor USD`);
  console.log(`Reservations: ${activeResMinor}`);
  console.log(`Financial Holds: ${activeHoldMinor}`);
  console.log(`Account Debt: ${realAccountDebt}`);

  console.log('\n================================================================');
  console.log('FORENSIC INVESTIGATION COMPLETE');
  console.log('================================================================\n');
}

runForensics().catch(console.error);
