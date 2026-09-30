import fs from 'fs';
import path from 'path';
(globalThis as any).WebSocket = class {};
import { createClient } from '@supabase/supabase-js';

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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

async function testRpc() {
  const orgId = '00000000-0000-0000-0000-000000000001';
  const internalUsageId = `call_outbound_test_${Date.now()}`;
  const idempotencyKey = `ext_${internalUsageId}_seq_1`;

  // First create a dummy reservation
  const { data: createRes, error: createErr } = await supabase.from('telecom_usage_reservations').insert({
    organization_id: orgId,
    internal_usage_id: internalUsageId,
    service_type: 'voice_outbound',
    direction: 'outbound',
    provider: 'twilio',
    amount_reserved_minor: 6,
    currency: 'USD',
    status: 'active',
    idempotency_key: `res_${internalUsageId}`,
    expires_at: new Date(Date.now() + 300000).toISOString(),
  }).select().single();

  if (createErr) {
    console.error('Reservation creation failed:', createErr);
    return;
  }

  console.log('Created test reservation:', createRes.id);

  // Now test extend RPC
  const { data: extRes, error: extErr } = await supabase.rpc('extend_telecom_usage_reservation_atomic', {
    p_organization_id: orgId,
    p_internal_usage_id: internalUsageId,
    p_additional_amount_reserved_minor: 6,
    p_idempotency_key: idempotencyKey,
    p_new_expires_in_seconds: 300,
  });

  if (extErr) {
    console.error('RPC extension error:', extErr);
  } else {
    console.log('RPC extension succeeded:', extRes);
  }

  // Cleanup test reservation
  await supabase.from('telecom_usage_reservations').delete().eq('id', createRes.id);
  await supabase.from('telecom_financial_operation_idempotency').delete().eq('idempotency_key', idempotencyKey);
}

testRpc().catch(console.error);
