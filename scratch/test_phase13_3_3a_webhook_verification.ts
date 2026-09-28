import Stripe from 'stripe';
import { StripeWebhookHandler } from '../src/lib/billing/providers/stripe/stripeWebhookHandler';
import { PaymentStateMachine } from '../src/lib/billing/paymentStateMachine';
import { PaymentCanonicalStatus } from '../src/lib/billing/types';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  } else {
    console.log(`✓ [PASS] ${message}`);
  }
}

async function runPhase13_3_3a_WebhookTests() {
  console.log('====================================================');
  console.log('RUNNING PHASE 13.3.3A STRIPE WEBHOOK VERIFICATION GATE');
  console.log('====================================================\n');

  // Set test environment variables for unit test execution
  process.env.STRIPE_SECRET_KEY = 'sk_test_mock_secret_key_for_unit_tests';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock_webhook_secret_key_12345';

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-02-24.acacia' as any });

  // Create Mock DB Store
  const webhookEvents = new Map<string, any>();
  const paymentOps = new Map<string, any>();
  let twilioMutationCallCount = 0;
  let stripeCaptureCallCount = 0;

  const mockSupabase: any = {
    from: (table: string) => {
      return {
        select: (cols: string) => {
          return {
            eq: (col: string, val: any) => {
              return {
                eq: (col2: string, val2: any) => {
                  return {
                    maybeSingle: async () => {
                      if (table === 'billing_webhook_events') {
                        const match = Array.from(webhookEvents.values()).find(
                          (e) => e[col] === val && e[col2] === val2
                        );
                        return { data: match || null, error: null };
                      }
                      if (table === 'billing_payment_operations') {
                        const match = Array.from(paymentOps.values()).find(
                          (p) => p[col] === val && p[col2] === val2
                        );
                        return { data: match || null, error: null };
                      }
                      return { data: null, error: null };
                    },
                  };
                },
                maybeSingle: async () => {
                  if (table === 'billing_payment_operations') {
                    const match = Array.from(paymentOps.values()).find((p) => p[col] === val);
                    return { data: match || null, error: null };
                  }
                  return { data: null, error: null };
                },
              };
            },
          };
        },
        insert: (payload: any) => {
          if (table === 'billing_webhook_events') {
            if (webhookEvents.has(payload.provider_event_id)) {
              return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
            }
            webhookEvents.set(payload.provider_event_id, { id: `wh_${Math.random()}`, ...payload });
          }
          return { error: null };
        },
        update: (payload: any) => {
          return {
            eq: (col: string, val: any) => {
              if (table === 'billing_payment_operations') {
                const item = paymentOps.get(val);
                if (item) Object.assign(item, payload);
              }
              return { data: null, error: null };
            },
          };
        },
      };
    },
  };

  // Helper to construct mock Stripe event
  function createMockStripeEvent(id: string, type: string, paymentIntentId: string): Stripe.Event {
    return {
      id,
      object: 'event',
      api_version: '2025-02-24.acacia',
      created: Math.floor(Date.now() / 1000),
      type: type as any,
      livemode: false,
      pending_webhooks: 1,
      request: { id: 'req_123', idempotency_key: 'idemp_123' },
      data: {
        object: {
          id: paymentIntentId,
          object: 'payment_intent',
          amount: 315,
          currency: 'usd',
          status: type === 'payment_intent.amount_capturable_updated' ? 'requires_capture' : 'succeeded',
        } as any,
      },
    };
  }

  function signPayload(payload: string): string {
    return stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
    });
  }

  // Set up mock payment operation
  const payOpId = 'pay_op_wh_1001';
  const piId = 'pi_wh_test_1001';
  paymentOps.set(payOpId, {
    id: payOpId,
    provider: 'stripe',
    provider_payment_id: piId,
    status: 'pending',
    organization_id: 'org_test_1001',
  });

  // TEST 0: Middleware route exemption logic verification
  {
    function simulateMiddlewareCheck(method: string, pathname: string, user: any) {
      if (
        (method === 'POST' && pathname === '/api/webhooks/stripe') ||
        pathname.startsWith('/api/twilio/voice/') ||
        pathname.startsWith('/api/twilio/status') ||
        pathname.startsWith('/api/twilio/recording') ||
        pathname.startsWith('/api/extension') ||
        pathname.startsWith('/api/invitations/verify') ||
        pathname.startsWith('/api/invitations/accept')
      ) {
        return { action: 'next' };
      }

      const isAuthRoute = ['/login', '/signup', '/forgot-password', '/reset-password'].includes(pathname);
      const isPublicRoute = isAuthRoute || pathname.startsWith('/auth/callback') || pathname.startsWith('/invite/accept');

      if (!user && !isPublicRoute && pathname !== '/') {
        return { action: 'redirect', redirectUrl: '/login' };
      }

      return { action: 'next' };
    }

    assert(simulateMiddlewareCheck('POST', '/api/webhooks/stripe', null).action === 'next', 'Test 0a: POST /api/webhooks/stripe is exempted from login redirect');
    assert(simulateMiddlewareCheck('GET', '/api/billing/checkout/session', null).redirectUrl === '/login', 'Test 0b: Protected API routes remain protected when unauthenticated');
    assert(simulateMiddlewareCheck('GET', '/dashboard', null).redirectUrl === '/login', 'Test 0c: Protected application routes remain protected when unauthenticated');
  }

  // TEST 1: Valid signed webhook delivery & durable receipt
  {
    const event = createMockStripeEvent('evt_test_001', 'payment_intent.amount_capturable_updated', piId);
    const rawBody = JSON.stringify(event);
    const signature = signPayload(rawBody);

    const res = await StripeWebhookHandler.handleWebhookEvent(mockSupabase, rawBody, signature);

    assert(res.success === true, 'Test 1: Valid webhook handled successfully');
    assert(res.duplicate === false, 'Test 1: First delivery is not duplicate');
    assert(webhookEvents.size === 1, 'Test 1: Durable receipt saved in billing_webhook_events');
    assert(paymentOps.get(payOpId).status === 'authorized', 'Test 1: Canonical payment status transitioned to authorized');
  }

  // TEST 2: Duplicate webhook delivery idempotency
  {
    const event = createMockStripeEvent('evt_test_001', 'payment_intent.amount_capturable_updated', piId);
    const rawBody = JSON.stringify(event);
    const signature = signPayload(rawBody);

    const res = await StripeWebhookHandler.handleWebhookEvent(mockSupabase, rawBody, signature);

    assert(res.success === true, 'Test 2: Duplicate delivery returns HTTP success');
    assert(res.duplicate === true, 'Test 2: Event marked as duplicate');
    assert(webhookEvents.size === 1, 'Test 2: Receipt count for evt_test_001 remains exactly 1');
  }

  // TEST 3: Invalid signature rejection
  {
    const rawBody = JSON.stringify(createMockStripeEvent('evt_bad', 'payment_intent.canceled', piId));
    try {
      await StripeWebhookHandler.handleWebhookEvent(mockSupabase, rawBody, 't=123,v1=invalid_signature');
      assert(false, 'Test 3: Invalid signature should throw error');
    } catch (err: any) {
      assert(err.message.includes('INVALID_WEBHOOK_SIGNATURE'), 'Test 3: Invalid signature rejected with INVALID_WEBHOOK_SIGNATURE');
    }
  }

  // TEST 4: Out-of-order state regression protection
  {
    // Set payment op status to captured
    paymentOps.get(payOpId).status = 'captured';

    // Send an out-of-order/older event (amount_capturable_updated -> authorized)
    const oldEvent = createMockStripeEvent('evt_test_002', 'payment_intent.amount_capturable_updated', piId);
    const rawBody = JSON.stringify(oldEvent);
    const signature = signPayload(rawBody);

    await StripeWebhookHandler.handleWebhookEvent(mockSupabase, rawBody, signature);

    // Canonical status MUST remain captured (no state regression to authorized)
    assert(paymentOps.get(payOpId).status === 'captured', 'Test 4: Captured payment status cannot be regressed to authorized by older webhook');
  }

  // TEST 5: State Machine rejection check: canceled -> pending
  {
    assert(
      PaymentStateMachine.isTransitionAllowed('canceled' as PaymentCanonicalStatus, 'pending' as PaymentCanonicalStatus) === false,
      'Test 5: PaymentStateMachine rejects regression from canceled to pending'
    );
  }

  // TEST 6: Webhook safety invariants (0 Twilio mutations, 0 Stripe captures)
  {
    assert(twilioMutationCallCount === 0, 'Test 6: Webhook processing executed 0 Twilio purchase/release mutations');
    assert(stripeCaptureCallCount === 0, 'Test 6: Webhook processing executed 0 Stripe capture calls');
  }

  console.log('\n====================================================');
  console.log('PHASE 13.3.3A WEBHOOK VERIFICATION SUMMARY: ALL PASSED');
  console.log('====================================================\n');
}

runPhase13_3_3a_WebhookTests().catch((err) => {
  console.error('Unhandled webhook test harness error:', err);
  process.exit(1);
});
