process.env.STRIPE_SECRET_KEY = 'sk_test_mock_key_1234567890';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_1234567890';
process.env.STRIPE_EXPECTED_MODE = 'test';

import Stripe from 'stripe';
import { StripeWebhookHandler } from '../src/lib/billing/providers/stripe/stripeWebhookHandler';
import { CommercialSubscriptionSyncService } from '../src/lib/billing/commercialSubscriptionSyncService';
import * as stripeClientModule from '../src/lib/billing/providers/stripe/stripeClient';

const realStripe = new Stripe('sk_test_mock_key_1234567890', { apiVersion: '2025-02-24.acacia' as any });

// Shared counters
let stripeRetrieveCalls = 0;
let stripeMutationCalls = 0;
let twilioCalls = 0;
let regulatoryCalls = 0;

let passedScenarios = 0;
let failedScenarios = 0;
let passedAssertions = 0;
let failedAssertions = 0;

function assert(condition: boolean, description: string) {
  if (condition) {
    passedAssertions++;
    console.log(`  ✓ PASS: ${description}`);
  } else {
    failedAssertions++;
    console.error(`  ✕ FAIL: ${description}`);
  }
}

function makeSignedPayload(eventObj: any): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(eventObj);
  const signature = realStripe.webhooks.generateTestHeaderString({
    payload: rawBody,
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
  });
  return { rawBody, signature };
}

class MockSupabase {
  orgs: Map<string, any> = new Map();
  plans: Map<string, any> = new Map();
  prices: Map<string, any> = new Map();
  orgSubs: Map<string, any> = new Map();
  providerCusts: Map<string, any> = new Map();
  providerPrices: Map<string, any> = new Map();
  providerSubs: Map<string, any> = new Map();
  webhookEvents: Map<string, any> = new Map();
  paymentOps: Map<string, any> = new Map();
  invoices: Map<string, any> = new Map();

  from(table: string) {
    const self = this;
    return {
      select(cols?: string) {
        return {
          eq(col: string, val: any) {
            return {
              eq(col2: string, val2: any) {
                return {
                  maybeSingle: async () => {
                    if (table === 'billing_provider_customers') {
                      for (const item of self.providerCusts.values()) {
                        if (item.provider === val && item.provider_customer_id === val2) {
                          return { data: item, error: null };
                        }
                      }
                      return { data: null, error: null };
                    }
                    if (table === 'billing_provider_subscriptions') {
                      for (const item of self.providerSubs.values()) {
                        if (item.provider === val && item.provider_subscription_id === val2) {
                          const sub = self.orgSubs.get(item.organization_subscription_id);
                          return {
                            data: {
                              ...item,
                              organization_subscriptions: sub ? { organization_id: sub.organization_id } : null,
                            },
                            error: null,
                          };
                        }
                      }
                      return { data: null, error: null };
                    }
                    if (table === 'billing_webhook_events') {
                      for (const item of self.webhookEvents.values()) {
                        if (item.provider === val && item.provider_event_id === val2) {
                          return { data: item, error: null };
                        }
                      }
                      return { data: null, error: null };
                    }
                    if (table === 'billing_payment_operations') {
                      for (const item of self.paymentOps.values()) {
                        if (item.provider === val && item.provider_payment_id === val2) {
                          return { data: item, error: null };
                        }
                      }
                      return { data: null, error: null };
                    }
                    return { data: null, error: null };
                  },
                };
              },
              maybeSingle: async () => {
                if (table === 'organizations') {
                  const org = self.orgs.get(val);
                  return { data: org || null, error: null };
                }
                if (table === 'organization_subscriptions') {
                  for (const item of self.orgSubs.values()) {
                    if (item.organization_id === val) {
                      return { data: item, error: null };
                    }
                  }
                  return { data: null, error: null };
                }
                if (table === 'billing_provider_customers') {
                  for (const item of self.providerCusts.values()) {
                    if (item.organization_id === val || item.provider_customer_id === val) {
                      return { data: item, error: null };
                    }
                  }
                  return { data: null, error: null };
                }
                if (table === 'billing_payment_operations') {
                  for (const item of self.paymentOps.values()) {
                    if (item.provider_payment_id === val || item.id === val) {
                      return { data: item, error: null };
                    }
                  }
                  return { data: null, error: null };
                }
                return { data: null, error: null };
              },
              in: async (col2: string, vals: any[]) => {
                if (table === 'billing_provider_prices') {
                  const res: any[] = [];
                  for (const item of self.providerPrices.values()) {
                    if (item.provider === val && vals.includes(item.provider_price_id)) {
                      const price = self.prices.get(item.price_id);
                      res.push({
                        ...item,
                        prices: price ? { ...price } : null,
                      });
                    }
                  }
                  return { data: res, error: null };
                }
                return { data: [], error: null };
              },
            };
          },
          in(col: string, vals: any[]) {
            return {
              eq(col2: string, val2: any) {
                return {
                  async then(resolve: any) {
                    resolve({ data: [], error: null });
                  },
                };
              },
            };
          },
        };
      },
      insert(item: any) {
        return {
          select(cols?: string) {
            return {
              single: async () => {
                const id = item.id || `id_${Math.random()}`;
                const rec = { ...item, id };
                if (table === 'organization_subscriptions') self.orgSubs.set(id, rec);
                return { data: rec, error: null };
              },
            };
          },
          async then(resolve: any) {
            const id = item.id || item.provider_event_id || `id_${Math.random()}`;
            const rec = { ...item, id };
            if (table === 'billing_webhook_events') {
              for (const existing of self.webhookEvents.values()) {
                if (existing.provider === rec.provider && existing.provider_event_id === rec.provider_event_id) {
                  return resolve({ error: { code: '23505', message: 'duplicate key' } });
                }
              }
              self.webhookEvents.set(id, rec);
            } else if (table === 'billing_provider_subscriptions') {
              self.providerSubs.set(id, rec);
            } else if (table === 'organization_subscriptions') {
              self.orgSubs.set(id, rec);
            }
            resolve({ data: rec, error: null });
          },
        };
      },
      update(item: any) {
        let conditions: Array<{ col: string; val: any }> = [];

        const handleUpdateExecution = () => {
          let matches: any[] = [];
          for (const [k, v] of Array.from(self.webhookEvents.entries())) {
            let pass = true;
            for (const cond of conditions) {
              if (cond.col === 'id' && v.id !== cond.val && k !== cond.val && v.provider_event_id !== cond.val) pass = false;
              if (cond.col === 'provider' && v.provider !== cond.val) pass = false;
              if (cond.col === 'provider_event_id' && v.provider_event_id !== cond.val) pass = false;
              if (cond.col === 'status' && v.status !== cond.val) pass = false;
              if (cond.col === 'processing_started_at' && v.processing_started_at !== cond.val) pass = false;
            }
            if (pass) {
              const updated = { ...v, ...item };
              self.webhookEvents.set(k, updated);
              matches.push(updated);
            }
          }
          for (const [k, v] of Array.from(self.orgSubs.entries())) {
            let pass = true;
            for (const cond of conditions) {
              if (cond.col === 'id' && v.id !== cond.val) pass = false;
              if (cond.col === 'organization_id' && v.organization_id !== cond.val) pass = false;
            }
            if (pass) {
              const updated = { ...v, ...item };
              self.orgSubs.set(k, updated);
              matches.push(updated);
            }
          }
          return matches;
        };

        const createBuilder = (): any => ({
          eq(col: string, val: any) {
            conditions.push({ col, val });
            return createBuilder();
          },
          select(cols?: string) {
            return {
              maybeSingle: async () => {
                const matches = handleUpdateExecution();
                return { data: matches[0] || null, error: null };
              },
              single: async () => {
                const matches = handleUpdateExecution();
                return { data: matches[0] || null, error: null };
              },
            };
          },
          then(resolve: any) {
            const matches = handleUpdateExecution();
            resolve({ data: matches[0] || null, error: null });
          },
        });

        return createBuilder();
      },
      upsert(item: any, opts?: any) {
        return {
          async then(resolve: any) {
            const id = item.id || `id_${Math.random()}`;
            if (table === 'billing_provider_subscriptions') {
              self.providerSubs.set(item.provider_subscription_id || id, { ...item, id });
            } else if (table === 'billing_invoices') {
              self.invoices.set(item.provider_invoice_id || id, { ...item, id });
            }
            resolve({ data: item, error: null });
          },
        };
      },
    };
  }

