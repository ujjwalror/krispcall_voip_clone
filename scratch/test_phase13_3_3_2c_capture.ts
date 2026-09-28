import Stripe from 'stripe';
import {
  CommercialCaptureReconciliationService,
} from '../src/lib/billing/commercialCaptureReconciliationService';
import { StripeCaptureAdapter } from '../src/lib/billing/providers/stripe/stripeCaptureAdapter';
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
  claimSagaRpcHandler?: (args: any) => any;
  claimPaymentRpcHandler?: (args: any) => any;
  confirmCapturedRpcHandler?: (args: any) => any;
  completeSagaRpcHandler?: (args: any) => any;
}) {
  const state = {
    sagas: JSON.parse(JSON.stringify(initialState.sagas || {})),
    paymentOps: JSON.parse(JSON.stringify(initialState.paymentOps || {})),
    providerOps: JSON.parse(JSON.stringify(initialState.providerOps || {})),
    phoneNumbers: JSON.parse(JSON.stringify(initialState.phoneNumbers || {})),
  };

  function getTableKey(table: string): keyof typeof state {
    if (table === 'commercial_number_purchase_sagas') return 'sagas';
    if (table === 'billing_payment_operations') return 'paymentOps';
    if (table === 'provider_number_operations') return 'providerOps';
    if (table === 'phone_numbers') return 'phoneNumbers';
    throw new Error(`Unknown table ${table}`);
  }

  function toCamelCase(str: string): string {
    return str.replace(/_([a-z])/g, (_, g) => g.toUpperCase());
  }

  const db: any = {
    _state: state,
    from: (table: string) => {
      const key = getTableKey(table);
      return {
        select: () => ({
          eq: (field1: string, val1: any) => ({
            eq: (field2: string, val2: any) => ({
              maybeSingle: async () => {
                const items = Object.values(state[key] || {});
                const match = items.find((item: any) =>
                  (item[field1] === val1 || item[toCamelCase(field1)] === val1) &&
                  (item[field2] === val2 || item[toCamelCase(field2)] === val2)
                );
                return { data: match ? JSON.parse(JSON.stringify(match)) : null, error: null };
              },
            }),
            maybeSingle: async () => {
              const items = Object.values(state[key] || {});
              const match = items.find((item: any) => item[field1] === val1 || item[toCamelCase(field1)] === val1);
              return { data: match ? JSON.parse(JSON.stringify(match)) : null, error: null };
            },
          }),
        }),
        update: (payload: any) => ({
          eq: (field: string, val: any) => ({
            select: () => ({
              maybeSingle: async () => {
                const items: any[] = Object.values(state[key] || {});
                const target = items.find((item: any) => item[field] === val);
                if (target) {
                  Object.assign(target, payload);
                  return { data: JSON.parse(JSON.stringify(target)), error: null };
                }
                return { data: null, error: null };
              },
            }),
          }),
        }),
      };
    },
    rpc: async (fnName: string, args: any) => {
      if (fnName === 'claim_commercial_saga_for_capture') {
        if (initialState.claimSagaRpcHandler) {
          return initialState.claimSagaRpcHandler(args);
        }
        const saga = state.sagas[args.p_saga_id];
        if (saga && saga.organization_id === args.p_organization_id && saga.state === 'ownership_confirmed') {
          saga.state = 'capture_pending';
          return { data: JSON.parse(JSON.stringify(saga)), error: null };
        }
        return { data: null, error: { message: 'SAGA_CLAIM_FAILED' } };
      }

      if (fnName === 'claim_payment_capture_dispatch') {
        if (initialState.claimPaymentRpcHandler) {
          return initialState.claimPaymentRpcHandler(args);
        }
        const op = state.paymentOps[args.p_payment_op_id];
        if (op && op.organization_id === args.p_organization_id && op.status === 'authorized' && !op.capture_dispatch_claimed_at) {
          op.status = 'capture_pending';
          op.capture_dispatch_claimed_at = new Date().toISOString();
          op.capture_idempotency_key = `cap_pi_${op.id}`;
          return { data: JSON.parse(JSON.stringify(op)), error: null };
        }
        return { data: null, error: { message: 'PAYMENT_DISPATCH_CLAIM_FAILED' } };
      }

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
          return { data: JSON.parse(JSON.stringify(op)), error: null };
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
          return { data: JSON.parse(JSON.stringify(saga)), error: null };
        }
        return { data: null, error: { message: 'SAGA_NOT_FOUND' } };
      }

      throw new Error(`Unhandled RPC ${fnName}`);
    },
  };

  return db;
}

