import fs from 'fs';
import path from 'path';
(globalThis as any).WebSocket = class {};
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';

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

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const apiKeySid = process.env.TWILIO_API_KEY_SID!;
const apiKeySecret = process.env.TWILIO_API_KEY_SECRET!;
const twilioClient = twilio(apiKeySid, apiKeySecret, { accountSid });

async function forensicAudit() {
  const callId = '99879839-0d52-4624-ab18-600f00320209';
  const authId = '34c87017-9486-4348-8b9d-e8b02173741d';
  console.log('=== FORENSIC AUDIT OF REPEAT CALL', callId, '===');

  // 1. Call Row
  const { data: call } = await supabase.from('calls').select('*').eq('id', callId).single();
  console.log('\nCall Row:', call);

  // 2. Authorization Row
  const { data: auth } = await supabase.from('telecom_experiment_authorizations').select('*').eq('id', authId).single();
  console.log('\nAuthorization Row:', auth);

  // 3. Twilio Legs
  if (call?.twilio_call_sid) {
    try {
      const parentCall = await twilioClient.calls(call.twilio_call_sid).fetch();
      console.log('\nParent Call Sid:', parentCall.sid, 'Status:', parentCall.status, 'Duration:', parentCall.duration, 'Price:', parentCall.price);
    } catch (e: any) {
      console.error('Parent Call Error:', e.message);
    }
  }

  const childSid = 'CAb7d73e0b72c1de9c3707c8dc12589f7b';
  try {
    const childCall = await twilioClient.calls(childSid).fetch();
    console.log('\nChild Call Sid:', childCall.sid, 'Status:', childCall.status, 'Duration:', childCall.duration, 'Price:', childCall.price, 'StartTime:', childCall.startTime, 'EndTime:', childCall.endTime);
  } catch (e: any) {
    console.error('Child Call Error:', e.message);
  }

  // 4. Wallet & Credit Ledger
  const { data: ledger } = await supabase.from('billing_credit_ledger').select('*').eq('organization_id', '00000000-0000-0000-0000-000000000001').order('created_at', { ascending: false });
  console.log('\nLedger:', ledger);

  // 5. Reservations
  const { data: reservations } = await supabase.from('telecom_usage_reservations').select('*').eq('organization_id', '00000000-0000-0000-0000-000000000001').order('created_at', { ascending: false });
  console.log('\nReservations:', reservations);

  // 6. Provider Ops
  const { data: providerOps } = await supabase.from('telecom_provider_operations').select('*').eq('organization_id', '00000000-0000-0000-0000-000000000001').order('created_at', { ascending: false });
  console.log('\nProvider Ops:', providerOps);
}

forensicAudit().catch(console.error);
