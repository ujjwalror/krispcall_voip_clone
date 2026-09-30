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

async function inspectCall1DurableTruth() {
  const callId = '5b38cdba-6559-47e6-916b-164fc94863a8';
  console.log('=== CALL 1 DURABLE RESERVATION TRUTH AUDIT ===');

  const { data: session } = await supabase.from('telecom_usage_sessions').select('*').eq('session_id', callId);
  console.log('\n1. Session:', session);

  const { data: components } = await supabase.from('telecom_usage_components').select('*').eq('session_id', callId);
  console.log('\n2. Components:', components);

  const { data: reservations } = await supabase.from('telecom_usage_reservations').select('*').ilike('internal_usage_id', `%${callId}%`);
  console.log('\n3. Reservations:', reservations);

  const { data: idempotency } = await supabase.from('telecom_financial_operation_idempotency').select('*').ilike('internal_usage_id', `%${callId}%`);
  console.log('\n4. Financial Idempotency:', idempotency);

  const { data: providerOps } = await supabase.from('telecom_provider_operations').select('*').ilike('internal_usage_id', `%${callId}%`);
  console.log('\n5. Provider Ops:', providerOps);

  const { data: events } = await supabase.from('telecom_provider_event_log').select('*').ilike('internal_usage_id', `%${callId}%`);
  console.log('\n6. Provider Event Log (by usage id):', events);

  const { data: eventsBySid } = await supabase.from('telecom_provider_event_log').select('*').eq('provider_resource_id', 'CA1dd4d33a74dfe9470f29021a6d32bdab');
  console.log('\n7. Provider Event Log (by CallSid CA1dd4...):', eventsBySid);
}

inspectCall1DurableTruth().catch(console.error);
