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

async function runC5C2FVerification() {
  console.log('================================================================');
  console.log('PHASE 13.4.3C STAGE C.5C.2F — FINAL NARROW REMOTE VERIFICATION');
  console.log('================================================================\n');

  const targetOrgId = '00000000-0000-0000-0000-000000000001';

  // 1. Execute scalar get_spendable_credit_balance_minor for existing organization
  const { data: scalarSpendable, error: rpcErr } = await supabase.rpc('get_spendable_credit_balance_minor', {
    p_organization_id: targetOrgId,
  });

  if (rpcErr) {
    console.error('❌ FAIL: get_spendable_credit_balance_minor RPC execution error:', rpcErr.message);
    process.exit(1);
  }

  console.log(`✓ [1] Scalar RPC get_spendable_credit_balance_minor result: ${scalarSpendable} minor USD ($${(Number(scalarSpendable) / 100).toFixed(2)})`);
  assert.strictEqual(Number(scalarSpendable), 50200, 'Scalar spendable balance must equal 50200 minor USD');

  // 2. Cross-check Authoritative Wallet Balance
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

  console.log('\n--- 2. AUTHORITATIVE WALLET CROSS-CHECK ---');
  console.log(`Funded Balance              : ${fundedBalance}`);
  console.log(`Active Telecom Reservations : ${activeReservations}`);
  console.log(`Active Financial Holds      : ${activeHolds}`);
  console.log(`Account Debt                : ${activeDebts}`);
  console.log(`Authoritative Spendable     : ${authoritativeSpendable}`);
  console.log(`Scalar / Wallet Equality    : ${Number(scalarSpendable) === authoritativeSpendable ? 'PASS' : 'FAIL'}`);

  assert.strictEqual(fundedBalance, 50200, 'Funded balance must be 50200');
  assert.strictEqual(activeReservations, 0, 'Active reservations must be 0');
  assert.strictEqual(activeHolds, 0, 'Active holds must be 0');
  assert.strictEqual(activeDebts, 0, 'Account debt must be 0');
  assert.strictEqual(authoritativeSpendable, 50200, 'Authoritative spendable must be 50200');
  assert.strictEqual(Number(scalarSpendable), authoritativeSpendable, 'Scalar RPC and Authoritative balance must match');

  // 3. Auto Top-Up Settings & Trigger state
  const { data: settingsRow, error: settingsErr } = await (supabase as any)
    .from('billing_auto_topup_settings')
    .select('status, threshold_state, configuration_generation, payment_authorization_generation')
    .eq('organization_id', targetOrgId)
    .single();

  if (settingsErr) {
    console.error('Settings query error:', settingsErr.message);
    process.exit(1);
  }

  console.log('\n--- 3. AUTO TOP-UP STATE ---');
  console.log(`Status                          : ${settingsRow.status}`);
  console.log(`Threshold State                 : ${settingsRow.threshold_state}`);
  console.log(`Configuration Generation        : ${settingsRow.configuration_generation}`);
  console.log(`Payment Authorization Generation: ${settingsRow.payment_authorization_generation}`);

  assert.strictEqual(settingsRow.status, 'enabled', 'Settings status must be enabled');
  assert.strictEqual(settingsRow.threshold_state, 'ARMED', 'Threshold state must be ARMED');

  const { count: triggerCount } = await (supabase as any)
    .from('billing_auto_topup_triggers')
    .select('id', { count: 'exact' });

  const { count: autoOpsCount } = await (supabase as any)
    .from('billing_payment_operations')
    .select('id', { count: 'exact' })
    .not('auto_topup_trigger_id', 'is', null);

  console.log(`C.5C Trigger Count               : ${triggerCount || 0}`);
  console.log(`Autonomous Payment Operations    : ${autoOpsCount || 0}`);

  assert.strictEqual(triggerCount || 0, 0, 'C.5C Trigger count must be 0');
  assert.strictEqual(autoOpsCount || 0, 0, 'Autonomous Payment Operations count must be 0');

  // 4. Historical C.4 Accounting Verification
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

  console.log('\n--- 4. HISTORICAL C.4 ACCOUNTING ---');
  console.log(`Op 1 Grants      : ${op1Grants?.length || 0}`);
  console.log(`Op 2 Grants      : ${op2Grants?.length || 0}`);
  console.log(`Declined Grants  : ${decGrants?.length || 0}`);

  assert.strictEqual(op1Grants?.length || 0, 1, 'Op 1 must have exactly 1 grant');
  assert.strictEqual(op2Grants?.length || 0, 1, 'Op 2 must have exactly 1 grant');
  assert.strictEqual(decGrants?.length || 0, 0, 'Declined op must have 0 grants');

  console.log('\n================================================================');
  console.log('C.5C.2F FINAL NARROW REMOTE VERIFICATION PASSED CLEANLY');
  console.log('================================================================\n');
}

runC5C2FVerification().catch((err) => {
  console.error('C.5C.2F Verification Failed:', err);
  process.exit(1);
});
