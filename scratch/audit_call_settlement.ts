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

async function deepAuditCall() {
  const callId = '5b38cdba-6559-47e6-916b-164fc94863a8';
  console.log('--- Deep Audit of Call', callId, '---');

  const { data: call } = await supabase.from('calls').select('*').eq('id', callId).single();
  console.log('Call row:', call);

  const { data: res } = await supabase.from('telecom_usage_reservations').select('*').ilike('internal_usage_id', `%${callId}%`);
  console.log('Reservations matching callId:', res);

  const { data: fin } = await supabase.from('telecom_financial_operation_idempotency').select('*').ilike('internal_usage_id', `%${callId}%`);
  console.log('Financial ops matching callId:', fin);

  const { data: prov } = await supabase.from('telecom_provider_operations').select('*').ilike('internal_usage_id', `%${callId}%`);
  console.log('Provider ops matching callId:', prov);

  const { data: auths } = await supabase.from('telecom_experiment_authorizations').select('*').eq('bound_call_id', callId);
  console.log('Experiment authorizations bound to callId:', auths);
}

deepAuditCall().catch(console.error);
