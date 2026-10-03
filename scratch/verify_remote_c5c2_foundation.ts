import fs from 'fs';
import path from 'path';

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

const supabase = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function runRemoteVerification() {
  console.log('================================================================');
  console.log('PHASE 13.4.3C STAGE C.5C.2D — REMOTE READ-ONLY VERIFICATION');
  console.log('================================================================\n');

  const targetOrgId = '00000000-0000-0000-0000-000000000001';

  // 1. Verify billing_auto_topup_settings schema & existing row
  const { data: settingsRow, error: settingsErr } = await (supabase as any)
    .from('billing_auto_topup_settings')
    .select('status, currency, threshold_minor, recharge_amount_minor, threshold_state, configuration_generation, payment_authorization_generation')
    .eq('organization_id', targetOrgId)
    .single();

  if (settingsErr) {
    console.error('Settings query error:', settingsErr.message);
  } else {
    console.log('--- 1. REMOTE SETTINGS ROW (CUSTOMER-SAFE) ---');
    console.log(`Status: ${settingsRow.status}`);
    console.log(`Currency: ${settingsRow.currency}`);
    console.log(`Threshold Minor: ${settingsRow.threshold_minor} ($${(settingsRow.threshold_minor / 100).toFixed(2)})`);
    console.log(`Recharge Amount Minor: ${settingsRow.recharge_amount_minor} ($${(settingsRow.recharge_amount_minor / 100).toFixed(2)})`);
    console.log(`Threshold State: ${settingsRow.threshold_state}`);
    console.log(`Configuration Generation: ${settingsRow.configuration_generation}`);
    console.log(`Payment Authorization Generation: ${settingsRow.payment_authorization_generation}`);
  }

  // 2. Verify billing_auto_topup_triggers schema columns & count
  const { data: triggerRows, count: triggerCount } = await (supabase as any)
    .from('billing_auto_topup_triggers')
    .select('id', { count: 'exact' });

  console.log('\n--- 2. REMOTE TRIGGER COUNTS ---');
  console.log(`C.5C Trigger Count: ${triggerCount || 0}`);

  // 3. Verify billing_payment_operations auto_topup_trigger_id column & autonomous count
  const { data: autoOpsRows, count: autoOpsCount } = await (supabase as any)
    .from('billing_payment_operations')
    .select('id, auto_topup_trigger_id', { count: 'exact' })
    .not('auto_topup_trigger_id', 'is', null);

  console.log('\n--- 3. REMOTE AUTONOMOUS PAYMENT OPERATION COUNTS ---');
  console.log(`Autonomous Payment Operations Count: ${autoOpsCount || 0}`);

  // 4. Verify authoritative wallet / accounting baseline
  const { data: ledgerLatest } = await (supabase as any)
    .from('billing_credit_ledger')
    .select('balance_after_minor')
    .eq('organization_id', targetOrgId)
    .order('created_at', { ascending: false })
    .limit(1);

  const fundedBalance = ledgerLatest?.[0]?.balance_after_minor || 0;

  const { data: resData } = await (supabase as any)
    .from('billing_telecom_reservations')
    .select('amount_minor')
    .eq('organization_id', targetOrgId)
    .eq('status', 'active');
  const activeReservations = (resData || []).reduce((acc: number, r: any) => acc + Number(r.amount_minor), 0);

  const { data: holdData } = await (supabase as any)
    .from('billing_financial_holds')
    .select('amount_minor')
    .eq('organization_id', targetOrgId)
    .eq('status', 'active');
  const activeHolds = (holdData || []).reduce((acc: number, h: any) => acc + Number(h.amount_minor), 0);

  const { data: debtData } = await (supabase as any)
    .from('billing_account_debts')
    .select('amount_minor')
    .eq('organization_id', targetOrgId)
    .eq('status', 'unpaid');
  const activeDebts = (debtData || []).reduce((acc: number, d: any) => acc + Number(d.amount_minor), 0);

  const spendableBalance = Math.max(0, Number(fundedBalance) - activeReservations - activeHolds);

  console.log('\n--- 4. AUTHORITATIVE WALLET / ACCOUNTING BASELINE ---');
  console.log(`Funded Balance: ${fundedBalance} minor USD ($${(Number(fundedBalance) / 100).toFixed(2)})`);
  console.log(`Active Telecom Reservations: ${activeReservations}`);
  console.log(`Active Financial Holds: ${activeHolds}`);
  console.log(`Active Account Debt: ${activeDebts}`);
  console.log(`Authoritative Spendable Balance: ${spendableBalance} minor USD ($${(spendableBalance / 100).toFixed(2)})`);

  // 5. Verify historical C.4 funding grants
  const { data: op1Grants } = await (supabase as any)
    .from('billing_credit_ledger')
    .select('id')
    .eq('reference_type', 'payment_operation')
    .eq('reference_id', '9481dbd1-9ee2-48b6-b805-15aa22017a2c');
  const { data: op2Grants } = await (supabase as any)
    .from('billing_credit_ledger')
    .select('id')
    .eq('reference_type', 'payment_operation')
    .eq('reference_id', '9f5446e4-3bee-4c9f-9ee4-217f9e98c03d');
  const { data: decGrants } = await (supabase as any)
    .from('billing_credit_ledger')
    .select('id')
    .eq('reference_type', 'payment_operation')
    .eq('reference_id', 'f1201871-07ca-442f-ab11-11abbe54bb9d');

  console.log('\n--- 5. HISTORICAL C.4 FUNDING GRANTS ---');
  console.log(`Operation 1 Funding Grants: ${op1Grants?.length || 0}`);
  console.log(`Operation 2 Funding Grants: ${op2Grants?.length || 0}`);
  console.log(`Declined Operation Funding Grants: ${decGrants?.length || 0}`);

  console.log('\n================================================================');
  console.log('C.5C.2D REMOTE READ-ONLY VERIFICATION COMPLETE');
  console.log('================================================================\n');
}

runRemoteVerification().catch(console.error);
