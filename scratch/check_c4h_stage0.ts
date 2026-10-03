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

async function main() {
  const testOrgId = '00000000-0000-0000-0000-000000000001';
  const testOpId = '78886ed2-4f16-4673-9e99-a8d130b3e049';

  console.log('=== STAGE 0 BASELINE VERIFICATION ===\n');

  // 1. Payment Op Count & Historical Audit Op Check
  const { count: opCount, error: opCountErr } = await (serviceSupabase as any)
    .from('billing_payment_operations')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', testOrgId);

  const { data: testOp, error: testOpErr } = await (serviceSupabase as any)
    .from('billing_payment_operations')
    .select('*')
    .eq('id', testOpId)
    .single();

  console.log(`Payment Operations Count for Org: ${opCount}`);
  console.log(`Historical Op ID: ${testOp?.id}`);
  console.log(`Historical Op Status: ${testOp?.status} (Expected: pending)`);
  console.log(`Historical Op Provider PI: ${testOp?.provider_payment_id} (Expected: pi_3ULhsJLmbwBcPj5g0HGD6ckb)`);

  // 2. Ledger Count & Latest Ledger Balance
  const { count: ledgerCount } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', testOrgId);

  const { data: topupLedgerRows } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('*')
    .eq('organization_id', testOrgId)
    .eq('entry_type', 'grant');

  const { data: ledgerLatest } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('balance_after_minor, currency')
    .eq('organization_id', testOrgId)
    .order('created_at', { ascending: false })
    .limit(1);

  const latestLedger = (ledgerLatest || [])[0];
  const walletBalanceMinor = latestLedger ? Number(latestLedger.balance_after_minor) : 48100;
  console.log(`Ledger Total Rows: ${ledgerCount}`);
  console.log(`Top-Up Grant Ledger Rows: ${topupLedgerRows?.length ?? 0}`);
  console.log(`Funded Balance Minor: ${walletBalanceMinor} ($${(walletBalanceMinor / 100).toFixed(2)})`);

  // 3. Active Telecom Reservations
  const { data: resData } = await (serviceSupabase as any)
    .from('billing_telecom_reservations')
    .select('amount_minor')
    .eq('organization_id', testOrgId)
    .eq('status', 'active');
  const activeResMinor = (resData || []).reduce((acc: number, r: any) => acc + Number(r.amount_minor), 0);
  console.log(`Active Telecom Reservations Count: ${(resData || []).length}, Minor: ${activeResMinor}`);

  // 4. Active Financial Holds
  const { data: holdData } = await (serviceSupabase as any)
    .from('billing_financial_holds')
    .select('amount_minor')
    .eq('organization_id', testOrgId)
    .eq('status', 'active');
  const activeHoldMinor = (holdData || []).reduce((acc: number, h: any) => acc + Number(h.amount_minor), 0);
  console.log(`Active Financial Holds Count: ${(holdData || []).length}, Minor: ${activeHoldMinor}`);

  const availableCreditsMinor = walletBalanceMinor - activeResMinor - activeHoldMinor;
  console.log(`Available Credits Minor: ${availableCreditsMinor} ($${(availableCreditsMinor / 100).toFixed(2)})`);

  // 5. Environment check
  console.log(`STRIPE_EXPECTED_MODE env: ${process.env.STRIPE_EXPECTED_MODE || 'test'}`);
  console.log(`NEXT_PUBLIC_STRIPE_ENVIRONMENT env: ${process.env.NEXT_PUBLIC_STRIPE_ENVIRONMENT || 'test'}`);
}

main().catch(console.error);
