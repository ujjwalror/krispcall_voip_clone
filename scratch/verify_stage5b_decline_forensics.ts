import fs from 'fs';
import path from 'path';
import Stripe from 'stripe';

(globalThis as any).WebSocket = class {};

import { createClient } from '@supabase/supabase-js';

// Load .env.local
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of envContent.split('\n')) {
    const line = rawLine.trim();
    if (line && !line.startsWith('#') && line.includes('=')) {
      const idx = line.indexOf('=');
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY!;

const serviceSupabase = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2025-01-27.acacia' as any,
});

async function main() {
  const testOrgId = '00000000-0000-0000-0000-000000000001';
  const op1Id = '9481dbd1-9ee2-48b6-b805-15aa22017a2c';
  const op2Id = '9f5446e4-3bee-4c9f-9ee4-217f9e98c03d';
  const historicalOpId = '78886ed2-4f16-4673-9e99-a8d130b3e049';
  const historicalPiId = 'pi_3ULhsJLmbwBcPj5g0HGD6ckb';

  console.log('=== STAGE 5B DECLINED PAYMENT FORENSICS ===\n');

  // 1. Fetch recent payment operations for org
  const { data: recentOps, error: recentErr } = await (serviceSupabase as any)
    .from('billing_payment_operations')
    .select('*')
    .eq('organization_id', testOrgId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (recentErr) {
    console.error('Error fetching recent operations:', recentErr);
    return;
  }

  console.log(`Found ${recentOps?.length || 0} recent operations.`);
  recentOps?.forEach((op: any, i: number) => {
    console.log(`[${i}] ID: ${op.id} | Status: ${op.status} | Amount: ${op.amount_minor} ${op.currency} | Created: ${op.created_at} | PI: ${op.provider_payment_id}`);
  });

  // Identify the declined operation (most recent 1000 minor USD created recently)
  const declinedOp = recentOps?.[0]; // most recent operation
  console.log('\n--- IDENTIFIED DECLINED PAYMENT OPERATION ---');
  console.log('Operation ID:', declinedOp?.id);
  console.log('Creation Timestamp:', declinedOp?.created_at);
  console.log('Attempted Amount:', declinedOp?.amount_minor, declinedOp?.currency);
  console.log('Local Status:', declinedOp?.status);
  console.log('Provider Payment ID (PI):', declinedOp?.provider_payment_id);

  let stripePi: Stripe.PaymentIntent | null = null;
  if (declinedOp?.provider_payment_id) {
    try {
      stripePi = await stripe.paymentIntents.retrieve(declinedOp.provider_payment_id);
    } catch (e: any) {
      console.error('Failed to retrieve Stripe PI:', e.message);
    }
  }

  console.log('\n--- STRIPE PROVIDER STATE ---');
  console.log('PaymentIntent ID:', stripePi?.id);
  console.log('Livemode:', stripePi?.livemode);
  console.log('Status:', stripePi?.status);
  console.log('Last Payment Error Code:', stripePi?.last_payment_error?.code);
  console.log('Last Payment Error Message:', stripePi?.last_payment_error?.message);
  console.log('Last Payment Error Decls Code:', stripePi?.last_payment_error?.decline_code);

  // Check if any payment_intent.succeeded event exists for this PI
  const { data: succeededEvents } = await (serviceSupabase as any)
    .from('stripe_events')
    .select('*')
    .eq('event_type', 'payment_intent.succeeded')
    .filter('payload->data->object->id', 'eq', declinedOp?.provider_payment_id);

  console.log('\n--- EVENT CHECK ---');
  console.log('Succeeded Events Count in DB:', succeededEvents?.length || 0);

  // Check grants for declined operation
  const { data: declinedGrants } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('*')
    .eq('organization_id', testOrgId)
    .eq('reference_type', 'payment_operation')
    .eq('reference_id', declinedOp?.id);

  console.log('\n--- DECLINED OPERATION GRANTS ---');
  console.log('Grants for declined op count:', declinedGrants?.length || 0);

  // 2. Wallet state check
  const { data: walletSummary, error: summaryErr } = await (serviceSupabase as any)
    .rpc('get_credit_summary', { p_organization_id: testOrgId });

  console.log('\n--- WALLET SUMMARY RPC ---');
  console.log('RPC Data:', walletSummary);

  const { data: ledgerLatest } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('balance_after_minor')
    .eq('organization_id', testOrgId)
    .order('created_at', { ascending: false })
    .limit(1);

  const latestBal = Number(ledgerLatest?.[0]?.balance_after_minor || 0);
  console.log('Latest Ledger Balance Minor:', latestBal);

  // Check active telecom reservations
  const { data: activeRes } = await (serviceSupabase as any)
    .from('telecom_reservations')
    .select('id')
    .eq('organization_id', testOrgId)
    .eq('status', 'active');

  console.log('Active Telecom Reservations:', activeRes?.length || 0);

  // Check active financial holds
  const { data: activeHolds } = await (serviceSupabase as any)
    .from('financial_holds')
    .select('id')
    .eq('organization_id', testOrgId)
    .eq('status', 'active');

  console.log('Active Financial Holds:', activeHolds?.length || 0);

  // 3. Check Prior Successful Operations
  const { data: op1Grants } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('id')
    .eq('organization_id', testOrgId)
    .eq('reference_type', 'payment_operation')
    .eq('reference_id', op1Id);

  const { data: op2Grants } = await (serviceSupabase as any)
    .from('billing_credit_ledger')
    .select('id')
    .eq('organization_id', testOrgId)
    .eq('reference_type', 'payment_operation')
    .eq('reference_id', op2Id);

  console.log('\n--- PRIOR SUCCESSFUL OPERATIONS ---');
  console.log(`Op 1 (${op1Id}) grant count:`, op1Grants?.length || 0);
  console.log(`Op 2 (${op2Id}) grant count:`, op2Grants?.length || 0);

  // 4. Historical Pending Fixture Check
  const { data: histOp } = await (serviceSupabase as any)
    .from('billing_payment_operations')
    .select('id, status, provider_payment_id')
    .eq('id', historicalOpId)
    .single();

  console.log('\n--- HISTORICAL PENDING FIXTURE ---');
  console.log('ID:', histOp?.id);
  console.log('Status:', histOp?.status);
  console.log('PI ID:', histOp?.provider_payment_id);

  let histStripePi: Stripe.PaymentIntent | null = null;
  if (histOp?.provider_payment_id) {
    try {
      histStripePi = await stripe.paymentIntents.retrieve(histOp.provider_payment_id);
    } catch (e: any) {
      console.error('Failed to retrieve historical Stripe PI:', e.message);
    }
  }
  console.log('Historical Stripe PI Status:', histStripePi?.status);
}

main().catch(console.error);
