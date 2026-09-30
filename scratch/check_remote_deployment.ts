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

async function verifyRemoteReality() {
  console.log('====================================================');
  console.log('CHECKING REMOTE REALITY FOR PROJECT jupwsumuutuysmpxdtpw');
  console.log('====================================================\n');

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;

  console.log(`Target Supabase URL: ${supabaseUrl}`);
  if (!supabaseUrl?.includes('jupwsumuutuysmpxdtpw')) {
    throw new Error(`ABORT: Target URL ${supabaseUrl} does not match expected project jupwsumuutuysmpxdtpw.`);
  }

  const supabase = createAdminClient();

  // 1. Check if new columns exist on billing_payment_operations
  const { data: colData, error: colErr } = await (supabase as any)
    .from('billing_payment_operations')
    .select('id, capture_dispatch_claimed_at, capture_idempotency_key')
    .limit(1);

  const columnsExist = !colErr;

  // 2. Check if claim_commercial_saga_for_capture RPC exists
  const { error: sagaRpcErr } = await (supabase as any).rpc('claim_commercial_saga_for_capture', {
    p_saga_id: '00000000-0000-0000-0000-000000000000',
    p_organization_id: '00000000-0000-0000-0000-000000000000',
  });
  const sagaRpcExists = !sagaRpcErr || sagaRpcErr.code !== 'PGRST202';

  // 3. Check if claim_payment_capture_dispatch RPC exists
  const { error: dispatchRpcErr } = await (supabase as any).rpc('claim_payment_capture_dispatch', {
    p_payment_op_id: '00000000-0000-0000-0000-000000000000',
    p_organization_id: '00000000-0000-0000-0000-000000000000',
    p_saga_id: '00000000-0000-0000-0000-000000000000',
  });
  const dispatchRpcExists = !dispatchRpcErr || dispatchRpcErr.code !== 'PGRST202';

  // 4. Check if confirm_payment_captured RPC exists
  const { error: confirmRpcErr } = await (supabase as any).rpc('confirm_payment_captured', {
    p_payment_op_id: '00000000-0000-0000-0000-000000000000',
    p_organization_id: '00000000-0000-0000-0000-000000000000',
    p_provider_payment_id: 'pi_test',
  });
  const confirmRpcExists = !confirmRpcErr || confirmRpcErr.code !== 'PGRST202';

  // 5. Check if complete_commercial_saga_after_capture RPC exists
  const { error: completeRpcErr } = await (supabase as any).rpc('complete_commercial_saga_after_capture', {
    p_saga_id: '00000000-0000-0000-0000-000000000000',
    p_organization_id: '00000000-0000-0000-0000-000000000000',
  });
  const completeRpcExists = !completeRpcErr || completeRpcErr.code !== 'PGRST202';

  // Check Phase 13.3.1 commercial_number_purchase_sagas table
  const { data: sagaTableData, error: sagaTableErr } = await (supabase as any)
    .from('commercial_number_purchase_sagas')
    .select('id')
    .limit(1);
  const sagaTableExists = !sagaTableErr;

  console.log('\n--- REMOTE REALITY AUDIT RESULTS ---');
  console.log(`- public.commercial_number_purchase_sagas table: ${sagaTableExists ? 'EXISTS' : 'DOES NOT EXIST'}`);
  console.log(`- capture_dispatch_claimed_at column: ${columnsExist ? 'EXISTS' : 'DOES NOT EXIST'}`);
  console.log(`- claim_commercial_saga_for_capture RPC: ${sagaRpcExists ? 'EXISTS' : 'DOES NOT EXIST'}`);
  console.log(`- claim_payment_capture_dispatch RPC: ${dispatchRpcExists ? 'EXISTS' : 'DOES NOT EXIST'}`);
  console.log(`- confirm_payment_captured RPC: ${confirmRpcExists ? 'EXISTS' : 'DOES NOT EXIST'}`);
  console.log(`- complete_commercial_saga_after_capture RPC: ${completeRpcExists ? 'EXISTS' : 'DOES NOT EXIST'}`);

  if (columnsExist && sagaRpcExists && dispatchRpcExists && confirmRpcExists && completeRpcExists) {
    console.log('\nSTATUS: ALREADY DEPLOYED');
  } else {
    console.log('\nSTATUS: NOT DEPLOYED');
  }
}

verifyRemoteReality().catch((err) => {
  console.error('Fatal error during remote reality check:', err);
  process.exit(1);
});
