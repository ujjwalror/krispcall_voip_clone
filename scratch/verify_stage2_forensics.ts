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
  const op1Id = '9481dbd1-9ee2-48b6-b805-15aa22017a2c';
  const op2Id = '9f5446e4-3bee-4c9f-9ee4-217f9e98c03d';
  const historicalOpId = '78886ed2-4f16-4673-9e99-a8d130b3e049';

  console.log('=== STAGE 2 FORENSIC VERIFICATION ===\n');

  // 1. Fetch Operation 1
  const { data: op1, error: op1Err } = await (serviceSupabase as any)
    .from('billing_payment_operations')
    .select('*')
    .eq('id', op1Id)
    .single();

  console.log('--- Operation 1 (9481dbd1...) ---');
  console.log('ID:', op1?.id);
  console.log('Created At:', op1?.created_at);
  console.log('Updated At:', op1?.updated_at);
  console.log('Operation Type:', op1?.operation_type);
  console.log('Status:', op1?.status);
  console.log('Amount Minor:', op1?.amount_minor);
  console.log('Currency:', op1?.currency);
  console.log('Provider Account ID:', op1?.provider_account_id);
  console.log('Provider Payment ID:', op1?.provider_payment_id);

  // 2. Fetch Ledger Entry 1
  const { data: ledger1Rows } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('*')
    .eq('organization_id', testOrgId)
    .eq('reference_type', 'payment_operation')
    .eq('reference_id', op1Id);

  console.log('Ledger entries for Op 1 count:', ledger1Rows?.length);
  if (ledger1Rows?.[0]) {
    console.log('Ledger 1 ID:', ledger1Rows[0].id);
    console.log('Ledger 1 Amount:', ledger1Rows[0].amount_minor);
    console.log('Ledger 1 Balance After:', ledger1Rows[0].balance_after_minor);
  }

  // 3. Fetch Operation 2
  const { data: op2, error: op2Err } = await (serviceSupabase as any)
    .from('billing_payment_operations')
    .select('*')
    .eq('id', op2Id)
    .single();

  console.log('\n--- Operation 2 (9f5446e4...) ---');
  console.log('ID:', op2?.id);
  console.log('Created At:', op2?.created_at);
  console.log('Updated At:', op2?.updated_at);
  console.log('Operation Type:', op2?.operation_type);
  console.log('Status:', op2?.status);
  console.log('Amount Minor:', op2?.amount_minor);
  console.log('Currency:', op2?.currency);
  console.log('Provider Account ID:', op2?.provider_account_id);
  console.log('Provider Payment ID:', op2?.provider_payment_id);

  // 4. Fetch Ledger Entry 2
  const { data: ledger2Rows } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('*')
    .eq('organization_id', testOrgId)
    .eq('reference_type', 'payment_operation')
    .eq('reference_id', op2Id);

  console.log('Ledger entries for Op 2 count:', ledger2Rows?.length);
  if (ledger2Rows?.[0]) {
    console.log('Ledger 2 ID:', ledger2Rows[0].id);
    console.log('Ledger 2 Amount:', ledger2Rows[0].amount_minor);
    console.log('Ledger 2 Balance After:', ledger2Rows[0].balance_after_minor);
  }

  // 5. Historical Pending Op Check
  const { data: histOp } = await (serviceSupabase as any)
    .from('billing_payment_operations')
    .select('id, status, provider_payment_id')
    .eq('id', historicalOpId)
    .single();

  console.log('\n--- Historical Audit Artifact ---');
  console.log('ID:', histOp?.id);
  console.log('Status:', histOp?.status);
  console.log('PI:', histOp?.provider_payment_id);

  // 6. Current Balance Check
  const { data: ledgerLatest } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('balance_after_minor')
    .eq('organization_id', testOrgId)
    .order('created_at', { ascending: false })
    .limit(1);

  const latestBal = Number(ledgerLatest?.[0]?.balance_after_minor || 0);
  console.log('\nCurrent Latest Wallet Balance Minor:', latestBal);
}

main().catch(console.error);