/**
 * Mock Stripe Client Double
 */
function createMockStripe(intents: Record<string, Stripe.PaymentIntent>, retrieveHandler?: (id: string) => Promise<Stripe.PaymentIntent>) {
  const store = { ...intents };
  return {
    paymentIntents: {
      retrieve: async (id: string) => {
        if (retrieveHandler) return retrieveHandler(id);
        if (store[id]) return JSON.parse(JSON.stringify(store[id]));
        throw new Error(`No such payment_intent: ${id}`);
      },
    },
    _store: store,
  } as unknown as Stripe;
}

// Fixture Constants
const ORG_ID = 'org_test_123';
const SAGA_ID = 'saga_test_789';
const OP_ID = 'op_test_456';
const PNO_ID = 'pno_test_111';
const PHONE_E164 = '+15551234567';
const PI_ID = 'pi_test_99999';
const TWILIO_SID = 'PN1234567890abcdef1234567890abcdef';

function getStandardFixtures(overrides?: { sagaState?: string; opStatus?: string; piStatus?: string; dispatchClaimed?: boolean }) {
  const sagaState = overrides?.sagaState || 'ownership_confirmed';
  const opStatus = overrides?.opStatus || 'authorized';
  const piStatus = overrides?.piStatus || 'requires_capture';
  const dispatchClaimed = overrides?.dispatchClaimed || false;

  const sagas = {
    [SAGA_ID]: {
      id: SAGA_ID,
      organization_id: ORG_ID,
      state: sagaState,
      phone_number_e164: PHONE_E164,
      retail_amount_minor: 1500,
      currency: 'usd',
      payment_operation_id: OP_ID,
      provider_number_operation_id: PNO_ID,
    },
  };

  const paymentOps = {
    [OP_ID]: {
      id: OP_ID,
      organization_id: ORG_ID,
      commercial_saga_id: SAGA_ID,
      provider: 'stripe',
      status: opStatus,
      amount_minor: 1500,
      currency: 'usd',
      provider_payment_id: PI_ID,
      capture_method: 'manual',
      capture_dispatch_claimed_at: dispatchClaimed ? '2026-09-28T12:00:00Z' : null,
      capture_idempotency_key: dispatchClaimed ? `cap_pi_${OP_ID}` : null,
    },
  };

  const providerOps = {
    [PNO_ID]: {
      id: PNO_ID,
      organization_id: ORG_ID,
      phone_number_e164: PHONE_E164,
      status: 'succeeded',
      provider_resource_id: TWILIO_SID,
    },
  };

  const phoneNumbers = {
    [PHONE_E164]: {
      id: 'phone_1',
      organization_id: ORG_ID,
      phone_number: PHONE_E164,
      status: 'active',
      provider_resource_id: TWILIO_SID,
    },
  };

  const paymentIntent: Stripe.PaymentIntent = {
    id: PI_ID,
    object: 'payment_intent',
    amount: 1500,
    amount_capturable: piStatus === 'succeeded' ? 0 : 1500,
    amount_received: piStatus === 'succeeded' ? 1500 : 0,
    capture_method: 'manual',
    currency: 'usd',
    livemode: false,
    status: piStatus as Stripe.PaymentIntent.Status,
    created: Date.now(),
    client_secret: 'secret_xxx',
  } as any;

  return { sagas, paymentOps, providerOps, phoneNumbers, paymentIntent };
}

