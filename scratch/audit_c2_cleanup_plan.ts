import fs from 'fs';
import path from 'path';

// Load .env.local if present
try {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    for (const line of envConfig.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...vals] = trimmed.split('=');
        if (key && !process.env[key.trim()]) {
          process.env[key.trim()] = vals.join('=').trim();
        }
      }
    }
  }
} catch (e) {}

import { createAdminClient } from '../src/lib/supabase/admin';

async function main() {
  const supabase = createAdminClient();

  const synthOrgId = '00000000-0000-4000-a000-00000000c201';
  const synthSagaId = '00000000-0000-4000-a000-00000000c202';
  const synthPaymentOpId = '00000000-0000-4000-a000-00000000c203';
  const synthProvOpId = '00000000-0000-4000-a000-00000000c204';
  const synthPhoneId = '00000000-0000-4000-a000-00000000c205';
  const synthE164 = '+15550009999';
  const synthSid = 'PN_c2_synth_test_sid_999';
  const synthStripePi = 'pi_3UKZfOLmbwBcPj5g1mT44lGs';

  console.log('=== READ-ONLY DATABASE VERIFICATION ===\n');

  // 1. Fetch exact 5 records
  const { data: org, error: orgErr } = await supabase
    .from('organizations')
    .select('*')
    .eq('id', synthOrgId)
    .maybeSingle();
  console.log('Organization:', orgErr ? `ERROR: ${orgErr.message}` : JSON.stringify(org, null, 2));

  const { data: saga, error: sagaErr } = await supabase
    .from('commercial_number_purchase_sagas')
    .select('*')
    .eq('id', synthSagaId)
    .maybeSingle();
  console.log('Commercial Saga:', sagaErr ? `ERROR: ${sagaErr.message}` : JSON.stringify(saga, null, 2));

  const { data: paymentOp, error: payErr } = await supabase
    .from('billing_payment_operations')
    .select('*')
    .eq('id', synthPaymentOpId)
    .maybeSingle();
  console.log('Billing Payment Operation:', payErr ? `ERROR: ${payErr.message}` : JSON.stringify(paymentOp, null, 2));

  const { data: provOp, error: provErr } = await supabase
    .from('provider_number_operations')
    .select('*')
    .eq('id', synthProvOpId)
    .maybeSingle();
  console.log('Provider Number Operation:', provErr ? `ERROR: ${provErr.message}` : JSON.stringify(provOp, null, 2));

  const { data: phone, error: phoneErr } = await supabase
    .from('phone_numbers')
    .select('*')
    .eq('id', synthPhoneId)
    .maybeSingle();
  console.log('Phone Number:', phoneErr ? `ERROR: ${phoneErr.message}` : JSON.stringify(phone, null, 2));

  console.log('\n=== CROSS-TABLE DEPENDENCY SEARCH ===');

  const searchValues = [
    { label: 'synthOrgId', val: synthOrgId },
    { label: 'synthSagaId', val: synthSagaId },
    { label: 'synthPaymentOpId', val: synthPaymentOpId },
    { label: 'synthProvOpId', val: synthProvOpId },
    { label: 'synthPhoneId', val: synthPhoneId },
    { label: 'synthE164', val: synthE164 },
    { label: 'synthSid', val: synthSid },
    { label: 'synthStripePi', val: synthStripePi }
  ];

  const tablesToCheck = [
    { name: 'organizations', cols: ['id'] },
    { name: 'commercial_number_purchase_sagas', cols: ['id', 'organization_id', 'provider_number_operation_id', 'billing_payment_operation_id', 'phone_number_id', 'e164_number'] },
    { name: 'billing_payment_operations', cols: ['id', 'organization_id', 'commercial_saga_id', 'provider_payment_id'] },
    { name: 'provider_number_operations', cols: ['id', 'organization_id', 'commercial_saga_id', 'phone_number_id', 'e164_number', 'provider_resource_id'] },
    { name: 'phone_numbers', cols: ['id', 'organization_id', 'phone_number', 'twilio_phone_number_sid'] },
    { name: 'billing_webhook_events', cols: ['id', 'stripe_event_id', 'event_type', 'payload'] },
    { name: 'caller_assignments', cols: ['id', 'organization_id', 'phone_number_id'] },
    { name: 'compliance_profiles', cols: ['id', 'organization_id'] },
    { name: 'compliance_documents', cols: ['id', 'organization_id'] },
    { name: 'phone_number_verification', cols: ['id', 'phone_number_id'] }
  ];

  for (const t of tablesToCheck) {
    for (const c of t.cols) {
      for (const s of searchValues) {
        try {
          const { data, error } = await supabase
            .from(t.name)
            .select('id')
            .eq(c, s.val);

          if (data && data.length > 0) {
            console.log(`[MATCH] Table '${t.name}', Column '${c}', Value '${s.label} (${s.val})': count=${data.length}, ids=${data.map((d: any) => d.id).join(', ')}`);
          }
        } catch (e) {
          // ignore
        }
      }
    }
  }
}

main().catch(console.error);
