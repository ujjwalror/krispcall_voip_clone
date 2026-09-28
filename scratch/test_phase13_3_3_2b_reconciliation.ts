import Stripe from 'stripe';
import {
  CommercialCaptureReconciliationService,
} from '../src/lib/billing/commercialCaptureReconciliationService';
import { CommercialSagaState } from '../src/lib/billing/commercialSagaStateMachine';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
    failed++;
  }
}

/**
 * Mock Supabase Client Double with synthetic in-memory state.
 */
function createMockSupabase(initialState: {
  sagas?: Record<string, any>;
  paymentOps?: Record<string, any>;
  providerOps?: Record<string, any>;
  phoneNumbers?: Record<string, any>;
  confirmCapturedRpcHandler?: (args: any) => any;
  completeSagaRpcHandler?: (args: any) => any;
}) {
  const state = {
    sagas: { ...(initialState.sagas || {}) },
    paymentOps: { ...(initialState.paymentOps || {}) },
    providerOps: { ...(initialState.providerOps || {}) },
    phoneNumbers: { ...(initialState.phoneNumbers || {}) },
  };

  const db: any = {
    from: (table: string) => {
      return {
        select: () => ({
          eq: (field1: string, val1: any) => ({
            maybeSingle: async () => {
              const items = Object.values((state as any)[getTableKey(table)] || {});
              const match = items.find((item: any) => item[field1] === val1 || item[toCamelCase(field1)] === val1);
              return { data: match || null, error: null };
            },
            eq: (field2: string, val2: any) => ({
              maybeSingle: async () => {
                const items = Object.values((state as any)[getTableKey(table)] || {});
                const match = items.find((item: any) =>
                  (item[field1] === val1 || item[toCamelCase(field1)] === val1) &&
                  (item[field2] === val2 || item[toCamelCase(field2)] === val2)
                );
                return { data: match || null, error: null };
              },
            }),
          }),
        }),
        update: (payload: any) => ({
          eq: (field: string, val: any) => ({
            select: () => ({
              maybeSingle: async () => {
                const items: any[] = Object.values((state as any)[getTableKey(table)] || {});
                const target = items.find((item: any) => item[field] === val);
                if (target) {
                  Object.assign(target, payload);
                  return { data: target, error: null };
                }
                return { data: null, error: null };
              },
            }),
          }),
        }),
      };
    },
    rpc: async (fnName: string, args: any) => {
      if (fnName === 'confirm_payment_captured') {
        if (initialState.confirmCapturedRpcHandler) {
          return initialState.confirmCapturedRpcHandler(args);
        }
        const op = state.paymentOps[args.p_payment_op_id];
        if (op) {
          if (!op.capture_dispatch_claimed_at) {
            return { data: null, error: { message: 'CAPTURE_DISPATCH_NOT_CLAIMED' } };
          }
          op.status = 'captured';
          op.provider_payment_id = args.p_provider_payment_id;
          return { data: op, error: null };
        }
        return { data: null, error: { message: 'PAYMENT_OP_NOT_FOUND' } };
      }

      if (fnName === 'complete_commercial_saga_after_capture') {
        if (initialState.completeSagaRpcHandler) {
          return initialState.completeSagaRpcHandler(args);
        }
        const saga = state.sagas[args.p_saga_id];
        if (saga) {
          saga.state = 'completed';
          saga.completed_at = new Date().toISOString();
          return { data: saga, error: null };
        }
        return { data: null, error: { message: 'SAGA_NOT_FOUND' } };
      }

      return { data: null, error: { message: 'UNKNOWN_RPC' } };
    },
    _state: state,
  };

  return db;
}

function getTableKey(table: string): string {
  switch (table) {
    case 'commercial_number_purchase_sagas': return 'sagas';
    case 'billing_payment_operations': return 'paymentOps';
    case 'provider_number_operations': return 'providerOps';
    case 'phone_numbers': return 'phoneNumbers';
    default: return table;
  }
}

function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
}