async function runTests() {
  console.log('=== PHASE 13.3.3.2C.1 ORCHESTRATION & DISPATCH TEST SUITE ===\n');

  // -------------------------------------------------------------
  // TEST GROUP 1: FEATURE GATES & DISPATCH ADAPTER SAFETY
  // -------------------------------------------------------------
  console.log('1. Dual-Gate Enforcement Tests');

  // Test 1.1: Gates default false -> adapter returns GATE_DISABLED
  delete process.env.PHASE13_PAYMENT_ENABLED;
  delete process.env.PHASE13_STRIPE_CAPTURE_ENABLED;
  assert(
    StripeCaptureAdapter.isCaptureExecutionAllowed() === false,
    'StripeCaptureAdapter.isCaptureExecutionAllowed() is false when env unset'
  );

  const res1 = await StripeCaptureAdapter.capturePaymentIntent({
    providerPaymentId: PI_ID,
    amountMinor: 1500,
    idempotencyKey: 'cap_pi_test',
    expectedMode: 'test',
  });
  assert(res1.success === false, 'Adapter capture succeeds=false when gates disabled');
  assert(res1.error?.code === 'GATE_DISABLED', 'Adapter returns GATE_DISABLED code when gates disabled');

  // Test 1.2: Payment true, Capture false -> isCaptureExecutionAllowed false
  process.env.PHASE13_PAYMENT_ENABLED = 'true';
  process.env.PHASE13_STRIPE_CAPTURE_ENABLED = 'false';
  assert(
    StripeCaptureAdapter.isCaptureExecutionAllowed() === false,
    'isCaptureExecutionAllowed() is false when payment=true, capture=false'
  );

  // Test 1.3: Payment false, Capture true -> isCaptureExecutionAllowed false
  process.env.PHASE13_PAYMENT_ENABLED = 'false';
  process.env.PHASE13_STRIPE_CAPTURE_ENABLED = 'true';
  assert(
    StripeCaptureAdapter.isCaptureExecutionAllowed() === false,
    'isCaptureExecutionAllowed() is false when payment=false, capture=true'
  );

  // Reset gates to false
  process.env.PHASE13_PAYMENT_ENABLED = 'false';
  process.env.PHASE13_STRIPE_CAPTURE_ENABLED = 'false';

  // -------------------------------------------------------------
  // TEST GROUP 2: CRASH RECOVERY SCENARIOS (A THROUGH F)
  // -------------------------------------------------------------
  console.log('\n2. Crash Recovery Scenarios (A through F)');

  // SCENARIO A: Crash before saga claim (saga is ownership_confirmed, RPC not called yet)
  {
    const fix = getStandardFixtures();
    const mockDb = createMockSupabase(fix);
    const mockStripe = createMockStripe({ [PI_ID]: fix.paymentIntent });

    let captureCalls = 0;
    const fakeDispatcher = async (p: any) => {
      captureCalls++;
      fix.paymentIntent.status = 'succeeded';
      fix.paymentIntent.amount_capturable = 0;
      fix.paymentIntent.amount_received = 1500;
      mockStripe._store[PI_ID] = fix.paymentIntent;
      return { success: true, status: 'succeeded' };
    };

    const result = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(mockDb, {
      sagaId: SAGA_ID,
      organizationId: ORG_ID,
      expectedMode: 'test',
      captureDispatcher: fakeDispatcher,
      stripeOverride: mockStripe,
    });

    assert(captureCalls === 1, 'Scenario A: Winning execution calls capture dispatcher exactly once');
    assert(result.success === true, 'Scenario A: Successful capture & completion');
    assert(mockDb._state.sagas[SAGA_ID].state === 'completed', 'Scenario A: Saga updated to completed');
    assert(mockDb._state.paymentOps[OP_ID].status === 'captured', 'Scenario A: Payment status updated to captured');
  }

  // SCENARIO B: Crash after saga claim before payment dispatch claim (Pre-Dispatch Crash Recovery)
  {
    const fix = getStandardFixtures({ sagaState: 'capture_pending', opStatus: 'authorized', dispatchClaimed: false });
    const mockDb = createMockSupabase(fix);
    const mockStripe = createMockStripe({ [PI_ID]: fix.paymentIntent });

    let captureCalls = 0;
    const fakeDispatcher = async (p: any) => {
      captureCalls++;
      fix.paymentIntent.status = 'succeeded';
      fix.paymentIntent.amount_capturable = 0;
      fix.paymentIntent.amount_received = 1500;
      mockStripe._store[PI_ID] = fix.paymentIntent;
      return { success: true, status: 'succeeded' };
    };

    const result = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(mockDb, {
      sagaId: SAGA_ID,
      organizationId: ORG_ID,
      expectedMode: 'test',
      captureDispatcher: fakeDispatcher,
      stripeOverride: mockStripe,
    });

    assert(captureCalls === 1, 'Scenario B: Pre-dispatch crash recovery continues to claim payment dispatch and calls dispatcher exactly once');
    assert(result.success === true, 'Scenario B: Pre-dispatch crash recovery completes successfully');
  }

  // SCENARIO C: Crash after payment dispatch claim before capture invocation
  {
    const fix = getStandardFixtures({ sagaState: 'capture_pending', opStatus: 'capture_pending', piStatus: 'requires_capture', dispatchClaimed: true });
    const mockDb = createMockSupabase(fix);
    const mockStripe = createMockStripe({ [PI_ID]: fix.paymentIntent });

    let captureCalls = 0;
    const fakeDispatcher = async (p: any) => {
      captureCalls++;
      return { success: true, status: 'succeeded' };
    };

    const result = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(mockDb, {
      sagaId: SAGA_ID,
      organizationId: ORG_ID,
      expectedMode: 'test',
      captureDispatcher: fakeDispatcher,
      stripeOverride: mockStripe,
    });

    assert(captureCalls === 0, 'Scenario C: Subsequent recovery DOES NOT blindly capture');
    assert(result.classification === 'DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED', 'Scenario C: Returns DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED');
  }

  // SCENARIO D: Capture invocation succeeded, crash before local DB confirmation
  {
    const fix = getStandardFixtures({ sagaState: 'capture_pending', opStatus: 'capture_pending', piStatus: 'succeeded', dispatchClaimed: true });
    const mockDb = createMockSupabase(fix);
    const mockStripe = createMockStripe({ [PI_ID]: fix.paymentIntent });

    let captureCalls = 0;
    const fakeDispatcher = async (p: any) => {
      captureCalls++;
      return { success: true, status: 'succeeded' };
    };

    const result = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(mockDb, {
      sagaId: SAGA_ID,
      organizationId: ORG_ID,
      expectedMode: 'test',
      captureDispatcher: fakeDispatcher,
      stripeOverride: mockStripe,
    });

    assert(captureCalls === 0, 'Scenario D: Authoritative reconciliation confirms without second capture POST');
    assert(result.success === true, 'Scenario D: Reconciliation confirmed capture and completed saga');
    assert(mockDb._state.paymentOps[OP_ID].status === 'captured', 'Scenario D: Payment confirmed captured');
    assert(mockDb._state.sagas[SAGA_ID].state === 'completed', 'Scenario D: Saga completed');
  }

  // SCENARIO E: Capture invocation ambiguous
  {
    const fix = getStandardFixtures();
    const mockDb = createMockSupabase(fix);
    let retrieveCount = 0;

    const mockStripe = createMockStripe({ [PI_ID]: fix.paymentIntent }, async (id) => {
      retrieveCount++;
      if (retrieveCount === 1) {
        return fix.paymentIntent;
      }
      throw new Error('Stripe API 504 Gateway Timeout');
    });

    let captureCalls = 0;
    const fakeDispatcher = async (p: any) => {
      captureCalls++;
      return { success: false, error: { code: 'timeout', message: 'timeout' } };
    };

    const result = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(mockDb, {
      sagaId: SAGA_ID,
      organizationId: ORG_ID,
      expectedMode: 'test',
      captureDispatcher: fakeDispatcher,
      stripeOverride: mockStripe,
    });

    assert(captureCalls === 1, 'Scenario E: Dispatcher attempted capture once');
    assert(result.success === false, 'Scenario E: Success=false on ambiguous outcome');
    assert(result.classification === 'DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED', 'Scenario E: Returns reconciliation required classification');
    assert(mockDb._state.phoneNumbers[PHONE_E164].status === 'active', 'Scenario E: Telecom line preserved (never released)');
  }

  // SCENARIO F: Payment confirmed captured, crash before saga completion
  {
    const fix = getStandardFixtures({ sagaState: 'capture_pending', opStatus: 'captured', piStatus: 'succeeded', dispatchClaimed: true });
    const mockDb = createMockSupabase(fix);
    const mockStripe = createMockStripe({ [PI_ID]: fix.paymentIntent });

    let captureCalls = 0;
    const fakeDispatcher = async (p: any) => {
      captureCalls++;
      return { success: true, status: 'succeeded' };
    };

    const result = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(mockDb, {
      sagaId: SAGA_ID,
      organizationId: ORG_ID,
      expectedMode: 'test',
      captureDispatcher: fakeDispatcher,
      stripeOverride: mockStripe,
    });

    assert(captureCalls === 0, 'Scenario F: Zero capture POSTs on resume');
    assert(result.success === true, 'Scenario F: Reconciliation resumes saga completion');
    assert(mockDb._state.sagas[SAGA_ID].state === 'completed', 'Scenario F: Saga state transitioned to completed');
  }

  // -------------------------------------------------------------
  // TEST GROUP 3: CONCURRENCY & CLAIM-LOSER HANDLING
  // -------------------------------------------------------------
  console.log('\n3. Concurrency & Claim-Loser Handling');

  {
    const fix = getStandardFixtures();

    let mockDbWinner: any;
    mockDbWinner = createMockSupabase({
      ...fix,
      claimSagaRpcHandler: (args) => {
        const saga = mockDbWinner._state.sagas[args.p_saga_id];
        if (saga) saga.state = 'capture_pending';
        return { data: JSON.parse(JSON.stringify(saga)), error: null };
      },
    });
    const mockStripe = createMockStripe({ [PI_ID]: fix.paymentIntent });

    let captureCalls = 0;
    const fakeDispatcher = async (p: any) => {
      captureCalls++;
      fix.paymentIntent.status = 'succeeded';
      fix.paymentIntent.amount_capturable = 0;
      fix.paymentIntent.amount_received = 1500;
      mockStripe._store[PI_ID] = fix.paymentIntent;
      return { success: true, status: 'succeeded' };
    };

    const winnerRes = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(mockDbWinner, {
      sagaId: SAGA_ID,
      organizationId: ORG_ID,
      expectedMode: 'test',
      captureDispatcher: fakeDispatcher,
      stripeOverride: mockStripe,
    });

    const mockDbLoser = createMockSupabase({
      ...fix,
      claimSagaRpcHandler: (args) => {
        return { data: null, error: { message: 'SAGA_ALREADY_CAPTURE_CLAIMED' } };
      },
    });

    const loserRes = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(mockDbLoser, {
      sagaId: SAGA_ID,
      organizationId: ORG_ID,
      expectedMode: 'test',
      captureDispatcher: fakeDispatcher,
      stripeOverride: mockStripe,
    });

    assert(captureCalls === 1, 'Concurrency: Only claim winner reached capture dispatcher (exactly 1 call)');
    assert(winnerRes.success === true, 'Concurrency: Claim winner execution succeeded');
  }

  // -------------------------------------------------------------
  // TEST GROUP 4: SECRET SUPPRESSION & CUSTOMER DTO VALIDATION
  // -------------------------------------------------------------
  console.log('\n4. Secret Suppression & Customer DTO Validation');

  {
    const fix = getStandardFixtures();
    const mockDb = createMockSupabase(fix);
    const mockStripe = createMockStripe({ [PI_ID]: fix.paymentIntent });

    const result = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(mockDb, {
      sagaId: SAGA_ID,
      organizationId: ORG_ID,
      expectedMode: 'test',
      captureDispatcher: async () => {
        fix.paymentIntent.status = 'succeeded';
        fix.paymentIntent.amount_capturable = 0;
        fix.paymentIntent.amount_received = 1500;
        mockStripe._store[PI_ID] = fix.paymentIntent;
        return { success: true, status: 'succeeded' };
      },
      stripeOverride: mockStripe,
    });

    const dto = result.customerDTO;
    const dtoStr = JSON.stringify(dto);

    assert(dtoStr.includes(PI_ID) === false, 'DTO does not contain Stripe PaymentIntent ID');
    assert(dtoStr.includes(TWILIO_SID) === false, 'DTO does not contain Twilio SID');
    assert(dtoStr.includes('cap_pi_') === false, 'DTO does not contain idempotency key');
    assert(dto.isSuccess === true, 'DTO reflects isSuccess=true for completed state');
    assert(dto.customerTitle === 'Number Activated', 'DTO title is customer-safe string');
  }

  // -------------------------------------------------------------
  // TEST GROUP 5: FOUR BOUNDARIES (A, B, C, D) & PRE-DISPATCH RECOVERY CONCURRENCY
  // -------------------------------------------------------------
  console.log('\n5. Four Boundaries & Pre-Dispatch Recovery Concurrency Tests');

  // BOUNDARY A: saga ownership_confirmed, payment authorized, no dispatch claim
  {
    const fix = getStandardFixtures({ sagaState: 'ownership_confirmed', opStatus: 'authorized', dispatchClaimed: false });
    const mockDb = createMockSupabase(fix);
    const mockStripe = createMockStripe({ [PI_ID]: fix.paymentIntent });

    let captureCalls = 0;
    const fakeDispatcher = async () => {
      captureCalls++;
      fix.paymentIntent.status = 'succeeded';
      fix.paymentIntent.amount_capturable = 0;
      fix.paymentIntent.amount_received = 1500;
      mockStripe._store[PI_ID] = fix.paymentIntent;
      return { success: true, status: 'succeeded' };
    };

    const resA = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(mockDb, {
      sagaId: SAGA_ID,
      organizationId: ORG_ID,
      expectedMode: 'test',
      captureDispatcher: fakeDispatcher,
      stripeOverride: mockStripe,
    });

    assert(captureCalls === 1, 'Boundary A: Normal flow executes exactly 1 capture call');
    assert(resA.success === true, 'Boundary A: Success=true');
    assert(mockDb._state.sagas[SAGA_ID].state === 'completed', 'Boundary A: Saga reached completed');
  }

  // BOUNDARY B: saga capture_pending, payment authorized, no dispatch claim (PRE-DISPATCH CRASH RECOVERY)
  {
    const fix = getStandardFixtures({ sagaState: 'capture_pending', opStatus: 'authorized', dispatchClaimed: false });
    let sagaClaimCalls = 0;
    const mockDb = createMockSupabase({
      ...fix,
      claimSagaRpcHandler: () => {
        sagaClaimCalls++;
        return { data: fix.sagas[SAGA_ID], error: null };
      },
    });
    const mockStripe = createMockStripe({ [PI_ID]: fix.paymentIntent });

    let captureCalls = 0;
    const fakeDispatcher = async () => {
      captureCalls++;
      fix.paymentIntent.status = 'succeeded';
      fix.paymentIntent.amount_capturable = 0;
      fix.paymentIntent.amount_received = 1500;
      mockStripe._store[PI_ID] = fix.paymentIntent;
      return { success: true, status: 'succeeded' };
    };

    const resB = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(mockDb, {
      sagaId: SAGA_ID,
      organizationId: ORG_ID,
      expectedMode: 'test',
      captureDispatcher: fakeDispatcher,
      stripeOverride: mockStripe,
    });

    assert(sagaClaimCalls === 0, 'Boundary B: Recovery skips claim_commercial_saga_for_capture (0 saga claim RPC calls)');
    assert(captureCalls === 1, 'Boundary B: Pre-dispatch crash recovery executes exactly 1 capture call');
    assert(resB.success === true, 'Boundary B: Pre-dispatch crash recovery completes successfully');
    assert(mockDb._state.paymentOps[OP_ID].status === 'captured', 'Boundary B: Payment status reaches captured');
  }

  // BOUNDARY C: saga capture_pending, payment capture_pending, dispatch claim exists -> ZERO CAPTURE REPLAY
  {
    const fix = getStandardFixtures({ sagaState: 'capture_pending', opStatus: 'capture_pending', piStatus: 'requires_capture', dispatchClaimed: true });
    const mockDb = createMockSupabase(fix);
    const mockStripe = createMockStripe({ [PI_ID]: fix.paymentIntent });

    let captureCalls = 0;
    const fakeDispatcher = async () => {
      captureCalls++;
      return { success: true, status: 'succeeded' };
    };

    const resC = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(mockDb, {
      sagaId: SAGA_ID,
      organizationId: ORG_ID,
      expectedMode: 'test',
      captureDispatcher: fakeDispatcher,
      stripeOverride: mockStripe,
    });

    assert(captureCalls === 0, 'Boundary C: Existing claim produces ZERO capture replay calls');
    assert(resC.classification === 'DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED', 'Boundary C: Routes to DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED');
  }

  // BOUNDARY D: saga capture_pending, payment authorized, INCONSISTENT partial dispatch fields -> FAIL CLOSED
  {
    const fix = getStandardFixtures({ sagaState: 'capture_pending', opStatus: 'authorized', dispatchClaimed: false });
    // Inject inconsistent partial dispatch fields (claimed_at set, idempotency_key null)
    fix.paymentOps[OP_ID].capture_dispatch_claimed_at = '2026-09-28T12:00:00Z';
    fix.paymentOps[OP_ID].capture_idempotency_key = null;

    const mockDb = createMockSupabase(fix);
    const mockStripe = createMockStripe({ [PI_ID]: fix.paymentIntent });

    let captureCalls = 0;
    const fakeDispatcher = async () => {
      captureCalls++;
      return { success: true, status: 'succeeded' };
    };

    const resD = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(mockDb, {
      sagaId: SAGA_ID,
      organizationId: ORG_ID,
      expectedMode: 'test',
      captureDispatcher: fakeDispatcher,
      stripeOverride: mockStripe,
    });

    assert(captureCalls === 0, 'Boundary D: Inconsistent partial dispatch fields results in ZERO capture calls');
    assert(resD.classification === 'MANUAL_REVIEW_REQUIRED', 'Boundary D: Inconsistent fields fails closed to MANUAL_REVIEW_REQUIRED');
  }

  // TERMINAL COMPLETED SAGA REPLAY: completed saga, captured payment, dispatch claimed, Stripe succeeded -> ZERO capture POSTs & terminal success DTO
  {
    const fix = getStandardFixtures({ sagaState: 'completed', opStatus: 'captured', dispatchClaimed: true });
    fix.paymentIntent.status = 'succeeded';
    fix.paymentIntent.amount_received = 1500;
    fix.paymentIntent.amount_capturable = 0;

    const mockDb = createMockSupabase(fix);
    const mockStripe = createMockStripe({ [PI_ID]: fix.paymentIntent });

    let captureCalls = 0;
    const fakeDispatcher = async () => {
      captureCalls++;
      return { success: true, status: 'succeeded' };
    };

    const resReplay = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(mockDb, {
      sagaId: SAGA_ID,
      organizationId: ORG_ID,
      expectedMode: 'test',
      captureDispatcher: fakeDispatcher,
      stripeOverride: mockStripe,
    });

    assert(captureCalls === 0, 'Terminal Replay: Completed saga produces ZERO capture calls');
    assert(resReplay.success === true, 'Terminal Replay: Completed saga returns success=true');
    assert(resReplay.classification === 'CAPTURE_CONFIRMED', 'Terminal Replay: Classification is CAPTURE_CONFIRMED');
    assert(resReplay.customerDTO.state === 'completed', 'Terminal Replay: customerDTO state is completed');
    assert(resReplay.customerDTO.isSuccess === true, 'Terminal Replay: customerDTO isSuccess is true');
  }

  // PRE-DISPATCH RECOVERY CONCURRENCY: Two concurrent requests in State B (saga capture_pending, payment authorized, no claim)
  {
    const fix = getStandardFixtures({ sagaState: 'capture_pending', opStatus: 'authorized', dispatchClaimed: false });

    let mockDbWinner: any;
    let paymentClaimCount = 0;

    mockDbWinner = createMockSupabase({
      ...fix,
      claimPaymentRpcHandler: (args) => {
        paymentClaimCount++;
        if (paymentClaimCount === 1) {
          const op = mockDbWinner._state.paymentOps[args.p_payment_op_id];
          if (op) {
            op.status = 'capture_pending';
            op.capture_dispatch_claimed_at = new Date().toISOString();
            op.capture_idempotency_key = `cap_pi_${op.id}`;
            return { data: JSON.parse(JSON.stringify(op)), error: null };
          }
        }
        return { data: null, error: { message: 'PAYMENT_DISPATCH_CLAIM_FAILED' } };
      },
    });

    const mockStripe = createMockStripe({ [PI_ID]: fix.paymentIntent });

    let captureCalls = 0;
    const fakeDispatcher = async () => {
      captureCalls++;
      fix.paymentIntent.status = 'succeeded';
      fix.paymentIntent.amount_capturable = 0;
      fix.paymentIntent.amount_received = 1500;
      mockStripe._store[PI_ID] = fix.paymentIntent;
      return { success: true, status: 'succeeded' };
    };

    // Winner execution in State B
    const winnerRes = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(mockDbWinner, {
      sagaId: SAGA_ID,
      organizationId: ORG_ID,
      expectedMode: 'test',
      captureDispatcher: fakeDispatcher,
      stripeOverride: mockStripe,
    });

    // Loser execution in State B
    const mockDbLoser = createMockSupabase({
      ...fix,
      claimPaymentRpcHandler: () => {
        return { data: null, error: { message: 'PAYMENT_DISPATCH_CLAIM_FAILED' } };
      },
    });

    const loserRes = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(mockDbLoser, {
      sagaId: SAGA_ID,
      organizationId: ORG_ID,
      expectedMode: 'test',
      captureDispatcher: fakeDispatcher,
      stripeOverride: mockStripe,
    });

    assert(captureCalls === 1, 'Pre-Dispatch Concurrency: Only payment-dispatch claim winner reached capture dispatcher (exactly 1 call)');
    assert(winnerRes.success === true, 'Pre-Dispatch Concurrency: Claim winner completed successfully');
    assert(loserRes.success === false, 'Pre-Dispatch Concurrency: Claim loser performed zero capture POSTs and returned non-success');
  }

  console.log(`\n==================================================`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`==================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test suite exception:', err);
  process.exit(1);
});

