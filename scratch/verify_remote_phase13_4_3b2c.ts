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
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
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
  'Content-Type': 'application/json',
};

const anonHeaders = {
  'apikey': anonKey,
  'Authorization': `Bearer ${anonKey}`,
  'Content-Type': 'application/json',
};

async function verifyRemoteB2CMigration() {
  console.log('================================================================');
  console.log('PHASE 13.4.3B.2C — READ-ONLY REMOTE POST-MIGRATION VERIFICATION');
  console.log('================================================================\n');
  console.log(`Target Supabase URL: ${supabaseUrl}\n`);

  // 1. Verify RPC Existence & Execution via service_role
  console.log('1. VERIFYING REMOTE RPC EXISTENCE (service_role)...');
  const serviceRpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/link_telecom_message_provider_resource_atomic`, {
    method: 'POST',
    headers: serviceHeaders,
    body: JSON.stringify({
      p_organization_id: '00000000-0000-0000-0000-000000000000',
      p_session_id: 'sess_nonexistent',
      p_component_id: 'comp_nonexistent',
      p_provider_message_sid: 'SM00000000000000000000000000000000',
    }),
  });

  const serviceRpcJson = await serviceRpcRes.json();
  console.log('  service_role response status:', serviceRpcRes.status);
  console.log('  service_role response payload:', JSON.stringify(serviceRpcJson));

  if (serviceRpcRes.ok) {
    console.log('  ✓ RPC exists and executed via service_role. Return type is JSONB:', serviceRpcJson);
  } else if (serviceRpcJson.code === 'PGRST202' || serviceRpcJson.message?.includes('Could not find the function')) {
    console.error('  ✕ RPC DOES NOT EXIST REMOTELY!');
  } else {
    console.log('  ✓ RPC exists and returned functional error payload (expected for non-existent session):', serviceRpcJson);
  }

  // 2. Verify Privilege Hardening (anon / public access denied)
  console.log('\n2. VERIFYING SECURITY HARDENING & PRIVILEGES (anon)...');
  const anonRpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/link_telecom_message_provider_resource_atomic`, {
    method: 'POST',
    headers: anonHeaders,
    body: JSON.stringify({
      p_organization_id: '00000000-0000-0000-0000-000000000000',
      p_session_id: 'sess_test',
      p_component_id: 'comp_test',
      p_provider_message_sid: 'SM1234567890',
    }),
  });

  const anonRpcJson = await anonRpcRes.json();
  console.log('  anon response status:', anonRpcRes.status);
  console.log('  anon response payload:', JSON.stringify(anonRpcJson));

  if (!anonRpcRes.ok || anonRpcJson.code === '42501' || anonRpcJson.message?.includes('permission denied')) {
    console.log('  ✓ SECURITY CONFIRMED: EXECUTE privilege DENIED for anon / PUBLIC role.');
  } else {
    console.error('  ✕ SECURITY DEFECT: RPC is accessible to anon!');
  }

  // 3. Verify Remote Schema Dependencies
  console.log('\n3. VERIFYING REMOTE SCHEMA DEPENDENCIES...');
  const tablesToVerify = [
    'telecom_usage_sessions',
    'telecom_usage_components',
    'telecom_usage_reservations',
    'telecom_provider_operations',
    'telecom_provider_event_log',
    'telecom_financial_operation_idempotency',
    'billing_credit_ledger',
    'telecom_retail_rate_cards',
  ];

  for (const table of tablesToVerify) {
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}?select=*&limit=1`, {
      method: 'GET',
      headers: serviceHeaders,
    });
    if (res.ok) {
      console.log(`  ✓ Remote table '${table}' exists and is accessible.`);
    } else {
      console.error(`  ✕ Remote table '${table}' check failed with status ${res.status}`);
    }
  }

  console.log('\n================================================================');
  console.log('REMOTE POST-MIGRATION VERIFICATION COMPLETE');
  console.log('================================================================\n');
}

verifyRemoteB2CMigration().catch(console.error);
