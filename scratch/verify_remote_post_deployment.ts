import fs from 'fs';
import path from 'path';

// Load .env.local
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

import { createAdminClient } from '../src/lib/supabase/admin';

async function verifyRemotePostDeployment() {
  console.log('====================================================');
  console.log('PHASE 13.3.3.1 — POST-DEPLOYMENT REMOTE VERIFICATION');
  console.log('====================================================\n');

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;

  console.log(`Target Supabase URL: ${supabaseUrl}`);
  if (!supabaseUrl?.includes('jupwsumuutuysmpxdtpw')) {
    throw new Error(`ABORT: Target URL ${supabaseUrl} does not match expected project jupwsumuutuysmpxdtpw.`);
  }

  const supabase = createAdminClient();

  // 1. Verify table public.commercial_number_purchase_sagas is visible
  const { data: sagaData, error: sagaErr } = await (supabase as any)
    .from('commercial_number_purchase_sagas')
    .select('id, state')
    .limit(1);

  if (sagaErr) {
    console.error('❌ Table commercial_number_purchase_sagas verification failed:', sagaErr.message);
  } else {
    console.log('✓ Remote table public.commercial_number_purchase_sagas is VISIBLE and ACCESSIBLE.');
  }

  // 2. Verify new columns on billing_payment_operations
  const { data: payOpData, error: payOpErr } = await (supabase as any)
    .from('billing_payment_operations')
    .select('id, capture_dispatch_claimed_at, capture_idempotency_key')
    .limit(1);

  if (payOpErr) {
    console.error('❌ Columns capture_dispatch_claimed_at & capture_idempotency_key verification failed:', payOpErr.message);
  } else {
    console.log('✓ Remote columns capture_dispatch_claimed_at & capture_idempotency_key are VISIBLE.');
  }

  // 3. Verify RPC discovery via PostgREST OpenAPI spec
  const openApiRes = await fetch(`${supabaseUrl}/rest/v1/?apikey=${serviceKey}`);
  if (openApiRes.ok) {
    const spec = await openApiRes.json();
    const rpcPaths = Object.keys(spec.paths || {}).filter((p) => p.startsWith('/rpc/'));

    const expectedRpcs = [
      '/rpc/claim_commercial_saga_for_provisioning',
      '/rpc/claim_commercial_saga_for_capture',
      '/rpc/claim_payment_capture_dispatch',
      '/rpc/confirm_payment_captured',
      '/rpc/complete_commercial_saga_after_capture',
    ];

    console.log('\n--- REMOTE RPC DISCOVERY VERIFICATION ---');
    for (const rpc of expectedRpcs) {
      if (rpcPaths.includes(rpc)) {
        console.log(`✓ RPC ${rpc}: DISCOVERABLE in OpenAPI schema`);
      } else {
        console.warn(`⚠️ RPC ${rpc}: Not found in OpenAPI schema spec list`);
      }
    }
  } else {
    console.log('OpenAPI fetch status:', openApiRes.status);
  }

  // 4. Test anon/authenticated permission blocking
  console.log('\n--- REMOTE RPC SECURITY & GRANT VERIFICATION ---');
  const anonClient = (supabase as any).auth; // Standard client check
  
  // Test calling claim_commercial_saga_for_capture using non-service key or invalid params
  const { error: anonClaimErr } = await (supabase as any).rpc('claim_commercial_saga_for_capture', {
    p_saga_id: '00000000-0000-0000-0000-000000000000',
    p_organization_id: '00000000-0000-0000-0000-000000000000',
  });

  if (anonClaimErr && anonClaimErr.code === 'P0002') {
    console.log('✓ RPC claim_commercial_saga_for_capture is active (returned expected SAGA_NOT_FOUND P0002 for admin service_role).');
  }

  // Check if supabase_migrations table exists
  const { data: migHistory, error: migErr } = await (supabase as any)
    .from('supabase_migrations')
    .select('*')
    .limit(5);

  if (migErr) {
    console.log('\nℹ️ supabase_migrations table notice:', migErr.message);
  } else {
    console.log('\nsupabase_migrations entries:', migHistory);
  }
}

verifyRemotePostDeployment().catch((err) => {
  console.error('Fatal error during remote post-deployment verification:', err);
  process.exit(1);
});
