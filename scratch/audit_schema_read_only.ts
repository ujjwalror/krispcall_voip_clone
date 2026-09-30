import fs from 'fs';
import path from 'path';

// Mock WebSocket globally for supabase-js in Node 20 environment
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

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

async function auditSchema() {
  console.log('=== READ-ONLY SCHEMA AUDIT ===');
  
  // 1. Check phone_numbers table for candidate number +61348328472
  const candidateNum = '+61348328472';
  const { data: phoneRows, error: phoneErr } = await supabase
    .from('phone_numbers')
    .select('*')
    .eq('phone_number', candidateNum);
    
  console.log('1. phone_numbers candidate query:', { rows: phoneRows, error: phoneErr });

  // 2. Check if phone_numbers table exists and its columns
  const { data: samplePhone, error: samplePhoneErr } = await supabase
    .from('phone_numbers')
    .select('*')
    .limit(1);
  console.log('2. phone_numbers sample/columns:', { samplePhone, samplePhoneErr });

  // 3. Check organizations table
  const { data: sampleOrg, error: sampleOrgErr } = await supabase
    .from('organizations')
    .select('*')
    .limit(1);
  console.log('3. organizations sample/columns:', { sampleOrg, sampleOrgErr });

  // 4. Check organization_members
  const { data: sampleMembers, error: membersErr } = await supabase
    .from('organization_members')
    .select('*')
    .limit(1);
  console.log('4. organization_members sample/columns:', { sampleMembers, membersErr });

  // 5. Check billing_credit_ledger
  const { data: sampleLedger, error: ledgerErr } = await supabase
    .from('billing_credit_ledger')
    .select('*')
    .limit(1);
  console.log('5. billing_credit_ledger sample/columns:', { sampleLedger, ledgerErr });

  // 6. Check telecom_wallets
  const { data: sampleWallets, error: walletErr } = await supabase
    .from('telecom_wallets')
    .select('*')
    .limit(1);
  console.log('6. telecom_wallets sample/columns:', { sampleWallets, walletErr });

  // 7. Check telecom_retail_rate_cards
  const { data: sampleRates, error: ratesErr } = await supabase
    .from('telecom_retail_rate_cards')
    .select('*')
    .limit(1);
  console.log('7. telecom_retail_rate_cards sample/columns:', { sampleRates, ratesErr });

  // 8. Check telecom_usage_sessions
  const { data: sampleSessions, error: sessionsErr } = await supabase
    .from('telecom_usage_sessions')
    .select('*')
    .limit(1);
  console.log('8. telecom_usage_sessions sample/columns:', { sampleSessions, sessionsErr });

  // 9. Check telecom_usage_components
  const { data: sampleComponents, error: componentsErr } = await supabase
    .from('telecom_usage_components')
    .select('*')
    .limit(1);
  console.log('9. telecom_usage_components sample/columns:', { sampleComponents, componentsErr });

  // 10. Check telecom_provider_operations
  const { data: sampleOps, error: opsErr } = await supabase
    .from('telecom_provider_operations')
    .select('*')
    .limit(1);
  console.log('10. telecom_provider_operations sample/columns:', { sampleOps, opsErr });

  // 11. Check telecom_provider_event_log
  const { data: sampleEvents, error: eventsErr } = await supabase
    .from('telecom_provider_event_log')
    .select('*')
    .limit(1);
  console.log('11. telecom_provider_event_log sample/columns:', { sampleEvents, eventsErr });
}

auditSchema().catch(console.error);
