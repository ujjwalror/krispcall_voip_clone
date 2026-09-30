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

async function audit() {
  console.log('=== FORENSIC AUDIT OF LIVE RUN ===\n');

  const orgId = '00000000-0000-0000-0000-000000000001';

  // 1. Audit Experiment Authorizations
  console.log('--- 1. EXPERIMENT AUTHORIZATIONS ---');
  const { data: auths, error: authErr } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .in('id', ['6fe00678-7f8a-4abb-be76-feb04c3f1894', '66b71bd5-a0f2-4da0-9a44-aad54ec68ccc']);

  console.log('Authorizations found:', auths);
  if (authErr) console.error('Auth fetch error:', authErr);

  // Also fetch any other authorizations for orgId
  const { data: allAuths } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

  console.log('All org authorizations:', allAuths);

  // 2. Audit Recent Calls
  console.log('\n--- 2. RECENT CALLS ---');
  const { data: calls } = await supabase
    .from('calls')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(5);

  console.log('Recent calls:', JSON.stringify(calls, null, 2));

  // 3. Audit Reservations
  console.log('\n--- 3. TELECOM USAGE RESERVATIONS ---');
  const { data: reservations } = await supabase
    .from('telecom_usage_reservations')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(5);

  console.log('Reservations:', JSON.stringify(reservations, null, 2));

  // 4. Audit Financial Idempotency
  console.log('\n--- 4. FINANCIAL OPERATION IDEMPOTENCY ---');
  const { data: finOps } = await supabase
    .from('telecom_financial_operation_idempotency')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(10);

  console.log('Financial ops:', JSON.stringify(finOps, null, 2));

  // 5. Audit Provider Operations
  console.log('\n--- 5. TELECOM PROVIDER OPERATIONS ---');
  const { data: providerOps } = await supabase
    .from('telecom_provider_operations')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(10);

  console.log('Provider ops:', JSON.stringify(providerOps, null, 2));

  // 6. Audit Credit Ledger
  console.log('\n--- 6. BILLING CREDIT LEDGER ---');
  const { data: ledger } = await supabase
    .from('billing_credit_ledger')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(5);

  console.log('Ledger entries:', JSON.stringify(ledger, null, 2));

  // 7. Audit Twilio Calls
  console.log('\n--- 7. TWILIO CALLS VIA REST API ---');
  if (calls && calls.length > 0) {
    for (const c of calls) {
      if (c.twilio_call_sid) {
        console.log(`\nFetching parent call from Twilio: ${c.twilio_call_sid}`);
        try {
          const parentCall = await twilioClient.calls(c.twilio_call_sid).fetch();
          console.log('Parent Call Resource:', {
            sid: parentCall.sid,
            status: parentCall.status,
            duration: parentCall.duration,
            startTime: parentCall.startTime,
            endTime: parentCall.endTime,
            price: parentCall.price,
            priceUnit: parentCall.priceUnit,
          });

          const childCalls = await twilioClient.calls.list({ parentCallSid: c.twilio_call_sid });
          console.log(`Child calls for ${c.twilio_call_sid}:`, childCalls.map(ch => ({
            sid: ch.sid,
            status: ch.status,
            duration: ch.duration,
            startTime: ch.startTime,
            endTime: ch.endTime,
            price: ch.price,
            priceUnit: ch.priceUnit,
            to: ch.to,
            from: ch.from,
          })));
        } catch (err: any) {
          console.error(`Error fetching Twilio call ${c.twilio_call_sid}:`, err.message);
        }
      }
    }
  }
}

audit().catch(console.error);
