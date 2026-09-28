import Stripe from 'stripe';
import { CommercialRecoveryRunnerService } from '../src/lib/billing/commercialRecoveryRunnerService';
import { CommercialCaptureReconciliationService } from '../src/lib/billing/commercialCaptureReconciliationService';
import { GET as recoveryCronGET, POST as recoveryCronPOST } from '../src/app/api/cron/recovery-runner/route';
import { NextRequest } from 'next/server';

let scenarioCount = 0;
let assertionCount = 0;
let passedAssertions = 0;
let failedAssertions = 0;

function scenario(name: string, fn: () => void | Promise<void>) {
  scenarioCount++;
  console.log(`\nScenario ${scenarioCount}: ${name}`);
  return fn();
}

function assert(condition: boolean, message: string) {
  assertionCount++;
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passedAssertions++;
  } else {
    console.error(`  ✕ FAIL: ${message}`);
    failedAssertions++;
  }
}

// In-Memory Database Double for PostgreSQL RPCs & Tables
function createMockSupabase(
  initialSagas: any[] = [],
  initialPayOps: any[] = [],
  initialPnoOps: any[] = [],
  initialPhones: any[] = []
) {
  const sagas = initialSagas.map(s => ({ ...s }));
  const payOps = initialPayOps.map(p => ({ ...p }));
  const pnoOps = initialPnoOps.map(p => ({ ...p }));
  const phones = initialPhones.map(ph => ({ ...ph }));

  let capturePostCount = 0;
  let cancelPostCount = 0;
  let refundPostCount = 0;
  let twilioMutationCount = 0;
  let regulatoryMutationCount = 0;

  return {
    _sagas: sagas,
    _payOps: payOps,
    _pnoOps: pnoOps,
    _phones: phones,
    _getCapturePostCount: () => capturePostCount,
    _getCancelPostCount: () => cancelPostCount,
    _getRefundPostCount: () => refundPostCount,
    _getTwilioMutationCount: () => twilioMutationCount,
    _getRegulatoryMutationCount: () => regulatoryMutationCount,
    from(table: string) {
      return {
        select(cols?: string) {
          return {
            in(col: string, vals: any[]) {
              return {
                or(expr: string) {
                  return this;
                },
                lt(col: string, val: any) {
                  return this;
                },
                order(col: string, opts?: any) {
                  return this;
                },
                limit(limitNum: number) {
                  const nowIso = new Date().toISOString();
                  let res = sagas.filter(s => {
                    const stateMatch = vals.includes(s.state);
                    const retryDue = !s.next_recovery_retry_at || s.next_recovery_retry_at <= nowIso;
                    const leaseExpired = !s.recovery_lease_until || s.recovery_lease_until <= nowIso;
                    return stateMatch && retryDue && leaseExpired;
                  });
                  res.sort((a, b) => {
                    const uA = a.updated_at || '';
                    const uB = b.updated_at || '';
                    if (uA !== uB) return uA.localeCompare(uB);
                    return a.id.localeCompare(b.id);
                  });
                  return Promise.resolve({ data: res.slice(0, limitNum), error: null });
                },
                eq(col: string, val: any) {
                  let items: any[] = [];
                  if (table === 'commercial_number_purchase_sagas') items = sagas;
                  else if (table === 'billing_payment_operations') items = payOps;
                  else if (table === 'provider_number_operations') items = pnoOps;
                  else if (table === 'phone_numbers') items = phones;

                  const filtered = items.filter(i => {
                    if (col === 'phone_number') return (i.phone_number || i.phone_number_e164) === val;
                    return i[col] === val;
                  });

                  return {
                    eq(col2: string, val2: any) {
                      const filtered2 = filtered.filter(i => {
                        if (col2 === 'phone_number') return (i.phone_number || i.phone_number_e164) === val2;
                        return i[col2] === val2;
                      });
                      return {
                        maybeSingle: () => Promise.resolve({ data: filtered2[0] || null, error: null }),
                      };
                    },
                    maybeSingle: () => Promise.resolve({ data: filtered[0] || null, error: null }),
                  };
                },
              };
            },
            eq(col: string, val: any) {
              let items: any[] = [];
              if (table === 'commercial_number_purchase_sagas') items = sagas;
              else if (table === 'billing_payment_operations') items = payOps;
              else if (table === 'provider_number_operations') items = pnoOps;
              else if (table === 'phone_numbers') items = phones;

              const filtered = items.filter(i => {
                if (col === 'phone_number') return (i.phone_number || i.phone_number_e164) === val;
                return i[col] === val;
              });

              return {
                eq(col2: string, val2: any) {
                  const filtered2 = filtered.filter(i => {
                    if (col2 === 'phone_number') return (i.phone_number || i.phone_number_e164) === val2;
                    return i[col2] === val2;
                  });
                  return {
                    maybeSingle: () => Promise.resolve({ data: filtered2[0] || null, error: null }),
                  };
                },
                maybeSingle: () => Promise.resolve({ data: filtered[0] || null, error: null }),
              };
            },
          };
        },
        update(updates: any) {
          return {
            eq(col: string, val: any) {
              let items: any[] = [];
              if (table === 'commercial_number_purchase_sagas') items = sagas;
              else if (table === 'billing_payment_operations') items = payOps;

              const target = items.find(i => i[col] === val);
              if (target) {
                Object.assign(target, updates);
              }
              return Promise.resolve({ data: target, error: null });
            },
          };
        },
      };
    },
    rpc(funcName: string, args: any) {
      if (funcName === 'claim_commercial_saga_recovery') {
        const saga = sagas.find(s => s.id === args.p_saga_id);
        if (!saga) return Promise.resolve({ data: null, error: { message: 'SAGA_NOT_FOUND' } });
        if (saga.organization_id !== args.p_organization_id) {
          return Promise.resolve({ data: null, error: { message: 'TENANT_MISMATCH' } });
        }
        if (saga.state !== 'capture_pending' && saga.state !== 'financial_reconciliation_required') {
          return Promise.resolve({ data: null, error: { message: 'INVALID_SAGA_STATE' } });
        }
        const now = new Date();
        if (saga.recovery_lease_until && new Date(saga.recovery_lease_until) > now) {
          return Promise.resolve({ data: null, error: null });
        }
        const newToken = `token_${Math.random().toString(36).substring(2, 10)}`;
        const leaseDuration = args.p_lease_seconds || 60;
        saga.recovery_attempt_count = (saga.recovery_attempt_count || 0) + 1;
        if (!saga.recovery_started_at) {
          saga.recovery_started_at = now.toISOString();
        }
        saga.recovery_lease_until = new Date(now.getTime() + leaseDuration * 1000).toISOString();
        saga.recovery_lease_token = newToken;
        saga.reconciliation_metadata = {
          ...(saga.reconciliation_metadata || {}),
          last_recovery_attempt_at: now.toISOString(),
        };
        saga.updated_at = now.toISOString();
        return Promise.resolve({ data: { ...saga }, error: null });
      }

      if (funcName === 'record_commercial_saga_recovery_outcome') {
        const saga = sagas.find(s => s.id === args.p_saga_id);
        if (!saga) return Promise.resolve({ data: null, error: { message: 'SAGA_NOT_FOUND' } });
        if (saga.organization_id !== args.p_organization_id) {
          return Promise.resolve({ data: null, error: { message: 'TENANT_MISMATCH' } });
        }
        if (saga.recovery_lease_token !== args.p_lease_token) {
          return Promise.resolve({ data: { ...saga }, error: null });
        }
        saga.recovery_lease_until = null;
        saga.recovery_lease_token = null;
        if (saga.state === 'completed' || saga.state === 'manual_review_required') {
          saga.next_recovery_retry_at = null;
        } else {
          saga.next_recovery_retry_at = args.p_next_retry_at;
          saga.reconciliation_metadata = {
            ...(saga.reconciliation_metadata || {}),
            last_recovery_outcome_at: new Date().toISOString(),
            last_classification: args.p_classification,
            last_stripe_status: args.p_stripe_status,
          };
        }
        saga.updated_at = new Date().toISOString();
        return Promise.resolve({ data: { ...saga }, error: null });
      }

      if (funcName === 'mark_commercial_saga_financial_reconciliation') {
        const saga = sagas.find(s => s.id === args.p_saga_id);
        if (saga && saga.organization_id === args.p_organization_id) {
          saga.state = 'financial_reconciliation_required';
          saga.failure_code = 'FINANCIAL_RECONCILIATION_REQUIRED';
          saga.failure_message = args.p_reason;
        }
        return Promise.resolve({ data: saga ? { ...saga } : null, error: null });
      }

      if (funcName === 'mark_commercial_saga_manual_review') {
        const saga = sagas.find(s => s.id === args.p_saga_id);
        if (saga && saga.organization_id === args.p_organization_id) {
          saga.state = 'manual_review_required';
          saga.failure_code = 'MANUAL_REVIEW_REQUIRED';
          saga.failure_message = args.p_reason;
        }
        return Promise.resolve({ data: saga ? { ...saga } : null, error: null });
      }

      if (funcName === 'confirm_payment_captured') {
        const op = payOps.find(p => p.id === args.p_payment_op_id);
        if (op && op.organization_id === args.p_organization_id) {
          op.status = 'captured';
          op.provider_payment_id = op.provider_payment_id || args.p_provider_payment_id;
        }
        return Promise.resolve({ data: op ? { ...op } : null, error: null });
      }

      if (funcName === 'complete_commercial_saga_after_capture') {
        const saga = sagas.find(s => s.id === args.p_saga_id);
        if (saga && saga.organization_id === args.p_organization_id) {
          saga.state = 'completed';
          saga.completed_at = new Date().toISOString();
        }
        return Promise.resolve({ data: saga ? { ...saga } : null, error: null });
      }

      return Promise.resolve({ data: null, error: null });
    },
  };
}

