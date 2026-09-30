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

async function forensicAudit() {
  console.log('==================================================');
  console.log('PHASE 13.4.3B.2E — AUTHORITATIVE POST-CALL FORENSIC AUDIT');
  console.log('==================================================\n');

  const orgId = '00000000-0000-0000-0000-000000000001';
  const authId = '83274462-24d5-4393-afa5-3ac7211c77a6';

  // 1. Authorization Record
  const { data: authRow } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('id', authId)
    .single();

  console.log('--- 1. AUTHORIZATION RECORD ---');
  console.log(JSON.stringify(authRow, null, 2));

  const dbCallId = authRow?.bound_call_id;

  // 2. Call Record
  let callRow: any = null;
  if (dbCallId) {
    const { data: c } = await supabase
      .from('calls')
      .select('*')
      .eq('id', dbCallId)
      .single();
    callRow = c;
  } else {
    // Search recent calls for org
    const { data: recentCalls } = await supabase
      .from('calls')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(5);
    console.log('Recent calls for org:', JSON.stringify(recentCalls, null, 2));
    if (recentCalls && recentCalls.length > 0) {
      callRow = recentCalls[0];
    }
  }

  console.log('\n--- 2. CALL RECORD ---');
  console.log(JSON.stringify(callRow, null, 2));

  const targetCallId = dbCallId || callRow?.id;
  const internalUsageId = `call:outbound:${targetCallId}`;

  // 3. Usage Reservations & Extensions
  const { data: reservations } = await supabase
    .from('telecom_usage_reservations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('internal_usage_id', internalUsageId);

  console.log('\n--- 3. USAGE RESERVATIONS ---');
  console.log(JSON.stringify(reservations, null, 2));

  // Check reservation extensions table if present
  let resExtensions: any = null;
  try {
    const { data: exts } = await supabase
      .from('telecom_reservation_extensions')
      .select('*')
      .eq('internal_usage_id', internalUsageId);
    resExtensions = exts;
  } catch (e) {}

  console.log('\n--- 3b. RESERVATION EXTENSIONS ---');
  console.log(JSON.stringify(resExtensions, null, 2));

  // 4. Provider Operations Log (if table exists)
  let provOps: any = null;
  try {
    const { data: ops } = await supabase
      .from('telecom_provider_operations')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false });
    provOps = ops;
  } catch (e) {}

  console.log('\n--- 4. PROVIDER OPERATIONS ---');
  console.log(JSON.stringify(provOps, null, 2));

  // 5. Billing Credit Ledger
  const { data: ledgerEntries } = await supabase
    .from('billing_credit_ledger')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });

  console.log('\n--- 5. BILLING CREDIT LEDGER ---');
  console.log(JSON.stringify(ledgerEntries, null, 2));

  // 6. Twilio Call Details (Read-only API)
  console.log('\n--- 6. TWILIO READ-ONLY AUDIT ---');
  const parentCallSid = callRow?.twilio_call_sid;
  let parentTwilioObj: any = null;
  let childTwilioObj: any = null;
  let childCallSid: string | null = null;

  if (parentCallSid) {
    try {
      parentTwilioObj = await twilioClient.calls(parentCallSid).fetch();
      console.log('Parent Twilio Call Obj:', {
        sid: parentTwilioObj.sid,
        status: parentTwilioObj.status,
        startTime: parentTwilioObj.startTime,
        endTime: parentTwilioObj.endTime,
        duration: parentTwilioObj.duration,
        price: parentTwilioObj.price,
        priceUnit: parentTwilioObj.priceUnit,
      });

      const childCalls = await twilioClient.calls.list({ parentCallSid: parentCallSid, limit: 5 });
      console.log('Child Calls count:', childCalls.length);
      if (childCalls.length > 0) {
        childTwilioObj = childCalls[0];
        childCallSid = childTwilioObj.sid;
        console.log('Child Twilio Call Obj:', {
          sid: childTwilioObj.sid,
          status: childTwilioObj.status,
          startTime: childTwilioObj.startTime,
          endTime: childTwilioObj.endTime,
          duration: childTwilioObj.duration,
          price: childTwilioObj.price,
          priceUnit: childTwilioObj.priceUnit,
        });
      }
    } catch (e: any) {
      console.error('Error fetching Twilio calls:', e.message);
    }
  } else {
    console.log('No parent twilio_call_sid found on callRow. Listing recent Twilio calls...');
    try {
      const recentTwilio = await twilioClient.calls.list({ limit: 5 });
      console.log('Recent Twilio calls:', recentTwilio.map(c => ({
        sid: c.sid,
        parentCallSid: c.parentCallSid,
        to: c.to,
        from: c.from,
        status: c.status,
        startTime: c.startTime,
        endTime: c.endTime,
        duration: c.duration,
        price: c.price
      })));
    } catch (e: any) {
      console.error('Error listing recent Twilio calls:', e.message);
    }
  }

  // 7. Active / Armed Auths & Exposure Summary
  const { data: activeRes } = await supabase
    .from('telecom_usage_reservations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'active');

  const { data: armedAuths } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'armed');

  const { data: claimedAuths } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'claimed');

  console.log('\n--- 7. CLEANLINESS & AMBIGUITY READBACK ---');
  console.log('Active Reservations:', activeRes?.length || 0);
  console.log('Usable Armed Auths:', armedAuths?.length || 0);
  console.log('Active Claimed Auths:', claimedAuths?.length || 0);
}

forensicAudit().catch(err => {
  console.error('Audit Error:', err);
  process.exit(1);
});