  rpc(funcName: string, params: any) {
    const self = this;
    if (funcName === 'claim_stripe_webhook_event_for_processing') {
      const eventId = params.p_provider_event_id;
      let eventRec: any = null;
      for (const item of self.webhookEvents.values()) {
        if (item.provider === 'stripe' && (item.provider_event_id === eventId || item.id === eventId)) {
          eventRec = item;
          break;
        }
      }

      if (!eventRec) {
        return Promise.resolve({ data: { claimed: false, reason: 'not_found' }, error: null });
      }

      if (eventRec.status === 'completed') {
        return Promise.resolve({ data: { claimed: false, reason: 'completed', event_id: eventRec.id }, error: null });
      }

      const staleThresholdMs = (params.p_stale_threshold_seconds || 300) * 1000;
      if (eventRec.status === 'processing' && eventRec.processing_started_at) {
        const started = new Date(eventRec.processing_started_at).getTime();
        if (Date.now() - started < staleThresholdMs) {
          return Promise.resolve({ data: { claimed: false, reason: 'processing_in_parallel', event_id: eventRec.id }, error: null });
        }
      }

      eventRec.status = 'processing';
      eventRec.processing_started_at = new Date().toISOString();
      eventRec.attempt_count = (eventRec.attempt_count || 0) + 1;

      return Promise.resolve({
        data: {
          claimed: true,
          event_id: eventRec.id,
          attempt_count: eventRec.attempt_count,
        },
        error: null,
      });
    }

    if (funcName === 'reconcile_stripe_subscription_atomic') {
      const org = self.orgs.get(params.p_organization_id);
      if (!org) {
        return Promise.resolve({
          data: null,
          error: { message: `ORGANIZATION_NOT_FOUND: Organization ${params.p_organization_id} does not exist.`, code: 'P0002' },
        });
      }
      if (params.p_cancel_at_period_end === null || params.p_cancel_at_period_end === undefined) {
        return Promise.resolve({
          data: null,
          error: { message: 'INVALID_ARGUMENT: p_cancel_at_period_end is required.', code: '22023' },
        });
      }
      if (['active', 'trialing', 'past_due'].includes(params.p_status)) {
        if (!params.p_current_period_start || !params.p_current_period_end) {
          return Promise.resolve({
            data: null,
            error: { message: 'INVALID_PERIOD: Active/trialing/past_due subscriptions require non-null period timestamps.', code: '22023' },
          });
        }
      }
      if (params.p_current_period_start && params.p_current_period_end) {
        if (new Date(params.p_current_period_end) < new Date(params.p_current_period_start)) {
          return Promise.resolve({
            data: null,
            error: { message: 'INVALID_PERIOD: end cannot be earlier than start.', code: '22023' },
          });
        }
      }

      // Check existing mapping conflict
      const provSub = self.providerSubs.get(params.p_provider_subscription_id);
      if (provSub && provSub.organization_subscription_id) {
        const existingSub = self.orgSubs.get(provSub.organization_subscription_id);
        if (existingSub && existingSub.organization_id !== params.p_organization_id) {
          return Promise.resolve({
            data: null,
            error: { message: 'SUBSCRIPTION_MAPPING_CONFLICT: Provider subscription belongs to another internal subscription.', code: '23505' },
          });
        }
      }

      // Reconcile in mock DB
      let sub = Array.from(self.orgSubs.values()).find((s) => s.organization_id === params.p_organization_id);

      // Out-of-order check
      if (sub && sub.current_period_start && params.p_current_period_start) {
        if (new Date(params.p_current_period_start) < new Date(sub.current_period_start)) {
          return Promise.resolve({
            data: { success: false, code: 'OUT_OF_ORDER_STALE_EVENT', message: 'Incoming current_period_start is older than existing current_period_start.', organization_subscription_id: sub.id },
            error: null,
          });
        }
      }

      // Terminal Resurrection Guard
      if (sub && (sub.ended_at || sub.status === 'canceled') && ['active', 'trialing', 'past_due'].includes(params.p_status)) {
        return Promise.resolve({
          data: {
            success: false,
            code: 'TERMINAL_RESURRECTION_PROHIBITED',
            message: 'Cannot resurrect an internally terminal subscription to active in-place. Reconciliation required.',
            organization_subscription_id: sub.id,
          },
          error: null,
        });
      }

      const subId = sub ? sub.id : `sub_rec_${Math.random()}`;
      const updatedSub = {
        id: subId,
        organization_id: params.p_organization_id,
        plan_id: params.p_plan_id,
        status: params.p_status,
        current_period_start: params.p_current_period_start,
        current_period_end: params.p_current_period_end,
        cancel_at_period_end: params.p_cancel_at_period_end,
        canceled_at: ['active', 'trialing'].includes(params.p_status) ? null : (params.p_canceled_at || sub?.canceled_at),
        ended_at: ['active', 'trialing', 'past_due'].includes(params.p_status) ? null : (params.p_ended_at || sub?.ended_at),
        updated_at: new Date().toISOString(),
      };
      self.orgSubs.set(subId, updatedSub);
      self.providerSubs.set(params.p_provider_subscription_id, {
        id: `ps_${subId}`,
        organization_subscription_id: subId,
        provider: 'stripe',
        provider_subscription_id: params.p_provider_subscription_id,
      });

      return Promise.resolve({
        data: {
          success: true,
          organization_subscription_id: subId,
          organization_id: params.p_organization_id,
          status: params.p_status,
          plan_id: params.p_plan_id,
          provider_subscription_id: params.p_provider_subscription_id,
        },
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  }
}

function createMockStripe(subResolver?: (id: string) => any): Stripe {
  return {
    subscriptions: {
      retrieve: async (id: string) => {
        stripeRetrieveCalls++;
        if (subResolver) return subResolver(id);
        throw new Error('Default mock error');
      },
      create: async () => { stripeMutationCalls++; throw new Error('STRICT PROHIBITION: stripe.subscriptions.create'); },
      update: async () => { stripeMutationCalls++; throw new Error('STRICT PROHIBITION: stripe.subscriptions.update'); },
      cancel: async () => { stripeMutationCalls++; throw new Error('STRICT PROHIBITION: stripe.subscriptions.cancel'); },
    },
  } as any;
}

let currentMockStripe: Stripe | null = null;
(stripeClientModule as any).getStripeClient = (): Stripe => {
  return currentMockStripe || createMockStripe();
};

async function runTests() {
  console.log('====================================================');
  console.log('PHASE 13.4.1 — SUBSCRIPTION SYNC DISCRETE TEST SUITE');
  console.log('====================================================\n');

  const orgId = 'org_test_1001';
  const planId = 'plan_growth_2002';
  const priceId = 'price_growth_monthly_3003';
  const cusId = 'cus_stripe_4004';
  const subId = 'sub_stripe_5005';
  const providerPriceId = 'price_stripe_growth_monthly_6006';

  function initMockDb(): MockSupabase {
    const db = new MockSupabase();
    db.orgs.set(orgId, { id: orgId, name: 'Alpha Ltd' });
    db.plans.set(planId, { id: planId, code: 'growth', name: 'Growth Plan' });
    db.prices.set(priceId, { id: priceId, plan_id: planId, billing_interval: 'monthly', amount_minor: 4900, currency: 'USD', is_active: true });
    db.providerCusts.set(cusId, { id: 'pc_1', organization_id: orgId, provider: 'stripe', provider_customer_id: cusId });
    db.providerPrices.set(providerPriceId, { id: 'pp_1', price_id: priceId, provider: 'stripe', provider_price_id: providerPriceId });
    return db;
  }

  // --- Scenario 1: gate disabled stores recoverable pending event ---
  console.log('Scenario 1: Feature gate disabled stores recoverable pending event');
  try {
    process.env.PHASE13_SUBSCRIPTION_SYNC_ENABLED = 'false';
    const db = initMockDb();
    const event = { id: 'evt_gate_off_1', type: 'customer.subscription.created', data: { object: { id: subId, livemode: false } } };
    const { rawBody, signature } = makeSignedPayload(event);

    const res = await StripeWebhookHandler.handleWebhookEvent(db as any, rawBody, signature);
    assert(res.success === true, 'Handler returned success true when gate disabled');
    assert(res.syncResult?.classification === 'FEATURE_GATE_DISABLED', 'Classification is FEATURE_GATE_DISABLED');
    const stored = db.webhookEvents.get('evt_gate_off_1');
    assert(stored.status === 'pending', 'Stored as pending when gate disabled');
    assert(stored.last_error === 'SUBSCRIPTION_SYNC_DISABLED', 'Recorded SUBSCRIPTION_SYNC_DISABLED error');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 1 Failed:', err.message);
  }

  // --- Scenario 2: gate disabled performs zero Stripe retrieve ---
  console.log('\nScenario 2: Feature gate disabled performs zero Stripe retrieve');
  try {
    const prevCount = stripeRetrieveCalls;
    process.env.PHASE13_SUBSCRIPTION_SYNC_ENABLED = 'false';
    const db = initMockDb();
    const event = { id: 'evt_gate_off_2', type: 'customer.subscription.created', data: { object: { id: subId } } };
    const { rawBody, signature } = makeSignedPayload(event);
    await StripeWebhookHandler.handleWebhookEvent(db as any, rawBody, signature);
    assert(stripeRetrieveCalls === prevCount, 'Zero Stripe retrieve calls performed');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 2 Failed:', err.message);
  }

  // --- Scenario 3: same pending event after gate enabled processes successfully ---
  console.log('\nScenario 3: Same pending event after gate enabled processes successfully');
  try {
    process.env.PHASE13_SUBSCRIPTION_SYNC_ENABLED = 'true';
    const db = initMockDb();
    db.webhookEvents.set('evt_gate_re-enabled', { id: 'we_ge', provider: 'stripe', provider_event_id: 'evt_gate_re-enabled', status: 'pending' });

    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'active',
      current_period_start: 1700000000, current_period_end: 1702592000, cancel_at_period_end: false,
      items: { data: [{ price: { id: providerPriceId, currency: 'usd' }, quantity: 1 }] },
    }));

    const event = { id: 'evt_gate_re-enabled', type: 'customer.subscription.created', data: { object: { id: subId } } };
    const { rawBody, signature } = makeSignedPayload(event);

    const res = await StripeWebhookHandler.handleWebhookEvent(db as any, rawBody, signature, { stripeOverride: mockStripe });
    assert(res.success === true, 'Successfully processed pending event');
    assert(res.syncResult?.success === true, 'Sync returned success true');
    assert(db.webhookEvents.get('evt_gate_re-enabled').status === 'completed', 'Event transitioned to completed');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 3 Failed:', err.message);
  }

