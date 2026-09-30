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

async function auditOrgAndFunding() {
  console.log('=== READ-ONLY AUDIT: ORG 00000000-0000-0000-0000-000000000001 & FUNDING PRIMITIVES ===\n');

  const testOrgId = '00000000-0000-0000-0000-000000000001';

  // 1. Audit Organization metadata
  const { data: orgData, error: orgErr } = await supabase
    .from('organizations')
    .select('*')
    .eq('id', testOrgId);
  console.log('1. Organization record:', { orgData, orgErr });

  // 2. Audit Profiles / Memberships for this Org
  const { data: profileData, error: profileErr } = await supabase
    .from('profiles')
    .select('*')
    .eq('organization_id', testOrgId);
  console.log('2. Profiles for Org:', { profileData, profileErr });

  // 3. Audit Phone Numbers for this Org
  const { data: phoneData, error: phoneErr } = await supabase
    .from('phone_numbers')
    .select('*')
    .eq('organization_id', testOrgId);
  console.log('3. Phone Numbers for Org:', { phoneData, phoneErr });

  // 4. Audit Billing Credit Ledger entries for this Org
  const { data: ledgerData, error: ledgerErr } = await supabase
    .from('billing_credit_ledger')
    .select('*')
    .eq('organization_id', testOrgId);
  console.log('4. Billing Credit Ledger entries:', { ledgerData, ledgerErr });

  // 5. Audit Retail Rate Cards
  const { data: rateData, error: rateErr } = await supabase
    .from('telecom_retail_rate_cards')
    .select('*')
    .limit(10);
  console.log('5. Retail Rate Cards in DB:', { rateData, rateErr });

}

auditOrgAndFunding().catch(console.error);
