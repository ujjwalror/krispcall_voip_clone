import fs from 'fs';
import path from 'path';

const envPath = path.join(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  for (const line of envConfig.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.substring(0, idx).trim();
        const val = trimmed.substring(idx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

async function verifyRemoteRpc() {
  console.log('================================================================');
  console.log('PHASE 13.4.3B.2B.1 — POST-MIGRATION REMOTE VERIFICATION');
  console.log('================================================================\n');

  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error('Supabase credentials missing in .env.local');
  }

  if (!(global as any).WebSocket) {
    (global as any).WebSocket = class DummyWebSocket {};
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false },
  });

  console.log('1. Verifying remote RPC invocation on link_telecom_child_provider_resource_atomic...');

  // Calling with non-existent component/org to verify function exists and executes
  const { data, error } = await supabase.rpc('link_telecom_child_provider_resource_atomic', {
    p_organization_id: '00000000-0000-0000-0000-000000000000',
    p_session_id: 'test_sess',
    p_component_id: 'test_comp',
    p_child_provider_resource_id: 'CA_TEST_123',
    p_parent_provider_resource_id: null,
  });

  console.log('Remote RPC invocation output:', { data, error });

  if (error && error.message.includes('COMPONENT_NOT_FOUND')) {
    console.log('  ✓ RPC link_telecom_child_provider_resource_atomic exists remotely and enforces COMPONENT_NOT_FOUND validation!');
  } else if (error) {
    console.log('  RPC returned error:', error);
  } else {
    console.log('  RPC returned data:', data);
  }

  console.log('\n2. Verifying anon role execution privilege revocation...');
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (anonKey) {
    const anonClient = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data: anonData, error: anonErr } = await anonClient.rpc('link_telecom_child_provider_resource_atomic', {
      p_organization_id: '00000000-0000-0000-0000-000000000000',
      p_session_id: 'test_sess',
      p_component_id: 'test_comp',
      p_child_provider_resource_id: 'CA_TEST_123',
    });
    if (anonErr && (anonErr.message.includes('permission denied') || anonErr.code === '42501' || anonErr.code === 'PGRST202')) {
      console.log('  ✓ Anon execution strictly revoked! Error:', anonErr.message);
    } else {
      console.error('  ✕ WARNING: Anon execution was NOT rejected as expected!', { anonData, anonErr });
    }
  }

  console.log('\n2. Verifying remote table presence...');
  const tables = [
    'telecom_retail_rate_cards',
    'telecom_usage_reservations',
    'telecom_usage_sessions',
    'telecom_usage_components',
    'telecom_provider_operations',
    'telecom_provider_event_log',
    'telecom_financial_operation_idempotency',
  ];

  for (const t of tables) {
    const { count, error: tErr } = await supabase.from(t).select('*', { count: 'exact', head: true });
    if (tErr) {
      console.error(`  ✕ Error inspecting table ${t}:`, tErr.message);
    } else {
      console.log(`  ✓ Table ${t} exists (row count head check OK)`);
    }
  }

  console.log('\n3. Checking migration history table...');
  const { data: migData, error: migErr } = await supabase.from('schema_migrations').select('*').limit(5);
  if (migErr) {
    console.log('  Note: schema_migrations query returned:', migErr.message);
  } else {
    console.log('  schema_migrations rows:', migData);
  }
}

verifyRemoteRpc().catch(console.error);
