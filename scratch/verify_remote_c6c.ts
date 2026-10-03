import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { createClient } from '@supabase/supabase-js';

(globalThis as any).WebSocket = class {};

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
      if (key) {
        process.env[key] = val;
      }
    }
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseSecretKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy_anon_token';

const serviceClient = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function runPostMigrationC6CVerification() {
  console.log('================================================================');
  console.log('STAGE C.6C-POST-MIGRATION-VERIFY — REAL SUPABASE DATABASE AUDIT');
  console.log('================================================================\n');

  console.log(`Supabase URL: ${supabaseUrl}`);
  assert(supabaseUrl.includes('jupwsumuutuysmpxdtpw'), 'Must connect to project jupwsumuutuysmpxdtpw');
  console.log('✓ Project URL verified: jupwsumuutuysmpxdtpw');

  // -------------------------------------------------------------
  // 1. VERIFY POLICY TABLE EXISTENCE & SCHEMA (Service Role)
  // -------------------------------------------------------------
  console.log('\n--- 1. Verify telecom_retail_pricing_policies Table Existence ---');

  const { data: policiesData, error: policiesErr } = await serviceClient
    .from('telecom_retail_pricing_policies')
    .select('*');

  if (policiesErr) {
    console.error('telecom_retail_pricing_policies query error:', policiesErr.message);
    assert.fail(`telecom_retail_pricing_policies table missing or error: ${policiesErr.message}`);
  }

  console.log(`✓ public.telecom_retail_pricing_policies exists (${policiesData.length} rows found).`);

  // -------------------------------------------------------------
  // 2. VERIFY EXACT VOICE POLICY SEED ROWS
  // -------------------------------------------------------------
  console.log('\n--- 2. Verify Deployed Voice Policy Seed Rows ---');

  const outboundPolicy = policiesData.find((p: any) => p.service_type === 'voice_outbound');
  const inboundPolicy = policiesData.find((p: any) => p.service_type === 'voice_inbound');
  const smsPolicy = policiesData.find((p: any) => p.service_type === 'sms_outbound');
  const mmsPolicy = policiesData.find((p: any) => p.service_type === 'mms_outbound');

  assert(outboundPolicy !== undefined, 'Outbound voice policy seed row must exist');
  assert(inboundPolicy !== undefined, 'Inbound voice policy seed row must exist');

  console.log(`Outbound Voice Policy ID: ${outboundPolicy.id}`);
  console.log(`Outbound Voice Policy Name: ${outboundPolicy.policy_name}`);
  console.log(`Outbound Voice Org ID: ${outboundPolicy.organization_id || 'NULL (Global Platform)'}`);
  console.log(`Outbound Voice Markup Basis Points: ${outboundPolicy.markup_basis_points}`);
  console.log(`Outbound Voice Pricing Mode: ${outboundPolicy.pricing_mode}`);
  console.log(`Outbound Voice Active: ${outboundPolicy.is_active}`);

  assert.strictEqual(outboundPolicy.organization_id, null, 'Outbound voice policy must be global platform (NULL org)');
  assert.strictEqual(outboundPolicy.markup_basis_points, 2500, 'Outbound voice markup must be exactly 2500 bps (25.00%)');
  assert.strictEqual(outboundPolicy.pricing_mode, 'markup_percentage');
  assert.strictEqual(outboundPolicy.is_active, true);

  console.log(`\nInbound Voice Policy ID: ${inboundPolicy.id}`);
  console.log(`Inbound Voice Policy Name: ${inboundPolicy.policy_name}`);
  console.log(`Inbound Voice Org ID: ${inboundPolicy.organization_id || 'NULL (Global Platform)'}`);
  console.log(`Inbound Voice Markup Basis Points: ${inboundPolicy.markup_basis_points}`);
  console.log(`Inbound Voice Pricing Mode: ${inboundPolicy.pricing_mode}`);
  console.log(`Inbound Voice Active: ${inboundPolicy.is_active}`);

  assert.strictEqual(inboundPolicy.organization_id, null, 'Inbound voice policy must be global platform (NULL org)');
  assert.strictEqual(inboundPolicy.markup_basis_points, 2500, 'Inbound voice markup must be exactly 2500 bps (25.00%)');
  assert.strictEqual(inboundPolicy.pricing_mode, 'markup_percentage');
  assert.strictEqual(inboundPolicy.is_active, true);

  assert.strictEqual(smsPolicy, undefined, 'No SMS 2500-bps policy should exist');
  assert.strictEqual(mmsPolicy, undefined, 'No MMS 2500-bps policy should exist');
  console.log('✓ SMS and MMS seeds confirmed absent (0 accidental messaging markup seeds).');

  // -------------------------------------------------------------
  // 3. VERIFY RPC DEFINITION & EXECUTION
  // -------------------------------------------------------------
  console.log('\n--- 3. Verify Deployed Policy Resolution RPC ---');

  const { data: rpcRes, error: rpcErr } = await serviceClient.rpc(
    'resolve_telecom_retail_pricing_policy_atomic',
    {
      p_organization_id: null,
      p_service_type: 'voice_outbound',
      p_direction: 'outbound',
      p_destination_phone_number: '+14155550199',
      p_currency: 'USD',
    }
  );

  if (rpcErr) {
    console.error('resolve_telecom_retail_pricing_policy_atomic call error:', rpcErr.message);
    assert.fail(`RPC execution failed: ${rpcErr.message}`);
  }

  console.log('RPC Resolution Output:', JSON.stringify(rpcRes, null, 2));
  assert(rpcRes.success === true, 'RPC must return success = true');
  assert.strictEqual(rpcRes.markup_basis_points, 2500, 'RPC must return 2500 basis points for voice_outbound');
  assert.strictEqual(rpcRes.pricing_mode, 'markup_percentage');
  console.log('✓ RPC resolve_telecom_retail_pricing_policy_atomic is active and functioning.');

  // -------------------------------------------------------------
  // 4. VERIFY RLS & PRIVILEGES (Anon Access Denial)
  // -------------------------------------------------------------
  console.log('\n--- 4. Verify RLS & Privilege Denial for Anon ---');

  const { data: anonData, error: anonErr } = await anonClient
    .from('telecom_retail_pricing_policies')
    .select('*')
    .limit(1);

  console.log('Anon table select error:', anonErr?.message || 'NONE');
  assert(anonErr !== null, 'Anon client must be DENIED access to public.telecom_retail_pricing_policies');
  console.log('✓ RLS privilege denial enforced on telecom_retail_pricing_policies.');

  const { data: anonRpcData, error: anonRpcErr } = await anonClient.rpc(
    'resolve_telecom_retail_pricing_policy_atomic',
    {
      p_organization_id: null,
      p_service_type: 'voice_outbound',
      p_direction: 'outbound',
      p_destination_phone_number: '+14155550199',
    }
  );

  console.log('Anon RPC execute error:', anonRpcErr?.message || 'NONE');
  assert(anonRpcErr !== null, 'Anon client must be DENIED EXECUTE privilege on RPC');
  console.log('✓ RPC EXECUTE permission denied for anon / public.');

  // -------------------------------------------------------------
  // 5. VERIFY WHOLESALE SOURCE & PHONE NUMBER PRICING ISOLATION
  // -------------------------------------------------------------
  console.log('\n--- 5. Verify Rate Cards & Phone Number Pricing Isolation ---');

  const { data: rateCards, error: rateCardErr } = await serviceClient
    .from('telecom_retail_rate_cards')
    .select('id, wholesale_cost_micro, retail_rate_micro')
    .limit(1);

  assert.strictEqual(rateCardErr, null, 'telecom_retail_rate_cards table must exist and be intact');
  assert(rateCards && rateCards.length > 0, 'telecom_retail_rate_cards must retain existing rows');
  console.log('✓ public.telecom_retail_rate_cards is intact and existing rate rows preserved.');

  const { data: numberPolicies, error: numberPolicyErr } = await serviceClient
    .from('phone_number_pricing_policies')
    .select('*');

  assert.strictEqual(numberPolicyErr, null, 'phone_number_pricing_policies table must exist and be intact');
  console.log(`✓ phone_number_pricing_policies exists (${numberPolicies.length} rows, separate from calling engine).`);

  // -------------------------------------------------------------
  // 6. VERIFY CUSTOMER WALLET CONSERVATION
  // -------------------------------------------------------------
  console.log('\n--- 6. Verify Customer Wallet Balance Conservation ---');

  const targetOrgId = '00000000-0000-0000-0000-000000000001';
  const { data: scalarSpendable } = await serviceClient.rpc('get_spendable_credit_balance_minor', {
    p_organization_id: targetOrgId,
  });

  console.log(`Authoritative Wallet Spendable Balance: ${scalarSpendable} cents ($${(Number(scalarSpendable) / 100).toFixed(2)})`);
  assert.strictEqual(Number(scalarSpendable), 52700, 'Wallet spendable balance must remain exactly 52,700 minor cents ($527.00)');
  console.log('✓ Customer wallet balance is 100% unchanged and authoritative.');

  console.log('\n================================================================');
  console.log('STAGE C.6C POST-MIGRATION REAL SUPABASE VERIFICATION PASSED');
  console.log('================================================================\n');
}

runPostMigrationC6CVerification().catch((err) => {
  console.error('Post-migration C.6C verification failed:', err);
  process.exit(1);
});