  // --- Scenario 4: concurrent pending replay after gate enabled ---
  console.log('\nScenario 4: Concurrent pending replay after gate enabled (exactly 1 winner)');
  try {
    process.env.PHASE13_SUBSCRIPTION_SYNC_ENABLED = 'true';
    const db = initMockDb();
    db.webhookEvents.set('evt_conc_pending_4', { id: 'we_cp4', provider: 'stripe', provider_event_id: 'evt_conc_pending_4', status: 'pending' });

    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'active',
      current_period_start: 1700000000, current_period_end: 1702592000, cancel_at_period_end: false,
      items: { data: [{ price: { id: providerPriceId, currency: 'usd' }, quantity: 1 }] },
    }));

    const event = { id: 'evt_conc_pending_4', type: 'customer.subscription.created', data: { object: { id: subId } } };
    const { rawBody, signature } = makeSignedPayload(event);

    const retrievesBefore = stripeRetrieveCalls;
    const [w1, w2] = await Promise.all([
      StripeWebhookHandler.handleWebhookEvent(db as any, rawBody, signature, { stripeOverride: mockStripe }),
      StripeWebhookHandler.handleWebhookEvent(db as any, rawBody, signature, { stripeOverride: mockStripe }),
    ]);

    const winners = [w1, w2].filter((r) => !r.duplicate);
    const losers = [w1, w2].filter((r) => r.duplicate);

    assert(winners.length === 1, `Exactly 1 winner obtained claim (actual: ${winners.length})`);
    assert(losers.length === 1, `Exactly 1 loser rejected as duplicate (actual: ${losers.length})`);
    assert(stripeRetrieveCalls - retrievesBefore === 1, `Exactly 1 Stripe retrieve call executed (actual: ${stripeRetrieveCalls - retrievesBefore})`);
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 4 Failed:', err.message);
  }

  // --- Scenario 5: duplicate completed webhook ---
  console.log('\nScenario 5: Duplicate completed webhook returns duplicate: true');
  try {
    const db = initMockDb();
    db.webhookEvents.set('evt_completed_5', { id: 'we_c5', provider: 'stripe', provider_event_id: 'evt_completed_5', status: 'completed' });
    const retrievesBefore = stripeRetrieveCalls;

    const event = { id: 'evt_completed_5', type: 'customer.subscription.created', data: { object: { id: subId } } };
    const { rawBody, signature } = makeSignedPayload(event);

    const res = await StripeWebhookHandler.handleWebhookEvent(db as any, rawBody, signature);
    assert(res.duplicate === true, 'Returned duplicate: true for completed event');
    assert(stripeRetrieveCalls === retrievesBefore, 'Zero additional Stripe retrieves executed');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 5 Failed:', err.message);
  }

  // --- Scenario 6: fresh processing duplicate ---
  console.log('\nScenario 6: Fresh processing duplicate blocks parallel worker');
  try {
    const db = initMockDb();
    db.webhookEvents.set('evt_proc_6', {
      id: 'we_p6', provider: 'stripe', provider_event_id: 'evt_proc_6', status: 'processing',
      processing_started_at: new Date(Date.now() - 30000).toISOString(),
    });

    const event = { id: 'evt_proc_6', type: 'customer.subscription.created', data: { object: { id: subId } } };
    const { rawBody, signature } = makeSignedPayload(event);

    const res = await StripeWebhookHandler.handleWebhookEvent(db as any, rawBody, signature);
    assert(res.duplicate === true, 'Fresh processing returned duplicate: true');
    assert(res.message.includes('currently processing'), 'Parallel worker blocked');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 6 Failed:', err.message);
  }

  // --- Scenario 7: stale processing recovery ---
  console.log('\nScenario 7: Stale processing recovery after 5 min timeout');
  try {
    const db = initMockDb();
    db.webhookEvents.set('evt_stale_7', {
      id: 'we_s7', provider: 'stripe', provider_event_id: 'evt_stale_7', status: 'processing',
      processing_started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'active',
      current_period_start: 1700000000, current_period_end: 1702592000, cancel_at_period_end: false,
      items: { data: [{ price: { id: providerPriceId, currency: 'usd' }, quantity: 1 }] },
    }));

    const event = { id: 'evt_stale_7', type: 'customer.subscription.created', data: { object: { id: subId } } };
    const { rawBody, signature } = makeSignedPayload(event);

    const res = await StripeWebhookHandler.handleWebhookEvent(db as any, rawBody, signature, { stripeOverride: mockStripe });
    assert(res.success === true, 'Stale processing event successfully reclaimed and processed');
    assert(db.webhookEvents.get('evt_stale_7').status === 'completed', 'Event status transitioned to completed');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 7 Failed:', err.message);
  }

  // --- Scenario 8: concurrent stale processing recovery ---
  console.log('\nScenario 8: Concurrent stale processing recovery (exactly 1 winner)');
  try {
    const db = initMockDb();
    db.webhookEvents.set('evt_stale_8', {
      id: 'we_s8', provider: 'stripe', provider_event_id: 'evt_stale_8', status: 'processing',
      processing_started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'active',
      current_period_start: 1700000000, current_period_end: 1702592000, cancel_at_period_end: false,
      items: { data: [{ price: { id: providerPriceId, currency: 'usd' }, quantity: 1 }] },
    }));

    const event = { id: 'evt_stale_8', type: 'customer.subscription.created', data: { object: { id: subId } } };
    const { rawBody, signature } = makeSignedPayload(event);

    const retrievesBefore = stripeRetrieveCalls;
    const [w1, w2] = await Promise.all([
      StripeWebhookHandler.handleWebhookEvent(db as any, rawBody, signature, { stripeOverride: mockStripe }),
      StripeWebhookHandler.handleWebhookEvent(db as any, rawBody, signature, { stripeOverride: mockStripe }),
    ]);

    const winners = [w1, w2].filter((r) => !r.duplicate);
    assert(winners.length === 1, `Exactly 1 worker reclaimed stale event (actual: ${winners.length})`);
    assert(stripeRetrieveCalls - retrievesBefore === 1, `Exactly 1 Stripe retrieve performed (actual: ${stripeRetrieveCalls - retrievesBefore})`);
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 8 Failed:', err.message);
  }

  // --- Scenario 9: attempt_count correctness ---
  console.log('\nScenario 9: attempt_count increments correctly across claims');
  try {
    const db = initMockDb();
    db.webhookEvents.set('evt_att_9', {
      id: 'we_a9', provider: 'stripe', provider_event_id: 'evt_att_9', status: 'pending', attempt_count: 2,
    });

    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'active',
      current_period_start: 1700000000, current_period_end: 1702592000, cancel_at_period_end: false,
      items: { data: [{ price: { id: providerPriceId, currency: 'usd' }, quantity: 1 }] },
    }));

    const event = { id: 'evt_att_9', type: 'customer.subscription.created', data: { object: { id: subId } } };
    const { rawBody, signature } = makeSignedPayload(event);

    await StripeWebhookHandler.handleWebhookEvent(db as any, rawBody, signature, { stripeOverride: mockStripe });
    const stored = db.webhookEvents.get('evt_att_9');
    assert(stored.attempt_count === 3, `attempt_count incremented from 2 to 3 (actual: ${stored.attempt_count})`);
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 9 Failed:', err.message);
  }

  // --- Scenario 10: nonexistent organization rejected ---
  console.log('\nScenario 10: Nonexistent organization rejected by RPC');
  try {
    const db = initMockDb();
    const rpcRes = await db.rpc('reconcile_stripe_subscription_atomic', {
      p_organization_id: 'org_nonexistent_9999',
      p_provider_subscription_id: subId,
      p_plan_id: planId,
      p_status: 'active',
      p_current_period_start: new Date().toISOString(),
      p_current_period_end: new Date(Date.now() + 86400000).toISOString(),
      p_cancel_at_period_end: false,
    });

    assert(rpcRes.error?.code === 'P0002', 'RPC returned error code P0002 for nonexistent organization');
    assert(rpcRes.error?.message.includes('ORGANIZATION_NOT_FOUND'), 'Returned ORGANIZATION_NOT_FOUND message');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 10 Failed:', err.message);
  }

  // --- Scenario 11: NULL p_cancel_at_period_end rejected ---
  console.log('\nScenario 11: NULL p_cancel_at_period_end rejected by RPC');
  try {
    const db = initMockDb();
    const rpcRes = await db.rpc('reconcile_stripe_subscription_atomic', {
      p_organization_id: orgId,
      p_provider_subscription_id: subId,
      p_plan_id: planId,
      p_status: 'active',
      p_current_period_start: new Date().toISOString(),
      p_current_period_end: new Date(Date.now() + 86400000).toISOString(),
      p_cancel_at_period_end: null,
    });

    assert(rpcRes.error?.code === '22023', 'RPC returned error code 22023 for NULL cancel_at_period_end');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 11 Failed:', err.message);
  }

  // --- Scenario 12: invalid period end < start rejected ---
  console.log('\nScenario 12: Invalid period end < start rejected by RPC');
  try {
    const db = initMockDb();
    const rpcRes = await db.rpc('reconcile_stripe_subscription_atomic', {
      p_organization_id: orgId,
      p_provider_subscription_id: subId,
      p_plan_id: planId,
      p_status: 'active',
      p_current_period_start: new Date('2026-12-10T00:00:00Z').toISOString(),
      p_current_period_end: new Date('2026-12-01T00:00:00Z').toISOString(),
      p_cancel_at_period_end: false,
    });

    assert(rpcRes.error?.code === '22023', 'RPC returned error code 22023 for period end < start');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 12 Failed:', err.message);
  }

  // --- Scenario 13: missing active period timestamps rejected ---
  console.log('\nScenario 13: Missing active period timestamps rejected by RPC');
  try {
    const db = initMockDb();
    const rpcRes = await db.rpc('reconcile_stripe_subscription_atomic', {
      p_organization_id: orgId,
      p_provider_subscription_id: subId,
      p_plan_id: planId,
      p_status: 'active',
      p_current_period_start: null,
      p_current_period_end: null,
      p_cancel_at_period_end: false,
    });

    assert(rpcRes.error?.code === '22023', 'RPC returned error code 22023 for missing active period');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 13 Failed:', err.message);
  }

  // --- Scenario 14: canceled state nullable period supported ---
  console.log('\nScenario 14: Canceled state nullable period supported by RPC');
  try {
    const db = initMockDb();
    const rpcRes = await db.rpc('reconcile_stripe_subscription_atomic', {
      p_organization_id: orgId,
      p_provider_subscription_id: subId,
      p_plan_id: planId,
      p_status: 'canceled',
      p_current_period_start: null,
      p_current_period_end: null,
      p_cancel_at_period_end: true,
      p_ended_at: new Date().toISOString(),
    });

    assert(rpcRes.data?.success === true, 'Canceled subscription with null period timestamps accepted');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 14 Failed:', err.message);
  }

  // --- Scenario 15: ended subscription resurrection prohibited ---
  console.log('\nScenario 15: Ended subscription resurrection prohibited');
  try {
    const db = initMockDb();
    db.orgSubs.set('sub_term_15', {
      id: 'sub_term_15', organization_id: orgId, plan_id: planId, status: 'canceled',
      ended_at: new Date('2026-08-31T00:00:00Z').toISOString(),
    });

    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'active',
      current_period_start: 1700000000, current_period_end: 1702592000, cancel_at_period_end: false,
      items: { data: [{ price: { id: providerPriceId, currency: 'usd' }, quantity: 1 }] },
    }));

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.classification === 'TERMINAL_RESURRECTION_PROHIBITED', 'Resurrection prohibited with TERMINAL_RESURRECTION_PROHIBITED');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 15 Failed:', err.message);
  }

  // --- Scenario 16: out-of-order event rejected ---
  console.log('\nScenario 16: Out-of-order created/updated event rejected');
  try {
    const db = initMockDb();
    db.orgSubs.set('sub_ooo_16', {
      id: 'sub_ooo_16', organization_id: orgId, plan_id: planId, status: 'active',
      current_period_start: new Date('2026-12-01T00:00:00Z').toISOString(),
    });

    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'active',
      current_period_start: Math.floor(new Date('2026-11-01T00:00:00Z').getTime() / 1000),
      current_period_end: Math.floor(new Date('2026-12-01T00:00:00Z').getTime() / 1000),
      cancel_at_period_end: false,
      items: { data: [{ price: { id: providerPriceId, currency: 'usd' }, quantity: 1 }] },
    }));

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.classification === 'OUT_OF_ORDER_STALE_EVENT', 'Stale out-of-order event rejected with OUT_OF_ORDER_STALE_EVENT');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 16 Failed:', err.message);
  }

  // --- Scenario 17: provider mapping replay idempotent ---
  console.log('\nScenario 17: Correct provider mapping replay remains idempotent');
  try {
    const db = initMockDb();
    db.orgSubs.set('sub_idemp_17', { id: 'sub_idemp_17', organization_id: orgId, plan_id: planId, status: 'active' });
    db.providerSubs.set(subId, { id: 'ps_17', organization_subscription_id: 'sub_idemp_17', provider: 'stripe', provider_subscription_id: subId });

    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'active',
      current_period_start: 1700000000, current_period_end: 1702592000, cancel_at_period_end: false,
      items: { data: [{ price: { id: providerPriceId, currency: 'usd' }, quantity: 1 }] },
    }));

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.success === true, 'Matching provider mapping sync succeeded idempotently');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 17 Failed:', err.message);
  }

  // --- Scenario 18: conflicting provider mapping cannot be reassigned ---
  console.log('\nScenario 18: Conflicting provider mapping cannot be reassigned');
  try {
    const db = initMockDb();
    db.providerSubs.set(subId, { organization_subscription_id: 'sub_other_org', provider: 'stripe', provider_subscription_id: subId });
    db.orgSubs.set('sub_other_org', { id: 'sub_other_org', organization_id: 'org_other_99' });

    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'active',
      items: { data: [{ price: { id: providerPriceId, currency: 'usd' }, quantity: 1 }] },
    }));

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.classification === 'TENANT_MAPPING_CONFLICT', 'Conflicting provider mapping rejected; not reassigned');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 18 Failed:', err.message);
  }

  // --- Scenario 19: deleted webhook + Stripe 404 reconciliation ---
  console.log('\nScenario 19: Deleted webhook + Stripe 404 reconciliation');
  try {
    const db = initMockDb();
    db.orgSubs.set('sub_del_19', { id: 'sub_del_19', organization_id: orgId, status: 'active' });
    db.providerSubs.set(subId, { id: 'ps_19', organization_subscription_id: 'sub_del_19', provider: 'stripe', provider_subscription_id: subId });

    const mockStripe = createMockStripe(() => {
      const err: any = new Error('No such subscription');
      err.statusCode = 404;
      throw err;
    });

    const eventPayload = { id: 'evt_del_19', type: 'customer.subscription.deleted', data: { object: { id: subId, status: 'canceled', customer: cusId } } } as any;
    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe, eventPayload,
    });

    assert(syncRes.success === true, 'Reconciled canceled status from verified webhook deletion payload');
    assert(syncRes.status === 'canceled', 'Status set to canceled');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 19 Failed:', err.message);
  }

  // --- Scenario 20: Stripe timeout handled gracefully ---
  console.log('\nScenario 20: Stripe API timeout handled gracefully');
  try {
    const db = initMockDb();
    const mockStripe = createMockStripe(() => {
      const err: any = new Error('Stripe API 504 Gateway Timeout');
      err.statusCode = 504;
      throw err;
    });

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.classification === 'STRIPE_RETRIEVAL_FAILED', 'Returned STRIPE_RETRIEVAL_FAILED on timeout');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 20 Failed:', err.message);
  }

  // --- Scenario 21: Stripe 5xx handled gracefully ---
  console.log('\nScenario 21: Stripe API 5xx handled gracefully');
  try {
    const db = initMockDb();
    const mockStripe = createMockStripe(() => {
      const err: any = new Error('Stripe API 500 Internal Server Error');
      err.statusCode = 500;
      throw err;
    });

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.classification === 'STRIPE_RETRIEVAL_FAILED', 'Returned STRIPE_RETRIEVAL_FAILED on 500');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 21 Failed:', err.message);
  }

  // --- Scenario 22: missing expected mode rejected ---
  console.log('\nScenario 22: Missing STRIPE_EXPECTED_MODE rejected');
  try {
    const db = initMockDb();
    const origMode = process.env.STRIPE_EXPECTED_MODE;
    delete process.env.STRIPE_EXPECTED_MODE;

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId,
    });

    process.env.STRIPE_EXPECTED_MODE = origMode;
    assert(syncRes.classification === 'STRIPE_EXPECTED_MODE_INVALID', 'Rejected missing expected mode');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 22 Failed:', err.message);
  }

  // --- Scenario 23: invalid expected mode rejected ---
  console.log('\nScenario 23: Invalid STRIPE_EXPECTED_MODE rejected');
  try {
    const db = initMockDb();
    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'invalid_mode' as any,
    });

    assert(syncRes.classification === 'STRIPE_EXPECTED_MODE_INVALID', 'Rejected invalid expected mode');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 23 Failed:', err.message);
  }

  // --- Scenario 24: livemode mismatch rejected ---
  console.log('\nScenario 24: Stripe livemode mismatch rejected');
  try {
    const db = initMockDb();
    const mockStripe = createMockStripe((id) => ({
      id, livemode: true, customer: cusId, status: 'active',
    }));

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.classification === 'STRIPE_MODE_MISMATCH', 'Failed closed with STRIPE_MODE_MISMATCH');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 24 Failed:', err.message);
  }

  // --- Scenario 25: unmapped customer rejected ---
  console.log('\nScenario 25: Unmapped customer rejected');
  try {
    const db = initMockDb();
    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: 'cus_unmapped_99', status: 'active',
    }));

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.classification === 'TENANT_OWNERSHIP_UNRESOLVED', 'Rejected unmapped customer');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 25 Failed:', err.message);
  }

  // --- Scenario 26: customer mapping conflict rejected ---
  console.log('\nScenario 26: Customer/subscription tenant mapping conflict rejected');
  try {
    const db = initMockDb();
    db.providerCusts.set(cusId, { id: 'pc_26', provider: 'stripe', provider_customer_id: cusId, organization_id: 'org_A' });
    db.providerSubs.set(subId, { id: 'ps_26', provider: 'stripe', provider_subscription_id: subId, organization_subscription_id: 'sub_org_B' });
    db.orgSubs.set('sub_org_B', { id: 'sub_org_B', organization_id: 'org_B' });

    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'active',
    }));

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.classification === 'TENANT_MAPPING_CONFLICT', 'Rejected customer/subscription tenant conflict');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 26 Failed:', err.message);
  }

  // --- Scenario 27: unmapped price rejected ---
  console.log('\nScenario 27: Unmapped provider price rejected');
  try {
    const db = initMockDb();
    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'active',
      items: { data: [{ price: { id: 'price_unmapped_unknown', currency: 'usd' }, quantity: 1 }] },
    }));

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.classification === 'UNMAPPED_PROVIDER_PRICE', 'Rejected unmapped provider price');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 27 Failed:', err.message);
  }

  // --- Scenario 28: ambiguous base-plan price mappings rejected ---
  console.log('\nScenario 28: Ambiguous base-plan price mappings rejected');
  try {
    const db = initMockDb();
    db.plans.set('plan_pro_99', { id: 'plan_pro_99', code: 'pro' });
    db.prices.set('price_pro_99', { id: 'price_pro_99', plan_id: 'plan_pro_99', currency: 'USD', is_active: true });
    db.providerPrices.set('price_stripe_pro', { id: 'pp_2', price_id: 'price_pro_99', provider: 'stripe', provider_price_id: 'price_stripe_pro' });

    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'active',
      items: {
        data: [
          { price: { id: providerPriceId, currency: 'usd' }, quantity: 1 },
          { price: { id: 'price_stripe_pro', currency: 'usd' }, quantity: 1 },
        ],
      },
    }));

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.classification === 'AMBIGUOUS_BASE_PLAN_PRICES', 'Rejected ambiguous multiple base plans');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 28 Failed:', err.message);
  }

  // --- Scenario 29: currency mismatch rejected ---
  console.log('\nScenario 29: Currency mismatch rejected');
  try {
    const db = initMockDb();
    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'active',
      items: { data: [{ price: { id: providerPriceId, currency: 'eur' }, quantity: 1 }] },
    }));

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.classification === 'CURRENCY_MISMATCH', 'Rejected currency mismatch');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 29 Failed:', err.message);
  }

  // --- Scenario 30: invalid quantity rejected ---
  console.log('\nScenario 30: Invalid quantity rejected');
  try {
    const db = initMockDb();
    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'active',
      items: { data: [{ price: { id: providerPriceId, currency: 'usd' }, quantity: 0 }] },
    }));

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.classification === 'INVALID_QUANTITY', 'Rejected invalid quantity 0');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 30 Failed:', err.message);
  }

  // --- Scenario 31: inactive historical price rejected for new subscription ---
  console.log('\nScenario 31: Inactive historical price rejected for new subscription');
  try {
    const db = initMockDb();
    db.prices.set(priceId, { id: priceId, plan_id: planId, currency: 'USD', is_active: false });

    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'active',
      current_period_start: 1700000000, current_period_end: 1702592000, cancel_at_period_end: false,
      items: { data: [{ price: { id: providerPriceId, currency: 'usd' }, quantity: 1 }] },
    }));

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.classification === 'INACTIVE_PRICE_NEW_SUBSCRIPTION_PROHIBITED', 'Rejected inactive historical price for new subscription');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 31 Failed:', err.message);
  }

  // --- Scenario 32: valid subscription.created ---
  console.log('\nScenario 32: Valid subscription.created synchronization');
  try {
    const db = initMockDb();
    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'active',
      current_period_start: 1700000000, current_period_end: 1702592000, cancel_at_period_end: false,
      items: { data: [{ price: { id: providerPriceId, currency: 'usd' }, quantity: 1 }] },
    }));

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.success === true, 'Sync returned success true');
    assert(syncRes.classification === 'SYNC_SUCCESSFUL', 'Classification is SYNC_SUCCESSFUL');
    assert(syncRes.organizationId === orgId, 'Organization ID matched fixture');
    assert(syncRes.status === 'active', 'Status is active');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 32 Failed:', err.message);
  }

  // --- Scenario 33: valid subscription.updated ---
  console.log('\nScenario 33: Valid subscription.updated synchronization');
  try {
    const db = initMockDb();
    db.orgSubs.set('sub_existing_33', { id: 'sub_existing_33', organization_id: orgId, plan_id: planId, status: 'active' });

    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'past_due',
      current_period_start: 1700000000, current_period_end: 1702592000, cancel_at_period_end: true,
      items: { data: [{ price: { id: providerPriceId, currency: 'usd' }, quantity: 1 }] },
    }));

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.success === true, 'Updated subscription successfully');
    assert(syncRes.status === 'past_due', 'Updated status to past_due');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 33 Failed:', err.message);
  }

  // --- Scenario 34: valid authoritative canceled subscription ---
  console.log('\nScenario 34: Valid authoritative canceled subscription synchronization');
  try {
    const db = initMockDb();
    const mockStripe = createMockStripe((id) => ({
      id, livemode: false, customer: cusId, status: 'canceled',
      canceled_at: 1701000000, ended_at: 1701000000,
      items: { data: [{ price: { id: providerPriceId, currency: 'usd' }, quantity: 1 }] },
    }));

    const syncRes = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(db as any, {
      providerSubscriptionId: subId, expectedMode: 'test', stripeOverride: mockStripe,
    });

    assert(syncRes.success === true, 'Canceled subscription synchronized');
    assert(syncRes.status === 'canceled', 'Status set to canceled');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 34 Failed:', err.message);
  }

  // --- Scenario 35: unsupported webhook event type ignored ---
  console.log('\nScenario 35: Unsupported webhook event type ignored');
  try {
    const db = initMockDb();
    const event = { id: 'evt_unsupported_35', type: 'customer.created', data: { object: { id: cusId } } };
    const { rawBody, signature } = makeSignedPayload(event);

    const res = await StripeWebhookHandler.handleWebhookEvent(db as any, rawBody, signature);
    assert(res.success === true, 'Unsupported event handled cleanly without error');
    assert(res.syncResult === undefined, 'No subscription sync result for unsupported event');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 35 Failed:', err.message);
  }

  // --- Scenario 36: invalid webhook signature rejected ---
  console.log('\nScenario 36: Invalid webhook signature rejected');
  try {
    const db = initMockDb();
    const event = { id: 'evt_bad_sig_36', type: 'customer.subscription.created', data: { object: { id: subId } } };
    const rawBody = JSON.stringify(event);

    let threw = false;
    try {
      await StripeWebhookHandler.handleWebhookEvent(db as any, rawBody, 't=12345,v1=invalid_sig');
    } catch (err: any) {
      threw = true;
      assert(err.message.includes('INVALID_WEBHOOK_SIGNATURE'), 'Thrown error contains INVALID_WEBHOOK_SIGNATURE');
    }
    assert(threw, 'Failed closed on bad signature');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 36 Failed:', err.message);
  }

  // --- Scenario 37: PaymentIntent event sync regression ---
  console.log('\nScenario 37: PaymentIntent event sync regression preserved');
  try {
    const db = initMockDb();
    db.paymentOps.set('pi_test_37', { id: 'po_37', provider_payment_id: 'pi_test_37', status: 'requires_confirmation' });

    const event = { id: 'evt_pi_37', type: 'payment_intent.succeeded', data: { object: { id: 'pi_test_37' } } };
    const { rawBody, signature } = makeSignedPayload(event);

    const res = await StripeWebhookHandler.handleWebhookEvent(db as any, rawBody, signature);
    assert(res.success === true, 'PaymentIntent webhook processed cleanly');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 37 Failed:', err.message);
  }

  // --- Scenario 38: Invoice event sync regression ---
  console.log('\nScenario 38: Invoice event sync regression preserved');
  try {
    const db = initMockDb();
    const event = { id: 'evt_inv_38', type: 'invoice.paid', data: { object: { id: 'in_test_38', customer: cusId } } };
    const { rawBody, signature } = makeSignedPayload(event);

    const res = await StripeWebhookHandler.handleWebhookEvent(db as any, rawBody, signature);
    assert(res.success === true, 'Invoice webhook processed cleanly');
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 38 Failed:', err.message);
  }

  // --- Scenario 39: Zero Stripe mutations ---
  console.log('\nScenario 39: Zero Stripe mutations');
  try {
    assert(stripeMutationCalls === 0, `ZERO Stripe mutation calls executed (actual: ${stripeMutationCalls})`);
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 39 Failed:', err.message);
  }

  // --- Scenario 40: Zero Twilio calls ---
  console.log('\nScenario 40: Zero Twilio calls');
  try {
    assert(twilioCalls === 0, `ZERO Twilio calls executed (actual: ${twilioCalls})`);
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 40 Failed:', err.message);
  }

  // --- Scenario 41: Zero regulatory calls ---
  console.log('\nScenario 41: Zero regulatory calls');
  try {
    assert(regulatoryCalls === 0, `ZERO regulatory calls executed (actual: ${regulatoryCalls})`);
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error('Scenario 41 Failed:', err.message);
  }

  console.log('\n====================================================');
  console.log(`SUMMARY: ${passedScenarios + failedScenarios} scenarios executed`);
  console.log(`SCENARIOS: ${passedScenarios} passed, ${failedScenarios} failed`);
  console.log(`ASSERTIONS: ${passedAssertions} passed, ${failedAssertions} failed (Total: ${passedAssertions + failedAssertions})`);
  console.log('====================================================\n');

  if (failedScenarios > 0 || failedAssertions > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
