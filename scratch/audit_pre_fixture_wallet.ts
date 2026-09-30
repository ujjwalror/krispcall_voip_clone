import fs from 'fs';
import path from 'path';

(globalThis as any).WebSocket = class {};

import { createClient } from '@supabase/supabase-js';

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
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

async function preFixtureAudit() {
  console.log('=== PRE-FIXTURE WALLET & TELECOM STATE AUDIT ===\n');
  const orgId = '00000000-0000-0000-0000-000000000001';

  // 1. Fetch Credit Ledger Entries
  const { data: ledgerEntries, error: ledgerErr } = await supabase
    .from('billing_credit_ledger')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

  console.log('1. Credit Ledger Entries:', { count: ledgerEntries?.length, ledgerErr, latest: ledgerEntries?.[0] });

  // 2. Fetch Active Telecom Reservations
  const { data: activeReservations, error: resErr } = await supabase
    .from('telecom_usage_reservations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'active');

  console.log('2. Active Reservations:', { count: activeReservations?.length, resErr });

  // 3. Fetch Provider Operations
  const { data: ops, error: opsErr } = await supabase
    .from('telecom_provider_operations')
    .select('*')
    .eq('organization_id', orgId);

  console.log('3. Provider Operations:', { count: ops?.length, opsErr });

  // 4. Fetch Existing Retail Rate Cards
  const { data: rates, error: rateErr } = await supabase
    .from('telecom_retail_rate_cards')
    .select('*')
    .eq('is_active', true);

  console.log('4. Active Retail Rate Cards in DB:', { count: rates?.length, rateErr });
}

preFixtureAudit().catch(console.error);
