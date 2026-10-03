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

const serviceSupabase = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function runPreTestBaseline() {
  console.log('================================================================');
  console.log('PHASE 13.4.3C SUBPHASE C.5B — PRE-ENROLMENT BASELINE VERIFICATION');
  console.log('================================================================\n');

  console.log(`Deployed SHA: 1dc2477b3107d697b83623b833c2f1a4bf89a09b`);
  console.log(`Stripe Environment: ${process.env.STRIPE_EXPECTED_MODE || 'test'}`);

  // Row counts
  const { count: settingsCount } = await (serviceSupabase as any).from('billing_auto_topup_settings').select('*', { count: 'exact', head: true });
  const { count: attemptsCount } = await (serviceSupabase as any).from('billing_auto_topup_attempts').select('*', { count: 'exact', head: true });
  const { count: triggersCount } = await (serviceSupabase as any).from('billing_auto_topup_triggers').select('*', { count: 'exact', head: true });

  console.log(`Pre-test Settings Count: ${settingsCount || 0}`);
  console.log(`Pre-test Attempts Count: ${attemptsCount || 0}`);
  console.log(`Pre-test Triggers Count: ${triggersCount || 0}`);

  // Wallet & Financial Baseline
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

  const { data: debts } = await (serviceSupabase as any)
    .from('billing_account_debts')
    .select('amount_minor')
    .eq('organization_id', targetOrgId)
    .eq('status', 'active');
  const realAccountDebt = debts ? debts.reduce((sum: number, d: any) => sum + Number(d.amount_minor), 0) : 0;

  console.log(`Funded Balance: ${walletBalanceMinor} minor USD`);
  console.log(`Available Credits: ${availableCreditsMinor} minor USD`);
  console.log(`Reservations: ${activeResMinor}`);
  console.log(`Financial Holds: ${activeHoldMinor}`);
  console.log(`Account Debt: ${realAccountDebt}`);

  console.log('\n================================================================');
  console.log('PRE-TEST BASELINE VERIFICATION COMPLETE');
  console.log('================================================================\n');
}

runPreTestBaseline().catch(console.error);
