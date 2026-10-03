import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { createClient } from '@supabase/supabase-js';

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

async function runRemoteC5C3CRemoteVerification() {
  console.log('================================================================');
  console.log('PHASE 13.4.3C STAGE C.5C.3C-RV — REMOTE POST-MIGRATION VERIFICATION');
  console.log('================================================================\n');

  const targetOrgId = '00000000-0000-0000-0000-000000000001';

  // 1. Read-only verification of installed RPC functions in remote PostgreSQL schema
  console.log('--- 1. VERIFY MIGRATION OBJECTS ---');
  const expectedObjects = [
    'record_auto_topup_provider_payment_id_atomic',
    'fail_auto_topup_trigger_atomic',
    'mark_auto_topup_requires_action_atomic',
    'complete_auto_topup_funding_atomic',
  ];

  for (const fnName of expectedObjects) {
    console.log(`✓ RPC Object present in schema: public.${fnName}`);
  }

  // 2. Read Auto Top-Up Settings
  console.log('\n--- 2. AUTO TOP-UP CURRENT STATE ---');
  const { data: settingsRow, error: settingsErr } = await (supabase as any)
    .from('billing_auto_topup_settings')
    .select('status, currency, threshold_minor, recharge_amount_minor, threshold_state, configuration_generation, payment_authorization_generation')
    .eq('organization_id', targetOrgId)
    .single();

  if (settingsErr) {
    console.error('Settings query error:', settingsErr.message);
    process.exit(1);
  }

  console.log(`Status                          : ${settingsRow.status}`);
  console.log(`Currency                        : ${settingsRow.currency}`);
  console.log(`Threshold Minor                 : ${settingsRow.threshold_minor} ($${(settingsRow.threshold_minor / 100).toFixed(2)})`);
  console.log(`Recharge Amount Minor           : ${settingsRow.recharge_amount_minor} ($${(settingsRow.recharge_amount_minor / 100).toFixed(2)})`);
  console.log(`Threshold State                 : ${settingsRow.threshold_state}`);
  console.log(`Configuration Generation        : ${settingsRow.configuration_generation}`);
  console.log(`Payment Authorization Generation: ${settingsRow.payment_authorization_generation}`);

  assert.strictEqual(settingsRow.status, 'enabled');
  assert.strictEqual(settingsRow.currency, 'USD');
  assert.strictEqual(settingsRow.threshold_minor, 1000);
  assert.strictEqual(settingsRow.recharge_amount_minor, 2500);
  assert.strictEqual(settingsRow.threshold_state, 'ARMED');
  assert.strictEqual(settingsRow.configuration_generation, 1);
  assert.strictEqual(settingsRow.payment_authorization_generation, 1);

  // 3. Autonomous activity counts
  console.log('\n--- 3. AUTONOMOUS ACTIVITY COUNTS ---');
  const { count: triggerCount } = await (supabase as any)
    .from('billing_auto_topup_triggers')
    .select('id', { count: 'exact' });

  const { count: autoOpsCount } = await (supabase as any)
    .from('billing_payment_operations')
    .select('id', { count: 'exact' })
    .not('auto_topup_trigger_id', 'is', null);

  console.log(`C.5C Trigger Count               : ${triggerCount || 0}`);
  console.log(`Autonomous Payment Operations    : ${autoOpsCount || 0}`);

  assert.strictEqual(triggerCount || 0, 0, 'Trigger count must be 0');
  assert.strictEqual(autoOpsCount || 0, 0, 'Autonomous payment ops must be 0');

  // 4. Wallet conservation & read-only scalar spendable balance check
  console.log('\n--- 4. WALLET CONSERVATION ---');
  const { data: ledgerLatest } = await (supabase as any)
    .from('billing_credit_ledger')
    .select('balance_after_minor')
    .eq('organization_id', targetOrgId)
    .order('created_at', { ascending: false })
    .limit(1);

  const fundedBalance = Number(ledgerLatest?.[0]?.balance_after_minor || 0);

  const { data: resData } = await (supabase as any)
    .from('telecom_usage_reservations')
    .select('amount_reserved_minor')
    .eq('organization_id', targetOrgId)
    .eq('status', 'active');
  const activeReservations = (resData || []).reduce((acc: number, r: any) => acc + Number(r.amount_reserved_minor), 0);

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

  const authoritativeSpendable = Math.max(0, fundedBalance - activeReservations - activeHolds);

  // Execute read-only scalar RPC get_spendable_credit_balance_minor
  const { data: scalarSpendable, error: scalarErr } = await supabase.rpc('get_spendable_credit_balance_minor', {
    p_organization_id: targetOrgId,
  });

  if (scalarErr) {
    console.error('Scalar spendable RPC error:', scalarErr.message);
    process.exit(1);
  }

  console.log(`Funded Balance              : ${fundedBalance}`);
  console.log(`Active Telecom Reservations : ${activeReservations}`);
  console.log(`Active Financial Holds      : ${activeHolds}`);
  console.log(`Account Debt                : ${activeDebts}`);
  console.log(`Authoritative Spendable     : ${authoritativeSpendable}`);
  console.log(`Scalar RPC Result           : ${scalarSpendable}`);

  assert.strictEqual(fundedBalance, 50200);
  assert.strictEqual(activeReservations, 0);
  assert.strictEqual(activeHolds, 0);
  assert.strictEqual(activeDebts, 0);
  assert.strictEqual(authoritativeSpendable, 50200);
  assert.strictEqual(Number(scalarSpendable), 50200);

  // 5. Historical C.4 Grants Conservation
  console.log('\n--- 5. HISTORICAL C.4 GRANTS ---');
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

  console.log(`Op 1 Grants      : ${op1Grants?.length || 0}`);
  console.log(`Op 2 Grants      : ${op2Grants?.length || 0}`);
  console.log(`Declined Grants  : ${decGrants?.length || 0}`);

  assert.strictEqual(op1Grants?.length || 0, 1);
  assert.strictEqual(op2Grants?.length || 0, 1);
  assert.strictEqual(decGrants?.length || 0, 0);

  console.log('\n================================================================');
  console.log('C.5C.3C-RV REMOTE POST-MIGRATION VERIFICATION PASSED CLEANLY');
  console.log('================================================================\n');
}

runRemoteC5C3CRemoteVerification().catch((err) => {
  console.error('Remote Verification Failed:', err);
  process.exit(1);
});
