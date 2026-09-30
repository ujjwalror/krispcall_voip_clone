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
  console.log('PHASE 13.4.3B.2A — READ-ONLY REMOTE POST-MIGRATION VERIFICATION');
  console.log('====================================================\n');
  console.log(`Target URL: ${supabaseUrl}\n`);

  // 1. Verify Remote Tables & Columns
  console.log('1. VERIFYING REMOTE TABLES AND COLUMNS...');

  const sessionCols = [
    'session_id', 'organization_id', 'created_by_user_id', 'session_type',
    'direction', 'status', 'currency', 'total_retail_charge_minor',
    'total_wholesale_cost_minor', 'reconciliation_status', 'metadata',
    'created_at', 'updated_at'
  ];

  console.log('\nChecking telecom_usage_sessions:');
  for (const col of sessionCols) {
    const res = await fetch(`${supabaseUrl}/rest/v1/telecom_usage_sessions?select=${col}&limit=1`, { headers: serviceHeaders });
    if (res.ok) {
      console.log(`  ✓ [PRESENT] telecom_usage_sessions.${col}`);
    } else {
      console.error(`  ✕ [ABSENT ] telecom_usage_sessions.${col} (status: ${res.status})`);
    }
  }

  const componentCols = [
    'component_id', 'session_id', 'organization_id', 'internal_usage_id',
    'provider', 'provider_account_id', 'parent_provider_resource_id',
    'child_provider_resource_id', 'leg_type', 'sequence_number',
    'duration_seconds', 'retail_charge_minor', 'provider_wholesale_cost_minor',
    'reconciliation_status', 'metadata', 'created_at', 'updated_at'
  ];

  console.log('\nChecking telecom_usage_components:');
  for (const col of componentCols) {
    const res = await fetch(`${supabaseUrl}/rest/v1/telecom_usage_components?select=${col}&limit=1`, { headers: serviceHeaders });
    if (res.ok) {
      console.log(`  ✓ [PRESENT] telecom_usage_components.${col}`);
    } else {
      console.error(`  ✕ [ABSENT ] telecom_usage_components.${col} (status: ${res.status})`);
    }
  }

  // Confirm reservation_id is ABSENT
  const resIdCheck = await fetch(`${supabaseUrl}/rest/v1/telecom_usage_components?select=reservation_id&limit=1`, { headers: serviceHeaders });
  if (!resIdCheck.ok) {
    console.log('  ✓ [CONFIRMED ABSENT] telecom_usage_components.reservation_id (single canonical internal_usage_id enforced)');
  } else {
    console.error('  ✕ [FAILED] telecom_usage_components.reservation_id STILL EXISTS!');
  }

  const opCols = [
    'id', 'organization_id', 'session_id', 'component_id', 'internal_usage_id',
    'provider', 'operation_type', 'idempotency_key', 'request_fingerprint',
    'provider_resource_id', 'status', 'reconciliation_status', 'attempt_count',
    'dispatch_token', 'last_error', 'metadata', 'created_at', 'updated_at'
  ];

  console.log('\nChecking telecom_provider_operations:');
  for (const col of opCols) {
    const res = await fetch(`${supabaseUrl}/rest/v1/telecom_provider_operations?select=${col}&limit=1`, { headers: serviceHeaders });
    if (res.ok) {
      console.log(`  ✓ [PRESENT] telecom_provider_operations.${col}`);
    } else {
      console.error(`  ✕ [ABSENT ] telecom_provider_operations.${col} (status: ${res.status})`);
    }
  }

  const eventCols = [
    'id', 'organization_id', 'provider', 'event_id', 'provider_resource_id',
    'event_type', 'sequence_number', 'payload_fingerprint', 'payload',
    'received_at', 'processed_at', 'processing_result', 'error_details', 'metadata'
  ];

  console.log('\nChecking telecom_provider_event_log:');
  for (const col of eventCols) {
    const res = await fetch(`${supabaseUrl}/rest/v1/telecom_provider_event_log?select=${col}&limit=1`, { headers: serviceHeaders });
    if (res.ok) {
      console.log(`  ✓ [PRESENT] telecom_provider_event_log.${col}`);
    } else {
      console.error(`  ✕ [ABSENT ] telecom_provider_event_log.${col} (status: ${res.status})`);
    }
  }

  // 2. RLS & Server-Only Confidentiality
  console.log('\n2. VERIFYING SERVER-ONLY CONFIDENTIALITY & RLS PRIVILEGES...');
  const tables = ['telecom_usage_sessions', 'telecom_usage_components', 'telecom_provider_operations', 'telecom_provider_event_log'];
  for (const tbl of tables) {
    const anonRes = await fetch(`${supabaseUrl}/rest/v1/${tbl}?select=*&limit=1`, { headers: anonHeaders });
    const data = anonRes.ok ? await anonRes.json() : null;
    console.log(`  Anon query ${tbl} status: ${anonRes.status} | Data length: ${Array.isArray(data) ? data.length : 'N/A'}`);
  }

  // 3. Remote Row Counts
  console.log('\n3. CHECKING REMOTE ROW COUNTS...');
  for (const tbl of tables) {
    const res = await fetch(`${supabaseUrl}/rest/v1/${tbl}?select=*`, {
      headers: { ...serviceHeaders, 'Prefer': 'count=exact' }
    });
    const countHeader = res.headers.get('content-range');
    console.log(`  Table ${tbl}: Row count range = ${countHeader || '0'}`);
  }

  // 4. Migration History Check
  console.log('\n4. CHECKING SCHEMA MIGRATIONS HISTORY...');
  const migRes = await fetch(`${supabaseUrl}/rest/v1/schema_migrations?version=eq.20261210000000`, { headers: serviceHeaders });
  if (migRes.ok) {
    const migData = await migRes.json();
    console.log(`  schema_migrations query status: ${migRes.status} | Version 20261210000000 record count: ${migData.length}`);
    if (migData.length === 0) {
      console.log('  -> Status: MANUALLY APPLIED / MIGRATION HISTORY NOT REPAIRED');
    } else {
      console.log('  -> Status: RECORDED IN SCHEMA MIGRATIONS');
    }
  } else {
    console.log('  schema_migrations not accessible via REST -> Status: MANUALLY APPLIED / MIGRATION HISTORY NOT REPAIRED');
  }

  console.log('\n====================================================');
  console.log('REMOTE VERIFICATION COMPLETED (READ-ONLY)');
  console.log('====================================================');
}

runRemoteVerification().catch((err) => {
  console.error('Remote verification error:', err);
  process.exit(1);
});
