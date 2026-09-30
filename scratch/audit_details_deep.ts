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
const supabaseKey = process.env.SUPABASE_SECRET_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const apiKeySid = process.env.TWILIO_API_KEY_SID!;
const apiKeySecret = process.env.TWILIO_API_KEY_SECRET!;
const twilioClient = twilio(apiKeySid, apiKeySecret, { accountSid });

async function deepAudit() {
  console.log('=== DEEP AUDIT OF CALL 2ba5869f-88a3-4fc8-a33e-62c7f6966b01 ===\n');

  // 1. Fetch Twilio calls around 10:25 UTC
  const callsList = await twilioClient.calls.list({
    startTimeAfter: new Date('2026-09-30T10:20:00Z'),
    startTimeBefore: new Date('2026-09-30T10:30:00Z'),
    limit: 20
  });

  console.log('Twilio Calls around 10:25 UTC:');
  for (const c of callsList) {
    console.log({
      sid: c.sid,
      parentCallSid: c.parentCallSid,
      from: c.from,
      to: c.to,
      status: c.status,
      startTime: c.startTime,
      endTime: c.endTime,
      duration: c.duration,
      price: c.price,
      direction: c.direction
    });
  }

  // 2. Fetch call logs / events in database
  const { data: callLogs } = await supabase
    .from('call_logs')
    .select('*')
    .eq('call_id', '2ba5869f-88a3-4fc8-a33e-62c7f6966b01');
  console.log('\nCall logs in DB:', callLogs);

  // 3. Fetch any reservations with internal_usage_id containing the call id or created today
  const { data: allRes } = await supabase
    .from('telecom_usage_reservations')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);
  console.log('\nAll recent reservations in DB:', allRes);

  // 4. Fetch all experiment auths
  const { data: allAuths } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);
  console.log('\nAll recent experiment auths in DB:', allAuths);

  // 5. Check if there are any call legs or provider operations
  const { data: providerOps } = await supabase
    .from('telecom_provider_operations')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);
  console.log('\nAll provider ops:', providerOps);
}

deepAudit().catch(console.error);
