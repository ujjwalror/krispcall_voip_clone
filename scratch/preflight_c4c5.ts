import assert from 'assert';
import fs from 'fs';
import path from 'path';

(globalThis as any).WebSocket = class {};

import { createClient } from '@supabase/supabase-js';

// Load .env.local
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key && !process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
if (!stripeSecretKey) {
  console.error('PREFLIGHT FAIL: STRIPE_SECRET_KEY is missing');
  process.exit(1);
}

if (!stripeSecretKey.startsWith('sk_test_')) {
  console.error('PREFLIGHT FAIL: STRIPE_SECRET_KEY is NOT test mode! Prefix check failed.');
  process.exit(1);
}

console.log('STRIPE_MODE = test');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY!;
const adminSupabase = createClient(supabaseUrl, supabaseSecretKey, { auth: { persistSession: false } });

async function preflight() {
  const testOrgId = '00000000-0000-0000-0000-000000000001';

  // Read wallet summary
  const { data: summary, error: summaryErr } = await (adminSupabase as any).rpc(
    'get_telecom_wallet_summary_atomic',
    { p_organization_id: testOrgId }
  );

  if (summaryErr) {
    console.error('PREFLIGHT FAIL: Could not fetch wallet summary:', summaryErr.message);
    process.exit(1);
  }

  console.log('PRE_TEST_WALLET_SUMMARY:', JSON.stringify(summary));

  // Count ledger rows
  const { count: ledgerCount, error: ledgerErr } = await adminSupabase
    .from('billing_credit_ledger')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', testOrgId);

  if (ledgerErr) {
    console.error('PREFLIGHT FAIL: Could not fetch ledger count:', ledgerErr.message);
    process.exit(1);
  }

  console.log('PRE_TEST_LEDGER_COUNT:', ledgerCount);
}

preflight().catch((err) => {
  console.error('Preflight error:', err);
  process.exit(1);
});
