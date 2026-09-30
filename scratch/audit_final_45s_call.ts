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

async function fullForensicAudit() {
  const orgId = '00000000-0000-0000-0000-000000000001';
  console.log('=== FINAL FORENSIC ANALYSIS OF 45-SECOND REPEAT CALL ===\n');

  // 1. Authorizations Audit
  console.log('--- 1. EXPERIMENT AUTHORIZATIONS ---');
  const { data: auths } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .in('id', ['34c87017-9486-4348-8b9d-e8b02173741d', 'ca590b37-7cb5-4a88-a847-cafe6f0c9e28']);

  console.log('Target Authorizations:', auths);

  const { data: allAuths } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

  console.log('All Org Authorizations:', allAuths);

  // 2. Calls Audit
  console.log('\n--- 2. CALLS IN DATABASE ---');
  const { data: calls } = await supabase
    .from('calls')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(5);

  console.log('Recent Calls:', JSON.stringify(calls, null, 2));

  // 3. Twilio Call Details
  console.log('\n--- 3. TWILIO REST API CALL DETAILS ---');
  const call45 = calls?.find(c => c.id === '99879839-0d52-4624-ab18-600f00320209');
  if (call45 && call45.twilio_call_sid) {
    try {
      const parentCall = await twilioClient.calls(call45.twilio_call_sid).fetch();
      console.log('Parent Call Sid:', parentCall.sid);
      console.log('  Parent Status:', parentCall.status);
      console.log('  Parent Duration:', parentCall.duration);
      console.log('  Parent StartTime:', parentCall.startTime);
      console.log('  Parent EndTime:', parentCall.endTime);
      console.log('  Parent Price:', parentCall.price, parentCall.priceUnit);
      console.log('  Parent Direction:', parentCall.direction);
      console.log('  Parent ParentCallSid:', parentCall.parentCallSid);

      // Check child PSTN legs if parentCallSid exists or via list
      const parentSid = parentCall.parentCallSid || parentCall.sid;
      const childCalls = await twilioClient.calls.list({ parentCallSid: parentSid });
      console.log('Child Calls for parent', parentSid, ':', childCalls.map(ch => ({
        sid: ch.sid,
        status: ch.status,
        duration: ch.duration,
        startTime: ch.startTime,
        endTime: ch.endTime,
        price: ch.price,
        to: ch.to,
        from: ch.from
      })));
    } catch (e: any) {
      console.error('Twilio fetch error:', e.message);
    }
  }

  // 4. Financial & Provider Operations Audit
  console.log('\n--- 4. RESERVATIONS & OPERATIONS ---');
  const { data: reservations } = await supabase
    .from('telecom_usage_reservations')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

  console.log('Reservations:', reservations);

  const { data: finOps } = await supabase
    .from('telecom_financial_operation_idempotency')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

  console.log('Financial Operation Idempotency:', finOps);

  const { data: providerOps } = await supabase
    .from('telecom_provider_operations')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

  console.log('Provider Operations:', providerOps);

  // 5. Credit Ledger Audit
  console.log('\n--- 5. BILLING CREDIT LEDGER ---');
  const { data: ledger } = await supabase
    .from('billing_credit_ledger')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

  console.log('Ledger:', ledger);
}

fullForensicAudit().catch(console.error);
