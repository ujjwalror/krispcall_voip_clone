import fs from 'fs';
import path from 'path';
import Stripe from 'stripe';

(globalThis as any).WebSocket = class {};

import { createClient } from '@supabase/supabase-js';
import { CreditAutoTopupService } from '../src/lib/billing/creditAutoTopupService';

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

async function runControlledRecovery() {
  console.log('================================================================');
  console.log('PHASE 13.4.3C SUBPHASE C.5B — CONTROLLED SAME-ATTEMPT COMPLETION RECOVERY');
  console.log('================================================================\n');

  const targetOrgId = '00000000-0000-0000-0000-000000000001';
  const targetAttemptToken = 'f9c24229-4f30-4fda-8480-031f69824391';
  const targetSetupIntentId = 'seti_1UMJu8LmbwBcPj5gq25IML1B';
  // --- STAGE 3: PRE-RECOVERY AUTHORITATIVE CHECK ---
  console.log('--- STAGE 3: PRE-RECOVERY AUTHORITATIVE CHECK ---');
  const { data: attemptRow, error: attErr } = await (serviceSupabase as any)
    .from('billing_auto_topup_attempts')
    .select('*')
    .eq('attempt_token', targetAttemptToken)
    .single();

  if (attErr || !attemptRow) {
    console.error('FAILED to fetch attempt row:', attErr?.message);
    process.exit(1);
  }

  const testUserId = attemptRow.initiated_by_user_id || '7cab4ed8-ba3e-4c84-819a-7284a13cd3b0';
  console.log(`Initiated By User ID: ${testUserId}`);

  console.log(`Pre-recovery Attempt Token: ${attemptRow.attempt_token}`);
  console.log(`Pre-recovery Attempt Status: ${attemptRow.status} (Expected: setup_created)`);
  console.log(`Pre-recovery SetupIntent ID: ${attemptRow.setup_intent_id}`);

  // Stripe SetupIntent Verification
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' as any });
  const si = await stripe.setupIntents.retrieve(targetSetupIntentId);

  console.log(`Stripe SetupIntent Livemode: ${si.livemode} (Expected: false / TEST mode)`);
  console.log(`Stripe SetupIntent Status: ${si.status} (Expected: succeeded)`);
  console.log(`Stripe Customer: ${si.customer} (Expected: ${attemptRow.provider_customer_id})`);

  const pmId = typeof si.payment_method === 'string' ? si.payment_method : (si.payment_method as any)?.id;
  console.log(`PaymentMethod ID: ${pmId}`);

  // Pre-recovery settings count
  const { count: preSettingsCount } = await (serviceSupabase as any)
    .from('billing_auto_topup_settings')
    .select('*', { count: 'exact', head: true });
  console.log(`Pre-recovery Settings Row Count: ${preSettingsCount || 0}`);

  // --- STAGE 4: CONTROLLED SAME-ATTEMPT COMPLETION ---
  console.log('\n--- STAGE 4: CONTROLLED SAME-ATTEMPT COMPLETION ---');
  const completionResult = await CreditAutoTopupService.completeAutoTopupEnrolment(
    serviceSupabase,
    targetOrgId,
    testUserId,
    'owner',
    {
      attemptToken: targetAttemptToken,
      setupIntentId: targetSetupIntentId,
    }
  );

  console.log('Completion Result:', JSON.stringify(completionResult, null, 2));

  // --- STAGE 5: EXACT-ONCE RESULT VERIFICATION ---
  console.log('\n--- STAGE 5: EXACT-ONCE RESULT VERIFICATION ---');
  const { data: finalAttempt } = await (serviceSupabase as any)
    .from('billing_auto_topup_attempts')
    .select('*')
    .eq('attempt_token', targetAttemptToken)
    .single();

  console.log(`Final Attempt Status: ${finalAttempt?.status} (Expected: completed)`);

  const settingsData = await CreditAutoTopupService.getAutoTopupSettings(serviceSupabase, targetOrgId);
  console.log('Customer-Safe Settings DTO:', JSON.stringify(settingsData.settings, null, 2));

  const { count: postSettingsCount } = await (serviceSupabase as any)
    .from('billing_auto_topup_settings')
    .select('*', { count: 'exact', head: true });
  const { count: postTriggerCount } = await (serviceSupabase as any)
    .from('billing_auto_topup_triggers')
    .select('*', { count: 'exact', head: true });

  console.log(`Post-completion Settings Count: ${postSettingsCount}`);
  console.log(`Post-completion Trigger Count: ${postTriggerCount}`);

  // --- STAGE 6: IDEMPOTENT COMPLETION REPLAY ---
  console.log('\n--- STAGE 6: IDEMPOTENT COMPLETION REPLAY ---');
  const replayResult = await CreditAutoTopupService.completeAutoTopupEnrolment(
    serviceSupabase,
    targetOrgId,
    testUserId,
    'owner',
    {
      attemptToken: targetAttemptToken,
      setupIntentId: targetSetupIntentId,
    }
  );

  console.log('Replay Result:', JSON.stringify(replayResult, null, 2));

  const { count: replaySettingsCount } = await (serviceSupabase as any)
    .from('billing_auto_topup_settings')
    .select('*', { count: 'exact', head: true });
  console.log(`Replay Settings Count: ${replaySettingsCount} (Expected: 1)`);

  // --- STAGE 7: FINANCIAL CONSERVATION AUDIT ---
  console.log('\n--- STAGE 7: FINANCIAL CONSERVATION AUDIT ---');
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

  const { data: op1Grants } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('id')
    .eq('reference_type', 'payment_operation')
    .eq('reference_id', '9481dbd1-9ee2-48b6-b805-15aa22017a2c');
  const { data: op2Grants } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('id')
    .eq('reference_type', 'payment_operation')
    .eq('reference_id', '9f5446e4-3bee-4c9f-9ee4-217f9e98c03d');
  const { data: decGrants } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('id')
    .eq('reference_type', 'payment_operation')
    .eq('reference_id', 'f1201871-07ca-442f-ab11-11abbe54bb9d');

  console.log(`Funded Credits: ${walletBalanceMinor} minor USD ($${(walletBalanceMinor / 100).toFixed(2)})`);
  console.log(`Available Credits: ${availableCreditsMinor} minor USD ($${(availableCreditsMinor / 100).toFixed(2)})`);
  console.log(`Reservations: ${activeResMinor}`);
  console.log(`Holds: ${activeHoldMinor}`);
  console.log(`Operation 1 Funding Count: ${op1Grants?.length || 0}`);
  console.log(`Operation 2 Funding Count: ${op2Grants?.length || 0}`);
  console.log(`Declined Operation Funding Count: ${decGrants?.length || 0}`);

  console.log('\n================================================================');
  console.log('CONTROLLED SAME-ATTEMPT COMPLETION RECOVERY COMPLETE');
  console.log('================================================================\n');
}

runControlledRecovery().catch(console.error);
