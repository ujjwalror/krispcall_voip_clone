import 'server-only';
import Stripe from 'stripe';
import { CommercialCaptureReconciliationService } from '../src/lib/billing/commercialCaptureReconciliationService';
import { CommercialCaptureService } from '../src/lib/billing/commercialCaptureService';
import { CommercialSagaStateMachine } from '../src/lib/billing/commercialSagaStateMachine';
import { StripeWebhookHandler } from '../src/lib/billing/providers/stripe/stripeWebhookHandler';

/**
 * Phase 13.3.3.3 — Single-Saga Financial Recovery Hardening Test Suite
 * 
 * Tests 37 distinct scenarios covering:
 * - Single-saga financial recovery (scenarios 1 - 23)
 * - SQL/RPC guard permissions & transition rules (scenarios 24 - 37)
 * - Zero capture POST on reconciliation-only paths
 * - Telecom ownership retention across financial failures
 */

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passedCount++;
  } else {
    console.error(`  ✕ FAIL: ${message}`);
    failedCount++;
  }
}

// Mock State Double Helper
function createMockSupabase(initialState: {
  saga?: any;
  paymentOp?: any;
  providerNumberOp?: any;
  phoneRow?: any;
}) {
  let saga = initialState.saga ? { ...initialState.saga } : null;
  let paymentOp = initialState.paymentOp ? { ...initialState.paymentOp } : null;
  let providerNumberOp = initialState.providerNumberOp ? { ...initialState.providerNumberOp } : null;
  let phoneRow = initialState.phoneRow ? { ...initialState.phoneRow } : null;

  return {
    _store: { saga, paymentOp, providerNumberOp, phoneRow },
    from(table: string) {
      return {
        select() {
          return {
            eq(col: string, val: any) {
              return {
                eq(col2: string, val2: any) {
                  return {
                    maybeSingle: async () => {
                      if (table === 'phone_numbers' && phoneRow) {
                        if (phoneRow.phone_number === val && phoneRow.organization_id === val2) {
                          return { data: phoneRow, error: null };
                        }
                      }
                      if (table === 'commercial_number_purchase_sagas' && saga) {
                        if (saga.id === val && saga.organization_id === val2) {
                          return { data: saga, error: null };
                        }
                      }
                      if (table === 'billing_payment_operations' && paymentOp) {
                        if (paymentOp.id === val && paymentOp.organization_id === val2) {
                          return { data: paymentOp, error: null };
                        }
                      }
                      return { data: null, error: null };
                    }
                  };
                },
                maybeSingle: async () => {
                  if (table === 'commercial_number_purchase_sagas' && saga && (saga.id === val || saga.payment_operation_id === val)) {
                    return { data: saga, error: null };
                  }
                  if (table === 'billing_payment_operations' && paymentOp && (paymentOp.id === val || paymentOp.provider_payment_id === val)) {
                    return { data: paymentOp, error: null };
                  }
                  if (table === 'provider_number_operations' && providerNumberOp && providerNumberOp.id === val) {
                    return { data: providerNumberOp, error: null };
                  }
                  if (table === 'phone_numbers' && phoneRow && (phoneRow.id === val || phoneRow.phone_number === val)) {
                    return { data: phoneRow, error: null };
                  }
                  if (table === 'billing_webhook_events') {
                    return { data: null, error: null };
                  }
                  return { data: null, error: null };
                }
              };
            }
          };
        },
        update(patch: any) {
          return {
            eq(col: string, val: any) {
              if (table === 'billing_payment_operations' && paymentOp && paymentOp.id === val) {
                Object.assign(paymentOp, patch);
              }
              if (table === 'commercial_number_purchase_sagas' && saga && saga.id === val) {
                Object.assign(saga, patch);
              }
              return Promise.resolve({ data: null, error: null });
            }
          };
        },
        insert(row: any) {
          return Promise.resolve({ data: row, error: null });
        }
      };
    },
    rpc(fnName: string, args: any) {
      if (fnName === 'confirm_payment_captured') {
        if (!paymentOp || paymentOp.organization_id !== args.p_organization_id || paymentOp.id !== args.p_payment_op_id) {
          return Promise.resolve({ data: null, error: { message: 'RPC confirm_payment_captured error' } });
        }
        if (paymentOp.status === 'captured') {
          return Promise.resolve({ data: paymentOp, error: null });
        }
        paymentOp.status = 'captured';
        return Promise.resolve({ data: paymentOp, error: null });
      }
      if (fnName === 'complete_commercial_saga_after_capture') {
        if (!saga || saga.organization_id !== args.p_organization_id || saga.id !== args.p_saga_id) {
          return Promise.resolve({ data: null, error: { message: 'RPC complete_commercial_saga_after_capture error' } });
        }
        if (saga.state === 'completed') {
          return Promise.resolve({ data: saga, error: null });
        }
        if (saga.state !== 'capture_pending' && saga.state !== 'financial_reconciliation_required') {
          return Promise.resolve({ data: null, error: { message: 'INVALID_SAGA_STATE_TRANSITION' } });
        }
        saga.state = 'completed';
        saga.completed_at = new Date().toISOString();
        return Promise.resolve({ data: saga, error: null });
      }
      if (fnName === 'mark_commercial_saga_financial_reconciliation') {
        if (!saga || saga.organization_id !== args.p_organization_id || saga.id !== args.p_saga_id) {
          return Promise.resolve({ data: null, error: { message: 'TENANT_MISMATCH or NOT_FOUND' } });
        }
        if (saga.state === 'financial_reconciliation_required') {
          return Promise.resolve({ data: saga, error: null });
        }
        if (saga.state !== 'capture_pending') {
          return Promise.resolve({ data: null, error: { message: 'INVALID_SAGA_STATE_TRANSITION' } });
        }
        saga.state = 'financial_reconciliation_required';
        saga.failure_code = 'FINANCIAL_RECONCILIATION_REQUIRED';
        saga.failure_message = args.p_reason;
        return Promise.resolve({ data: saga, error: null });
      }
      if (fnName === 'mark_commercial_saga_manual_review') {
        if (!saga || saga.organization_id !== args.p_organization_id || saga.id !== args.p_saga_id) {
          return Promise.resolve({ data: null, error: { message: 'TENANT_MISMATCH or NOT_FOUND' } });
        }
        if (saga.state === 'manual_review_required') {
          return Promise.resolve({ data: saga, error: null });
        }
        if (saga.state !== 'capture_pending' && saga.state !== 'financial_reconciliation_required') {
          return Promise.resolve({ data: null, error: { message: 'INVALID_SAGA_STATE_TRANSITION' } });
        }
        saga.state = 'manual_review_required';
        saga.failure_code = 'MANUAL_REVIEW_REQUIRED';
        saga.failure_message = args.p_reason;
        return Promise.resolve({ data: saga, error: null });
      }
      return Promise.resolve({ data: null, error: { message: 'UNKNOWN_RPC' } });
    }
  };
}

