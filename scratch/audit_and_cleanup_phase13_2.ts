import fs from 'fs';
import path from 'path';

// Load .env.local variables
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

import { createAdminClient } from '../src/lib/supabase/admin';
import { PaymentStateMachine } from '../src/lib/billing/paymentStateMachine';

async function main() {
  console.log('====================================================');
  console.log('PHASE 13.2 — FINAL DB RECONCILIATION & CLEANUP');
  console.log('====================================================\n');

  const supabase = createAdminClient();

  const targetOps = [
    { name: 'TEST 1 (Standard Card)', piId: 'pi_3UKH25LmbwBcPj5g0R186C3o', opId: 'c9e38eda-15ab-45ea-b5aa-a9e54d43e39d', e164: '+14788004516' },
    { name: 'TEST 2 (Standard Card)', piId: 'pi_3UKUBhLmbwBcPj5g1UbxKOAU', opId: '64693e97-81de-45c1-9b90-aa1c52e89f14', e164: '+16414065157' },
    { name: 'TEST 3 (3DS / SCA Card)', piId: 'pi_3UKUNrLmbwBcPj5g0PIYmqOu', opId: '8a87f38c-f7ff-4161-bc88-7681005d0f14', e164: '+12175489717' },
  ];

  // STEP 1: Reconcile DB status pending -> authorized
  console.log('--- RECONCILING DB STATUSES TO AUTHORIZED ---');
  for (const item of targetOps) {
    const { data: op } = await (supabase as any)
      .from('billing_payment_operations')
      .select('status')
      .eq('id', item.opId)
      .single();

    if (op && op.status === 'pending') {
      if (PaymentStateMachine.isTransitionAllowed('pending', 'authorized')) {
        await (supabase as any)
          .from('billing_payment_operations')
          .update({
            status: 'authorized',
            updated_at: new Date().toISOString(),
          })
          .eq('id', item.opId);
        console.log(`- ${item.name} (${item.opId}): Status updated pending -> authorized`);
      }
    } else {
      console.log(`- ${item.name} (${item.opId}): Current Status = ${op?.status}`);
    }
  }

  // STEP 2: Cancel/Release test holds in DB: authorized -> canceled
  console.log('\n--- CLEANUP: RECONCILING AUTHORIZED TO CANCELED ---');
  for (const item of targetOps) {
    const { data: op } = await (supabase as any)
      .from('billing_payment_operations')
      .select('status')
      .eq('id', item.opId)
      .single();

    if (op && op.status === 'authorized') {
      if (PaymentStateMachine.isTransitionAllowed('authorized', 'canceled')) {
        await (supabase as any)
          .from('billing_payment_operations')
          .update({
            status: 'canceled',
            failure_code: 'TEST_HOLD_RELEASED',
            failure_message: 'Phase 13.2 post-audit test hold release',
            updated_at: new Date().toISOString(),
          })
          .eq('id', item.opId);
        console.log(`- ${item.name} (${item.opId}): Status updated authorized -> canceled`);
      }
    } else {
      console.log(`- ${item.name} (${item.opId}): Current Status = ${op?.status}`);
    }
  }

  // STEP 3: Post-cleanup verification in DB
  console.log('\n--- POST-CLEANUP VERIFICATION ---');
  for (const item of targetOps) {
    const { data: dbOp } = await (supabase as any)
      .from('billing_payment_operations')
      .select('id, provider_payment_id, status, amount_minor, currency, request_fingerprint')
      .eq('id', item.opId)
      .single();

    console.log(`\n${item.name}:`);
    console.log(`- Operation ID: ${dbOp.id}`);
    console.log(`- PaymentIntent ID: ${dbOp.provider_payment_id}`);
    console.log(`- Target E.164: ${item.e164}`);
    console.log(`- Final Canonical DB Status: ${dbOp.status}`);
    console.log(`- Fingerprint: ${dbOp.request_fingerprint}`);
  }

  const { count: pOpsCount } = await (supabase as any).from('provider_number_operations').select('*', { count: 'exact', head: true });
  const { count: pNumsCount } = await (supabase as any).from('phone_numbers').select('*', { count: 'exact', head: true });

  console.log(`\nFINAL SYSTEM METRICS:`);
  console.log(`- provider_number_operations count: ${pOpsCount || 0}`);
  console.log(`- phone_numbers count: ${pNumsCount || 0}`);
  console.log(`- PHASE13_PAYMENT_ENABLED: ${process.env.PHASE13_PAYMENT_ENABLED || 'false'}`);

  console.log('\n====================================================');
  console.log('RECONCILIATION & CLEANUP COMPLETE');
  console.log('====================================================');
}

main().catch(console.error);
