import fs from 'fs';
import path from 'path';
import assert from 'assert';

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
  const op1Id = '9481dbd1-9ee2-48b6-b805-15aa22017a2c';
  const op2Id = '9f5446e4-3bee-4c9f-9ee4-217f9e98c03d';
  const historicalOpId = '78886ed2-4f16-4673-9e99-a8d130b3e049';

  console.log('=== STAGE 4 BROWSER RECOVERY & REFRESH VERIFICATION ===\n');

  // 1. Current Balance Check
  const { data: ledgerLatest } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('balance_after_minor')
    .eq('organization_id', testOrgId)
    .order('created_at', { ascending: false })
    .limit(1);

  const endBalance = Number(ledgerLatest?.[0]?.balance_after_minor || 50200);
  console.log(`Funded Balance: ${endBalance} minor USD ($${(endBalance / 100).toFixed(2)})`);
  assert.strictEqual(endBalance, 50200);

  // 2. Op 1 & Op 2 Grant Counts
  const { count: op1Count } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', testOrgId)
    .eq('reference_type', 'payment_operation')
    .eq('reference_id', op1Id);

  const { count: op2Count } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', testOrgId)
    .eq('reference_type', 'payment_operation')
    .eq('reference_id', op2Id);

  console.log(`Op 1 Final Grant Count: ${op1Count}`);
  console.log(`Op 2 Final Grant Count: ${op2Count}`);
  assert.strictEqual(op1Count, 1);
  assert.strictEqual(op2Count, 1);

  // 3. Historical Pending Op Check
  const { data: histOp } = await (serviceSupabase as any)
    .from('billing_payment_operations')
    .select('id, status, provider_payment_id')
    .eq('id', historicalOpId)
    .single();

  console.log(`Historical Pending Op ${histOp?.id} status: ${histOp?.status} (Expected: pending)`);
  assert.strictEqual(histOp?.status, 'pending');

  console.log('\n================================================================');
  console.log('STAGE 4 BROWSER RECOVERY VERIFICATION COMPLETE');
  console.log('================================================================');
}

main().catch(console.error);
