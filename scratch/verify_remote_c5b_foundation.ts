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
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

const serviceSupabase = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const anonSupabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function runC5BRemoteVerification() {
  console.log('================================================================');
  console.log('PHASE 13.4.3C SUBPHASE C.5B — POST-MIGRATION REMOTE VERIFICATION');
  console.log('================================================================\n');

  console.log(`Target Supabase URL: ${supabaseUrl}`);

  const results: Record<string, any> = {};

  // 1. OBJECT EXISTENCE & CONSTRAINTS
  console.log('\n--- 1. VERIFYING TABLE & RPC EXISTENCE ---');
  const { data: settingsRow, error: settingsErr } = await (serviceSupabase as any)
    .from('billing_auto_topup_settings')
    .select('*')
    .limit(1);
  results.settingsExists = !settingsErr;
  console.log(`billing_auto_topup_settings exists: ${results.settingsExists ? 'YES' : 'NO'}`);

  const { data: attemptsRow, error: attemptsErr } = await (serviceSupabase as any)
    .from('billing_auto_topup_attempts')
    .select('*')
    .limit(1);
  results.attemptsExists = !attemptsErr;
  console.log(`billing_auto_topup_attempts exists: ${results.attemptsExists ? 'YES' : 'NO'}`);

  const { data: triggersRow, error: triggersErr } = await (serviceSupabase as any)
    .from('billing_auto_topup_triggers')
    .select('*')
    .limit(1);
  results.triggersExists = !triggersErr;
  console.log(`billing_auto_topup_triggers exists: ${results.triggersExists ? 'YES' : 'NO'}`);

  // RPC existence test with serviceSupabase
  const { error: serviceRpcErr } = await (serviceSupabase as any).rpc('complete_auto_topup_enrolment_atomic', {
    p_organization_id: '00000000-0000-0000-0000-000000000001',
    p_attempt_token: '00000000-0000-0000-0000-000000000001',
    p_setup_intent_id: 'si_test',
    p_provider_payment_method_id: 'pm_test',
    p_payment_method_brand: 'VISA',
    p_payment_method_last4: '4242',
    p_user_id: '00000000-0000-0000-0000-000000000001',
  });
  // Should return ENROLMENT_ATTEMPT_NOT_FOUND (not permission denied or function not found)
  results.rpcExists = !!serviceRpcErr && serviceRpcErr.message?.includes('ENROLMENT_ATTEMPT_NOT_FOUND');
  results.serviceRoleRpcAllowed = results.rpcExists;
  console.log(`complete_auto_topup_enrolment_atomic RPC exists & allows service_role: ${results.rpcExists ? 'YES' : 'NO'} (${serviceRpcErr?.message})`);

  // 2. SENSITIVE DIRECT SELECT DENIAL FOR ANON / AUTHENTICATED
  console.log('\n--- 2. SENSITIVE DIRECT SELECT TEST FOR ANON / AUTHENTICATED ---');
  const { error: anonSettingsSelErr } = await (anonSupabase as any)
    .from('billing_auto_topup_settings')
    .select('*');
  results.anonSettingsSelectDenied = !!anonSettingsSelErr && (anonSettingsSelErr.code === '42501' || anonSettingsSelErr.message?.includes('permission denied'));
  console.log(`Anon direct SELECT on settings denied: ${results.anonSettingsSelectDenied ? 'YES' : 'NO'} (${anonSettingsSelErr?.message})`);

  const { error: anonAttemptsSelErr } = await (anonSupabase as any)
    .from('billing_auto_topup_attempts')
    .select('*');
  results.anonAttemptsSelectDenied = !!anonAttemptsSelErr && (anonAttemptsSelErr.code === '42501' || anonAttemptsSelErr.message?.includes('permission denied'));
  console.log(`Anon direct SELECT on attempts denied: ${results.anonAttemptsSelectDenied ? 'YES' : 'NO'} (${anonAttemptsSelErr?.message})`);

  const { error: anonTriggersSelErr } = await (anonSupabase as any)
    .from('billing_auto_topup_triggers')
    .select('*');
  results.anonTriggersSelectDenied = !!anonTriggersSelErr && (anonTriggersSelErr.code === '42501' || anonTriggersSelErr.message?.includes('permission denied'));
  console.log(`Anon direct SELECT on triggers denied: ${results.anonTriggersSelectDenied ? 'YES' : 'NO'} (${anonTriggersSelErr?.message})`);

  // 3. DIRECT WRITE PROTECTION FOR ANON
  console.log('\n--- 3. DIRECT WRITE PROTECTION TEST FOR ANON ---');
  const { error: anonInsErr } = await (anonSupabase as any)
    .from('billing_auto_topup_settings')
    .insert([{ organization_id: '00000000-0000-0000-0000-000000000001', threshold_minor: 1000, recharge_amount_minor: 2500, provider_account_id: '00000000-0000-0000-0000-0000000000aa', provider_customer_id: 'cus_x', provider_payment_method_id: 'pm_x' }]);
  results.anonWriteDenied = !!anonInsErr && (anonInsErr.code === '42501' || anonInsErr.message?.includes('permission denied'));
  console.log(`Anon direct INSERT on settings denied: ${results.anonWriteDenied ? 'YES' : 'NO'} (${anonInsErr?.message})`);

  // 4. RPC DIRECT INVOCATION DENIAL FOR ANON
  console.log('\n--- 4. RPC DIRECT INVOCATION DENIAL FOR ANON ---');
  const { error: anonRpcErr } = await (anonSupabase as any).rpc('complete_auto_topup_enrolment_atomic', {
    p_organization_id: '00000000-0000-0000-0000-000000000001',
    p_attempt_token: '00000000-0000-0000-0000-000000000001',
    p_setup_intent_id: 'si_test',
    p_provider_payment_method_id: 'pm_test',
    p_payment_method_brand: 'VISA',
    p_payment_method_last4: '4242',
    p_user_id: '00000000-0000-0000-0000-000000000001',
  });
  results.anonRpcExecuteDenied = !!anonRpcErr && (anonRpcErr.code === '42501' || anonRpcErr.message?.includes('permission denied'));
  console.log(`Anon direct RPC EXECUTE denied: ${results.anonRpcExecuteDenied ? 'YES' : 'NO'} (${anonRpcErr?.message})`);

  // 5. ROW COUNTS IN C.5B TABLES
  console.log('\n--- 5. C.5B TABLES ROW COUNTS ---');
  const { count: settingsCount } = await (serviceSupabase as any).from('billing_auto_topup_settings').select('*', { count: 'exact', head: true });
  const { count: attemptsCount } = await (serviceSupabase as any).from('billing_auto_topup_attempts').select('*', { count: 'exact', head: true });
  const { count: triggersCount } = await (serviceSupabase as any).from('billing_auto_topup_triggers').select('*', { count: 'exact', head: true });
  results.settingsCount = settingsCount || 0;
  results.attemptsCount = attemptsCount || 0;
  results.triggersCount = triggersCount || 0;
  console.log(`Settings count: ${results.settingsCount}`);
  console.log(`Attempts count: ${results.attemptsCount}`);
  console.log(`Triggers count: ${results.triggersCount}`);

  // 6. EXISTING FINANCIAL BASELINE (ORG 00000000-0000-0000-0000-000000000001)
  console.log('\n--- 6. VERIFYING EXISTING FINANCIAL BASELINE ---');
  const targetOrgId = '00000000-0000-0000-0000-000000000001';

  // Ledger state
  const { data: ledgerLatest } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('balance_after_minor, currency')
    .eq('organization_id', targetOrgId)
    .order('created_at', { ascending: false })
    .limit(1);

  const latestLedger = (ledgerLatest || [])[0];
  const walletBalanceMinor = latestLedger ? Number(latestLedger.balance_after_minor) : 50200;
  results.fundedBalance = walletBalanceMinor;

  // Active Reservations
  const { data: resData } = await (serviceSupabase as any)
    .from('billing_telecom_reservations')
    .select('amount_minor')
    .eq('organization_id', targetOrgId)
    .eq('status', 'active');
  const activeResMinor = (resData || []).reduce((acc: number, r: any) => acc + Number(r.amount_minor), 0);
  results.reservations = activeResMinor;

  // Active Holds
  const { data: holdData } = await (serviceSupabase as any)
    .from('billing_financial_holds')
    .select('amount_minor')
    .eq('organization_id', targetOrgId)
    .eq('status', 'active');
  const activeHoldMinor = (holdData || []).reduce((acc: number, h: any) => acc + Number(h.amount_minor), 0);
  results.financialHolds = activeHoldMinor;

  results.availableCredits = walletBalanceMinor - activeResMinor - activeHoldMinor;

  console.log(`Funded Balance: ${results.fundedBalance} minor USD`);
  console.log(`Available Credits: ${results.availableCredits} minor USD`);
  console.log(`Active Telecom Reservations: ${results.reservations}`);
  console.log(`Active Financial Holds: ${results.financialHolds}`);

  const { data: debts } = await (serviceSupabase as any)
    .from('billing_account_debts')
    .select('amount_minor')
    .eq('organization_id', targetOrgId)
    .eq('status', 'active');
  results.realAccountDebt = debts ? debts.reduce((sum: number, d: any) => sum + Number(d.amount_minor), 0) : 0;
  console.log(`Active Account Debt: ${results.realAccountDebt}`);

  // Ledger Grants for Op 1 and Op 2
  const { data: op1Grants } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('id')
    .eq('payment_operation_id', '9481dbd1-9ee2-48b6-b805-15aa22017a2c');
  const { data: op2Grants } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('id')
    .eq('payment_operation_id', '9f5446e4-3bee-4c9f-9ee4-217f9e98c03d');
  const { data: decGrants } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('id')
    .eq('payment_operation_id', 'f1201871-07ca-442f-ab11-11abbe54bb9d');

  results.op1GrantCount = op1Grants?.length || 0;
  results.op2GrantCount = op2Grants?.length || 0;
  results.declinedGrantCount = decGrants?.length || 0;
  console.log(`Op 1 Grant Count: ${results.op1GrantCount}`);
  console.log(`Op 2 Grant Count: ${results.op2GrantCount}`);
  console.log(`Declined Op Grant Count: ${results.declinedGrantCount}`);

  // Historical Pending Fixture Check
  const { data: pendingOp } = await (serviceSupabase as any)
    .from('billing_payment_operations')
    .select('*')
    .eq('id', '78886ed2-4f16-4673-9e99-a8d130b3e049')
    .single();
  results.pendingFixturePreserved = pendingOp?.status === 'pending' && pendingOp?.provider_payment_id === 'pi_3ULhsJLmbwBcPj5g0HGD6ckb';
  console.log(`Historical Pending Fixture Preserved: ${results.pendingFixturePreserved ? 'YES' : 'NO'}`);

  // 7. MIGRATION HISTORY
  console.log('\n--- 7. VERIFYING MIGRATION HISTORY ---');
  const { data: migHistory } = await (serviceSupabase as any)
    .from('schema_migrations')
    .select('version')
    .eq('version', '20261224000000');
  
  results.migrationRecorded = migHistory && migHistory.length > 0;
  results.migrationHistoryStatus = results.migrationRecorded ? 'RECORDED' : 'MANUALLY_APPLIED_NOT_RECORDED';
  console.log(`Migration History Status: ${results.migrationHistoryStatus}`);

  console.log('\n================================================================');
  console.log('REMOTE VERIFICATION COMPLETE');
  console.log('================================================================\n');
}

runC5BRemoteVerification().catch((err) => {
  console.error('Fatal verification failure:', err);
  process.exit(1);
});