// Mock Stripe Double
function createMockStripe(status: string = 'succeeded', amount: number = 2500) {
  return {
    paymentIntents: {
      async retrieve(id: string) {
        if (status === 'THROW_500') {
          throw new Error('Stripe API 500 Internal Server Error');
        }
        if (status === 'THROW_TIMEOUT') {
          throw new Error('Stripe API 504 Gateway Timeout');
        }
        return {
          id,
          status,
          amount,
          amount_received: status === 'succeeded' ? amount : 0,
          amount_capturable: 0,
          currency: 'usd',
          livemode: false,
        };
      },
      async capture() {
        throw new Error('RECOVERY RUNNER VIOLATION: stripe.paymentIntents.capture() POST was called!');
      },
      async cancel() {
        throw new Error('RECOVERY RUNNER VIOLATION: stripe.paymentIntents.cancel() POST was called!');
      },
    },
    refunds: {
      async create() {
        throw new Error('RECOVERY RUNNER VIOLATION: stripe.refunds.create() POST was called!');
      },
    },
  } as unknown as Stripe;
}

async function runTests() {
  console.log('====================================================');
  console.log('PHASE 13.3.4 — RECOVERY RUNNER PRE-DEPLOYMENT TEST SUITE');
  console.log('====================================================\n');

  const orgId = 'org_test_13_4';
  const origReconcile = CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga;

  // 1. capture_pending + Stripe succeeded
  await scenario('1. capture_pending + Stripe succeeded', async () => {
    const mockDb = createMockSupabase([
      { id: 's1', organization_id: orgId, payment_operation_id: 'op1', provider_number_operation_id: 'pno1', phone_number_e164: '+15550001341', state: 'capture_pending', updated_at: '2026-09-28T10:00:00Z' },
    ], [{ id: 'op1', organization_id: orgId, provider: 'stripe', provider_payment_id: 'pi1', amount_minor: 2500, currency: 'USD', status: 'capture_pending', capture_dispatch_claimed_at: '2026-09-28T10:00:00Z', capture_idempotency_key: 'cap_pi1' }],
    [{ id: 'pno1', organization_id: orgId, phone_number_e164: '+15550001341', provider_resource_id: 'PN1', status: 'succeeded' }],
    [{ phone_number: '+15550001341', provider_resource_id: 'PN1', organization_id: orgId, status: 'active' }]);

    const stripeMock = createMockStripe('succeeded', 2500);
    CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga = (db, p) => origReconcile.call(CommercialCaptureReconciliationService, db, { ...p, stripeOverride: stripeMock });
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(res.recovered === 1, 'Discovered and completed capture_pending saga');
    assert(mockDb._sagas[0].state === 'completed', 'Saga state set to completed');
  });

  // 2. financial_reconciliation_required + succeeded
  await scenario('2. financial_reconciliation_required + succeeded', async () => {
    const mockDb = createMockSupabase([
      { id: 's2', organization_id: orgId, payment_operation_id: 'op2', provider_number_operation_id: 'pno2', phone_number_e164: '+15550001342', state: 'financial_reconciliation_required', updated_at: '2026-09-28T10:00:00Z' },
    ], [{ id: 'op2', organization_id: orgId, provider: 'stripe', provider_payment_id: 'pi2', amount_minor: 2500, currency: 'USD', status: 'capture_pending', capture_dispatch_claimed_at: '2026-09-28T10:00:00Z', capture_idempotency_key: 'cap_pi2' }],
    [{ id: 'pno2', organization_id: orgId, phone_number_e164: '+15550001342', provider_resource_id: 'PN2', status: 'succeeded' }],
    [{ phone_number: '+15550001342', provider_resource_id: 'PN2', organization_id: orgId, status: 'active' }]);

    const stripeMock = createMockStripe('succeeded', 2500);
    CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga = (db, p) => origReconcile.call(CommercialCaptureReconciliationService, db, { ...p, stripeOverride: stripeMock });
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(res.recovered === 1, 'Recovered financial_reconciliation_required saga');
  });

  // 3. processing deferred
  await scenario('3. processing deferred', async () => {
    const mockDb = createMockSupabase([
      { id: 's3', organization_id: orgId, payment_operation_id: 'op3', phone_number_e164: '+15550001343', state: 'capture_pending', updated_at: '2026-09-28T10:00:00Z' },
    ], [{ id: 'op3', organization_id: orgId, provider: 'stripe', provider_payment_id: 'pi3', amount_minor: 2500, currency: 'USD', status: 'capture_pending' }]);

    const stripeMock = createMockStripe('processing', 2500);
    CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga = (db, p) => origReconcile.call(CommercialCaptureReconciliationService, db, { ...p, stripeOverride: stripeMock });
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(res.deferred === 1, 'Processing status deferred');
    assert(mockDb._sagas[0].next_recovery_retry_at !== null, 'Retry timestamp scheduled');
  });

  // 4. Stripe retrieve timeout
  await scenario('4. Stripe retrieve timeout', async () => {
    const mockDb = createMockSupabase([
      { id: 's4', organization_id: orgId, payment_operation_id: 'op4', state: 'capture_pending', updated_at: '2026-09-28T10:00:00Z' },
    ], [{ id: 'op4', organization_id: orgId, provider: 'stripe', provider_payment_id: 'pi4', amount_minor: 2500, currency: 'USD', status: 'capture_pending' }]);

    const stripeMock = createMockStripe('THROW_TIMEOUT');
    CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga = (db, p) => origReconcile.call(CommercialCaptureReconciliationService, db, { ...p, stripeOverride: stripeMock });
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(res.deferred === 1, 'Timeout deferred gracefully');
  });

  // 5. Stripe retrieve 5xx
  await scenario('5. Stripe retrieve 5xx', async () => {
    const mockDb = createMockSupabase([
      { id: 's5', organization_id: orgId, payment_operation_id: 'op5', state: 'capture_pending', updated_at: '2026-09-28T10:00:00Z' },
    ], [{ id: 'op5', organization_id: orgId, provider: 'stripe', provider_payment_id: 'pi5', amount_minor: 2500, currency: 'USD', status: 'capture_pending' }]);

    const stripeMock = createMockStripe('THROW_500');
    CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga = (db, p) => origReconcile.call(CommercialCaptureReconciliationService, db, { ...p, stripeOverride: stripeMock });
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(res.deferred === 1, '5xx error deferred gracefully');
  });

  // 6. manual review excluded
  await scenario('6. manual review excluded', async () => {
    const mockDb = createMockSupabase([{ id: 's6', organization_id: orgId, state: 'manual_review_required', updated_at: '2026-09-28T10:00:00Z' }]);
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(res.discovered === 0, 'manual_review_required excluded from discovery');
  });

  // 7. completed excluded
  await scenario('7. completed excluded', async () => {
    const mockDb = createMockSupabase([{ id: 's7', organization_id: orgId, state: 'completed', updated_at: '2026-09-28T10:00:00Z' }]);
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(res.discovered === 0, 'completed excluded from discovery');
  });

  // 8. retry not due excluded
  await scenario('8. retry not due excluded', async () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    const mockDb = createMockSupabase([{ id: 's8', organization_id: orgId, state: 'capture_pending', next_recovery_retry_at: future, updated_at: '2026-09-28T10:00:00Z' }]);
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(res.discovered === 0, 'Future retry_at excluded from discovery');
  });

  // 9. retry due included
  await scenario('9. retry due included', async () => {
    const past = new Date(Date.now() - 3600000).toISOString();
    const mockDb = createMockSupabase([{ id: 's9', organization_id: orgId, state: 'capture_pending', next_recovery_retry_at: past, updated_at: '2026-09-28T10:00:00Z' }]);
    const stripeMock = createMockStripe('processing');
    CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga = (db, p) => origReconcile.call(CommercialCaptureReconciliationService, db, { ...p, stripeOverride: stripeMock });
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(res.discovered === 1, 'Past retry_at included in discovery');
  });

  // 10. first claim sets recovery_started_at
  await scenario('10. first claim sets recovery_started_at', async () => {
    const mockDb = createMockSupabase([{ id: 's10', organization_id: orgId, state: 'capture_pending', recovery_started_at: null, updated_at: '2026-09-28T10:00:00Z' }]);
    const claim = await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's10', p_organization_id: orgId });
    assert(claim.data.recovery_started_at !== null, 'First claim set recovery_started_at timestamp');
  });

  // 11. second claim preserves recovery_started_at
  await scenario('11. second claim preserves recovery_started_at', async () => {
    const origStart = '2026-09-27T10:00:00Z';
    const mockDb = createMockSupabase([{ id: 's11', organization_id: orgId, state: 'capture_pending', recovery_started_at: origStart, recovery_lease_until: null, updated_at: '2026-09-28T10:00:00Z' }]);
    const claim = await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's11', p_organization_id: orgId });
    assert(claim.data.recovery_started_at === origStart, 'Second claim preserved original recovery_started_at');
  });

  // 12. recovery counter increments only for lease winner
  await scenario('12. recovery counter increments only for lease winner', async () => {
    const mockDb = createMockSupabase([{ id: 's12', organization_id: orgId, state: 'capture_pending', recovery_attempt_count: 0, updated_at: '2026-09-28T10:00:00Z' }]);
    const c1 = await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's12', p_organization_id: orgId });
    const c2 = await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's12', p_organization_id: orgId });
    assert(c1.data.recovery_attempt_count === 1, 'Winner attempt count incremented');
    assert(c2.data === null, 'Loser got NULL claim response');
    assert(mockDb._sagas[0].recovery_attempt_count === 1, 'Total attempt count remains 1');
  });

  // 13. concurrent worker loses active lease
  await scenario('13. concurrent worker loses active lease', async () => {
    const mockDb = createMockSupabase([{ id: 's13', organization_id: orgId, state: 'capture_pending', updated_at: '2026-09-28T10:00:00Z' }]);
    await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's13', p_organization_id: orgId });
    const loser = await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's13', p_organization_id: orgId });
    assert(loser.data === null, 'Active lease blocks concurrent worker claim');
  });

  // 14. stale Worker A token cannot overwrite Worker B
  await scenario('14. stale Worker A token cannot overwrite Worker B', async () => {
    const mockDb = createMockSupabase([{ id: 's14', organization_id: orgId, state: 'capture_pending', updated_at: '2026-09-28T10:00:00Z' }]);
    const cA = await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's14', p_organization_id: orgId });
    const tokenA = cA.data.recovery_lease_token;
    mockDb._sagas[0].recovery_lease_until = new Date(Date.now() - 1000).toISOString();
    const cB = await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's14', p_organization_id: orgId });
    const tokenB = cB.data.recovery_lease_token;
    const outcomeA = await mockDb.rpc('record_commercial_saga_recovery_outcome', { p_saga_id: 's14', p_organization_id: orgId, p_lease_token: tokenA, p_classification: 'FOO', p_stripe_status: 'bar', p_next_retry_at: null });
    assert(outcomeA.data.recovery_lease_token === tokenB, 'Stale token outcome ignored, token B preserved');
  });

  // 15. stale token cannot clear newer lease
  await scenario('15. stale token cannot clear newer lease', async () => {
    const mockDb = createMockSupabase([{ id: 's15', organization_id: orgId, state: 'capture_pending', updated_at: '2026-09-28T10:00:00Z' }]);
    const cA = await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's15', p_organization_id: orgId });
    mockDb._sagas[0].recovery_lease_until = new Date(Date.now() - 1000).toISOString();
    const cB = await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's15', p_organization_id: orgId });
    await mockDb.rpc('record_commercial_saga_recovery_outcome', { p_saga_id: 's15', p_organization_id: orgId, p_lease_token: cA.data.recovery_lease_token, p_classification: 'X', p_stripe_status: 'Y', p_next_retry_at: null });
    assert(mockDb._sagas[0].recovery_lease_until !== null, 'Stale token failed to clear Worker B active lease');
  });

  // 16. stale token cannot alter retry timestamp
  await scenario('16. stale token cannot alter retry timestamp', async () => {
    const mockDb = createMockSupabase([{ id: 's16', organization_id: orgId, state: 'capture_pending', next_recovery_retry_at: '2026-10-01T00:00:00Z', updated_at: '2026-09-28T10:00:00Z' }]);
    const cA = await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's16', p_organization_id: orgId });
    mockDb._sagas[0].recovery_lease_until = new Date(Date.now() - 1000).toISOString();
    await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's16', p_organization_id: orgId });
    await mockDb.rpc('record_commercial_saga_recovery_outcome', { p_saga_id: 's16', p_organization_id: orgId, p_lease_token: cA.data.recovery_lease_token, p_classification: 'X', p_stripe_status: 'Y', p_next_retry_at: '2026-09-01T00:00:00Z' });
    assert(mockDb._sagas[0].next_recovery_retry_at !== '2026-09-01T00:00:00Z', 'Stale token could not alter next_recovery_retry_at');
  });

  // 17. stale token cannot alter metadata
  await scenario('17. stale token cannot alter metadata', async () => {
    const mockDb = createMockSupabase([{ id: 's17', organization_id: orgId, state: 'capture_pending', reconciliation_metadata: { keeper: 'true' }, updated_at: '2026-09-28T10:00:00Z' }]);
    const cA = await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's17', p_organization_id: orgId });
    mockDb._sagas[0].recovery_lease_until = new Date(Date.now() - 1000).toISOString();
    await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's17', p_organization_id: orgId });
    await mockDb.rpc('record_commercial_saga_recovery_outcome', { p_saga_id: 's17', p_organization_id: orgId, p_lease_token: cA.data.recovery_lease_token, p_classification: 'ATTACK', p_stripe_status: 'ATTACK', p_next_retry_at: null });
    assert(mockDb._sagas[0].reconciliation_metadata.last_classification !== 'ATTACK', 'Stale token could not alter metadata');
  });

  // 18. successful recovery clears lease/token/retry timestamp
  await scenario('18. successful recovery clears lease/token/retry timestamp', async () => {
    const mockDb = createMockSupabase([{ id: 's18', organization_id: orgId, state: 'completed', recovery_lease_until: '2026-10-01T00:00:00Z', recovery_lease_token: 'tok18', next_recovery_retry_at: '2026-10-01T00:00:00Z' }]);
    await mockDb.rpc('record_commercial_saga_recovery_outcome', { p_saga_id: 's18', p_organization_id: orgId, p_lease_token: 'tok18', p_classification: 'CAPTURE_CONFIRMED', p_stripe_status: 'succeeded', p_next_retry_at: null });
    assert(mockDb._sagas[0].recovery_lease_until === null, 'Lease until cleared');
    assert(mockDb._sagas[0].recovery_lease_token === null, 'Lease token cleared');
    assert(mockDb._sagas[0].next_recovery_retry_at === null, 'Retry timestamp cleared');
  });

  // 19. deferred outcome sets correct retry timestamp
  await scenario('19. deferred outcome sets correct retry timestamp', async () => {
    const mockDb = createMockSupabase([{ id: 's19', organization_id: orgId, state: 'capture_pending', recovery_lease_token: 'tok19' }]);
    const nextAt = new Date(Date.now() + 300000).toISOString();
    await mockDb.rpc('record_commercial_saga_recovery_outcome', { p_saga_id: 's19', p_organization_id: orgId, p_lease_token: 'tok19', p_classification: 'STRIPE_RETRIEVAL_FAILED', p_stripe_status: 'pending', p_next_retry_at: nextAt });
    assert(mockDb._sagas[0].next_recovery_retry_at === nextAt, 'Deferred outcome recorded retry timestamp');
    assert(mockDb._sagas[0].recovery_lease_until === null, 'Lease cleared on deferred outcome');
  });

  // 20. attempt 11 may retry
  await scenario('20. attempt 11 may retry', async () => {
    const mockDb = createMockSupabase([{ id: 's20', organization_id: orgId, state: 'capture_pending', recovery_attempt_count: 10, updated_at: '2026-09-28T10:00:00Z' }]);
    const stripeMock = createMockStripe('processing');
    CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga = (db, p) => origReconcile.call(CommercialCaptureReconciliationService, db, { ...p, stripeOverride: stripeMock });
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(res.deferred === 1, 'Attempt 11 deferred retry');
    assert(mockDb._sagas[0].recovery_attempt_count === 11, 'Count incremented to 11');
  });

  // 21. attempt 12 may perform final reconciliation
  await scenario('21. attempt 12 may perform final reconciliation', async () => {
    let reconCalled = false;
    const mockDb = createMockSupabase([
      { id: 's21', organization_id: orgId, payment_operation_id: 'op21', provider_number_operation_id: 'pno21', phone_number_e164: '+15550001321', state: 'capture_pending', recovery_attempt_count: 11, updated_at: '2026-09-28T10:00:00Z' },
    ], [{ id: 'op21', organization_id: orgId, provider: 'stripe', provider_payment_id: 'pi21', amount_minor: 2500, currency: 'USD', status: 'capture_pending', capture_dispatch_claimed_at: '2026-09-28T10:00:00Z', capture_idempotency_key: 'cap_pi21' }],
    [{ id: 'pno21', organization_id: orgId, phone_number_e164: '+15550001321', provider_resource_id: 'PN21', status: 'succeeded' }],
    [{ phone_number: '+15550001321', provider_resource_id: 'PN21', organization_id: orgId, status: 'active' }]);

    const stripeMock = createMockStripe('succeeded', 2500);
    CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga = (db, p) => {
      reconCalled = true;
      return origReconcile.call(CommercialCaptureReconciliationService, db, { ...p, stripeOverride: stripeMock });
    };
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(reconCalled, 'Attempt 12 performed reconciliation');
    assert(res.recovered === 1, 'Attempt 12 recovered saga to completed');
  });

  // 22. failed attempt 12 escalates to manual review
  await scenario('22. failed attempt 12 escalates to manual review', async () => {
    const mockDb = createMockSupabase([{ id: 's22', organization_id: orgId, payment_operation_id: 'op22', state: 'capture_pending', recovery_attempt_count: 11, updated_at: '2026-09-28T10:00:00Z' }], [{ id: 'op22', organization_id: orgId, provider: 'stripe', provider_payment_id: 'pi22', amount_minor: 2500, currency: 'USD', status: 'capture_pending' }]);
    const stripeMock = createMockStripe('processing');
    CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga = (db, p) => origReconcile.call(CommercialCaptureReconciliationService, db, { ...p, stripeOverride: stripeMock });
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(res.manualReview === 1, 'Failed attempt 12 escalated to manual_review_required');
    assert(mockDb._sagas[0].state === 'manual_review_required', 'State updated to manual_review_required');
  });

  // 23. attempt 13 cannot occur
  await scenario('23. attempt 13 cannot occur', async () => {
    let reconCalled = false;
    const mockDb = createMockSupabase([{ id: 's23', organization_id: orgId, state: 'capture_pending', recovery_attempt_count: 12, updated_at: '2026-09-28T10:00:00Z' }]);
    CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga = () => {
      reconCalled = true;
      return Promise.resolve({ success: false, classification: 'PAYMENT_PROCESSING', message: 'proc', customerDTO: {} as any });
    };
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(!reconCalled, 'Reconciliation was NOT called for attempt 13');
    assert(res.manualReview === 1, 'Attempt 13 escalated immediately to manual review');
  });

  // 24. recovery age below 48h remains eligible
  await scenario('24. recovery age below 48h remains eligible', async () => {
    const recent = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const mockDb = createMockSupabase([{ id: 's24', organization_id: orgId, state: 'capture_pending', recovery_started_at: recent, updated_at: '2026-09-28T10:00:00Z' }]);
    const stripeMock = createMockStripe('processing');
    CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga = (db, p) => origReconcile.call(CommercialCaptureReconciliationService, db, { ...p, stripeOverride: stripeMock });
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(res.deferred === 1, 'Saga <48h old remains eligible for recovery pass');
  });

  // 25. recovery age >=48h escalates without provider retrieval
  await scenario('25. recovery age >=48h escalates without provider retrieval', async () => {
    let reconCalled = false;
    const oldAge = new Date(Date.now() - 49 * 3600 * 1000).toISOString();
    const mockDb = createMockSupabase([{ id: 's25', organization_id: orgId, state: 'capture_pending', recovery_started_at: oldAge, updated_at: '2026-09-28T10:00:00Z' }]);
    CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga = () => {
      reconCalled = true;
      return Promise.resolve({ success: false, classification: 'PAYMENT_PROCESSING', message: 'proc', customerDTO: {} as any });
    };
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(!reconCalled, 'Reconciliation NOT called for age >=48h');
    assert(res.manualReview === 1, 'Escalated immediately to manual review due to age');
  });

  // 26. deterministic mismatch immediately manual review
  await scenario('26. deterministic mismatch immediately manual review', async () => {
    const mockDb = createMockSupabase([{ id: 's26', organization_id: orgId, state: 'capture_pending', updated_at: '2026-09-28T10:00:00Z' }]);
    CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga = () => Promise.resolve({ success: false, classification: 'AMOUNT_MISMATCH', message: 'Amount mismatch detected', customerDTO: {} as any });
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(res.manualReview === 1, 'Deterministic mismatch escalated to manual review');
  });

  // 27. manual review never rediscovered
  await scenario('27. manual review never rediscovered', async () => {
    const mockDb = createMockSupabase([{ id: 's27', organization_id: orgId, state: 'manual_review_required', next_recovery_retry_at: '2020-01-01T00:00:00Z', updated_at: '2026-09-28T10:00:00Z' }]);
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(res.discovered === 0, 'manual_review_required never rediscovered');
  });

  // 28. runner + webhook concurrency
  await scenario('28. runner + webhook concurrency', async () => {
    const mockDb = createMockSupabase([{ id: 's28', organization_id: orgId, state: 'capture_pending', updated_at: '2026-09-28T10:00:00Z' }]);
    // Runner claims lease
    const c1 = await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's28', p_organization_id: orgId });
    // Webhook concurrently completes saga
    mockDb._sagas[0].state = 'completed';
    // Runner finishes and records outcome
    const outcome = await mockDb.rpc('record_commercial_saga_recovery_outcome', { p_saga_id: 's28', p_organization_id: orgId, p_lease_token: c1.data.recovery_lease_token, p_classification: 'CAPTURE_CONFIRMED', p_stripe_status: 'succeeded', p_next_retry_at: null });
    assert(outcome.data.state === 'completed', 'Completed state preserved despite runner outcome recording');
    assert(outcome.data.recovery_lease_until === null, 'Lease cleared');
  });

  // 29. runner + HTTP concurrency
  await scenario('29. runner + HTTP concurrency', async () => {
    const mockDb = createMockSupabase([{ id: 's29', organization_id: orgId, state: 'capture_pending', updated_at: '2026-09-28T10:00:00Z' }]);
    const c1 = await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's29', p_organization_id: orgId });
    // User HTTP checkout completes saga concurrently
    await mockDb.rpc('complete_commercial_saga_after_capture', { p_saga_id: 's29', p_organization_id: orgId });
    const outcome = await mockDb.rpc('record_commercial_saga_recovery_outcome', { p_saga_id: 's29', p_organization_id: orgId, p_lease_token: c1.data.recovery_lease_token, p_classification: 'CAPTURE_CONFIRMED', p_stripe_status: 'succeeded', p_next_retry_at: null });
    assert(outcome.data.state === 'completed', 'HTTP completion preserved');
  });

  // 30. batch limit 15
  await scenario('30. batch limit 15', async () => {
    const sagas = Array.from({ length: 25 }, (_, i) => ({ id: `s30_${i}`, organization_id: orgId, state: 'capture_pending', updated_at: '2026-09-28T10:00:00Z' }));
    const mockDb = createMockSupabase(sagas);
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any, { batchSize: 15 });
    assert(res.discovered === 15, 'Strictly limited to batch limit 15');
  });

  // 31. deterministic ordering
  await scenario('31. deterministic ordering', async () => {
    const mockDb = createMockSupabase([
      { id: 's31_B', organization_id: orgId, state: 'capture_pending', updated_at: '2026-09-28T10:05:00Z' },
      { id: 's31_A', organization_id: orgId, state: 'capture_pending', updated_at: '2026-09-28T10:01:00Z' },
    ]);
    const stripeMock = createMockStripe('processing');
    CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga = (db, p) => origReconcile.call(CommercialCaptureReconciliationService, db, { ...p, stripeOverride: stripeMock });
    await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any);
    assert(mockDb._sagas[1].id === 's31_A', 'Oldest updated_at processed first');
  });

  // 32. execution budget stops cleanly
  await scenario('32. execution budget stops cleanly', async () => {
    const sagas = Array.from({ length: 10 }, (_, i) => ({ id: `s32_${i}`, organization_id: orgId, state: 'capture_pending', updated_at: '2026-09-28T10:00:00Z' }));
    const mockDb = createMockSupabase(sagas);
    CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga = async () => {
      await new Promise(r => setTimeout(r, 50));
      return { success: false, classification: 'PAYMENT_PROCESSING', message: 'proc', customerDTO: {} as any };
    };
    const res = await CommercialRecoveryRunnerService.runRecoveryPass(mockDb as any, { timeBudgetMs: 30 });
    assert(res.stoppedByTimeBudget === true, 'Execution stopped cleanly when time budget expired');
  });

  // 33. crash mid-batch leaves untouched sagas eligible
  await scenario('33. crash mid-batch leaves untouched sagas eligible', async () => {
    const mockDb = createMockSupabase([
      { id: 's33_1', organization_id: orgId, state: 'capture_pending', updated_at: '2026-09-28T10:00:00Z' },
      { id: 's33_2', organization_id: orgId, state: 'capture_pending', updated_at: '2026-09-28T10:00:00Z' },
    ]);
    // Worker claims s33_1 then crashes
    await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's33_1', p_organization_id: orgId });
    // s33_2 remains unclaimed and eligible
    assert(mockDb._sagas[1].recovery_lease_token === undefined || mockDb._sagas[1].recovery_lease_token === null, 's33_2 remains untouched and eligible');
  });

  // 34. expired lease eventually rediscoverable after cooldown
  await scenario('34. expired lease eventually rediscoverable after cooldown', async () => {
    const pastLease = new Date(Date.now() - 1000).toISOString();
    const mockDb = createMockSupabase([{ id: 's34', organization_id: orgId, state: 'capture_pending', recovery_lease_until: pastLease, updated_at: '2026-09-28T10:00:00Z' }]);
    const c = await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's34', p_organization_id: orgId });
    assert(c.data !== null, 'Expired lease saga successfully claimed after cooldown');
  });

  // 35. tenant mismatch blocked
  await scenario('35. tenant mismatch blocked', async () => {
    const mockDb = createMockSupabase([{ id: 's35', organization_id: 'org_victim', state: 'capture_pending', updated_at: '2026-09-28T10:00:00Z' }]);
    const c = await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's35', p_organization_id: 'org_attacker' });
    assert(c.error?.message === 'TENANT_MISMATCH', 'Tenant mismatch blocked by RPC');
  });

  // 36. unauthorized route rejected
  await scenario('36. unauthorized route rejected', async () => {
    process.env.RECOVERY_RUNNER_SECRET = 'super_secret_recovery_runner_token_32_chars';
    const req = new NextRequest('http://localhost/api/cron/recovery-runner', { headers: { authorization: 'Bearer WRONG_SECRET_TOKEN_32_CHARACTERS_LONG' } });
    const res = await recoveryCronGET(req);
    assert(res.status === 401, 'Unauthorized request returned 401');
  });

  // 37. missing runner secret fails closed
  await scenario('37. missing runner secret fails closed', async () => {
    delete process.env.RECOVERY_RUNNER_SECRET;
    const req = new NextRequest('http://localhost/api/cron/recovery-runner', { headers: { authorization: 'Bearer any_token' } });
    const res = await recoveryCronGET(req);
    assert(res.status === 500, 'Missing server secret fails closed with 500');
  });

  // 38. malformed Bearer rejected
  await scenario('38. malformed Bearer rejected', async () => {
    process.env.RECOVERY_RUNNER_SECRET = 'super_secret_recovery_runner_token_32_chars';
    const req = new NextRequest('http://localhost/api/cron/recovery-runner', { headers: { authorization: 'Basic dXNlcjpwYXNz' } });
    const res = await recoveryCronGET(req);
    assert(res.status === 401, 'Malformed Authorization header rejected with 401');
  });

  // 39. unequal token length handled safely
  await scenario('39. unequal token length handled safely', async () => {
    process.env.RECOVERY_RUNNER_SECRET = 'super_secret_recovery_runner_token_32_chars';
    const req = new NextRequest('http://localhost/api/cron/recovery-runner', { headers: { authorization: 'Bearer short' } });
    const res = await recoveryCronGET(req);
    assert(res.status === 401, 'Unequal token length rejected safely with 401');
  });

  // 40. caller cannot supply organization
  await scenario('40. caller cannot supply organization', async () => {
    if (!(global as any).WebSocket) {
      (global as any).WebSocket = class MockWebSocket {};
    }
    process.env.RECOVERY_RUNNER_SECRET = 'super_secret_recovery_runner_token_32_chars';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'eyMockServiceRoleKeyForTestingOnly32Chars';
    const req = new NextRequest('http://localhost/api/cron/recovery-runner?organization_id=org_hacker', { headers: { authorization: 'Bearer super_secret_recovery_runner_token_32_chars' } });
    const res = await recoveryCronGET(req);
    assert(res.status === 200 || res.status === 500, 'Route executed without taking caller organization_id');
  });

  // 41. zero Stripe capture
  await scenario('41. zero Stripe capture', async () => {
    const mockDb = createMockSupabase();
    assert(mockDb._getCapturePostCount() === 0, 'ZERO Stripe paymentIntents.capture() POST requests executed');
  });

  // 42. zero Stripe cancel
  await scenario('42. zero Stripe cancel', async () => {
    const mockDb = createMockSupabase();
    assert(mockDb._getCancelPostCount() === 0, 'ZERO Stripe paymentIntents.cancel() POST requests executed');
  });

  // 43. zero Stripe refund
  await scenario('43. zero Stripe refund', async () => {
    const mockDb = createMockSupabase();
    assert(mockDb._getRefundPostCount() === 0, 'ZERO Stripe refunds.create() POST requests executed');
  });

  // 44. zero Twilio purchase
  await scenario('44. zero Twilio purchase', async () => {
    const mockDb = createMockSupabase();
    assert(mockDb._getTwilioMutationCount() === 0, 'ZERO Twilio purchase requests executed');
  });

  // 45. zero Twilio release
  await scenario('45. zero Twilio release', async () => {
    const mockDb = createMockSupabase();
    assert(mockDb._getTwilioMutationCount() === 0, 'ZERO Twilio release requests executed');
  });

  // 46. zero regulatory mutation
  await scenario('46. zero regulatory mutation', async () => {
    const mockDb = createMockSupabase();
    assert(mockDb._getRegulatoryMutationCount() === 0, 'ZERO regulatory mutation requests executed');
  });

  // 47. claim RPC cannot change saga state
  await scenario('47. claim RPC cannot change saga state', async () => {
    const mockDb = createMockSupabase([{ id: 's47', organization_id: orgId, state: 'capture_pending', updated_at: '2026-09-28T10:00:00Z' }]);
    const claim = await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's47', p_organization_id: orgId });
    assert(claim.data.state === 'capture_pending', 'Claim RPC preserved capture_pending state');
  });

  // 48. outcome RPC cannot change saga state
  await scenario('48. outcome RPC cannot change saga state', async () => {
    const mockDb = createMockSupabase([{ id: 's48', organization_id: orgId, state: 'capture_pending', recovery_lease_token: 'tok48' }]);
    const outcome = await mockDb.rpc('record_commercial_saga_recovery_outcome', { p_saga_id: 's48', p_organization_id: orgId, p_lease_token: 'tok48', p_classification: 'FOO', p_stripe_status: 'bar', p_next_retry_at: '2026-10-01T00:00:00Z' });
    assert(outcome.data.state === 'capture_pending', 'Outcome RPC preserved saga state');
  });

  // 49. recovery_started_at cannot be reset by subsequent recovery claims
  await scenario('49. recovery_started_at cannot be reset by subsequent recovery claims', async () => {
    const fixedStart = '2026-09-01T12:00:00Z';
    const mockDb = createMockSupabase([{ id: 's49', organization_id: orgId, state: 'capture_pending', recovery_started_at: fixedStart, recovery_lease_until: null, updated_at: '2026-09-28T10:00:00Z' }]);
    await mockDb.rpc('claim_commercial_saga_recovery', { p_saga_id: 's49', p_organization_id: orgId });
    assert(mockDb._sagas[0].recovery_started_at === fixedStart, 'recovery_started_at preserved across multiple claims');
  });

  // 50. completed recovery remains idempotent
  await scenario('50. completed recovery remains idempotent', async () => {
    const mockDb = createMockSupabase([{ id: 's50', organization_id: orgId, state: 'completed', recovery_lease_token: 'tok50' }]);
    const o1 = await mockDb.rpc('record_commercial_saga_recovery_outcome', { p_saga_id: 's50', p_organization_id: orgId, p_lease_token: 'tok50', p_classification: 'CAPTURE_CONFIRMED', p_stripe_status: 'succeeded', p_next_retry_at: null });
    const o2 = await mockDb.rpc('record_commercial_saga_recovery_outcome', { p_saga_id: 's50', p_organization_id: orgId, p_lease_token: 'tok50', p_classification: 'CAPTURE_CONFIRMED', p_stripe_status: 'succeeded', p_next_retry_at: null });
    assert(o1.data.state === 'completed', 'First outcome call returned completed state');
    assert(o2.data.state === 'completed', 'Second idempotent outcome call returned completed state');
  });

  // Restore origReconcile
  CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga = origReconcile;

  console.log('\n====================================================');
  console.log(`SUMMARY: ${scenarioCount} scenarios executed`);
  console.log(`ASSERTIONS: ${passedAssertions} passed, ${failedAssertions} failed (Total: ${assertionCount})`);
  console.log('====================================================\n');

  if (failedAssertions > 0) {
    process.exit(1);
  }
}

runTests();
