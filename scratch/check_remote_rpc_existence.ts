import fs from 'fs';
import path from 'path';

// Parse .env.local manually
const envPath = path.resolve('.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.substring(0, idx).trim();
      const val = trimmed.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
      process.env[key] = val;
    }
  }
}

import { createAdminClient } from '../src/lib/supabase/admin';

async function checkRemoteRpc() {
  const supabase = createAdminClient();

  console.log('Testing remote existence of RPC: reconcile_stripe_subscription_atomic');

  const { data, error } = await supabase.rpc('reconcile_stripe_subscription_atomic' as any, {
    p_organization_id: '00000000-0000-0000-0000-000000000000',
    p_provider_subscription_id: 'sub_test_check',
    p_plan_id: '00000000-0000-0000-0000-000000000000',
    p_status: 'active',
    p_current_period_start: new Date().toISOString(),
    p_current_period_end: new Date().toISOString(),
    p_cancel_at_period_end: false,
  });

  console.log('RPC Call Error:', error);

  if (error && (error.message.includes('Could not find the function') || error.code === 'PGRST202')) {
    console.log('\nRESULT: RPC DOES NOT EXIST REMOTELY (Safe, zero collision).');
  } else {
    console.log('\nRESULT: RPC EXISTS REMOTELY OR RETURNED SPECIFIC ERROR:', error?.message);
  }
}

checkRemoteRpc().catch(console.error);