async function runTests() {
  console.log('====================================================');
  console.log('PHASE 13.3.3.2B — SHARED RECONCILIATION TEST SUITE');
  console.log('====================================================\n');

  const orgId = '11111111-1111-4111-a111-111111111111';
  const sagaId = '22222222-2222-4222-a222-222222222222';
  const paymentOpId = '33333333-3333-4333-a333-333333333333';
  const providerOpId = 'prov_op_4444444444444444';
  const piId = 'pi_test_5555555555555555';
  const twilioSid = 'PN66666666666666666666666666666666';
  const e164 = '+12025550199';

  const baseSaga = {
    id: sagaId,
    organization_id: orgId,
    state: 'capture_pending' as CommercialSagaState,
    phone_number_e164: e164,
    retail_amount_minor: 1500,
    currency: 'USD',
    payment_operation_id: paymentOpId,
    provider_number_operation_id: providerOpId,
  };

  const basePaymentOpClaimed = {
    id: paymentOpId,
    organization_id: orgId,
    commercial_saga_id: sagaId,
    provider: 'stripe',
    status: 'capture_pending',
    amount_minor: 1500,
    currency: 'USD',
    provider_payment_id: piId,
    capture_method: 'manual',
    capture_dispatch_claimed_at: '2026-09-28T10:00:00Z',
    capture_idempotency_key: `cap_pi_${paymentOpId}`,
    authorization_expires_at: null,
  };

  const baseProvOp = {
    id: providerOpId,
    organization_id: orgId,
    phone_number_e164: e164,
    status: 'succeeded',
    provider_resource_id: twilioSid,
  };

  const basePhoneRow = {
    id: 'phone_7777777777777777',
    organization_id: orgId,
    phone_number: e164,
    status: 'active',
    provider_resource_id: twilioSid,
  };

  const mockSucceededPI: Partial<Stripe.PaymentIntent> = {
    id: piId,
    status: 'succeeded',
    capture_method: 'manual',
    amount: 1500,
    currency: 'usd',
    amount_capturable: 0,
    amount_received: 1500,
    livemode: false,
  };

  const mockStripeOverride: any = {
    paymentIntents: {
      retrieve: async (id: string) => {
        if (id === piId) return mockSucceededPI;
        if (id === 'pi_requires_capture') {
          return { ...mockSucceededPI, id, status: 'requires_capture', amount_capturable: 1500, amount_received: 0 };
        }
        throw new Error('No such PaymentIntent');
      },
    },
  };

  // --------------------------------------------------
  // 1. HAPPY PATH SHARED RECONCILIATION
  // --------------------------------------------------
  console.log('--- 1. Authoritative Shared Reconciliation (Happy Path) ---');

  const db1 = createMockSupabase({
    sagas: { [sagaId]: { ...baseSaga } },
    paymentOps: { [paymentOpId]: { ...basePaymentOpClaimed } },
    providerOps: { [providerOpId]: { ...baseProvOp } },
    phoneNumbers: { [e164]: { ...basePhoneRow } },
  });

  const res1 = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(db1, {
    sagaId,
    expectedMode: 'test',
    stripeOverride: mockStripeOverride,
  });

  assert(res1.success === true, 'Reconciliation success');
  assert(res1.classification === 'CAPTURE_CONFIRMED', 'Classification CAPTURE_CONFIRMED');
  assert(res1.saga?.state === 'completed', 'Saga state reached completed');
  assert(res1.paymentOp?.status === 'captured', 'Payment operation reached captured');
  assert(res1.customerDTO.isSuccess === true, 'Customer DTO is success state');


  // --------------------------------------------------
  // 2. MANDATORY CORRECTION 1: SUCCEEDED WITHOUT DISPATCH CLAIM
  // --------------------------------------------------
  console.log('\n--- 2. MANDATORY CORRECTION 1: Succeeded PI without Dispatch Claim ---');

  const basePaymentOpUnclaimed = {
    ...basePaymentOpClaimed,
    status: 'authorized',
    capture_dispatch_claimed_at: null, // UNCLAIMED ANOMALY!
    capture_idempotency_key: null,
  };

  const db2 = createMockSupabase({
    sagas: { [sagaId]: { ...baseSaga, state: 'ownership_confirmed' } },
    paymentOps: { [paymentOpId]: { ...basePaymentOpUnclaimed } },
    providerOps: { [providerOpId]: { ...baseProvOp } },
    phoneNumbers: { [e164]: { ...basePhoneRow } },
  });

  const res2 = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(db2, {
    sagaId,
    expectedMode: 'test',
    stripeOverride: mockStripeOverride,
  });

  assert(res2.success === false, 'Anomalous succeeded without dispatch claim fails closed');
  assert(
    res2.classification === 'DISPATCH_NOT_CLAIMED_RECONCILIATION_REQUIRED',
    'Classification is DISPATCH_NOT_CLAIMED_RECONCILIATION_REQUIRED'
  );
  assert(res2.paymentOp?.status === 'authorized', 'Payment status remains authorized (confirm_payment_captured NOT called)');
  assert(res2.saga?.state === 'ownership_confirmed', 'Saga state remains ownership_confirmed (READ-ONLY / ZERO DB mutations)');
  assert(!JSON.stringify(res2.customerDTO).includes('DISPATCH_NOT_CLAIMED'), 'Customer DTO leaks no internal error text');


  // --------------------------------------------------
  // 3. TELECOM NOT READY AT CAPTURE TIME
  // --------------------------------------------------
  console.log('\n--- 3. Telecom Not Ready At Payment Capture Time ---');

  const db3 = createMockSupabase({
    sagas: { [sagaId]: { ...baseSaga } },
    paymentOps: { [paymentOpId]: { ...basePaymentOpClaimed } },
    providerOps: { [providerOpId]: { ...baseProvOp, status: 'pending' } }, // NOT READY!
    phoneNumbers: {},
  });

  const res3 = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(db3, {
    sagaId,
    expectedMode: 'test',
    stripeOverride: mockStripeOverride,
  });

  assert(res3.success === false, 'Saga completion skipped when telecom not ready');
  assert(res3.classification === 'CAPTURE_CONFIRMED', 'Payment itself captured authoritatively');
  assert(res3.paymentOp?.status === 'captured', 'Payment operation status transitioned to captured');
  assert(res3.saga?.state === 'capture_pending', 'Saga state remains in capture_pending (complete_saga NOT called)');


  // --------------------------------------------------
  // 4. AMBIGUOUS DISPATCH (CLAIMED + REQUIRES_CAPTURE)
  // --------------------------------------------------
  console.log('\n--- 4. Ambiguous Dispatch (Claimed + Requires Capture) ---');

  const db4 = createMockSupabase({
    sagas: { [sagaId]: { ...baseSaga } },
    paymentOps: { [paymentOpId]: { ...basePaymentOpClaimed } },
    providerOps: { [providerOpId]: { ...baseProvOp } },
    phoneNumbers: { [e164]: { ...basePhoneRow } },
  });

  const mockRequiresCaptureOverride: any = {
    paymentIntents: {
      retrieve: async () => ({
        id: piId,
        status: 'requires_capture',
        capture_method: 'manual',
        amount: 1500,
        currency: 'usd',
        amount_capturable: 1500,
        amount_received: 0,
        livemode: false,
      }),
    },
  };

  const res4 = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(db4, {
    sagaId,
    expectedMode: 'test',
    stripeOverride: mockRequiresCaptureOverride,
  });

  assert(res4.success === false, 'Ambiguous dispatch fails closed');
  assert(
    res4.classification === 'DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED',
    'Classification is DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED (NEVER safe replay)'
  );
  assert(res4.paymentOp?.status === 'capture_pending', 'Payment status remains capture_pending');


  // --------------------------------------------------
  // 5. STRIPE RETRIEVAL FAILURE / TIMEOUT
  // --------------------------------------------------
  console.log('\n--- 5. Authoritative Stripe Retrieval Failure / Timeout ---');

  const mockFailingStripeOverride: any = {
    paymentIntents: {
      retrieve: async () => {
        throw new Error('Stripe API 500 Connection Timeout');
      },
    },
  };

  const db5 = createMockSupabase({
    sagas: { [sagaId]: { ...baseSaga } },
    paymentOps: { [paymentOpId]: { ...basePaymentOpClaimed } },
  });

  const res5 = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(db5, {
    sagaId,
    expectedMode: 'test',
    stripeOverride: mockFailingStripeOverride,
  });

  assert(res5.success === false, 'Fails closed on Stripe API failure');
  assert(res5.classification === 'STRIPE_RETRIEVAL_FAILED', 'Classification STRIPE_RETRIEVAL_FAILED');
  assert(res5.paymentOp?.status === 'capture_pending', 'Payment state unmodified');


  // --------------------------------------------------
  // 6. IDEMPOTENCY & ALREADY COMPLETED RECOVERY
  // --------------------------------------------------
  console.log('\n--- 6. Idempotency & Already Completed Recovery ---');

  const db6 = createMockSupabase({
    sagas: { [sagaId]: { ...baseSaga, state: 'completed' } },
    paymentOps: { [paymentOpId]: { ...basePaymentOpClaimed, status: 'captured' } },
    providerOps: { [providerOpId]: { ...baseProvOp } },
    phoneNumbers: { [e164]: { ...basePhoneRow } },
  });

  const res6 = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(db6, {
    sagaId,
    expectedMode: 'test',
    stripeOverride: mockStripeOverride,
  });

  assert(res6.success === true, 'Already completed saga returns success idempotently');
  assert(res6.saga?.state === 'completed', 'Saga remains completed');


  // --------------------------------------------------
  // 7. CUSTOMER DTO SECRET SUPPRESSION
  // --------------------------------------------------
  console.log('\n--- 7. Customer DTO Secret Suppression ---');

  const dtoStr = JSON.stringify(res1.customerDTO);
  assert(!dtoStr.includes(piId), 'Customer DTO contains no Stripe PaymentIntent ID');
  assert(!dtoStr.includes(twilioSid), 'Customer DTO contains no Twilio SID');
  assert(!dtoStr.includes('cap_pi_'), 'Customer DTO contains no idempotency key');
  assert(!dtoStr.includes('CAPTURE_CONFIRMED'), 'Customer DTO contains no internal classification enum');

  console.log(`\n====================================================`);
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log(`====================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
