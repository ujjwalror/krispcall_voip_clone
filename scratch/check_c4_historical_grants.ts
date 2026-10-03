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

async function runSanityCheck() {
  console.log('================================================================');
  console.log('C.4 HISTORICAL FINANCIAL SANITY FORENSIC CHECK');
  console.log('================================================================\n');

  const op1Id = '9481dbd1-9ee2-48b6-b805-15aa22017a2c';
  const op2Id = '9f5446e4-3bee-4c9f-9ee4-217f9e98c03d';
  const decId = 'f1201871-07ca-442f-ab11-11abbe54bb9d';
  const targetOrgId = '00000000-0000-0000-0000-000000000001';

  // 1. Inspect billing_payment_operations
  console.log('--- 1. INSPECTING PAYMENT OPERATIONS ---');
  const { data: op1, error: op1Err } = await (serviceSupabase as any)
    .from('billing_payment_operations')
    .select('*')
    .eq('id', op1Id)
    .single();

  console.log('Op 1:', op1 || op1Err);

  const { data: op2, error: op2Err } = await (serviceSupabase as any)
    .from('billing_payment_operations')
    .select('*')
    .eq('id', op2Id)
    .single();

  console.log('Op 2:', op2 || op2Err);

  const { data: decOp, error: decErr } = await (serviceSupabase as any)
    .from('billing_payment_operations')
    .select('*')
    .eq('id', decId)
    .single();

  console.log('Declined Op:', decOp || decErr);

  // 2. Inspect all billing_credit_ledger entries for target org
  console.log('\n--- 2. INSPECTING BILLING CREDIT LEDGER FOR ORG ---');
  const { data: ledgerRows, error: ledgerErr } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('*')
    .eq('organization_id', targetOrgId);

  console.log(`Total ledger rows for org: ${ledgerRows?.length || 0}`);
  if (ledgerRows) {
    for (const r of ledgerRows) {
      console.log('Ledger Row:', JSON.stringify(r));
    }
  }

  // 3. Inspect specific ledger entries
  console.log('\n--- 3. CHECKING SPECIFIC LEDGER ENTRY IDs ---');
  const op1LedgerId = 'f5246502-1fa4-4628-b6e2-4c43e03e71f7';
  const op2LedgerId = '2067d748-5449-40ee-b423-11390e8dbea3';

  const { data: l1 } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('*')
    .eq('id', op1LedgerId)
    .maybeSingle();
  console.log('Op 1 Ledger Entry (f5246502...):', l1);

  const { data: l2 } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('*')
    .eq('id', op2LedgerId)
    .maybeSingle();
  console.log('Op 2 Ledger Entry (2067d748...):', l2);
}

runSanityCheck().catch(console.error);
