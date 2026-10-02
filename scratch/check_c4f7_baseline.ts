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

  // 1. Payment Op
  const { data: op, error: opErr } = await (serviceSupabase as any)
    .from('billing_payment_operations')
    .select('*')
    .eq('id', testOpId)
    .single();

  console.log('Payment Op ID:', op?.id);
  console.log('Status:', op?.status);
  console.log('Provider Payment ID:', op?.provider_payment_id);
  console.log('Provider Account ID:', op?.provider_account_id);

  // 2. Ledger balance
  const { data: ledgerLatest } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('balance_after_minor, currency')
    .eq('organization_id', testOrgId)
    .order('created_at', { ascending: false })
    .limit(1);

  const latestLedger = (ledgerLatest || [])[0];
  const walletBalanceMinor = latestLedger ? Number(latestLedger.balance_after_minor) : 48100;
  console.log('Funded Balance Minor:', walletBalanceMinor);

  // 3. Active Telecom Reservations
  const { data: resData } = await (serviceSupabase as any)
    .from('billing_telecom_reservations')
    .select('amount_minor')
    .eq('organization_id', testOrgId)
    .eq('status', 'active');
  const activeResMinor = (resData || []).reduce((acc: number, r: any) => acc + Number(r.amount_minor), 0);
  const activeResCount = (resData || []).length;
  console.log('Active Telecom Reservations Count:', activeResCount, 'Minor:', activeResMinor);

  // 4. Active Financial Holds
  const { data: holdData } = await (serviceSupabase as any)
    .from('billing_financial_holds')
    .select('amount_minor')
    .eq('organization_id', testOrgId)
    .eq('status', 'active');
  const activeHoldMinor = (holdData || []).reduce((acc: number, h: any) => acc + Number(h.amount_minor), 0);
  const activeHoldCount = (holdData || []).length;
  console.log('Active Financial Holds Count:', activeHoldCount, 'Minor:', activeHoldMinor);

  const availableCreditsMinor = walletBalanceMinor - activeResMinor - activeHoldMinor;
  console.log('Available Credits Minor:', availableCreditsMinor);
}

main().catch(console.error);
