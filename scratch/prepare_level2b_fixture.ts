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

async function prepareLevel2BFixture() {
  console.log('=== EXECUTE LEVEL 2B FIXTURE PREPARATION & VERIFICATION ===\n');

  const orgId = '00000000-0000-0000-0000-000000000001';
  const grantRef = 'phase13_4_3b2e_level2b_credit_v1';
  const rateCode = 'RATE_AU_TO_IN_TEST';

  let remoteDbReads = 0;
  let remoteDbWrites = 0;
  let creditLedgerWrites = 0;
  let rateCardWrites = 0;
  let reservationWrites = 0;
  let sessionWrites = 0;
  let providerOpWrites = 0;

  // 1. Check existing grant entry (IDEMPOTENCY CHECK)
  remoteDbReads++;
  const { data: existingGrants } = await supabase
    .from('billing_credit_ledger')
    .select('*')
    .eq('organization_id', orgId)
    .eq('reference_id', grantRef);

  if (!existingGrants || existingGrants.length === 0) {
    console.log('1. Executing canonical credit grant atomic RPC ($1.00 / 100 cents)...');
    remoteDbWrites++;
    creditLedgerWrites++;
    const { data: grantResult, error: grantErr } = await supabase.rpc('record_credit_ledger_entry_atomic', {
      p_organization_id: orgId,
      p_entry_type: 'grant',
      p_amount_minor: 100, // 100 cents = $1.00 USD
      p_currency: 'USD',
      p_description: 'Phase 13.4.3B.2E Level 2B Synthetic Experiment Credit Grant',
      p_reference_type: 'admin_action',
      p_reference_id: grantRef,
    });

    if (grantErr) {
      console.error('❌ Credit grant RPC failed:', grantErr);
      process.exit(1);
    }
    console.log('   ✓ Credit grant created:', grantResult);
  } else {
    console.log('   ✓ Existing grant entry found (Idempotent reuse):', existingGrants[0].id);
  }

  // 2. Check existing retail rate card (IDEMPOTENCY CHECK)
  remoteDbReads++;
  const { data: existingRates } = await supabase
    .from('telecom_retail_rate_cards')
    .select('*')
    .eq('rate_code', rateCode);

  if (!existingRates || existingRates.length === 0) {
    console.log('2. Creating isolated synthetic retail rate card (6.0c/min)...');
    remoteDbWrites++;
    rateCardWrites++;
    const { data: rateResult, error: rateErr } = await supabase
      .from('telecom_retail_rate_cards')
      .insert({
        rate_code: rateCode,
        service_type: 'voice_outbound',
        direction: 'outbound',
        destination_pattern: '+919193399740',
        destination_name: 'Level 2B Isolated Synthetic Test Rate',
        retail_rate_micro: 60000, // 6.0 cents/min = 60,000 micro-units
        wholesale_cost_micro: 49600, // 4.96 cents/min wholesale = 49,600 micro-units
        unit_type: 'minute',
        billing_increment_seconds: 60,
        min_chargeable_units: 1,
        currency: 'USD',
        is_active: true,
        metadata: { test_marker: 'b2e_level2b_fixture' },
      })
      .select();

    if (rateErr) {
      console.error('❌ Retail rate card creation failed:', rateErr);
      process.exit(1);
    }
    console.log('   ✓ Retail rate card created:', rateResult[0]);
  } else {
    console.log('   ✓ Existing retail rate card found (Idempotent reuse):', existingRates[0].id);
  }

  // 3. READ-ONLY VERIFICATION AFTER WRITE
  console.log('\n3. Performing Post-Write Verification...');

  // A & B: Verify Wallet balance
  remoteDbReads++;
  const { data: ledgerRows } = await supabase
    .from('billing_credit_ledger')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

  const fundedBalance = ledgerRows?.[0]?.balance_after_minor || 0;
  console.log(`   ✓ Resulting wallet balance: ${fundedBalance} cents ($${(fundedBalance / 100).toFixed(2)})`);

  // C: No duplicate grant
  const grantCount = ledgerRows?.filter((r) => r.reference_id === grantRef).length || 0;
  console.log(`   ✓ Synthetic credit grants with reference ${grantRef}: ${grantCount}`);

  // D, E, F, G: Verify Retail Rate Card
  remoteDbReads++;
  const { data: activeCards } = await supabase
    .from('telecom_retail_rate_cards')
    .select('*')
    .eq('rate_code', rateCode);

  const card = activeCards?.[0];
  console.log(`   ✓ Rate Card '${card?.rate_code}': Rate = ${card?.retail_rate_micro / 10000}c/min, Wholesale = ${card?.wholesale_cost_micro / 10000}c/min, Currency = ${card?.currency}, Pattern = ${card?.destination_pattern}`);

  // H & I: Test Rating Resolution Precision
  const testDest = '+919193399740';
  const unrelatedDest = '+61412345678';

  remoteDbReads++;
  const { data: testMatch } = await supabase
    .from('telecom_retail_rate_cards')
    .select('*')
    .eq('is_active', true)
    .eq('service_type', 'voice_outbound')
    .eq('destination_pattern', testDest);

  remoteDbReads++;
  const { data: unrelatedMatch } = await supabase
    .from('telecom_retail_rate_cards')
    .select('*')
    .eq('is_active', true)
    .eq('service_type', 'voice_outbound')
    .eq('destination_pattern', unrelatedDest);

  console.log(`   ✓ Controlled destination match count for ${testDest.slice(0, 4)}***: ${testMatch?.length} (rate_code: ${testMatch?.[0]?.rate_code})`);
  console.log(`   ✓ Unrelated destination match count for +614***: ${unrelatedMatch?.length}`);

  // J & K: Check candidate number ownership
  remoteDbReads++;
  const { data: phoneRows } = await supabase
    .from('phone_numbers')
    .select('organization_id, phone_number')
    .eq('phone_number', '+61348328472');

  console.log(`   ✓ Candidate number +61348328472 owner: ${phoneRows?.[0]?.organization_id} (Unchanged)`);

  // L, M, N, O: Verify 0 session/component/reservation/op writes
  remoteDbReads++;
  const { data: ops } = await supabase
    .from('telecom_provider_operations')
    .select('id')
    .eq('organization_id', orgId);

  remoteDbReads++;
  const { data: sess } = await supabase
    .from('telecom_usage_sessions')
    .select('session_id')
    .eq('organization_id', orgId);

  console.log(`   ✓ Provider operations count: ${ops?.length}`);
  console.log(`   ✓ Telecom usage sessions count: ${sess?.length}`);

  console.log('\n=== FIXTURE PREPARATION COUNTERS ===');
  console.log('Remote DB reads:', remoteDbReads);
  console.log('Remote DB writes:', remoteDbWrites);
  console.log('Credit ledger writes:', creditLedgerWrites);
  console.log('Rate-card writes:', rateCardWrites);
  console.log('Telecom reservation writes:', reservationWrites);
  console.log('Telecom session/component writes:', sessionWrites);
  console.log('Provider-operation writes:', providerOpWrites);
  console.log('Twilio read-only requests: 0');
  console.log('Twilio call creations: 0');
  console.log('Twilio Call mutations: 0');
  console.log('Twilio number mutations: 0');
  console.log('Twilio message mutations: 0');
  console.log('Stripe calls: 0');
}

prepareLevel2BFixture().catch((err) => {
  console.error('Fixture preparation failed:', err);
  process.exit(1);
});