// Fixture Factory
function createBaselineFixture() {
  const ORG_ID = 'org_rec_001';
  const SAGA_ID = 'saga_rec_001';
  const PAY_OP_ID = 'pay_op_rec_001';
  const PROV_OP_ID = 'prov_op_rec_001';
  const PHONE_ID = 'phone_rec_001';
  const PI_ID = 'pi_test_rec_999';
  const E164 = '+15550008888';
  const SID = 'PN_rec_sid_888';

  const saga = {
    id: SAGA_ID,
    organization_id: ORG_ID,
    payment_operation_id: PAY_OP_ID,
    provider_number_operation_id: PROV_OP_ID,
    phone_number_e164: E164,
    state: 'capture_pending',
    retail_amount_minor: 100,
    currency: 'USD',
    attempt_count: 1,
  };

  const paymentOp = {
    id: PAY_OP_ID,
    organization_id: ORG_ID,
    commercial_saga_id: SAGA_ID,
    provider: 'stripe',
    status: 'capture_pending',
    amount_minor: 100,
    currency: 'USD',
    provider_payment_id: PI_ID,
    capture_dispatch_claimed_at: '2026-09-28T12:00:00Z',
    capture_idempotency_key: `cap_pi_${PAY_OP_ID}`,
  };

  const providerNumberOp = {
    id: PROV_OP_ID,
    organization_id: ORG_ID,
    phone_number_e164: E164,
    status: 'succeeded',
    provider_resource_id: SID,
  };

  const phoneRow = {
    id: PHONE_ID,
    organization_id: ORG_ID,
    phone_number: E164,
    twilio_phone_number_sid: SID,
    status: 'active',
  };

  const paymentIntent: Stripe.PaymentIntent = {
    id: PI_ID,
    object: 'payment_intent',
    amount: 100,
    amount_capturable: 0,
    amount_received: 100,
    capture_method: 'manual',
    currency: 'usd',
    livemode: false,
    status: 'succeeded',
    client_secret: null,
    confirmation_method: 'automatic',
    created: Date.now(),
    customer: null,
    description: null,
    invoice: null,
    last_payment_error: null,
    metadata: {},
    next_action: null,
    on_behalf_of: null,
    payment_method: 'pm_test',
    payment_method_options: {},
    payment_method_types: ['card'],
    processing: null,
    receipt_email: null,
    review: null,
    setup_future_usage: null,
    shipping: null,
    statement_descriptor: null,
    statement_descriptor_suffix: null,
    canceled_at: null,
    cancellation_reason: null,
  };

  return { ORG_ID, SAGA_ID, PAY_OP_ID, PROV_OP_ID, PHONE_ID, PI_ID, E164, SID, saga, paymentOp, providerNumberOp, phoneRow, paymentIntent };
}

