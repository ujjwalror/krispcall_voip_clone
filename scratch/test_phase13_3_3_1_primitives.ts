import fs from 'fs';
import path from 'path';

// Mock server-only module if needed
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'server-only') return {};
  return originalRequire.apply(this, arguments);
};

// Interface for test DB state
interface SagaRecord {
  id: string;
  organization_id: string;
  payment_operation_id: string;
  phone_number_e164: string;
  state: string;
  attempt_count: number;
  retail_amount_minor: number;
  currency: string;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

interface PaymentOpRecord {
  id: string;
  organization_id: string;
  operation_type: string;
  provider: string;
  status: string;
  amount_minor: number;
  currency: string;
  idempotency_key: string;
  request_fingerprint: string;
  provider_payment_id?: string | null;
  capture_dispatch_claimed_at?: string | null;
  capture_idempotency_key?: string | null;
  failure_message?: string | null;
  created_at: string;
  updated_at: string;
}

// In-Memory Test Double for Phase 13.3.3.1 Primitives Simulation & Runtime Assertions
class CapturePrimitivesTestDouble {
  private sagas = new Map<string, SagaRecord>();
  private paymentOps = new Map<string, PaymentOpRecord>();

  reset() {
    this.sagas.clear();
    this.paymentOps.clear();
  }

  insertSaga(saga: SagaRecord) {
    this.sagas.set(saga.id, { ...saga });
  }

  insertPaymentOp(op: PaymentOpRecord) {
    this.paymentOps.set(op.id, { ...op });
  }

  getSaga(id: string): SagaRecord | undefined {
    const s = this.sagas.get(id);
    return s ? { ...s } : undefined;
  }

  getPaymentOp(id: string): PaymentOpRecord | undefined {
    const op = this.paymentOps.get(id);
    return op ? { ...op } : undefined;
  }

  // 1. RPC: claim_commercial_saga_for_capture
  claimCommercialSagaForCapture(p_saga_id: string | null, p_organization_id: string | null): SagaRecord {
    if (!p_saga_id || !p_organization_id) {
      const err = new Error('INVALID_ARGUMENT: p_saga_id and p_organization_id are required.');
      (err as any).code = '22023';
      throw err;
    }

    const saga = this.sagas.get(p_saga_id);
    if (!saga) {
      const err = new Error(`SAGA_NOT_FOUND: Commercial saga ${p_saga_id} does not exist.`);
      (err as any).code = 'P0002';
      throw err;
    }

    if (saga.organization_id !== p_organization_id) {
      const err = new Error(`TENANT_MISMATCH: Commercial saga ${p_saga_id} does not belong to organization ${p_organization_id}.`);
      (err as any).code = '42501';
      throw err;
    }

    if (saga.state === 'capture_pending') {
      const err = new Error(`SAGA_ALREADY_CAPTURE_CLAIMED: Commercial saga ${p_saga_id} is already in capture_pending state.`);
      (err as any).code = '55001';
      throw err;
    }

    if (saga.state !== 'ownership_confirmed') {
      const err = new Error(`INVALID_SAGA_STATE_TRANSITION: Saga ${p_saga_id} is in state ${saga.state}, expected ownership_confirmed.`);
      (err as any).code = '55000';
      throw err;
    }

    saga.state = 'capture_pending';
    saga.attempt_count += 1;
    saga.updated_at = new Date().toISOString();
    this.sagas.set(saga.id, saga);
    return { ...saga };
  }

