import Stripe from 'stripe';
import {
  CommercialCaptureService,
} from '../src/lib/billing/commercialCaptureService';
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

async function runTests() {
  console.log('====================================================');
  console.log('PHASE 13.3.3.2A — PURE PREDICATES & CLASSIFIER SUITE');
  console.log('====================================================\n');

  const orgId = '11111111-1111-4111-a111-111111111111';
  const sagaId = '22222222-2222-4222-a222-222222222222';
  const paymentOpId = '33333333-3333-4333-a333-333333333333';
  const providerOpId = 'prov_op_4444444444444444';
  const piId = 'pi_test_5555555555555555';
  const twilioSid = 'PN66666666666666666666666666666666';
  const e164 = '+12025550199';
  const fingerprint = 'sha256:abc123def456';

  // Base Valid Pre-Capture Entities
  const baseSaga = {
    id: sagaId,
    organization_id: orgId,
    state: 'ownership_confirmed' as CommercialSagaState,
    phone_number_e164: e164,
    retail_amount_minor: 1500,
    currency: 'USD',
    payment_operation_id: paymentOpId,
    provider_number_operation_id: providerOpId,
  };

  const basePaymentOp = {
    id: paymentOpId,
    organization_id: orgId,
    commercial_saga_id: sagaId,
    provider: 'stripe',
    status: 'authorized',
    amount_minor: 1500,
    currency: 'USD',
    provider_payment_id: piId,
    capture_method: 'manual',
    capture_dispatch_claimed_at: null,
    capture_idempotency_key: null,
    authorization_expires_at: null,
    request_fingerprint: fingerprint,
    metadata: {},
  };

  const basePaymentIntent: Partial<Stripe.PaymentIntent> = {
    id: piId,
    status: 'requires_capture',
    capture_method: 'manual',
    amount: 1500,
    currency: 'usd',
    amount_capturable: 1500,
    amount_received: 0,
    livemode: false, // test mode
    metadata: {
      organization_id: orgId,
      operation_id: paymentOpId,
    },
  };

  // --------------------------------------------------
  // 1. PRE-CAPTURE PREDICATE TESTS
  // --------------------------------------------------
  console.log('--- 1. Pre-Capture Dispatch Predicate ---');

  const validPreCap = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: baseSaga,
    paymentOp: basePaymentOp,
    paymentIntent: basePaymentIntent as Stripe.PaymentIntent,
    expectedMode: 'test',
    expectedFingerprint: fingerprint,
  });
  assert(validPreCap.eligible === true, 'Pre-capture valid baseline');

  // FAIL CLOSED CASES
  const failWrongProvider = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: baseSaga,
    paymentOp: { ...basePaymentOp, provider: 'paypal' },
    paymentIntent: basePaymentIntent as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failWrongProvider.eligible === false, 'Fail closed: Wrong payment provider');

  const failWrongPI = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: baseSaga,
    paymentOp: { ...basePaymentOp, provider_payment_id: 'pi_wrong_999' },
    paymentIntent: basePaymentIntent as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failWrongPI.eligible === false, 'Fail closed: Provider payment ID mismatch');

  const failTenantMismatch = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: { ...baseSaga, organization_id: '99999999-9999-4999-a999-999999999999' },
    paymentOp: basePaymentOp,
    paymentIntent: basePaymentIntent as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failTenantMismatch.eligible === false, 'Fail closed: Tenant organization mismatch');

  const failSagaLinkageMismatch = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: baseSaga,
    paymentOp: { ...basePaymentOp, commercial_saga_id: 'other_saga_id' },
    paymentIntent: basePaymentIntent as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failSagaLinkageMismatch.eligible === false, 'Fail closed: Saga linkage mismatch');

  const failAmountMismatch = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: { ...baseSaga, retail_amount_minor: 2000 },
    paymentOp: basePaymentOp,
    paymentIntent: basePaymentIntent as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failAmountMismatch.eligible === false, 'Fail closed: Amount mismatch');

  const failCurrencyMismatch = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: { ...baseSaga, currency: 'EUR' },
    paymentOp: basePaymentOp,
    paymentIntent: basePaymentIntent as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failCurrencyMismatch.eligible === false, 'Fail closed: Currency mismatch');

  const failWrongOpStatus = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: baseSaga,
    paymentOp: { ...basePaymentOp, status: 'pending' },
    paymentIntent: basePaymentIntent as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failWrongOpStatus.eligible === false, 'Fail closed: Payment operation status not authorized');

  const failWrongSagaState = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: { ...baseSaga, state: 'authorized' },
    paymentOp: basePaymentOp,
    paymentIntent: basePaymentIntent as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failWrongSagaState.eligible === false, 'Fail closed: Saga state not ownership_confirmed');

  const failAlreadyClaimedAt = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: baseSaga,
    paymentOp: { ...basePaymentOp, capture_dispatch_claimed_at: '2026-09-28T10:00:00Z' },
    paymentIntent: basePaymentIntent as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failAlreadyClaimedAt.eligible === false, 'Fail closed: capture_dispatch_claimed_at already set');

  const failAlreadyIdempotencyKey = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: baseSaga,
    paymentOp: { ...basePaymentOp, capture_idempotency_key: 'cap_pi_123' },
    paymentIntent: basePaymentIntent as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failAlreadyIdempotencyKey.eligible === false, 'Fail closed: capture_idempotency_key already set');

  const failAutomaticCapture = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: baseSaga,
    paymentOp: basePaymentOp,
    paymentIntent: { ...basePaymentIntent, capture_method: 'automatic' } as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failAutomaticCapture.eligible === false, 'Fail closed: Automatic capture method');

  const failWrongPIStatus = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: baseSaga,
    paymentOp: basePaymentOp,
    paymentIntent: { ...basePaymentIntent, status: 'succeeded' } as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failWrongPIStatus.eligible === false, 'Fail closed: PaymentIntent status is succeeded (expected requires_capture)');

  const failInsufficientCapturable = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: baseSaga,
    paymentOp: basePaymentOp,
    paymentIntent: { ...basePaymentIntent, amount_capturable: 1000 } as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failInsufficientCapturable.eligible === false, 'Fail closed: Insufficient amount_capturable');

  const failModeMismatch = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: baseSaga,
    paymentOp: basePaymentOp,
    paymentIntent: { ...basePaymentIntent, livemode: true } as Stripe.PaymentIntent,
    expectedMode: 'test', // expected test, PI is livemode true
  });
  assert(failModeMismatch.eligible === false, 'Fail closed: Mode mismatch (expected test, got live)');

  const failExpiredAuth = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: baseSaga,
    paymentOp: { ...basePaymentOp, authorization_expires_at: '2020-01-01T00:00:00Z' },
    paymentIntent: basePaymentIntent as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failExpiredAuth.eligible === false, 'Fail closed: Expired payment authorization');

  const failFingerprintMismatch = CommercialCaptureService.isEligibleForCaptureDispatch({
    saga: baseSaga,
    paymentOp: basePaymentOp,
    paymentIntent: basePaymentIntent as Stripe.PaymentIntent,
    expectedMode: 'test',
    expectedFingerprint: 'sha256:different_fingerprint',
  });
  assert(failFingerprintMismatch.eligible === false, 'Fail closed: Request fingerprint mismatch');


  // --------------------------------------------------
  // 2. AUTHORITATIVE CAPTURE-SUCCESS PREDICATE TESTS
  // --------------------------------------------------
  console.log('\n--- 2. Authoritative Capture-Success Predicate ---');

  const capturedPI: Partial<Stripe.PaymentIntent> = {
    id: piId,
    status: 'succeeded',
    capture_method: 'manual',
    amount: 1500,
    currency: 'usd',
    amount_capturable: 0,
    amount_received: 1500,
    livemode: false,
  };

  const validCaptureProof = CommercialCaptureService.isAuthoritativeCaptureSuccess({
    paymentOp: basePaymentOp,
    paymentIntent: capturedPI as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(validCaptureProof.eligible === true, 'Capture success valid baseline');

  // FAILURES
  const failCapWrongPI = CommercialCaptureService.isAuthoritativeCaptureSuccess({
    paymentOp: { ...basePaymentOp, provider_payment_id: 'pi_other' },
    paymentIntent: capturedPI as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failCapWrongPI.eligible === false, 'Capture failure: Wrong PaymentIntent ID');

  const failCapWrongStatus = CommercialCaptureService.isAuthoritativeCaptureSuccess({
    paymentOp: basePaymentOp,
    paymentIntent: { ...capturedPI, status: 'requires_capture' } as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failCapWrongStatus.eligible === false, 'Capture failure: Status requires_capture');

  const failCapWrongReceived = CommercialCaptureService.isAuthoritativeCaptureSuccess({
    paymentOp: basePaymentOp,
    paymentIntent: { ...capturedPI, amount_received: 1000 } as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failCapWrongReceived.eligible === false, 'Capture failure: Partial amount_received');

  const failCapUncapturedFunds = CommercialCaptureService.isAuthoritativeCaptureSuccess({
    paymentOp: basePaymentOp,
    paymentIntent: { ...capturedPI, amount_capturable: 500 } as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(failCapUncapturedFunds.eligible === false, 'Capture failure: Uncaptured funds remain');


  // --------------------------------------------------
  // 3. AMBIGUOUS DISPATCH & RECONCILIATION CLASSIFIER TESTS
  // --------------------------------------------------
  console.log('\n--- 3. Shared Reconciliation Classifier ---');

  const classConfirmed = CommercialCaptureService.classifyCaptureReconciliation({
    paymentOp: basePaymentOp,
    paymentIntent: capturedPI as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(classConfirmed === 'CAPTURE_CONFIRMED', 'Classification: CAPTURE_CONFIRMED');

  const classUnclaimed = CommercialCaptureService.classifyCaptureReconciliation({
    paymentOp: basePaymentOp, // claimed_at === null
    paymentIntent: basePaymentIntent as Stripe.PaymentIntent, // requires_capture
    expectedMode: 'test',
  });
  assert(classUnclaimed === 'STILL_REQUIRES_CAPTURE_UNCLAIMED', 'Classification: STILL_REQUIRES_CAPTURE_UNCLAIMED');

  // CRITICAL CONSERVATIVE OVERRIDE TEST
  const classAmbiguousClaimed = CommercialCaptureService.classifyCaptureReconciliation({
    paymentOp: {
      ...basePaymentOp,
      capture_dispatch_claimed_at: '2026-09-28T10:00:00Z',
      capture_idempotency_key: `cap_pi_${paymentOpId}`,
    },
    paymentIntent: basePaymentIntent as Stripe.PaymentIntent, // requires_capture
    expectedMode: 'test',
  });
  assert(
    classAmbiguousClaimed === 'DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED',
    'Classification: Ambiguous dispatch (claimed + requires_capture) -> DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED (NEVER safe replay)'
  );

  const classFailed = CommercialCaptureService.classifyCaptureReconciliation({
    paymentOp: basePaymentOp,
    paymentIntent: { ...basePaymentIntent, status: 'canceled' } as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(classFailed === 'PAYMENT_FAILED', 'Classification: PAYMENT_FAILED (status canceled)');

  const classModeMismatch = CommercialCaptureService.classifyCaptureReconciliation({
    paymentOp: basePaymentOp,
    paymentIntent: { ...basePaymentIntent, livemode: true } as Stripe.PaymentIntent,
    expectedMode: 'test',
  });
  assert(classModeMismatch === 'MODE_MISMATCH', 'Classification: MODE_MISMATCH');


  // --------------------------------------------------
  // 4. TELECOM OWNERSHIP PREDICATE TESTS
  // --------------------------------------------------
  console.log('\n--- 4. Telecom Ownership Predicate ---');

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

  const validTelecom = CommercialCaptureService.isEligibleForTelecomOwnership({
    saga: baseSaga,
    providerNumberOp: baseProvOp,
    phoneRow: basePhoneRow,
  });
  assert(validTelecom.eligible === true, 'Telecom ownership valid baseline');

  // Verify Phase 12 / 13.3.2 status aliases (reconciled_success, completed, purchased)
  const validReconciledStatus = CommercialCaptureService.isEligibleForTelecomOwnership({
    saga: baseSaga,
    providerNumberOp: { ...baseProvOp, status: 'reconciled_success' },
    phoneRow: { ...basePhoneRow, status: 'purchased' },
  });
  assert(validReconciledStatus.eligible === true, 'Telecom ownership valid with Phase 12 status aliases (reconciled_success, purchased)');

  const failTelecomOrg = CommercialCaptureService.isEligibleForTelecomOwnership({
    saga: baseSaga,
    providerNumberOp: { ...baseProvOp, organization_id: 'other_org' },
    phoneRow: basePhoneRow,
  });
  assert(failTelecomOrg.eligible === false, 'Telecom fail: Organization mismatch');

  const failTelecomStatus = CommercialCaptureService.isEligibleForTelecomOwnership({
    saga: baseSaga,
    providerNumberOp: { ...baseProvOp, status: 'pending' },
    phoneRow: basePhoneRow,
  });
  assert(failTelecomStatus.eligible === false, 'Telecom fail: Provider number operation not succeeded');

  const failTelecomSidMismatch = CommercialCaptureService.isEligibleForTelecomOwnership({
    saga: baseSaga,
    providerNumberOp: baseProvOp,
    phoneRow: { ...basePhoneRow, provider_resource_id: 'PN_different_sid' },
  });
  assert(failTelecomSidMismatch.eligible === false, 'Telecom fail: Provider resource ID mismatch');


  // --------------------------------------------------
  // 5. FINAL COMMERCIAL COMPLETION PREDICATE TESTS
  // --------------------------------------------------
  console.log('\n--- 5. Final Commercial Saga Completion Predicate ---');

  const capturePendingSaga = { ...baseSaga, state: 'capture_pending' as CommercialSagaState };
  const capturedPaymentOp = { ...basePaymentOp, status: 'captured' };

  const validCompletion = CommercialCaptureService.isEligibleForSagaCompletion({
    saga: capturePendingSaga,
    paymentOp: capturedPaymentOp,
    paymentIntent: capturedPI as Stripe.PaymentIntent,
    providerNumberOp: baseProvOp,
    phoneRow: basePhoneRow,
    expectedMode: 'test',
  });
  assert(validCompletion.eligible === true, 'Saga completion valid baseline');

  const failCompSagaState = CommercialCaptureService.isEligibleForSagaCompletion({
    saga: baseSaga, // ownership_confirmed
    paymentOp: capturedPaymentOp,
    paymentIntent: capturedPI as Stripe.PaymentIntent,
    providerNumberOp: baseProvOp,
    phoneRow: basePhoneRow,
    expectedMode: 'test',
  });
  assert(failCompSagaState.eligible === false, 'Saga completion fail: Saga state is not capture_pending');

  const failCompPaymentNotCaptured = CommercialCaptureService.isEligibleForSagaCompletion({
    saga: capturePendingSaga,
    paymentOp: basePaymentOp, // status: authorized
    paymentIntent: capturedPI as Stripe.PaymentIntent,
    providerNumberOp: baseProvOp,
    phoneRow: basePhoneRow,
    expectedMode: 'test',
  });
  assert(failCompPaymentNotCaptured.eligible === false, 'Saga completion fail: Payment operation status is not captured');


  // --------------------------------------------------
  // 6. CUSTOMER DTO MAPPING TESTS
  // --------------------------------------------------
  console.log('\n--- 6. Customer DTO Mapping ---');

  const dtoPending = CommercialCaptureService.getCustomerSafeSagaDTO('ownership_confirmed');
  assert(dtoPending.state === 'ownership_confirmed', 'Customer DTO state mapped');
  assert(dtoPending.customerTitle === 'Finalizing Purchase', 'Customer DTO safe title');
  assert(!JSON.stringify(dtoPending).includes('pi_'), 'Customer DTO contains no Stripe PI ID');
  assert(!JSON.stringify(dtoPending).includes('PN'), 'Customer DTO contains no Twilio SID');

  const dtoCompleted = CommercialCaptureService.getCustomerSafeSagaDTO('completed');
  assert(dtoCompleted.isTerminal === true && dtoCompleted.isSuccess === true, 'Customer DTO completed terminal success');

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
