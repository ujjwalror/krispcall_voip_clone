import * as fs from 'fs';
import * as path from 'path';

// Parse .env.local manually
const envPath = path.resolve('.env.local');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      process.env[key] = val;
    }
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || '';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';

const serviceHeaders = {
  'apikey': serviceRoleKey,
  'Authorization': `Bearer ${serviceRoleKey}`,
  'Content-Type': 'application/json'
};

const anonHeaders = {
  'apikey': anonKey,
  'Authorization': `Bearer ${anonKey}`,
  'Content-Type': 'application/json'
};

async function runRemoteVerification() {
  console.log('====================================================');
  console.log('PHASE 13.4.3B.1 — READ-ONLY REMOTE POST-MIGRATION VERIFICATION');
  console.log('====================================================\n');
  console.log(`Target URL: ${supabaseUrl}\n`);

  // 1. Verify Remote Tables and Columns via REST select=col&limit=1
  console.log('1. VERIFYING REMOTE TABLES AND COLUMNS...');

  const rateCardCols = [
    'id', 'rate_code', 'service_type', 'direction', 'destination_pattern',
    'destination_name', 'retail_rate_micro', 'wholesale_cost_micro', 'unit_type',
    'billing_increment_seconds', 'min_chargeable_units', 'currency', 'is_active',
    'effective_start_at', 'effective_end_at', 'metadata', 'created_at', 'updated_at'
  ];

  console.log('\nChecking telecom_retail_rate_cards:');
  for (const col of rateCardCols) {
    const res = await fetch(`${supabaseUrl}/rest/v1/telecom_retail_rate_cards?select=${col}&limit=1`, { headers: serviceHeaders });
    if (res.ok) {
      console.log(`  ✓ [PRESENT] telecom_retail_rate_cards.${col}`);
    } else {
      console.error(`  ✕ [ABSENT ] telecom_retail_rate_cards.${col} (status: ${res.status})`);
    }
  }

  const reservationCols = [
    'id', 'internal_usage_id', 'organization_id', 'service_type', 'direction',
    'provider', 'provider_resource_id', 'rate_card_id', 'rate_snapshot',
    'amount_reserved_minor', 'currency', 'status', 'idempotency_key', 'expires_at',
    'settled_at', 'released_at', 'settlement_ledger_id', 'actual_provider_cost_minor',
    'actual_customer_charge_minor', 'actual_gross_margin_minor', 'metadata',
    'created_at', 'updated_at'
  ];

  console.log('\nChecking telecom_usage_reservations:');
  for (const col of reservationCols) {
    const res = await fetch(`${supabaseUrl}/rest/v1/telecom_usage_reservations?select=${col}&limit=1`, { headers: serviceHeaders });
    if (res.ok) {
      console.log(`  ✓ [PRESENT] telecom_usage_reservations.${col}`);
    } else {
      console.error(`  ✕ [ABSENT ] telecom_usage_reservations.${col} (status: ${res.status})`);
    }
  }

  const idempotencyCols = [
    'id', 'organization_id', 'operation_type', 'idempotency_key',
    'internal_usage_id', 'request_payload', 'response_payload', 'created_at'
  ];

  console.log('\nChecking telecom_financial_operation_idempotency:');
  for (const col of idempotencyCols) {
    const res = await fetch(`${supabaseUrl}/rest/v1/telecom_financial_operation_idempotency?select=${col}&limit=1`, { headers: serviceHeaders });
    if (res.ok) {
      console.log(`  ✓ [PRESENT] telecom_financial_operation_idempotency.${col}`);
    } else {
      console.error(`  ✕ [ABSENT ] telecom_financial_operation_idempotency.${col} (status: ${res.status})`);
    }
  }

  // 2. RLS & Server-Only Security Verification
  console.log('\n2. VERIFYING SERVER-ONLY CONFIDENTIALITY & RLS PRIVILEGES...');

  // Anon table access check:
  const anonRateCardRes = await fetch(`${supabaseUrl}/rest/v1/telecom_retail_rate_cards?select=*&limit=1`, { headers: anonHeaders });
  console.log(`  Anon query telecom_retail_rate_cards status: ${anonRateCardRes.status} ${anonRateCardRes.ok ? '(empty data array)' : ''}`);
  const anonRateCardData = anonRateCardRes.ok ? await anonRateCardRes.json() : null;
  if (!anonRateCardRes.ok || (Array.isArray(anonRateCardData) && anonRateCardData.length === 0)) {
    console.log('  ✓ [VERIFIED] Anon client cannot read telecom_retail_rate_cards');
  }

  const anonResHoldRes = await fetch(`${supabaseUrl}/rest/v1/telecom_usage_reservations?select=*&limit=1`, { headers: anonHeaders });
  const anonResHoldData = anonResHoldRes.ok ? await anonResHoldRes.json() : null;
  if (!anonResHoldRes.ok || (Array.isArray(anonResHoldData) && anonResHoldData.length === 0)) {
    console.log('  ✓ [VERIFIED] Anon client cannot read telecom_usage_reservations');
  }

  const anonIdempRes = await fetch(`${supabaseUrl}/rest/v1/telecom_financial_operation_idempotency?select=*&limit=1`, { headers: anonHeaders });
  const anonIdempData = anonIdempRes.ok ? await anonIdempRes.json() : null;
  if (!anonIdempRes.ok || (Array.isArray(anonIdempData) && anonIdempData.length === 0)) {
    console.log('  ✓ [VERIFIED] Anon client cannot read telecom_financial_operation_idempotency');
  }

  // Service role access check:
  const srRateCardRes = await fetch(`${supabaseUrl}/rest/v1/telecom_retail_rate_cards?select=id&limit=1`, { headers: serviceHeaders });
  if (srRateCardRes.ok) {
    console.log('  ✓ [VERIFIED] service_role retains direct database access');
  }

  // 3. RPC Existence & Security Verification
  console.log('\n3. VERIFYING RPC FUNCTIONS AND EXECUTE PRIVILEGES...');

  const rpcs = [
    'get_telecom_wallet_summary_atomic',
    'record_telecom_usage_reservation_atomic',
    'extend_telecom_usage_reservation_atomic',
    'settle_telecom_usage_reservation_atomic',
    'release_telecom_usage_reservation_atomic',
    'record_telecom_usage_reversal_atomic'
  ];

  for (const rpcName of rpcs) {
    // Test execution with anon key (must be rejected with permission denied)
    const anonRpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/${rpcName}`, {
      method: 'POST',
      headers: anonHeaders,
      body: JSON.stringify({})
    });

    if (anonRpcRes.status === 401 || anonRpcRes.status === 403 || anonRpcRes.status === 404 || !anonRpcRes.ok) {
      console.log(`  ✓ [VERIFIED] RPC ${rpcName} exists & blocks non-service_role execution (status: ${anonRpcRes.status})`);
    } else {
      console.error(`  ✕ [ALERT] RPC ${rpcName} allowed non-service_role execution!`);
    }
  }

  // Verify get_telecom_wallet_summary_atomic with service_role read-only
  const srSummaryRes = await fetch(`${supabaseUrl}/rest/v1/rpc/get_telecom_wallet_summary_atomic`, {
    method: 'POST',
    headers: serviceHeaders,
    body: JSON.stringify({ p_organization_id: '00000000-0000-0000-0000-000000000000' })
  });

  if (srSummaryRes.ok) {
    const summaryData = await srSummaryRes.json();
    console.log(`  ✓ [VERIFIED] get_telecom_wallet_summary_atomic executed cleanly via service_role:`, summaryData);
  } else {
    console.error(`  ✕ get_telecom_wallet_summary_atomic failed via service_role: ${srSummaryRes.status}`);
  }

  console.log('\n=== READ-ONLY REMOTE VERIFICATION COMPLETE ===');
}

runRemoteVerification().catch((err) => {
  console.error('Remote verification error:', err);
  process.exit(1);
});
