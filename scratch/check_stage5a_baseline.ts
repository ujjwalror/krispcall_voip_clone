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

  console.log('=== STAGE 5A PRE-DECLINE BASELINE RECORDING ===\n');

  // 1. Balance
  const { data: ledgerLatest } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('balance_after_minor')
    .eq('organization_id', testOrgId)
    .order('created_at', { ascending: false })
    .limit(1);

  const fundedBalance = Number(ledgerLatest?.[0]?.balance_after_minor || 50200);
  console.log(`Funded Balance: ${fundedBalance} minor USD ($${(fundedBalance / 100).toFixed(2)})`);

  // 2. Ledger Count
  const { count: ledgerCount } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', testOrgId);

  console.log(`Top-Up Ledger Total Count: ${ledgerCount}`);

  // 3. Payment Operations Count
  const { count: opCount } = await (serviceSupabase as any)
    .from('billing_payment_operations')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', testOrgId);

  const { count: capturedOpCount } = await (serviceSupabase as any)
    .from('billing_payment_operations')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', testOrgId)
    .eq('status', 'captured');

  console.log(`Payment Operations Total Count: ${opCount}`);
  console.log(`Captured Payment Operations Count: ${capturedOpCount}`);

  // 4. Stripe Environment
  console.log(`STRIPE_EXPECTED_MODE env: ${process.env.STRIPE_EXPECTED_MODE || 'test'}`);
  console.log(`NEXT_PUBLIC_STRIPE_ENVIRONMENT env: ${process.env.NEXT_PUBLIC_STRIPE_ENVIRONMENT || 'test'}`);
}

main().catch(console.error);
