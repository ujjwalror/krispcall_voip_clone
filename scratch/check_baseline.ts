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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SECRET_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

async function checkBaseline() {
  const orgId = '00000000-0000-0000-0000-000000000001';

  // 1. Wallet balance from billing_credit_ledger
  const { data: ledgerRows } = await supabase
    .from('billing_credit_ledger')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

  const currentBalance = ledgerRows?.[0]?.balance_after_minor || 0;

  // 1b. Wallets table if any
  const { data: wallet } = await supabase
    .from('wallets')
    .select('*')
    .eq('organization_id', orgId)
    .maybeSingle();

  // 2. Active usage reservations
  const { data: activeRes } = await supabase
    .from('telecom_usage_reservations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'active');

  // 3. Usable ARMED authorizations
  const { data: armedAuths } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'armed')
    .gt('expires_at', new Date().toISOString());

  // 4. Active CLAIMED authorizations
  const { data: claimedAuths } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'claimed')
    .gt('claim_expires_at', new Date().toISOString());

  // 5. Unresolved financial operations
  const { data: pendingOps } = await supabase
    .from('telecom_usage_reservations')
    .select('*')
    .eq('organization_id', orgId)
    .neq('status', 'settled')
    .neq('status', 'released');

  console.log('=== BASELINE QUERY RESULTS ===');
  console.log('Latest Ledger Row:', ledgerRows?.[0]);
  console.log('Calculated Ledger Balance:', currentBalance, 'minor USD');
  console.log('Wallets Table Record:', wallet);
  console.log('Active Reservations Count:', activeRes?.length || 0);
  console.log('Armed Auths Count:', armedAuths?.length || 0);
  console.log('Claimed Auths Count:', claimedAuths?.length || 0);
  console.log('Unsettled/Pending Reservations Count:', pendingOps?.length || 0);
}

checkBaseline().catch(console.error);