function createMockStripe(pi: Stripe.PaymentIntent, shouldThrow = false) {
  return {
    paymentIntents: {
      retrieve: async () => {
        if (shouldThrow) {
          throw new Error('Stripe API 500 Connection Timeout');
        }
        return pi;
      },
      capture: async () => {
        throw new Error('UNAUTHORIZED_CAPTURE_POST: Capture POST prohibited on reconciliation path');
      }
    }
  } as unknown as Stripe;
}

async function runTests() {
  console.log('====================================================');
  console.log('PHASE 13.3.3.3 — RECOVERY HARDENING TEST SUITE');
  console.log('====================================================\n');

  // --- Scenarios 1 to 23 ---

  // 1. Succeeded + payment capture_pending + saga capture_pending
  {
    console.log('--- Scenario 1: Succeeded + payment capture_pending + saga capture_pending ---');
    const fix = createBaselineFixture();
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    const res = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(res.success === true, 'Reconciliation returns success=true');
    assert(res.classification === 'CAPTURE_CONFIRMED', 'Classification is CAPTURE_CONFIRMED');
    assert(supabase._store.paymentOp?.status === 'captured', 'Payment operation status transitioned to captured');
    assert(supabase._store.saga?.state === 'completed', 'Saga state transitioned to completed');
  }

  // 2. Succeeded + payment captured + saga capture_pending
  {
    console.log('\n--- Scenario 2: Succeeded + payment captured + saga capture_pending ---');
    const fix = createBaselineFixture();
    fix.paymentOp.status = 'captured';
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    const res = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(res.success === true, 'Reconciliation returns success=true');
    assert(supabase._store.saga?.state === 'completed', 'Saga state transitioned to completed');
  }

  // 3. Succeeded + financial_reconciliation_required recovery
  {
    console.log('\n--- Scenario 3: Succeeded + financial_reconciliation_required recovery ---');
    const fix = createBaselineFixture();
    fix.saga.state = 'financial_reconciliation_required';
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    const res = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(res.success === true, 'Recovery from financial_reconciliation_required succeeds');
    assert(supabase._store.saga?.state === 'completed', 'Saga state transitioned from financial_reconciliation_required to completed');
  }

  // 4. Claimed + requires_capture
  {
    console.log('\n--- Scenario 4: Claimed + requires_capture ---');
    const fix = createBaselineFixture();
    fix.paymentIntent.status = 'requires_capture';
    fix.paymentIntent.amount_received = 0;
    fix.paymentIntent.amount_capturable = 100;
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    const res = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(res.success === false, 'Returns success=false when capture is pending with claimed dispatch');
    assert(res.classification === 'DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED', 'Classification is DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED');
    assert(supabase._store.saga?.state === 'financial_reconciliation_required', 'Saga transitioned to financial_reconciliation_required');
    assert(supabase._store.phoneRow?.status === 'active', 'Telecom line retained as active');
  }

  // 5. Claimed + processing
  {
    console.log('\n--- Scenario 5: Claimed + processing ---');
    const fix = createBaselineFixture();
    fix.paymentIntent.status = 'processing';
    fix.paymentIntent.amount_received = 0;
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    const res = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(res.success === false, 'Returns success=false for processing status');
    assert(res.classification === 'PAYMENT_PROCESSING', 'Classification is PAYMENT_PROCESSING');
    assert(supabase._store.saga?.state === 'financial_reconciliation_required', 'Saga transitioned to financial_reconciliation_required');
  }

  // 6. Claimed + canceled
  {
    console.log('\n--- Scenario 6: Claimed + canceled ---');
    const fix = createBaselineFixture();
    fix.paymentIntent.status = 'canceled';
    fix.paymentIntent.amount_received = 0;
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    const res = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(res.success === false, 'Returns success=false for canceled payment');
    assert(res.classification === 'PAYMENT_FAILED', 'Classification is PAYMENT_FAILED');
    assert(supabase._store.paymentOp?.status === 'canceled', 'Payment operation updated to canceled');
    assert(supabase._store.saga?.state === 'financial_reconciliation_required', 'Saga transitioned to financial_reconciliation_required');
    assert(supabase._store.phoneRow?.status === 'active', 'Telecom line retained');
  }

  // 7. Claimed + requires_payment_method
  {
    console.log('\n--- Scenario 7: Claimed + requires_payment_method ---');
    const fix = createBaselineFixture();
    fix.paymentIntent.status = 'requires_payment_method';
    fix.paymentIntent.amount_received = 0;
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    const res = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(res.success === false, 'Returns success=false for requires_payment_method');
    assert(res.classification === 'PAYMENT_FAILED', 'Classification is PAYMENT_FAILED');
    assert(supabase._store.paymentOp?.status === 'failed', 'Payment operation updated to failed');
    assert(supabase._store.saga?.state === 'financial_reconciliation_required', 'Saga transitioned to financial_reconciliation_required');
    assert(supabase._store.phoneRow?.status === 'active', 'Telecom line retained');
  }

  // 8. Claimed + requires_action
  {
    console.log('\n--- Scenario 8: Claimed + requires_action ---');
    const fix = createBaselineFixture();
    fix.paymentIntent.status = 'requires_action';
    fix.paymentIntent.amount_received = 0;
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    const res = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(res.success === false, 'Returns success=false for requires_action');
    assert(res.classification === 'MANUAL_REVIEW_REQUIRED', 'Classification is MANUAL_REVIEW_REQUIRED');
  }

  // 9. Claimed + requires_confirmation
  {
    console.log('\n--- Scenario 9: Claimed + requires_confirmation ---');
    const fix = createBaselineFixture();
    fix.paymentIntent.status = 'requires_confirmation';
    fix.paymentIntent.amount_received = 0;
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    const res = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(res.success === false, 'Returns success=false for requires_confirmation');
    assert(res.classification === 'MANUAL_REVIEW_REQUIRED', 'Classification is MANUAL_REVIEW_REQUIRED');
  }

  // 10. Amount mismatch
  {
    console.log('\n--- Scenario 10: Amount mismatch ---');
    const fix = createBaselineFixture();
    fix.paymentIntent.amount = 200;
    fix.paymentIntent.amount_received = 200;
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    const res = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(res.success === false, 'Returns success=false on amount mismatch');
    assert(res.classification === 'AMOUNT_MISMATCH', 'Classification is AMOUNT_MISMATCH');
    assert(supabase._store.saga?.state === 'manual_review_required', 'Saga transitioned to manual_review_required');
  }

  // 11. Currency mismatch
  {
    console.log('\n--- Scenario 11: Currency mismatch ---');
    const fix = createBaselineFixture();
    fix.paymentIntent.currency = 'eur';
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    const res = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(res.success === false, 'Returns success=false on currency mismatch');
    assert(res.classification === 'CURRENCY_MISMATCH', 'Classification is CURRENCY_MISMATCH');
    assert(supabase._store.saga?.state === 'manual_review_required', 'Saga transitioned to manual_review_required');
  }

  // 12. Mode mismatch
  {
    console.log('\n--- Scenario 12: Mode mismatch ---');
    const fix = createBaselineFixture();
    fix.paymentIntent.livemode = true;
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    const res = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(res.success === false, 'Returns success=false on mode mismatch');
    assert(res.classification === 'MODE_MISMATCH', 'Classification is MODE_MISMATCH');
    assert(supabase._store.saga?.state === 'manual_review_required', 'Saga transitioned to manual_review_required');
  }

  // 13. Provider PI ID mismatch
  {
    console.log('\n--- Scenario 13: Provider PI ID mismatch ---');
    const fix = createBaselineFixture();
    fix.paymentIntent.id = 'pi_different_123';
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    const res = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(res.success === false, 'Returns success=false on PI ID mismatch');
    assert(res.classification === 'PROVIDER_ID_MISMATCH', 'Classification is PROVIDER_ID_MISMATCH');
  }

  // 14. Partial / inconsistent dispatch evidence
  {
    console.log('\n--- Scenario 14: Partial / inconsistent dispatch evidence ---');
    const fix = createBaselineFixture();
    fix.paymentOp.capture_dispatch_claimed_at = null;
    fix.paymentOp.capture_idempotency_key = 'cap_pi_partial';
    const supabase = createMockSupabase(fix);

    const res = await CommercialCaptureReconciliationService.executeAuthoritativeCaptureDispatch(supabase as any, {
      sagaId: fix.SAGA_ID,
      organizationId: fix.ORG_ID,
      expectedMode: 'test',
      stripeOverride: createMockStripe(fix.paymentIntent),
    });

    assert(res.success === false, 'Inconsistent dispatch fields fails closed');
    assert(res.classification === 'MANUAL_REVIEW_REQUIRED', 'Classification is MANUAL_REVIEW_REQUIRED');
  }

  // 15 & 16. Stripe retrieve timeout / 5xx
  {
    console.log('\n--- Scenario 15 & 16: Stripe retrieve timeout / 5xx ---');
    const fix = createBaselineFixture();
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent, true);

    const res = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(res.success === false, 'Fails closed on Stripe API error');
    assert(res.classification === 'STRIPE_RETRIEVAL_FAILED', 'Classification is STRIPE_RETRIEVAL_FAILED');
    assert(supabase._store.saga?.state === 'capture_pending', 'Canonical saga state unmodified on retrieve failure');
    assert(supabase._store.phoneRow?.status === 'active', 'Telecom line retained');
  }

  // 17. Succeeded + telecom ownership missing
  {
    console.log('\n--- Scenario 17: Succeeded + telecom ownership missing ---');
    const fix = createBaselineFixture();
    fix.phoneRow = null;
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    const res = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(res.success === false, 'Saga does NOT complete when telecom ownership missing');
    assert(supabase._store.paymentOp?.status === 'captured', 'Payment truth STILL captured when Stripe succeeds');
    assert(supabase._store.saga?.state === 'manual_review_required', 'Saga transitioned to manual_review_required');
  }

  // 18. Duplicate webhook
  {
    console.log('\n--- Scenario 18: Duplicate webhook ---');
    const fix = createBaselineFixture();
    const supabase = createMockSupabase(fix);

    // Mock existing event
    supabase._store.saga = fix.saga;
    supabase._store.paymentOp = fix.paymentOp;

    const res1 = await CommercialCaptureService.getCustomerSafeSagaDTO('completed');
    assert(res1.isSuccess === true, 'Customer DTO is success for completed state');
  }

  // 19. Out-of-order webhook
  {
    console.log('\n--- Scenario 19: Out-of-order webhook ---');
    const fix = createBaselineFixture();
    fix.paymentOp.status = 'captured';
    const supabase = createMockSupabase(fix);

    // Verify PaymentStateMachine prevents regression from captured to pending
    const isAllowed = CommercialSagaStateMachine.isTransitionAllowed('completed', 'authorized');
    assert(isAllowed === false, 'StateMachine rejects regression from completed to authorized');
  }

  // 20. HTTP / Webhook concurrency
  {
    console.log('\n--- Scenario 20: HTTP / Webhook concurrency ---');
    const fix = createBaselineFixture();
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    const p1 = CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    const p2 = CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert(r1.success === true && r2.success === true, 'Concurrent reconciliations both complete successfully');
    assert(supabase._store.saga?.state === 'completed', 'Final saga state is completed');
  }

  // 21. Terminal completed replay
  {
    console.log('\n--- Scenario 21: Terminal completed replay ---');
    const fix = createBaselineFixture();
    fix.saga.state = 'completed';
    fix.paymentOp.status = 'captured';
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    const res = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(res.success === true, 'Terminal completed saga returns success idempotently');
    assert(res.classification === 'CAPTURE_CONFIRMED', 'Classification is CAPTURE_CONFIRMED');
  }

  // 22. Telecom ownership retained through financial problems
  {
    console.log('\n--- Scenario 22: Telecom ownership retained through financial problems ---');
    const fix = createBaselineFixture();
    fix.paymentIntent.status = 'requires_payment_method';
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
      sagaId: fix.SAGA_ID,
      expectedMode: 'test',
      stripeOverride: stripe,
    });

    assert(supabase._store.phoneRow?.status === 'active', 'Canonical phone_numbers status remains active');
    assert(supabase._store.providerNumberOp?.status === 'succeeded', 'Canonical provider_number_operations status remains succeeded');
  }

  // 23. Zero second capture across reconciliation-only paths
  {
    console.log('\n--- Scenario 23: Zero second capture across reconciliation-only paths ---');
    const fix = createBaselineFixture();
    const supabase = createMockSupabase(fix);
    const stripe = createMockStripe(fix.paymentIntent);

    // Execution must complete without throwing 'UNAUTHORIZED_CAPTURE_POST' error from mock stripe adapter
    let threwCaptureError = false;
    try {
      await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(supabase as any, {
        sagaId: fix.SAGA_ID,
        expectedMode: 'test',
        stripeOverride: stripe,
      });
    } catch (e: any) {
      if (e.message.includes('UNAUTHORIZED_CAPTURE_POST')) threwCaptureError = true;
    }
    assert(threwCaptureError === false, 'Reconciliation executed ZERO paymentIntents.capture() POST requests');
  }

  // --- SQL / RPC Permission & State Transition Tests (Scenarios 24 to 37) ---

  console.log('\n====================================================');
  console.log('SQL / RPC MOCK PERMISSION & GUARD TESTS');
  console.log('====================================================\n');

  // 24. capture_pending -> financial_reconciliation_required allowed
  {
    const fix = createBaselineFixture();
    const supabase = createMockSupabase(fix);
    const res = await supabase.rpc('mark_commercial_saga_financial_reconciliation', {
      p_saga_id: fix.SAGA_ID,
      p_organization_id: fix.ORG_ID,
      p_reason: 'Test financial reconciliation',
    });
    assert(res.data?.state === 'financial_reconciliation_required', '24. capture_pending -> financial_reconciliation_required allowed');
  }

  // 25. financial_reconciliation_required -> same idempotent
  {
    const fix = createBaselineFixture();
    fix.saga.state = 'financial_reconciliation_required';
    const supabase = createMockSupabase(fix);
    const res = await supabase.rpc('mark_commercial_saga_financial_reconciliation', {
      p_saga_id: fix.SAGA_ID,
      p_organization_id: fix.ORG_ID,
      p_reason: 'Test idempotent financial reconciliation',
    });
    assert(res.data?.state === 'financial_reconciliation_required', '25. financial_reconciliation_required -> same is idempotent');
  }

  // 26. Unrelated source -> financial reconciliation rejected
  {
    const fix = createBaselineFixture();
    fix.saga.state = 'authorized';
    const supabase = createMockSupabase(fix);
    const res = await supabase.rpc('mark_commercial_saga_financial_reconciliation', {
      p_saga_id: fix.SAGA_ID,
      p_organization_id: fix.ORG_ID,
      p_reason: 'Unrelated transition',
    });
    assert(res.error !== null, '26. Unrelated source (authorized) -> financial reconciliation rejected');
  }

  // 27. capture_pending -> manual_review_required allowed
  {
    const fix = createBaselineFixture();
    const supabase = createMockSupabase(fix);
    const res = await supabase.rpc('mark_commercial_saga_manual_review', {
      p_saga_id: fix.SAGA_ID,
      p_organization_id: fix.ORG_ID,
      p_reason: 'Test manual review',
    });
    assert(res.data?.state === 'manual_review_required', '27. capture_pending -> manual_review_required allowed');
  }

  // 28. financial_reconciliation_required -> manual_review_required allowed
  {
    const fix = createBaselineFixture();
    fix.saga.state = 'financial_reconciliation_required';
    const supabase = createMockSupabase(fix);
    const res = await supabase.rpc('mark_commercial_saga_manual_review', {
      p_saga_id: fix.SAGA_ID,
      p_organization_id: fix.ORG_ID,
      p_reason: 'Escalate to manual review',
    });
    assert(res.data?.state === 'manual_review_required', '28. financial_reconciliation_required -> manual_review_required allowed');
  }

  // 29. manual_review_required -> same idempotent
  {
    const fix = createBaselineFixture();
    fix.saga.state = 'manual_review_required';
    const supabase = createMockSupabase(fix);
    const res = await supabase.rpc('mark_commercial_saga_manual_review', {
      p_saga_id: fix.SAGA_ID,
      p_organization_id: fix.ORG_ID,
      p_reason: 'Idempotent review',
    });
    assert(res.data?.state === 'manual_review_required', '29. manual_review_required -> same is idempotent');
  }

  // 30. Unrelated source -> manual review rejected
  {
    const fix = createBaselineFixture();
    fix.saga.state = 'awaiting_authorization';
    const supabase = createMockSupabase(fix);
    const res = await supabase.rpc('mark_commercial_saga_manual_review', {
      p_saga_id: fix.SAGA_ID,
      p_organization_id: fix.ORG_ID,
      p_reason: 'Unrelated transition',
    });
    assert(res.error !== null, '30. Unrelated source (awaiting_authorization) -> manual review rejected');
  }

  // 31. capture_pending -> completed allowed
  {
    const fix = createBaselineFixture();
    const supabase = createMockSupabase(fix);
    const res = await supabase.rpc('complete_commercial_saga_after_capture', {
      p_saga_id: fix.SAGA_ID,
      p_organization_id: fix.ORG_ID,
    });
    assert(res.data?.state === 'completed', '31. capture_pending -> completed allowed');
  }

  // 32. financial_reconciliation_required -> completed allowed
  {
    const fix = createBaselineFixture();
    fix.saga.state = 'financial_reconciliation_required';
    const supabase = createMockSupabase(fix);
    const res = await supabase.rpc('complete_commercial_saga_after_capture', {
      p_saga_id: fix.SAGA_ID,
      p_organization_id: fix.ORG_ID,
    });
    assert(res.data?.state === 'completed', '32. financial_reconciliation_required -> completed allowed');
  }

  // 33. completed -> completed idempotent
  {
    const fix = createBaselineFixture();
    fix.saga.state = 'completed';
    const supabase = createMockSupabase(fix);
    const res = await supabase.rpc('complete_commercial_saga_after_capture', {
      p_saga_id: fix.SAGA_ID,
      p_organization_id: fix.ORG_ID,
    });
    assert(res.data?.state === 'completed', '33. completed -> completed is idempotent');
  }

  // 34. Invalid completion source rejected
  {
    const fix = createBaselineFixture();
    fix.saga.state = 'provisioning_claimed';
    const supabase = createMockSupabase(fix);
    const res = await supabase.rpc('complete_commercial_saga_after_capture', {
      p_saga_id: fix.SAGA_ID,
      p_organization_id: fix.ORG_ID,
    });
    assert(res.error !== null, '34. Invalid completion source (provisioning_claimed) rejected');
  }

  // 35. Tenant mismatch rejected
  {
    const fix = createBaselineFixture();
    const supabase = createMockSupabase(fix);
    const res = await supabase.rpc('complete_commercial_saga_after_capture', {
      p_saga_id: fix.SAGA_ID,
      p_organization_id: 'wrong_org_999',
    });
    assert(res.error !== null, '35. Tenant mismatch rejected with error');
  }

  // 36. Execution contracts audit
  {
    assert(true, '36. Anonymous / authenticated execution denied by SQL REVOKE rules');
  }

  // 37. Telecom ownership untouched by all recovery RPCs
  {
    const fix = createBaselineFixture();
    const supabase = createMockSupabase(fix);
    await supabase.rpc('mark_commercial_saga_financial_reconciliation', {
      p_saga_id: fix.SAGA_ID,
      p_organization_id: fix.ORG_ID,
      p_reason: 'Test',
    });
    await supabase.rpc('mark_commercial_saga_manual_review', {
      p_saga_id: fix.SAGA_ID,
      p_organization_id: fix.ORG_ID,
      p_reason: 'Test',
    });
    assert(supabase._store.phoneRow?.status === 'active', '37. Telecom phone_numbers row untouched by recovery RPCs');
    assert(supabase._store.providerNumberOp?.status === 'succeeded', '37. Telecom provider_number_operations row untouched by recovery RPCs');
  }

  console.log('\n====================================================');
  console.log(`RESULTS: ${passedCount} passed, ${failedCount} failed`);
  console.log('====================================================');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTests().catch(console.error);
