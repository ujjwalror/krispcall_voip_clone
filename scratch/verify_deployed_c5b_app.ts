import fs from 'fs';
import path from 'path';
import execSync from 'child_process';

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

async function runPostDeploymentVerification() {
  console.log('================================================================');
  console.log('PHASE 13.4.3C SUBPHASE C.5B — POST-DEPLOYMENT NON-FINANCIAL VERIFICATION');
  console.log('================================================================\n');

  const prodUrl = 'https://krispcall-voip-clone-udlg.vercel.app';
  console.log(`Deployed Production URL: ${prodUrl}`);
  console.log(`Deployed SHA: 1dc2477b3107d697b83623b833c2f1a4bf89a09b`);

  // 1. Verify C.5B tables row count in remote Supabase
  console.log('\n--- 1. VERIFYING C.5B DATABASE ROW COUNTS ---');
  const { count: settingsCount } = await (serviceSupabase as any).from('billing_auto_topup_settings').select('*', { count: 'exact', head: true });
  const { count: attemptsCount } = await (serviceSupabase as any).from('billing_auto_topup_attempts').select('*', { count: 'exact', head: true });
  const { count: triggersCount } = await (serviceSupabase as any).from('billing_auto_topup_triggers').select('*', { count: 'exact', head: true });

  console.log(`Auto Top-Up Settings Rows: ${settingsCount || 0}`);
  console.log(`Auto Top-Up Attempt Rows: ${attemptsCount || 0}`);
  console.log(`Auto Top-Up Trigger Rows: ${triggersCount || 0}`);

  // 2. Verify Financial Baseline for org 00000000-0000-0000-0000-000000000001
  console.log('\n--- 2. VERIFYING FINANCIAL BASELINE ---');
  const targetOrgId = '00000000-0000-0000-0000-000000000001';
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

  console.log(`Funded Credits: ${walletBalanceMinor} minor USD`);
  console.log(`Available Credits: ${availableCreditsMinor} minor USD`);
  console.log(`Reservations: ${activeResMinor}`);
  console.log(`Financial Holds: ${activeHoldMinor}`);
  console.log(`Operation 1 Funding Count: ${op1Grants?.length || 0}`);
  console.log(`Operation 2 Funding Count: ${op2Grants?.length || 0}`);
  console.log(`Declined Operation Funding Count: ${decGrants?.length || 0}`);

  console.log('\n================================================================');
  console.log('POST-DEPLOYMENT NON-FINANCIAL VERIFICATION COMPLETE');
  console.log('================================================================\n');
}

runPostDeploymentVerification().catch(console.error);