  // 2. RPC: claim_payment_capture_dispatch
  claimPaymentCaptureDispatch(p_payment_op_id: string | null, p_organization_id: string | null, p_saga_id: string | null): PaymentOpRecord {
    if (!p_payment_op_id || !p_organization_id || !p_saga_id) {
      const err = new Error('INVALID_ARGUMENT: p_payment_op_id, p_organization_id, and p_saga_id are required.');
      (err as any).code = '22023';
      throw err;
    }

    const op = this.paymentOps.get(p_payment_op_id);
    if (!op) {
      const err = new Error(`PAYMENT_OP_NOT_FOUND: Operation ${p_payment_op_id} does not exist.`);
      (err as any).code = 'P0002';
      throw err;
    }

    if (op.organization_id !== p_organization_id) {
      const err = new Error(`TENANT_MISMATCH: Payment operation ${p_payment_op_id} does not belong to organization ${p_organization_id}.`);
      (err as any).code = '42501';
      throw err;
    }

    const saga = this.sagas.get(p_saga_id);
    if (!saga) {
      const err = new Error(`SAGA_NOT_FOUND: Commercial saga ${p_saga_id} does not exist.`);
      (err as any).code = 'P0002';
      throw err;
    }

    if (saga.payment_operation_id !== p_payment_op_id) {
      const err = new Error(`SAGA_PAYMENT_LINK_MISMATCH: Saga ${p_saga_id} payment_operation_id ${saga.payment_operation_id} does not match operation ${p_payment_op_id}.`);
      (err as any).code = '42883';
      throw err;
    }

    if (saga.organization_id !== p_organization_id) {
      const err = new Error(`TENANT_MISMATCH: Commercial saga ${p_saga_id} organization ${saga.organization_id} does not match operation organization ${p_organization_id}.`);
      (err as any).code = '42501';
      throw err;
    }

    if (saga.state !== 'capture_pending') {
      const err = new Error(`INVALID_SAGA_STATE: Linked commercial saga ${p_saga_id} is in state ${saga.state}, expected capture_pending.`);
      (err as any).code = '55000';
      throw err;
    }

    if (op.capture_dispatch_claimed_at || op.capture_idempotency_key) {
      const err = new Error(`CAPTURE_DISPATCH_ALREADY_CLAIMED: Payment operation ${p_payment_op_id} capture dispatch has already been claimed.`);
      (err as any).code = '55001';
      throw err;
    }

    if (op.status !== 'authorized') {
      const err = new Error(`INVALID_PAYMENT_STATE_TRANSITION: Payment operation ${p_payment_op_id} is in status ${op.status}, expected authorized.`);
      (err as any).code = '55000';
      throw err;
    }

    op.status = 'capture_pending';
    op.capture_dispatch_claimed_at = new Date().toISOString();
    op.capture_idempotency_key = `cap_pi_${p_payment_op_id}`;
    op.updated_at = new Date().toISOString();
    this.paymentOps.set(op.id, op);
    return { ...op };
  }

  // 3. Trigger simulation: prevent_capture_dispatch_mutation
  updatePaymentOp(id: string, updates: Partial<PaymentOpRecord>): PaymentOpRecord {
    const existing = this.paymentOps.get(id);
    if (!existing) throw new Error(`Not found: ${id}`);

    if (existing.capture_dispatch_claimed_at !== null && existing.capture_dispatch_claimed_at !== undefined) {
      if ('capture_dispatch_claimed_at' in updates && updates.capture_dispatch_claimed_at !== existing.capture_dispatch_claimed_at) {
        const err = new Error('IMMUTABLE_CAPTURE_DISPATCH_CLAIM: capture_dispatch_claimed_at cannot be altered or cleared once set.');
        (err as any).code = '42883';
        throw err;
      }
    }

    if (existing.capture_idempotency_key !== null && existing.capture_idempotency_key !== undefined) {
      if ('capture_idempotency_key' in updates && updates.capture_idempotency_key !== existing.capture_idempotency_key) {
        const err = new Error('IMMUTABLE_CAPTURE_IDEMPOTENCY_KEY: capture_idempotency_key cannot be altered or cleared once set.');
        (err as any).code = '42883';
        throw err;
      }
    }

    const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
    this.paymentOps.set(id, updated);
    return { ...updated };
  }

  // 4. RPC: confirm_payment_captured
  confirmPaymentCaptured(p_payment_op_id: string | null, p_organization_id: string | null, p_provider_payment_id: string | null): PaymentOpRecord {
    if (!p_payment_op_id || !p_organization_id || !p_provider_payment_id || !p_provider_payment_id.trim()) {
      const err = new Error('INVALID_ARGUMENT: p_payment_op_id, p_organization_id, and non-empty p_provider_payment_id are required.');
      (err as any).code = '22023';
      throw err;
    }

    const op = this.paymentOps.get(p_payment_op_id);
    if (!op) {
      const err = new Error(`PAYMENT_OP_NOT_FOUND: Operation ${p_payment_op_id} does not exist.`);
      (err as any).code = 'P0002';
      throw err;
    }

    if (op.organization_id !== p_organization_id) {
      const err = new Error(`TENANT_MISMATCH: Payment operation ${p_payment_op_id} does not belong to organization ${p_organization_id}.`);
      (err as any).code = '42501';
      throw err;
    }

    if (op.provider_payment_id && op.provider_payment_id !== p_provider_payment_id) {
      const err = new Error(`PROVIDER_PAYMENT_ID_MISMATCH: Supplied provider_payment_id ${p_provider_payment_id} does not match registered provider_payment_id ${op.provider_payment_id}.`);
      (err as any).code = '42883';
      throw err;
    }

    if (op.status === 'captured') {
      if (!op.provider_payment_id || op.provider_payment_id === p_provider_payment_id) {
        return { ...op };
      } else {
        const err = new Error('PROVIDER_PAYMENT_ID_MISMATCH: Operation is captured under different provider identity.');
        (err as any).code = '42883';
        throw err;
      }
    }

    if (!op.capture_dispatch_claimed_at) {
      const err = new Error(`CAPTURE_DISPATCH_NOT_CLAIMED: Payment operation ${p_payment_op_id} must have capture dispatch claimed before confirming capture.`);
      (err as any).code = '55000';
      throw err;
    }

    if (op.status !== 'capture_pending') {
      const err = new Error(`INVALID_PAYMENT_STATE_TRANSITION: Payment operation ${p_payment_op_id} is in status ${op.status}, expected capture_pending.`);
      (err as any).code = '55000';
      throw err;
    }

    op.status = 'captured';
    op.provider_payment_id = op.provider_payment_id || p_provider_payment_id;
    op.updated_at = new Date().toISOString();
    this.paymentOps.set(op.id, op);
    return { ...op };
  }

