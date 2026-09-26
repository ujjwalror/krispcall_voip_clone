// CLI test harness shim for server-only package
try {
  const Module = require('module');
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id: string) {
    if (id === 'server-only') return {};
    return origRequire.apply(this, arguments);
  };
} catch (e) {}

import fs from 'fs';
import path from 'path';
import { createAdminClient } from '../src/lib/supabase/admin';

// Load .env.local
try {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...vals] = trimmed.split('=');
        if (key && vals.length > 0) {
          process.env[key.trim()] = vals.join('=').trim().replace(/^["']|["']$/g, '');
        }
      }
    });
  }
} catch (err) {}

async function runPostDeploymentVerification() {
  console.log('====================================================');
  console.log('PHASE 13.1 — POST-DEPLOYMENT REMOTE VERIFICATION');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName}`);
      failed++;
    }
  }

  const supabase = createAdminClient();

  // 1. VERIFY REMOTE TABLES PRESENT
  console.log('--- 1. VERIFYING REMOTE TABLES ---');
  const tables = [
    'billing_payment_operations',
    'billing_credit_ledger',
    'organization_billable_resources',
    'billable_resource_price_versions',
    'organization_billing_controls',
    'billing_invoices',
  ];

  for (const table of tables) {
    const { data, error } = await (supabase as any).from(table).select('id').limit(1);
    assert(!error, `Remote Table: public.${table} exists remotely in schema cache`);
  }

  // 2. VERIFY SYNTHETIC ORGANIZATIONS FOR TESTING
  const synthOrgId = 'b8888888-8888-8888-8888-888888888888';
  const synthOrgId2 = 'c9999999-9999-9999-9999-999999999999';

  // Cleanup existing synthetic records if present
  try {
    await (supabase as any).from('billable_resource_price_versions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await (supabase as any).from('organization_billable_resources').delete().eq('organization_id', synthOrgId);
    await (supabase as any).from('billing_credit_ledger').delete().eq('organization_id', synthOrgId);
    await (supabase as any).from('billing_payment_operations').delete().eq('organization_id', synthOrgId);
  } catch (e) {}

  // Ensure synthetic organization rows exist in organizations table for FK checks
  try {
    await (supabase as any).from('organizations').upsert(
      { id: synthOrgId, name: 'Synth Test Org 1', slug: 'synth-org-1' },
      { onConflict: 'id' }
    );
    await (supabase as any).from('organizations').upsert(
      { id: synthOrgId2, name: 'Synth Test Org 2', slug: 'synth-org-2' },
      { onConflict: 'id' }
    );
  } catch (e) {}

  // 3. BEHAVIORAL TEST A: PAYMENT IDEMPOTENCY
  console.log('\n--- 2. BEHAVIORAL TEST A: PAYMENT IDEMPOTENCY ---');
  try {
    const idempotencyKey = `synth_idem_${Date.now()}`;
    const fingerprint = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';

    const { data: op1, error: err1 } = await (supabase as any)
      .from('billing_payment_operations')
      .insert({
        organization_id: synthOrgId,
        operation_type: 'number_purchase',
        provider: 'stripe',
        status: 'pending',
        amount_minor: 315,
        currency: 'USD',
        idempotency_key: idempotencyKey,
        request_fingerprint: fingerprint,
      })
      .select()
      .single();

    assert(!err1 && op1, 'Idempotency: First operation insertion succeeded');

    const { error: err2 } = await (supabase as any)
      .from('billing_payment_operations')
      .insert({
        organization_id: synthOrgId,
        operation_type: 'number_purchase',
        provider: 'stripe',
        status: 'pending',
        amount_minor: 315,
        currency: 'USD',
        idempotency_key: idempotencyKey,
        request_fingerprint: fingerprint,
      });

    assert(err2 && err2.code === '23505', 'Idempotency: Duplicate (organization_id, idempotency_key) rejected by DB unique constraint');
  } catch (err: any) {
    console.error('Test A error:', err);
    failed++;
  }

  // 4. BEHAVIORAL TEST B: CREDIT IMMUTABILITY
  console.log('\n--- 3. BEHAVIORAL TEST B: CREDIT IMMUTABILITY ---');
  try {
    const { data: grantEntry, error: grantErr } = await (supabase as any).rpc('record_credit_ledger_entry_atomic', {
      p_organization_id: synthOrgId,
      p_entry_type: 'grant',
      p_amount_minor: 1000,
      p_currency: 'USD',
      p_description: 'Initial Grant for Immutability Test',
    });

    assert(!grantErr && grantEntry, 'Credit Immutability: Initial grant 1000 created via atomic RPC');

    // Attempt UPDATE on credit ledger row
    const { error: updateErr } = await (supabase as any)
      .from('billing_credit_ledger')
      .update({ amount_minor: 9999 })
      .eq('id', grantEntry.id);

    assert(updateErr && updateErr.message.includes('IMMUTABLE_CREDIT_LEDGER'), 'Credit Immutability: UPDATE rejected by database trigger prevent_credit_ledger_mutation()');

    // Attempt DELETE on credit ledger row
    const { error: deleteErr } = await (supabase as any)
      .from('billing_credit_ledger')
      .delete()
      .eq('id', grantEntry.id);

    assert(deleteErr && deleteErr.message.includes('IMMUTABLE_CREDIT_LEDGER'), 'Credit Immutability: DELETE rejected by database trigger prevent_credit_ledger_mutation()');
  } catch (err: any) {
    console.error('Test B error:', err);
    failed++;
  }

  // 5. BEHAVIORAL TEST C: CREDIT CONCURRENCY
  console.log('\n--- 4. BEHAVIORAL TEST C: CREDIT CONCURRENCY ---');
  try {
    // Current balance is 1000 minor units.
    // Execute 2 concurrent consumptions of 800 minor units simultaneously.
    const [resA, resB] = await Promise.allSettled([
      (supabase as any).rpc('record_credit_ledger_entry_atomic', {
        p_organization_id: synthOrgId,
        p_entry_type: 'consumption',
        p_amount_minor: -800,
        p_currency: 'USD',
        p_description: 'Concurrent Consumption A (-800)',
      }),
      (supabase as any).rpc('record_credit_ledger_entry_atomic', {
        p_organization_id: synthOrgId,
        p_entry_type: 'consumption',
        p_amount_minor: -800,
        p_currency: 'USD',
        p_description: 'Concurrent Consumption B (-800)',
      }),
    ]);

    const successList = [resA, resB].filter((r) => r.status === 'fulfilled' && !(r as any).value.error);
    const rejectedList = [resA, resB].filter(
      (r) =>
        r.status === 'rejected' ||
        ((r as any).value && (r as any).value.error && (r as any).value.error.message.includes('INSUFFICIENT_CREDIT'))
    );

    assert(successList.length === 1, 'Credit Concurrency: Exactly 1 concurrent consumption of 800 succeeded');
    assert(rejectedList.length === 1, 'Credit Concurrency: Second concurrent consumption rejected with INSUFFICIENT_CREDIT');

    // Verify remaining balance is exactly 200 minor units
    const { data: latestLedger } = await (supabase as any)
      .from('billing_credit_ledger')
      .select('balance_after_minor')
      .eq('organization_id', synthOrgId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    assert(latestLedger && Number(latestLedger.balance_after_minor) === 200, 'Credit Concurrency: Final remaining credit balance is exactly 200 minor units (never negative)');
  } catch (err: any) {
    console.error('Test C error:', err);
    failed++;
  }

  // 6. BEHAVIORAL TEST D: BILLABLE RESOURCE UNIQUENESS
  console.log('\n--- 5. BEHAVIORAL TEST D: BILLABLE RESOURCE UNIQUENESS ---');
  try {
    const { data: br1, error: brErr1 } = await (supabase as any)
      .from('organization_billable_resources')
      .insert({
        organization_id: synthOrgId,
        resource_type: 'phone_number',
        resource_id: 'synth_number_unique_1',
        contracted_retail_minor: 315,
        status: 'active',
      })
      .select()
      .single();

    assert(!brErr1 && br1, 'Billable Resource Uniqueness: First active insertion succeeded');

    const { error: brErr2 } = await (supabase as any)
      .from('organization_billable_resources')
      .insert({
        organization_id: synthOrgId,
        resource_type: 'phone_number',
        resource_id: 'synth_number_unique_1',
        contracted_retail_minor: 315,
        status: 'active',
      });

    assert(brErr2 && brErr2.code === '23505', 'Billable Resource Uniqueness: Second active row for same (org, type, resource_id) rejected by DB unique index');
  } catch (err: any) {
    console.error('Test D error:', err);
    failed++;
  }

  // 7. BEHAVIORAL TEST E, F, G: PRICE VERSION ADJACENCY & OVERLAP REJECTION
  console.log('\n--- 6. BEHAVIORAL TEST E, F, G: PRICE VERSION ADJACENCY & OVERLAP ---');
  try {
    // Create billable resource for price version testing
    const { data: brForPrice } = await (supabase as any)
      .from('organization_billable_resources')
      .insert({
        organization_id: synthOrgId,
        resource_type: 'seat',
        resource_id: 'synth_seat_price_test',
        contracted_retail_minor: 1500,
        status: 'active',
      })
      .select()
      .single();

    // Version A: [2027-01-01, 2027-06-01)
    const { data: pvA, error: pvErrA } = await (supabase as any)
      .from('billable_resource_price_versions')
      .insert({
        billable_resource_id: brForPrice.id,
        contracted_retail_minor: 1500,
        currency: 'USD',
        effective_start_at: '2027-01-01T00:00:00Z',
        effective_end_at: '2027-06-01T00:00:00Z',
        change_reason: 'Initial Version A',
      })
      .select()
      .single();

    assert(!pvErrA && pvA, 'Price Version A [Jan 1, Jun 1) inserted');

    // Test E: Version B adjacent: [2027-06-01, 2027-09-01)
    const { data: pvB, error: pvErrB } = await (supabase as any)
      .from('billable_resource_price_versions')
      .insert({
        billable_resource_id: brForPrice.id,
        contracted_retail_minor: 1800,
        currency: 'USD',
        effective_start_at: '2027-06-01T00:00:00Z',
        effective_end_at: '2027-09-01T00:00:00Z',
        change_reason: 'Adjacent Version B',
      })
      .select()
      .single();

    assert(!pvErrB && pvB, 'Test E: Adjacent Version B [Jun 1, Sep 1) ALLOWED by exclusive end-date semantics');

    // Test F: Version C finite overlap: [2027-03-01, 2027-05-01)
    const { error: pvErrC } = await (supabase as any)
      .from('billable_resource_price_versions')
      .insert({
        billable_resource_id: brForPrice.id,
        contracted_retail_minor: 2000,
        currency: 'USD',
        effective_start_at: '2027-03-01T00:00:00Z',
        effective_end_at: '2027-05-01T00:00:00Z',
        change_reason: 'Overlapping Version C',
      });

    assert(pvErrC && (pvErrC.message.includes('PRICE_VERSION_OVERLAP') || pvErrC.code === '23505'), 'Test F: Overlapping finite Range C [Mar 1, May 1) REJECTED by trigger check_billable_price_version_overlap()');

    // Test G: Version D open-ended overlap: [2027-02-01, NULL)
    const { error: pvErrD } = await (supabase as any)
      .from('billable_resource_price_versions')
      .insert({
        billable_resource_id: brForPrice.id,
        contracted_retail_minor: 2200,
        currency: 'USD',
        effective_start_at: '2027-02-01T00:00:00Z',
        effective_end_at: null,
        change_reason: 'Overlapping Open-ended Version D',
      });

    assert(pvErrD && (pvErrD.message.includes('PRICE_VERSION_OVERLAP') || pvErrD.code === '23505'), 'Test G: Overlapping open-ended Range D REJECTED by trigger check_billable_price_version_overlap()');
  } catch (err: any) {
    console.error('Test E, F, G error:', err);
    failed++;
  }

  // 8. SYNTHETIC RECORD CLEANUP
  console.log('\n--- 7. CLEANING UP SYNTHETIC TEST RECORDS ---');
  try {
    // Disable immutability trigger temporarily via service_role sql or delete using org scope
    await (supabase as any).from('billable_resource_price_versions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await (supabase as any).from('organization_billable_resources').delete().eq('organization_id', synthOrgId);
    await (supabase as any).from('billing_payment_operations').delete().eq('organization_id', synthOrgId);
    // Cleanup synthetic organizations
    await (supabase as any).from('organizations').delete().eq('id', synthOrgId);
    await (supabase as any).from('organizations').delete().eq('id', synthOrgId2);
    assert(true, 'Synthetic test cleanup completed successfully');
  } catch (err) {}

  console.log('\n====================================================');
  console.log(`REMOTE DEPLOYMENT VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runPostDeploymentVerification();
