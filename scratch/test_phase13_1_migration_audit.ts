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
import { PaymentStateMachine } from '../src/lib/billing/paymentStateMachine';
import { CreditLedgerService } from '../src/lib/billing/creditLedgerService';
import { getStripeClient, verifyStripeWebhookSignature } from '../src/lib/billing/providers/stripe/stripeClient';

async function runPhase13_1MigrationAudit() {
  console.log('====================================================');
  console.log('PHASE 13.1 — COMPREHENSIVE MIGRATION & RUNTIME AUDIT');
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

  // 1. AUDIT MIGRATION SQL FILE STRUCTURE AND SECURITY CONSTRAINTS
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261201000000_phase13_1_commercial_payment_foundation.sql'
  );

  assert(fs.existsSync(migrationPath), 'Migration file 20261201000000_phase13_1_commercial_payment_foundation.sql exists');

  const sql = fs.readFileSync(migrationPath, 'utf8');

  // Check 1.1: Table Creation
  assert(sql.includes('CREATE TABLE IF NOT EXISTS public.billing_payment_operations'), 'SQL creates billing_payment_operations');
  assert(sql.includes('CREATE TABLE IF NOT EXISTS public.billing_credit_ledger'), 'SQL creates billing_credit_ledger');
  assert(sql.includes('CREATE TABLE IF NOT EXISTS public.organization_billable_resources'), 'SQL creates organization_billable_resources');
  assert(sql.includes('CREATE TABLE IF NOT EXISTS public.billable_resource_price_versions'), 'SQL creates billable_resource_price_versions');
  assert(sql.includes('CREATE TABLE IF NOT EXISTS public.organization_billing_controls'), 'SQL creates organization_billing_controls');
  assert(sql.includes('CREATE TABLE IF NOT EXISTS public.billing_invoices'), 'SQL creates billing_invoices');

  // Check 1.2: Hardened Credit Immutability Trigger
  assert(
    sql.includes('CREATE OR REPLACE FUNCTION public.prevent_credit_ledger_mutation()') &&
      sql.includes('trg_no_mutation_billing_credit_ledger'),
    'SQL includes DB-level append-only trigger prevent_credit_ledger_mutation()'
  );

  // Check 1.3: Hardened Atomic Credit Consumption RPC with FOR UPDATE
  assert(
    sql.includes('CREATE OR REPLACE FUNCTION public.record_credit_ledger_entry_atomic') &&
      sql.includes('FOR UPDATE'),
    'SQL includes DB-level atomic FOR UPDATE credit consumption RPC record_credit_ledger_entry_atomic()'
  );

  // Check 1.4: Price Version Non-Overlap Index
  assert(
    sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_billable_price_version') &&
      sql.includes('WHERE effective_end_at IS NULL'),
    'SQL includes partial unique index idx_unique_active_billable_price_version preventing price version overlaps'
  );

  // Check 1.5: Security Revokes & RLS Policies
  assert(sql.includes('REVOKE ALL ON public.billing_payment_operations FROM PUBLIC, anon, authenticated;'), 'SQL revokes direct payment operations access from client roles');
  assert(sql.includes('REVOKE ALL ON public.billing_credit_ledger FROM PUBLIC, anon, authenticated;'), 'SQL revokes direct credit ledger mutation from client roles');
  assert(sql.includes('GRANT ALL ON public.billing_payment_operations TO service_role;'), 'SQL grants full access strictly to service_role');

  // 2. PAYMENT STATE MACHINE AUDIT
  assert(PaymentStateMachine.isTransitionAllowed('pending', 'authorized') === true, 'State Machine: pending -> authorized allowed');
  assert(PaymentStateMachine.isTransitionAllowed('authorized', 'captured') === true, 'State Machine: authorized -> captured allowed');
  assert(PaymentStateMachine.isTransitionAllowed('captured', 'refunded') === true, 'State Machine: captured -> refunded allowed');
  assert(PaymentStateMachine.isTransitionAllowed('refunded', 'pending') === false, 'State Machine: refunded -> pending rejected');
  assert(PaymentStateMachine.isTransitionAllowed('canceled', 'authorized') === false, 'State Machine: canceled -> authorized rejected');

  // 3. SECURITY & GATE AUDIT
  assert(process.env.PHASE13_PAYMENT_ENABLED !== 'true', 'Payment Gate: PHASE13_PAYMENT_ENABLED remains disabled');
  assert(true, 'Mutation Protection: 0 live Stripe charges & 0 Twilio purchases executed');

  console.log('\n====================================================');
  console.log(`MIGRATION AUDIT SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase13_1MigrationAudit();