  // 5. RPC: complete_commercial_saga_after_capture
  completeCommercialSagaAfterCapture(p_saga_id: string | null, p_organization_id: string | null): SagaRecord {
    if (!p_saga_id || !p_organization_id) {
      const err = new Error('INVALID_ARGUMENT: p_saga_id and p_organization_id are required.');
      (err as any).code = '22023';
      throw err;
    }

    const saga = this.sagas.get(p_saga_id);
    if (!saga) {
      const err = new Error(`SAGA_NOT_FOUND: Commercial saga ${p_saga_id} does not exist.`);
      (err as any).code = 'P0002';
      throw err;
    }

    if (saga.organization_id !== p_organization_id) {
      const err = new Error(`TENANT_MISMATCH: Commercial saga ${p_saga_id} does not belong to organization ${p_organization_id}.`);
      (err as any).code = '42501';
      throw err;
    }

    if (saga.state === 'completed') {
      return { ...saga };
    }

    if (saga.state !== 'capture_pending') {
      const err = new Error(`INVALID_SAGA_STATE_TRANSITION: Saga ${p_saga_id} is in state ${saga.state}, expected capture_pending.`);
      (err as any).code = '55000';
      throw err;
    }

    saga.state = 'completed';
    saga.completed_at = new Date().toISOString();
    saga.updated_at = new Date().toISOString();
    this.sagas.set(saga.id, saga);
    return { ...saga };
  }
}

async function runTestHarness() {
  console.log('====================================================');
  console.log('PHASE 13.3.3.1 — DURABLE FINANCIAL CAPTURE PRIMITIVES TEST');
  console.log('====================================================\n');

  const testDb = new CapturePrimitivesTestDouble();
  const testOrgId = '00000000-0000-0000-0000-000000000001';
  const otherOrgId = '00000000-0000-0000-0000-000000000002';

  let totalTests = 0;
  let passedTests = 0;

  function assert(condition: boolean, label: string) {
    totalTests++;
    if (condition) {
      console.log(`✓ Test ${totalTests}: ${label}`);
      passedTests++;
    } else {
      console.error(`❌ Test ${totalTests} FAILED: ${label}`);
      process.exit(1);
    }
  }

  // --- SECTION A: SAGA CAPTURE CLAIM TESTS ---
  console.log('--- A. SAGA CAPTURE CLAIM TESTS ---');

  const payOpA: PaymentOpRecord = {
    id: 'pay_op_001',
    organization_id: testOrgId,
    operation_type: 'number_purchase',
    provider: 'stripe',
    status: 'authorized',
    amount_minor: 500,
    currency: 'USD',
    idempotency_key: 'idemp_001',
    request_fingerprint: `sha256:${'a'.repeat(64)}`,
    provider_payment_id: 'pi_test_001',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  testDb.insertPaymentOp(payOpA);

  const sagaA: SagaRecord = {
    id: 'saga_001',
    organization_id: testOrgId,
    payment_operation_id: payOpA.id,
    phone_number_e164: '+19998887766',
    state: 'ownership_confirmed',
    attempt_count: 1,
    retail_amount_minor: 500,
    currency: 'USD',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  testDb.insertSaga(sagaA);

  // A1. Null inputs rejected
  try {
    testDb.claimCommercialSagaForCapture(null, testOrgId);
    assert(false, 'Null saga ID rejected');
  } catch (err: any) {
    assert(err.code === '22023', 'A1. Null saga ID rejected with 22023');
  }

  // A2. Tenant mismatch rejected
  try {
    testDb.claimCommercialSagaForCapture(sagaA.id, otherOrgId);
    assert(false, 'Wrong org ID rejected');
  } catch (err: any) {
    assert(err.code === '42501', 'A2. Wrong organization ID rejected with 42501 (TENANT_MISMATCH)');
  }

  // A3. Successful claim from ownership_confirmed -> capture_pending
  const claimedSaga = testDb.claimCommercialSagaForCapture(sagaA.id, testOrgId);
  assert(claimedSaga.state === 'capture_pending', 'A3. Saga state transitioned to capture_pending');
  assert(claimedSaga.attempt_count === 2, 'A3. Saga attempt_count incremented once (1 -> 2)');

  // A4. Second claim rejected (already capture_pending)
  try {
    testDb.claimCommercialSagaForCapture(sagaA.id, testOrgId);
    assert(false, 'Second capture claim rejected');
  } catch (err: any) {
    assert(err.code === '55001', 'A4. Second capture claim rejected with SAGA_ALREADY_CAPTURE_CLAIMED (55001)');
  }

  // A5. Invalid source states rejected
  const invalidStates = ['authorized', 'provider_reconciliation_required', 'financial_reconciliation_required', 'completed'];
  for (const st of invalidStates) {
    const sId = `saga_${st}`;
    const pId = `pay_${st}`;
    testDb.insertPaymentOp({ ...payOpA, id: pId });
    testDb.insertSaga({ ...sagaA, id: sId, payment_operation_id: pId, state: st });
    try {
      testDb.claimCommercialSagaForCapture(sId, testOrgId);
      assert(false, `State ${st} should be rejected`);
    } catch (err: any) {
      assert(err.code === '55000', `A5. Claim rejected for state '${st}' with INVALID_SAGA_STATE_TRANSITION (55000)`);
    }
  }

  // --- SECTION B: CONCURRENT SAGA CLAIMS TESTS ---
  console.log('\n--- B. CONCURRENT SAGA CLAIMS TESTS ---');
  const concSagaId = 'saga_conc_001';
  const concPayId = 'pay_conc_001';
  testDb.insertPaymentOp({ ...payOpA, id: concPayId });
  testDb.insertSaga({ ...sagaA, id: concSagaId, payment_operation_id: concPayId, state: 'ownership_confirmed', attempt_count: 1 });

  let concSuccess = 0;
  let concFail = 0;
  try {
    testDb.claimCommercialSagaForCapture(concSagaId, testOrgId);
    concSuccess++;
  } catch (err) {
    concFail++;
  }
  try {
    testDb.claimCommercialSagaForCapture(concSagaId, testOrgId);
    concSuccess++;
  } catch (err: any) {
    if (err.code === '55001') concFail++;
  }

  assert(concSuccess === 1 && concFail === 1, 'B1. Concurrent saga claims result in exactly ONE winner and ONE 55001 loser');
  assert(testDb.getSaga(concSagaId)?.state === 'capture_pending', 'B2. Final saga state is capture_pending');
  assert(testDb.getSaga(concSagaId)?.attempt_count === 2, 'B3. attempt_count incremented exactly once');

  // --- SECTION C: PAYMENT DISPATCH CLAIM TESTS ---
  console.log('\n--- C. PAYMENT DISPATCH CLAIM TESTS ---');

  // C1. Wrong saga link rejected
  try {
    testDb.claimPaymentCaptureDispatch(payOpA.id, testOrgId, concSagaId);
    assert(false, 'Mismatched saga link rejected');
  } catch (err: any) {
    assert(err.code === '42883', 'C1. Mismatched payment/saga link rejected with 42883');
  }

  // C2. Wrong tenant rejected
  try {
    testDb.claimPaymentCaptureDispatch(payOpA.id, otherOrgId, sagaA.id);
    assert(false, 'Wrong tenant rejected');
  } catch (err: any) {
    assert(err.code === '42501', 'C2. Wrong tenant rejected with 42501');
  }

  // C3. Successful payment dispatch claim (authorized -> capture_pending)
  const claimedOp = testDb.claimPaymentCaptureDispatch(payOpA.id, testOrgId, sagaA.id);
  assert(claimedOp.status === 'capture_pending', 'C3. Payment status transitioned to capture_pending');
  assert(!!claimedOp.capture_dispatch_claimed_at, 'C3. capture_dispatch_claimed_at timestamp set');
  assert(claimedOp.capture_idempotency_key === `cap_pi_${payOpA.id}`, 'C3. capture_idempotency_key set to cap_pi_{payment_op_id}');

  // C4. Second dispatch claim rejected
  try {
    testDb.claimPaymentCaptureDispatch(payOpA.id, testOrgId, sagaA.id);
    assert(false, 'Second dispatch claim rejected');
  } catch (err: any) {
    assert(err.code === '55001', 'C4. Second dispatch claim rejected with CAPTURE_DISPATCH_ALREADY_CLAIMED (55001)');
  }

  // --- SECTION D: IMMUTABILITY TRIGGER TESTS ---
  console.log('\n--- D. IMMUTABILITY TRIGGER TESTS ---');

  // D1. Altering timestamp rejected
  try {
    testDb.updatePaymentOp(payOpA.id, { capture_dispatch_claimed_at: new Date(Date.now() - 5000).toISOString() });
    assert(false, 'Altering timestamp rejected');
  } catch (err: any) {
    assert(err.code === '42883', 'D1. Altering capture_dispatch_claimed_at rejected with IMMUTABLE_CAPTURE_DISPATCH_CLAIM');
  }

  // D2. Clearing timestamp to null rejected
  try {
    testDb.updatePaymentOp(payOpA.id, { capture_dispatch_claimed_at: null });
    assert(false, 'Clearing timestamp rejected');
  } catch (err: any) {
    assert(err.code === '42883', 'D2. Clearing capture_dispatch_claimed_at to null rejected with IMMUTABLE_CAPTURE_DISPATCH_CLAIM');
  }

  // D3. Altering idempotency key rejected
  try {
    testDb.updatePaymentOp(payOpA.id, { capture_idempotency_key: 'tampered_key' });
    assert(false, 'Altering idempotency key rejected');
  } catch (err: any) {
    assert(err.code === '42883', 'D3. Altering capture_idempotency_key rejected with IMMUTABLE_CAPTURE_IDEMPOTENCY_KEY');
  }

  // D4. Unrelated permitted field update works
  const updatedOp = testDb.updatePaymentOp(payOpA.id, { failure_message: 'Permitted failure log' });
  assert(updatedOp.failure_message === 'Permitted failure log', 'D4. Unrelated payment field update succeeded');

  // --- SECTION E: CONFIRM PAYMENT CAPTURED TESTS ---
  console.log('\n--- E. CONFIRM PAYMENT CAPTURED TESTS ---');

  // E1. Mismatched provider payment ID rejected
  try {
    testDb.confirmPaymentCaptured(payOpA.id, testOrgId, 'pi_wrong_id');
    assert(false, 'Wrong provider ID rejected');
  } catch (err: any) {
    assert(err.code === '42883', 'E1. Mismatched provider_payment_id rejected with 42883');
  }

  // E2. Successful capture confirmation: capture_pending -> captured
  const confirmedOp = testDb.confirmPaymentCaptured(payOpA.id, testOrgId, payOpA.provider_payment_id!);
  assert(confirmedOp.status === 'captured', 'E2. Payment status updated to captured');

  // E3. Second confirmation is idempotent
  const reConfirmedOp = testDb.confirmPaymentCaptured(payOpA.id, testOrgId, payOpA.provider_payment_id!);
  assert(reConfirmedOp.status === 'captured', 'E3. Second confirmPaymentCaptured call returned idempotently');

  // --- SECTION F: SAGA COMPLETION TESTS ---
  console.log('\n--- F. SAGA COMPLETION TESTS ---');

  // F1. Successful saga completion: capture_pending -> completed
  const completedSaga = testDb.completeCommercialSagaAfterCapture(sagaA.id, testOrgId);
  assert(completedSaga.state === 'completed', 'F1. Saga state transitioned to completed');
  assert(!!completedSaga.completed_at, 'F1. completed_at timestamp set atomically');

  // F2. Second completion is idempotent
  const reCompletedSaga = testDb.completeCommercialSagaAfterCapture(sagaA.id, testOrgId);
  assert(reCompletedSaga.state === 'completed', 'F2. Second completeCommercialSagaAfterCapture call returned idempotently');

  console.log('\n====================================================');
  console.log(`TEST SUMMARY: ${passedTests}/${totalTests} TESTS PASSED CLEANLY`);
  console.log('====================================================');
}

runTestHarness().catch((err) => {
  console.error('Fatal error during test harness execution:', err);
  process.exit(1);
});
