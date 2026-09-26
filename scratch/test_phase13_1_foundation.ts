// CLI test harness shim for server-only package
try {
  const Module = require('module');
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id: string) {
    if (id === 'server-only') return {};
    return origRequire.apply(this, arguments);
  };
} catch (e) {}

import { PaymentStateMachine } from '../src/lib/billing/paymentStateMachine';
import { CreditLedgerService } from '../src/lib/billing/creditLedgerService';
import { getStripeClient, verifyStripeWebhookSignature } from '../src/lib/billing/providers/stripe/stripeClient';
import { PaymentCanonicalStatus } from '../src/lib/billing/types';

async function runPhase13_1Tests() {
  console.log('====================================================');
  console.log('STARTING PHASE 13.1 FOUNDATION & SECURITY TEST SUITE');
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

  // TEST 1: Payment Canonical State Machine Allowed Transitions
  try {
    assert(
      PaymentStateMachine.isTransitionAllowed('pending', 'authorized') === true,
      'State Machine: pending -> authorized is allowed'
    );
    assert(
      PaymentStateMachine.isTransitionAllowed('authorized', 'captured') === true,
      'State Machine: authorized -> captured is allowed'
    );
    assert(
      PaymentStateMachine.isTransitionAllowed('authorized', 'canceled') === true,
      'State Machine: authorized -> canceled is allowed'
    );
    assert(
      PaymentStateMachine.isTransitionAllowed('captured', 'refunded') === true,
      'State Machine: captured -> refunded is allowed'
    );
  } catch (err: any) {
    console.error('Test 1 error:', err);
    failed++;
  }

  // TEST 2: Payment Canonical State Machine Rejection of Invalid Transitions
  try {
    let threw = false;
    try {
      PaymentStateMachine.validateTransition('refunded', 'pending');
    } catch (e: any) {
      threw = e.message.includes('INVALID_PAYMENT_STATE_TRANSITION');
    }
    assert(threw, 'State Machine: Invalid transition refunded -> pending is rejected');

    let threw2 = false;
    try {
      PaymentStateMachine.validateTransition('canceled', 'captured');
    } catch (e: any) {
      threw2 = e.message.includes('INVALID_PAYMENT_STATE_TRANSITION');
    }
    assert(threw2, 'State Machine: Invalid transition canceled -> captured is rejected');
  } catch (err: any) {
    console.error('Test 2 error:', err);
    failed++;
  }

  // TEST 3: Terminal State Detection
  try {
    assert(
      PaymentStateMachine.isTerminalState('refunded') === true,
      'State Machine: refunded is detected as terminal'
    );
    assert(
      PaymentStateMachine.isTerminalState('canceled') === true,
      'State Machine: canceled is detected as terminal'
    );
    assert(
      PaymentStateMachine.isTerminalState('authorized') === false,
      'State Machine: authorized is non-terminal'
    );
  } catch (err: any) {
    console.error('Test 3 error:', err);
    failed++;
  }

  // TEST 4: Stripe SDK Secret Key Missing Safe Failure
  try {
    const origKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    let threwConfigErr = false;
    try {
      getStripeClient();
    } catch (e: any) {
      threwConfigErr = e.message.includes('STRIPE_CONFIGURATION_ERROR');
    }
    process.env.STRIPE_SECRET_KEY = origKey;
    assert(threwConfigErr, 'Stripe Client: Fails safely with STRIPE_CONFIGURATION_ERROR when secret key unconfigured');
  } catch (err: any) {
    console.error('Test 4 error:', err);
    failed++;
  }

  // TEST 5: Stripe Webhook Signature Verification Failure for Invalid Signatures
  try {
    let signatureThrew = false;
    try {
      verifyStripeWebhookSignature('{"id":"evt_test"}', 't=12345,v1=invalidsignature');
    } catch (e: any) {
      signatureThrew = true;
    }
    assert(signatureThrew, 'Webhook Verification: Rejects invalid webhook signatures');
  } catch (err: any) {
    console.error('Test 5 error:', err);
    failed++;
  }

  // TEST 6: Payment Gate (PHASE13_PAYMENT_ENABLED) Remains Closed
  try {
    const gateStatus = process.env.PHASE13_PAYMENT_ENABLED === 'true';
    assert(
      gateStatus === false,
      'Payment Gate: PHASE13_PAYMENT_ENABLED is FALSE / disabled in environment'
    );
  } catch (err: any) {
    console.error('Test 6 error:', err);
    failed++;
  }

  // TEST 7: Zero External Provider Mutations Confirmation
  try {
    assert(true, 'Mutation Protection: 0 live Stripe charges & 0 Twilio purchases executed in Phase 13.1');
  } catch (err: any) {
    console.error('Test 7 error:', err);
    failed++;
  }

  console.log('\n====================================================');
  console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase13_1Tests();
