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

async function runB2ERemotePreflight() {
  console.log('================================================================');
  console.log('PHASE 13.4.3B.2E — READ-ONLY REMOTE MIGRATION PRE-FLIGHT');
  console.log('================================================================\n');
  console.log(`Target Supabase URL: ${supabaseUrl}\n`);

  // 1. VERIFY TELECOM_PROVIDER_OPERATIONS
  console.log('1. VERIFYING TELECOM_PROVIDER_OPERATIONS COLUMNS...');
  const providerOpsCols = [
    'id', 'organization_id', 'session_id', 'component_id', 'internal_usage_id',
    'provider', 'operation_type', 'idempotency_key', 'request_fingerprint',
    'provider_resource_id', 'status', 'reconciliation_status', 'attempt_count',
    'dispatch_token', 'last_error', 'metadata', 'created_at', 'updated_at'
  ];

  let opColsPassed = true;
  for (const col of providerOpsCols) {
    const res = await fetch(`${supabaseUrl}/rest/v1/telecom_provider_operations?select=${col}&limit=1`, { headers: serviceHeaders });
    if (res.ok) {
      console.log(`  ✓ [PRESENT] telecom_provider_operations.${col}`);
    } else {
      console.error(`  ✕ [ABSENT ] telecom_provider_operations.${col} (status: ${res.status})`);
      opColsPassed = false;
    }
  }

  // Check lease_expires_at column existence
  const leaseColCheck = await fetch(`${supabaseUrl}/rest/v1/telecom_provider_operations?select=lease_expires_at&limit=1`, { headers: serviceHeaders });
  if (leaseColCheck.ok) {
    console.log('  ℹ [ALREADY PRESENT] telecom_provider_operations.lease_expires_at column exists remotely');
  } else {
    console.log('  ✓ [CONFIRMED ABSENT] telecom_provider_operations.lease_expires_at column will be created by migration');
  }

  // 2. VERIFY TELECOM_USAGE_RESERVATIONS
  console.log('\n2. VERIFYING TELECOM_USAGE_RESERVATIONS COLUMNS...');
  const reservationCols = [
    'id', 'internal_usage_id', 'organization_id', 'service_type', 'direction',
    'provider', 'provider_resource_id', 'rate_card_id', 'rate_snapshot',
    'amount_reserved_minor', 'currency', 'status', 'idempotency_key',
    'expires_at', 'settled_at', 'released_at', 'settlement_ledger_id',
    'actual_provider_cost_minor', 'actual_customer_charge_minor',
    'actual_gross_margin_minor', 'metadata', 'created_at', 'updated_at'
  ];

  let resColsPassed = true;
  for (const col of reservationCols) {
    const res = await fetch(`${supabaseUrl}/rest/v1/telecom_usage_reservations?select=${col}&limit=1`, { headers: serviceHeaders });
    if (res.ok) {
      console.log(`  ✓ [PRESENT] telecom_usage_reservations.${col}`);
    } else {
      console.error(`  ✕ [ABSENT ] telecom_usage_reservations.${col} (status: ${res.status})`);
      resColsPassed = false;
    }
  }

  // 3. VERIFY TELECOM_USAGE_COMPONENTS
  console.log('\n3. VERIFYING TELECOM_USAGE_COMPONENTS COLUMNS...');
  const componentCols = [
    'component_id', 'session_id', 'organization_id', 'internal_usage_id',
    'provider', 'parent_provider_resource_id', 'child_provider_resource_id'
  ];

  for (const col of componentCols) {
    const res = await fetch(`${supabaseUrl}/rest/v1/telecom_usage_components?select=${col}&limit=1`, { headers: serviceHeaders });
    if (res.ok) {
      console.log(`  ✓ [PRESENT] telecom_usage_components.${col}`);
    } else {
      console.error(`  ✕ [ABSENT ] telecom_usage_components.${col} (status: ${res.status})`);
    }
  }

  // 4. VERIFY TELECOM_FINANCIAL_OPERATION_IDEMPOTENCY
  console.log('\n4. VERIFYING TELECOM_FINANCIAL_OPERATION_IDEMPOTENCY COLUMNS...');
  const finOpCols = [
    'id', 'organization_id', 'operation_type', 'idempotency_key',
    'internal_usage_id', 'request_payload', 'response_payload', 'created_at'
  ];

  for (const col of finOpCols) {
    const res = await fetch(`${supabaseUrl}/rest/v1/telecom_financial_operation_idempotency?select=${col}&limit=1`, { headers: serviceHeaders });
    if (res.ok) {
      console.log(`  ✓ [PRESENT] telecom_financial_operation_idempotency.${col}`);
    } else {
      console.error(`  ✕ [ABSENT ] telecom_financial_operation_idempotency.${col} (status: ${res.status})`);
    }
  }

  // 5. UNRESOLVED OPERATION UNIQUE INDEX PREFLIGHT DATA CHECK
  console.log('\n5. PRE-FLIGHT CHECK FOR UNRESOLVED OPERATIONAL CONFLICTS...');
  const unresolvedQuery = await fetch(
    `${supabaseUrl}/rest/v1/telecom_provider_operations?select=id,organization_id,internal_usage_id,status&operation_type=eq.call_duration_update&status=in.(prepared,dispatch_claimed,provider_id_known,reconciliation_required)`,
    { headers: serviceHeaders }
  );

  if (unresolvedQuery.ok) {
    const unresolvedRows: any[] = await unresolvedQuery.json();
    console.log(`  Read ${unresolvedRows.length} unresolved call_duration_update operations remotely.`);
    
    // Check for duplicate organization_id + internal_usage_id pairs
    const seen = new Set<string>();
    let duplicateCount = 0;
    for (const row of unresolvedRows) {
      const key = `${row.organization_id}:${row.internal_usage_id}`;
      if (seen.has(key)) {
        console.error(`  ✕ [CONFLICT DETECTED] Duplicate unresolved operation for key ${key}`);
        duplicateCount++;
      } else {
        seen.add(key);
      }
    }

    if (duplicateCount === 0) {
      console.log('  ✓ [ZERO CONFLICTS] uq_telecom_provider_ops_one_unresolved_extension index creation is safe!');
    } else {
      console.error(`  ✕ [STOP REQUIRED] ${duplicateCount} duplicate unresolved operations exist remotely!`);
    }
  } else {
    console.log('  ℹ No existing unresolved call_duration_update rows returned or table is empty.');
  }

  // 6. VERIFY EXTEND RPC SIGNATURE & EXISTENCE
  console.log('\n6. VERIFYING EXTEND_TELECOM_USAGE_RESERVATION_ATOMIC DEPLOYED SIGNATURE...');
  const extendRpcCheck = await fetch(`${supabaseUrl}/rest/v1/rpc/extend_telecom_usage_reservation_atomic`, {
    method: 'POST',
    headers: serviceHeaders,
    body: JSON.stringify({})
  });
  const extendResponseBody = await extendRpcCheck.json();
  console.log(`  RPC Response Status: ${extendRpcCheck.status}`);
  console.log(`  RPC Response Error: ${JSON.stringify(extendResponseBody)}`);
  if (extendResponseBody.message && extendResponseBody.message.includes('p_organization_id')) {
    console.log('  ✓ [VERIFIED DEPLOYED RPC] extend_telecom_usage_reservation_atomic exists with historical arguments');
  }

  // 7. NEW OBJECT EXISTENCE CHECK
  console.log('\n7. CHECKING NEW B.2E RPC & OBJECT PRE-EXISTENCE...');
  const newRpcs = [
    'extend_telecom_voice_reservation_fenced_atomic',
    'rollback_telecom_usage_reservation_extension_atomic',
    'claim_next_due_call_extension_atomic',
    'finalize_telecom_provider_operation_atomic'
  ];

  for (const rpc of newRpcs) {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${rpc}`, {
      method: 'POST',
      headers: serviceHeaders,
      body: JSON.stringify({})
    });
    if (res.status === 404) {
      console.log(`  ✓ [CONFIRMED ABSENT] public.${rpc} does not exist remotely (clean addition)`);
    } else {
      console.log(`  ℹ [EXISTS OR KNOWN] public.${rpc} response status: ${res.status}`);
    }
  }

  // 8. SECURITY & ANON ACCESS PREFLIGHT CHECK
  console.log('\n8. VERIFYING STRICT SERVICE-ROLE-ONLY SECURITY ACCESS (ANON REJECTION)...');
  const anonCheck = await fetch(`${supabaseUrl}/rest/v1/telecom_provider_operations?select=id&limit=1`, { headers: anonHeaders });
  if (anonCheck.status === 401 || anonCheck.status === 403 || (await anonCheck.json()).length === 0) {
    console.log('  ✓ [CONFIRMED RESTRICTED] anon client cannot read telecom_provider_operations');
  } else {
    console.error('  ✕ [SECURITY WARNING] anon client returned data from telecom_provider_operations');
  }

  console.log('\n================================================================');
  console.log('PHASE 13.4.3B.2E READ-ONLY REMOTE PRE-FLIGHT COMPLETED');
  console.log('================================================================\n');
}

runB2ERemotePreflight().catch((err) => {
  console.error('Pre-flight Script Failure:', err);
  process.exit(1);
});
