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

  console.log('=== AUDITING LEDGER ENTRIES FOR ORG 00000000-0000-0000-0000-000000000001 ===\n');

  const { data: ledgerEntries, error: ledgerErr } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('id, entry_type, amount_minor, balance_after_minor, currency, description, reference_type, reference_id, created_at')
    .eq('organization_id', testOrgId)
    .order('created_at', { ascending: true });

  if (ledgerErr) {
    console.error('Error fetching ledger entries:', ledgerErr);
    return;
  }

  console.log(`Total ledger entries found: ${ledgerEntries?.length}`);
  ledgerEntries?.forEach((entry: any, index: number) => {
    console.log(`[${index + 1}] ID: ${entry.id} | Type: ${entry.entry_type} | Amt: ${entry.amount_minor} | BalAfter: ${entry.balance_after_minor} | Desc: ${entry.description} | RefType: ${entry.reference_type} | RefID: ${entry.reference_id} | CreatedAt: ${entry.created_at}`);
  });

  // Check all payment operations for this organization
  console.log('\n=== PAYMENT OPERATIONS ===\n');
  const { data: paymentOps, error: opsErr } = await (serviceSupabase as any)
    .from('billing_payment_operations')
    .select('id, operation_type, provider, provider_account_id, provider_payment_id, status, amount_minor, created_at, updated_at')
    .eq('organization_id', testOrgId)
    .order('created_at', { ascending: true });

  console.log(`Total payment operations found: ${paymentOps?.length}`);
  paymentOps?.forEach((op: any, index: number) => {
    console.log(`[${index + 1}] OpID: ${op.id} | Type: ${op.operation_type} | Status: ${op.status} | Amt: ${op.amount_minor} | ProviderPI: ${op.provider_payment_id} | ProviderAccount: ${op.provider_account_id} | CreatedAt: ${op.created_at} | UpdatedAt: ${op.updated_at}`);
  });
}

main().catch(console.error);
