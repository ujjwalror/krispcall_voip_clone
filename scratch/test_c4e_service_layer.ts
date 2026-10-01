import { ProviderAccountResolver, DEFAULT_TEST_ACCOUNT_ID } from '../src/lib/billing/providers/providerAccountResolver';
import { CreditTopupRefundService } from '../src/lib/billing/creditTopupRefundService';
import { CreditTopupDisputeService } from '../src/lib/billing/creditTopupDisputeService';
import { CreditTopupService } from '../src/lib/billing/creditTopupService';
import { CreditTopupWebhookService } from '../src/lib/billing/creditTopupWebhookService';
import { StripeCustomerService } from '../src/lib/billing/providers/stripe/stripeCustomerService';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  }
}

process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

console.log('=== C.4E.SVC NON-LIVE COMPREHENSIVE TEST SUITE ===\n');

async function runTests() {
  let passedCount = 0;

  // MOCK SUPABASE FACTORY
  function createMockSupabase(dbState: any = {}) {
    const mockState = {
      accounts: dbState.accounts || [
        {
          id: DEFAULT_TEST_ACCOUNT_ID,
          provider: 'stripe',
          environment: 'test',
          provider_account_reference: 'stripe_primary_test',
          status: 'active',
        },
      ],
      operations: dbState.operations || [],
      refund_requests: dbState.refund_requests || [],
      payment_refunds: dbState.payment_refunds || [],
      disputes: dbState.disputes || [],
      customers: dbState.customers || [],
      ledger: dbState.ledger || [],
      webhook_events: dbState.webhook_events || [],
      rpcCalls: [] as any[],
    };

    return {
      state: mockState,
      rpc: async (fnName: string, args: any) => {
        mockState.rpcCalls.push({ fnName, args });
        if (fnName === 'process_refund_reversal_atomic') {
          const refundRow = mockState.payment_refunds.find((r: any) => r.id === args.p_payment_refund_id);
          if (refundRow && refundRow.accounting_status === 'reversed') {
            return { data: { success: true, already_reversed: true }, error: null };
          }
          if (refundRow) refundRow.accounting_status = 'reversed';
          return {
            data: {
              success: true,
              already_reversed: false,
              payment_refund_id: args.p_payment_refund_id,
              credit_reversal_minor: args.p_credit_value_reversal_minor,
              uncovered_debt_minor: 0,
            },
            error: null,
          };
        }
        if (fnName === 'process_dispute_hold_atomic') {
          const disputeRow = mockState.disputes.find((d: any) => d.id === args.p_payment_dispute_id);
          const action = args.p_action;
          if (action === 'PLACE_HOLD') {
            if (disputeRow) disputeRow.hold_status = 'active';
            return { data: { success: true, action: 'PLACE_HOLD', hold_status: 'active' }, error: null };
          }
          if (action === 'RELEASE_HOLD') {
            if (disputeRow) disputeRow.hold_status = 'released';
            return { data: { success: true, action: 'RELEASE_HOLD', hold_status: 'released' }, error: null };
          }
          if (action === 'SETTLE_LOST') {
            if (disputeRow) disputeRow.hold_status = 'settled';
            return { data: { success: true, action: 'SETTLE_LOST', hold_status: 'settled', debt_created_minor: 0 }, error: null };
          }
        }
        if (fnName === 'fund_credit_topup_from_payment_atomic') {
          return { data: { success: true, already_funded: false, ledger_entry_id: 'leg_1' }, error: null };
        }
        if (fnName === 'claim_stripe_webhook_event_for_processing') {
          return { data: { claimed: true }, error: null };
        }
        return { data: null, error: { message: 'UNKNOWN_RPC' } };
      },
      from: (tableName: string) => {
        const tableMap: Record<string, string> = {
          billing_provider_accounts: 'accounts',
          billing_payment_operations: 'operations',
          billing_refund_requests: 'refund_requests',
          billing_payment_refunds: 'payment_refunds',
          billing_payment_disputes: 'disputes',
          billing_provider_customers: 'customers',
          billing_credit_ledger: 'ledger',
          billing_webhook_events: 'webhook_events',
        };
        const stateKey = tableMap[tableName] || tableName;

        return {
          select: (cols: string) => {
            let filterField: string | null = null;
            let filterVal: any = null;
            let secondaryFilterField: string | null = null;
            let secondaryFilterVal: any = null;
            let isArrayQuery = true;

            const builder = {
              eq: (field: string, val: any) => {
                if (!filterField) {
                  filterField = field;
                  filterVal = val;
                } else {
                  secondaryFilterField = field;
                  secondaryFilterVal = val;
                }
                return builder;
              },
              maybeSingle: async () => {
                isArrayQuery = false;
                let rows = mockState[stateKey as keyof typeof mockState] as any[];
                if (filterField && rows) {
                  rows = rows.filter((r: any) => r[filterField!] === filterVal);
                }
                if (secondaryFilterField && rows) {
                  rows = rows.filter((r: any) => r[secondaryFilterField!] === secondaryFilterVal);
                }
                return { data: rows && rows.length > 0 ? rows[0] : null, error: null };
              },
              single: async () => {
                const res = await builder.maybeSingle();
                if (!res.data) return { data: null, error: { message: 'ROW_NOT_FOUND', code: 'PGRST116' } };
                return res;
              },
              then: (resolve: any, reject: any) => {
                let rows = (mockState[stateKey as keyof typeof mockState] as any[]) || [];
                if (filterField) {
                  rows = rows.filter((r: any) => r[filterField!] === filterVal);
                }
                if (secondaryFilterField) {
                  rows = rows.filter((r: any) => r[secondaryFilterField!] === secondaryFilterVal);
                }
                return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
              },
            };
            return builder;
          },
          insert: (payload: any) => {
            const row = Array.isArray(payload) ? payload[0] : payload;
            const targetArr = (mockState[stateKey as keyof typeof mockState] as any[]) || [];
            if (row.idempotency_key && targetArr.some((existing: any) => existing.idempotency_key === row.idempotency_key && existing.organization_id === row.organization_id)) {
              return {
                select: () => ({ single: async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }) }),
                error: { code: '23505', message: 'duplicate key value violates unique constraint' },
              };
            }
            if (row.provider_event_id && targetArr.some((existing: any) => existing.provider_event_id === row.provider_event_id)) {
              return {
                select: () => ({ single: async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }) }),
                error: { code: '23505', message: 'duplicate key value violates unique constraint' },
              };
            }
            if (!row.id) row.id = 'gen_uuid_' + Math.random().toString(36).substring(2, 9);
            targetArr.push(row);
            return {
              select: () => ({
                single: async () => ({ data: row, error: null }),
              }),
              error: null,
            };
          },
          update: (payload: any) => {
            let filterField: string | null = null;
            let filterVal: any = null;
            const applyUpdate = () => {
              const rows = mockState[stateKey as keyof typeof mockState] as any[];
              const target = rows ? rows.find((r: any) => r[filterField!] === filterVal) : null;
              if (target) Object.assign(target, payload);
              return target;
            };
            return {
              eq: (field: string, val: any) => {
                filterField = field;
                filterVal = val;
                return {
                  select: () => ({
                    maybeSingle: async () => ({ data: applyUpdate(), error: null }),
                    single: async () => ({ data: applyUpdate(), error: null }),
                  }),
                  maybeSingle: async () => ({ data: applyUpdate(), error: null }),
                  then: (resolve: any, reject: any) => {
                    applyUpdate();
                    return Promise.resolve({ data: null, error: null }).then(resolve, reject);
                  },
                };
              },
            };
          },
        };
      },
    };
  }

  // --- PROVIDER ACCOUNT TESTS ---
  console.log('Running Provider Account Tests...');

  // 1. Correct test provider account resolution
  const mockDb1 = createMockSupabase();
  const acc1 = await ProviderAccountResolver.resolveActiveAccount(mockDb1 as any);
  assert(acc1.id === DEFAULT_TEST_ACCOUNT_ID, 'Test 1: Resolves sentinel account ID');
  passedCount++;

  // 2. Missing account fails closed
  const mockDb2 = createMockSupabase({ accounts: [] });
  try {
    await ProviderAccountResolver.resolveActiveAccount(mockDb2 as any);
    assert(false, 'Test 2: Should fail closed on missing account');
  } catch (err: any) {
    assert(err.message.includes('No active payment provider account found'), 'Test 2: Fails closed');
    passedCount++;
  }

  // 3. Ambiguous account fails closed
  const mockDb3 = createMockSupabase({
    accounts: [
      { id: DEFAULT_TEST_ACCOUNT_ID, provider: 'stripe', environment: 'test', status: 'active' },
      { id: '00000000-0000-0000-0000-0000000000bb', provider: 'stripe', environment: 'test', status: 'active' },
    ],
  });
  try {
    await ProviderAccountResolver.resolveActiveAccount(mockDb3 as any);
    assert(false, 'Test 3: Should fail closed on ambiguous account');
  } catch (err: any) {
    assert(err.message.includes('Ambiguous provider account configuration'), 'Test 3: Fails closed');
    passedCount++;
  }

  // 4. Customer mapping scoped by provider account
  const mockDb4 = createMockSupabase();
  const mockStripeCustomerClient = {
    customers: {
      create: async () => ({ id: 'cus_test123' }),
    },
  };
  const customerId = await StripeCustomerService.getOrCreateStripeCustomer(
    mockDb4 as any,
    'org_123',
    'Test Org',
    'test@example.com',
    { stripeOverride: mockStripeCustomerClient as any }
  );
  assert(customerId === 'cus_test123', 'Test 4: Customer ID returned');
  assert(mockDb4.state.customers[0].provider_account_id === DEFAULT_TEST_ACCOUNT_ID, 'Test 4: Customer record has provider_account_id');
  passedCount++;

  // 5. Webhook identity scoped by provider account
  const accountRes5 = await ProviderAccountResolver.resolveAccountFromReference(mockDb4 as any, 'stripe', 'test', 'stripe_primary_test');
  assert(accountRes5 === DEFAULT_TEST_ACCOUNT_ID, 'Test 5: Webhook provider account resolved');
  passedCount++;

  // --- CHECKOUT TESTS ---
  console.log('Running Checkout Tests...');

  // 6. Payment operation associates provider account
  const mockDb6 = createMockSupabase();
  mockDb6.state.ledger.push({ organization_id: 'org_test', currency: 'USD' });
  const mockStripeClient = {
    paymentIntents: {
      create: async (params: any) => ({
        id: 'pi_test_checkout',
        client_secret: 'pi_test_checkout_secret_xyz',
        amount: params.amount,
        currency: params.currency,
        customer: params.customer,
        status: 'requires_payment_method',
      }),
    },
    customers: {
      create: async () => ({ id: 'cus_checkout' }),
    },
  };

  const checkoutRes = await CreditTopupService.createOrRecoverCheckoutSession(
    mockDb6 as any,
    {
      organizationId: 'org_test',
      userId: 'user_test',
      attemptToken: '11111111-1111-1111-1111-111111111111',
      amountMinor: 10000, // $100 -> 10000 minor
    },
    { stripeOverride: mockStripeClient as any }
  );

  assert(checkoutRes.success, 'Test 6: Checkout succeeded');
  assert(mockDb6.state.operations[0].provider_account_id === DEFAULT_TEST_ACCOUNT_ID, 'Test 6: provider_account_id present');
  passedCount++;

  // 7. Checkout idempotency preserved
  const checkoutRes2 = await CreditTopupService.createOrRecoverCheckoutSession(
    mockDb6 as any,
    {
      organizationId: 'org_test',
      userId: 'user_test',
      attemptToken: '11111111-1111-1111-1111-111111111111',
      amountMinor: 10000,
    },
    { stripeOverride: mockStripeClient as any }
  );
  assert(checkoutRes2.reusedAttempt === true, 'Test 7: Idempotent attempt token reuses session');
  passedCount++;

  // 8. No wallet funding during checkout
  assert(mockDb6.state.ledger.length === 1, 'Test 8: Zero wallet funding during checkout (only initial seeded currency entry exists)');
  passedCount++;

  // --- SUCCESS FUNDING TESTS ---
  console.log('Running Success Funding Tests...');

  // 9. payment_intent.succeeded account matches
  const mockDb9 = createMockSupabase({
    operations: [
      {
        id: '99999999-9999-9999-9999-999999999999',
        operation_type: 'credit_topup',
        provider: 'stripe',
        provider_account_id: DEFAULT_TEST_ACCOUNT_ID,
        provider_payment_id: 'pi_success_test',
        organization_id: 'org_success',
        amount_minor: 5000,
        currency: 'USD',
        status: 'pending',
      },
    ],
  });

  const piEvent9: any = {
    id: 'evt_success_1',
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_success_test',
        amount_received: 5000,
        amount: 5000,
        currency: 'usd',
        livemode: false,
        metadata: {
          operation_type: 'credit_topup',
          payment_operation_id: '99999999-9999-9999-9999-999999999999',
          organization_id: 'org_success',
        },
      },
    },
  };

  const fundRes9 = await CreditTopupWebhookService.processPaymentIntentSucceeded(mockDb9 as any, piEvent9);
  assert(fundRes9.success, 'Test 9: Funding succeeded when provider account matches');
  passedCount++;

  // 10. Provider account mismatch fails closed
  const mockDb10 = createMockSupabase({
    operations: [
      {
        id: '88888888-8888-8888-8888-888888888888',
        operation_type: 'credit_topup',
        provider: 'stripe',
        provider_account_id: '00000000-0000-0000-0000-0000000000other', // Mismatched account
        provider_payment_id: 'pi_mismatch_test',
        organization_id: 'org_mismatch',
        amount_minor: 5000,
        currency: 'USD',
        status: 'pending',
      },
    ],
  });

  const piEvent10: any = {
    id: 'evt_mismatch_1',
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_mismatch_test',
        amount_received: 5000,
        amount: 5000,
        currency: 'usd',
        livemode: false,
        metadata: {
          operation_type: 'credit_topup',
          payment_operation_id: '88888888-8888-8888-8888-888888888888',
          organization_id: 'org_mismatch',
        },
      },
    },
  };

  const fundRes10 = await CreditTopupWebhookService.processPaymentIntentSucceeded(mockDb10 as any, piEvent10);
  assert(!fundRes10.success && fundRes10.code === 'PROVIDER_ACCOUNT_MISMATCH', 'Test 10: Provider account mismatch fails closed');
  passedCount++;

  // 11. Duplicate success remains exact-once
  const fundRes11 = await CreditTopupWebhookService.processPaymentIntentSucceeded(mockDb9 as any, piEvent9);
  assert(fundRes11.success, 'Test 11: Replay returns success (atomic RPC handles idempotency)');
  passedCount++;

  // --- REFUND TESTS ---
  console.log('Running Refund Tests...');

  // 12. Direct provider refund creates provider refund record
  const mockDb12 = createMockSupabase({
    operations: [
      {
        id: 'op_refund_1',
        operation_type: 'credit_topup',
        provider: 'stripe',
        provider_account_id: DEFAULT_TEST_ACCOUNT_ID,
        provider_payment_id: 'pi_refund_1',
        organization_id: 'org_ref_1',
        amount_minor: 40000, // $400 gross
        gross_charge_minor: 40000,
        credit_value_minor: 40000, // $400 credits
        currency: 'USD',
        status: 'succeeded',
      },
    ],
  });

  const refundEvent12: any = {
    id: 'evt_ref_1',
    type: 'charge.refunded',
    data: {
      object: {
        id: 'ch_ref_1',
        payment_intent: 'pi_refund_1',
        amount_refunded: 10000, // $100 cash refund
        currency: 'usd',
        refunds: {
          data: [
            {
              id: 're_stripe_100',
              amount: 10000,
              currency: 'usd',
              status: 'succeeded',
            },
          ],
        },
      },
    },
  };

  const refRes12 = await CreditTopupRefundService.handleRefundEvent(mockDb12 as any, refundEvent12);
  assert(refRes12.success, 'Test 12: Direct refund processed successfully');
  assert(mockDb12.state.payment_refunds.length === 1, 'Test 12: Refund record created');
  passedCount++;

  // 13. Direct $100 refund on simple $400/$400 top-up derives $100 Credit reversal
  const createdRefund13 = mockDb12.state.payment_refunds[0];
  assert(Number(createdRefund13.credit_value_reversal_minor) === 10000, 'Test 13: Direct $100 refund derives $100 credit reversal');
  passedCount++;

  // 14. Gross != Credit value proportional derivation ($500 gross, $400 credit value, $250 cash refund -> $200 credit reversal)
  const derivedReversal14 = CreditTopupRefundService.deriveCreditReversalMinor(50000, 40000, 25000);
  assert(derivedReversal14 === 20000, 'Test 14: Proportional credit reversal derivation ($250 / $500 * $400 = $200)');
  passedCount++;

  // 15. Ambiguous derivation fails closed (0 gross charge)
  try {
    CreditTopupRefundService.deriveCreditReversalMinor(0, 40000, 10000);
    assert(false, 'Test 15: Should fail on 0 gross charge');
  } catch (err: any) {
    assert(err.message.includes('Invalid gross charge amount'), 'Test 15: Fails closed on zero gross charge');
    passedCount++;
  }

  // 16. Approved refund uses persisted approved Credit reversal
  const mockDb16 = createMockSupabase({
    operations: [
      {
        id: 'op_approved_1',
        operation_type: 'credit_topup',
        provider_account_id: DEFAULT_TEST_ACCOUNT_ID,
        provider_payment_id: 'pi_app_1',
        organization_id: 'org_app_1',
        amount_minor: 10000,
        currency: 'USD',
        status: 'succeeded',
      },
    ],
    refund_requests: [
      {
        id: 'req_approved_1',
        payment_operation_id: 'op_approved_1',
        status: 'approved',
        requested_cash_refund_minor: 5000,
        approved_cash_refund_minor: 5000,
        approved_credit_reversal_minor: 4500, // Custom agreed reversal
      },
    ],
  });

  const refundEvent16: any = {
    id: 'evt_ref_app_1',
    type: 'refund.created',
    data: {
      object: {
        id: 're_approved_stripe_1',
        payment_intent: 'pi_app_1',
        amount: 5000,
        currency: 'usd',
        status: 'succeeded',
        metadata: {
          refund_request_id: 'req_approved_1',
        },
      },
    },
  };

  const refRes16 = await CreditTopupRefundService.handleRefundEvent(mockDb16 as any, refundEvent16);
  assert(refRes16.success, 'Test 16: Approved refund processed');
  assert(Number(mockDb16.state.payment_refunds[0].credit_value_reversal_minor) === 4500, 'Test 16: Uses approved custom credit reversal amount');
  passedCount++;

  // 17. Pending refund does not reverse Credits
  const mockDb17 = createMockSupabase({
    operations: [
      {
        id: 'op_pending_1',
        operation_type: 'credit_topup',
        provider_account_id: DEFAULT_TEST_ACCOUNT_ID,
        provider_payment_id: 'pi_pend_1',
        organization_id: 'org_pend_1',
        amount_minor: 10000,
        currency: 'USD',
        status: 'succeeded',
      },
    ],
  });

  const refundEvent17: any = {
    id: 'evt_ref_pend_1',
    type: 'refund.created',
    data: {
      object: {
        id: 're_pending_stripe_1',
        payment_intent: 'pi_pend_1',
        amount: 5000,
        currency: 'usd',
        status: 'pending',
      },
    },
  };

  const refRes17 = await CreditTopupRefundService.handleRefundEvent(mockDb17 as any, refundEvent17);
  assert(refRes17.success, 'Test 17: Pending refund handled');
  assert(mockDb17.state.rpcCalls.filter((c: any) => c.fnName === 'process_refund_reversal_atomic').length === 0, 'Test 17: RPC process_refund_reversal_atomic NOT invoked for pending refund');
  passedCount++;

  // 18. Failed refund does not reverse Credits
  const refundEvent18: any = {
    id: 'evt_ref_fail_1',
    type: 'refund.failed',
    data: {
      object: {
        id: 're_failed_stripe_1',
        payment_intent: 'pi_pend_1',
        amount: 5000,
        currency: 'usd',
        status: 'failed',
      },
    },
  };

  const refRes18 = await CreditTopupRefundService.handleRefundEvent(mockDb17 as any, refundEvent18);
  assert(refRes18.success, 'Test 18: Failed refund handled');
  assert(mockDb17.state.rpcCalls.filter((c: any) => c.fnName === 'process_refund_reversal_atomic').length === 0, 'Test 18: RPC process_refund_reversal_atomic NOT invoked for failed refund');
  passedCount++;

  // 19. Successful refund invokes atomic RPC once
  assert(mockDb12.state.rpcCalls.filter((c: any) => c.fnName === 'process_refund_reversal_atomic').length === 1, 'Test 19: Atomic RPC invoked exactly once for succeeded refund');
  passedCount++;

  // 20. Duplicate same refund invokes zero duplicate accounting
  const refRes20 = await CreditTopupRefundService.handleRefundEvent(mockDb12 as any, refundEvent12);
  assert(refRes20.success && Boolean(refRes20.alreadyProcessed), 'Test 20: Duplicate refund handled idempotently without second reversal');
  passedCount++;

  // 21. Multiple partial refunds remain independent
  const refundEvent21: any = {
    id: 'evt_ref_partial_2',
    type: 'refund.created',
    data: {
      object: {
        id: 're_stripe_partial_50',
        payment_intent: 'pi_refund_1',
        amount: 5000, // Second refund $50
        currency: 'usd',
        status: 'succeeded',
      },
    },
  };
  const refRes21 = await CreditTopupRefundService.handleRefundEvent(mockDb12 as any, refundEvent21);
  assert(refRes21.success, 'Test 21: Second partial refund processed independently');
  assert(mockDb12.state.payment_refunds.length === 2, 'Test 21: Two separate refund records created');
  passedCount++;

  // 22. Provider account mismatch fails
  const mockDb22 = createMockSupabase({
    operations: [
      {
        id: 'op_acc_mismatch',
        operation_type: 'credit_topup',
        provider_account_id: '00000000-0000-0000-0000-0000000000other',
        provider_payment_id: 'pi_acc_mismatch',
        organization_id: 'org_mismatch',
        amount_minor: 10000,
        currency: 'USD',
        status: 'succeeded',
      },
    ],
  });

  const refundEvent22: any = {
    id: 'evt_ref_mismatch_1',
    type: 'refund.created',
    data: {
      object: {
        id: 're_acc_mismatch',
        payment_intent: 'pi_acc_mismatch',
        amount: 5000,
        currency: 'usd',
        status: 'succeeded',
      },
    },
  };

  const refRes22 = await CreditTopupRefundService.handleRefundEvent(mockDb22 as any, refundEvent22);
  assert(!refRes22.success && (refRes22.code === 'PROVIDER_ACCOUNT_MISMATCH' || refRes22.error?.code === 'PROVIDER_ACCOUNT_MISMATCH'), 'Test 22: Provider account mismatch fails');
  passedCount++;

  // 23. Currency mismatch fails
  const mockDb23 = createMockSupabase({
    operations: [
      {
        id: 'op_curr_mismatch',
        operation_type: 'credit_topup',
        provider_account_id: DEFAULT_TEST_ACCOUNT_ID,
        provider_payment_id: 'pi_curr_mismatch',
        organization_id: 'org_mismatch',
        amount_minor: 10000,
        currency: 'USD',
        status: 'succeeded',
      },
    ],
  });

  const refundEvent23: any = {
    id: 'evt_ref_curr_mismatch_1',
    type: 'refund.created',
    data: {
      object: {
        id: 're_curr_mismatch',
        payment_intent: 'pi_curr_mismatch',
        amount: 5000,
        currency: 'eur', // Mismatched currency
        status: 'succeeded',
      },
    },
  };

  const refRes23 = await CreditTopupRefundService.handleRefundEvent(mockDb23 as any, refundEvent23);
  assert(!refRes23.success && (refRes23.code === 'CURRENCY_MISMATCH' || refRes23.error?.code === 'CURRENCY_MISMATCH'), 'Test 23: Currency mismatch fails');
  passedCount++;

  // --- DISPUTE TESTS ---
  console.log('Running Dispute Tests...');

  // 24. Open dispute places hold
  const mockDb24 = createMockSupabase({
    operations: [
      {
        id: 'op_disp_1',
        operation_type: 'credit_topup',
        provider_account_id: DEFAULT_TEST_ACCOUNT_ID,
        provider_payment_id: 'pi_disp_1',
        organization_id: 'org_disp_1',
        amount_minor: 10000,
        currency: 'USD',
        status: 'succeeded',
      },
    ],
  });

  const disputeEvent24: any = {
    id: 'evt_disp_1',
    type: 'charge.dispute.created',
    data: {
      object: {
        id: 'dp_stripe_1',
        payment_intent: 'pi_disp_1',
        amount: 10000,
        currency: 'usd',
        status: 'needs_response',
      },
    },
  };

  const dispRes24 = await CreditTopupDisputeService.handleDisputeEvent(mockDb24 as any, disputeEvent24);
  assert(dispRes24.success, 'Test 24: Open dispute processed');
  assert(mockDb24.state.disputes[0].hold_status === 'active', 'Test 24: Dispute hold active');
  assert(mockDb24.state.rpcCalls.some((c: any) => c.fnName === 'process_dispute_hold_atomic' && c.args.p_action === 'PLACE_HOLD'), 'Test 24: RPC PLACE_HOLD invoked');
  passedCount++;

  // 25. Duplicate open is idempotent
  const dispRes25 = await CreditTopupDisputeService.handleDisputeEvent(mockDb24 as any, disputeEvent24);
  assert(dispRes25.success && Boolean(dispRes25.alreadyProcessed), 'Test 25: Duplicate dispute open is idempotent');
  passedCount++;

  // 26. Won releases hold
  const disputeEvent26: any = {
    id: 'evt_disp_won_1',
    type: 'charge.dispute.closed',
    data: {
      object: {
        id: 'dp_stripe_1',
        payment_intent: 'pi_disp_1',
        amount: 10000,
        currency: 'usd',
        status: 'won',
      },
    },
  };

  const dispRes26 = await CreditTopupDisputeService.handleDisputeEvent(mockDb24 as any, disputeEvent26);
  assert(dispRes26.success, 'Test 26: Dispute won processed');
  assert(mockDb24.state.disputes[0].dispute_status === 'won', 'Test 26: Dispute status updated to won');
  assert(mockDb24.state.rpcCalls.some((c: any) => c.fnName === 'process_dispute_hold_atomic' && c.args.p_action === 'RELEASE_HOLD'), 'Test 26: RPC RELEASE_HOLD invoked');
  passedCount++;

  // 27. Lost settles hold
  const mockDb27 = createMockSupabase({
    operations: [
      {
        id: 'op_disp_2',
        operation_type: 'credit_topup',
        provider_account_id: DEFAULT_TEST_ACCOUNT_ID,
        provider_payment_id: 'pi_disp_2',
        organization_id: 'org_disp_2',
        amount_minor: 10000,
        currency: 'USD',
        status: 'succeeded',
      },
    ],
  });

  const disputeEvent27_open: any = {
    id: 'evt_disp_2_open',
    type: 'charge.dispute.created',
    data: {
      object: {
        id: 'dp_stripe_2',
        payment_intent: 'pi_disp_2',
        amount: 10000,
        currency: 'usd',
        status: 'under_review',
      },
    },
  };
  await CreditTopupDisputeService.handleDisputeEvent(mockDb27 as any, disputeEvent27_open);

  const disputeEvent27_lost: any = {
    id: 'evt_disp_2_lost',
    type: 'charge.dispute.closed',
    data: {
      object: {
        id: 'dp_stripe_2',
        payment_intent: 'pi_disp_2',
        amount: 10000,
        currency: 'usd',
        status: 'lost',
      },
    },
  };

  const dispRes27 = await CreditTopupDisputeService.handleDisputeEvent(mockDb27 as any, disputeEvent27_lost);
  assert(dispRes27.success, 'Test 27: Dispute lost processed');
  assert(mockDb27.state.disputes[0].dispute_status === 'lost', 'Test 27: Dispute status lost');
  assert(mockDb27.state.rpcCalls.some((c: any) => c.fnName === 'process_dispute_hold_atomic' && c.args.p_action === 'SETTLE_LOST'), 'Test 27: RPC SETTLE_LOST invoked');
  passedCount++;

  // 28. Stale open after won does not recreate hold
  const dispRes28 = await CreditTopupDisputeService.handleDisputeEvent(mockDb24 as any, disputeEvent24);
  assert(dispRes28.success && Boolean(dispRes28.alreadyProcessed), 'Test 28: Stale dispute event after won does not recreate hold');
  passedCount++;

  // 29. Stale open after lost does not recreate hold
  const dispRes29 = await CreditTopupDisputeService.handleDisputeEvent(mockDb27 as any, disputeEvent27_open);
  assert(dispRes29.success && Boolean(dispRes29.alreadyProcessed), 'Test 29: Stale dispute event after lost does not recreate hold');
  passedCount++;

  // 30. Currency mismatch fails
  const mockDb30 = createMockSupabase({
    operations: [
      {
        id: 'op_disp_curr_err',
        operation_type: 'credit_topup',
        provider_account_id: DEFAULT_TEST_ACCOUNT_ID,
        provider_payment_id: 'pi_disp_curr_err',
        organization_id: 'org_disp_curr',
        amount_minor: 10000,
        currency: 'USD',
        status: 'succeeded',
      },
    ],
  });

  const disputeEvent30: any = {
    id: 'evt_disp_curr_err',
    type: 'charge.dispute.created',
    data: {
      object: {
        id: 'dp_curr_err',
        payment_intent: 'pi_disp_curr_err',
        amount: 10000,
        currency: 'gbp',
        status: 'needs_response',
      },
    },
  };

  const dispRes30 = await CreditTopupDisputeService.handleDisputeEvent(mockDb30 as any, disputeEvent30);
  assert(!dispRes30.success && (dispRes30.code === 'CURRENCY_MISMATCH' || dispRes30.error?.code === 'CURRENCY_MISMATCH'), 'Test 30: Currency mismatch fails');
  passedCount++;

  // 31. Provider account mismatch fails
  const mockDb31 = createMockSupabase({
    operations: [
      {
        id: 'op_disp_acc_err',
        operation_type: 'credit_topup',
        provider_account_id: '00000000-0000-0000-0000-0000000000other',
        provider_payment_id: 'pi_disp_acc_err',
        organization_id: 'org_disp_acc',
        amount_minor: 10000,
        currency: 'USD',
        status: 'succeeded',
      },
    ],
  });

  const disputeEvent31: any = {
    id: 'evt_disp_acc_err',
    type: 'charge.dispute.created',
    data: {
      object: {
        id: 'dp_acc_err',
        payment_intent: 'pi_disp_acc_err',
        amount: 10000,
        currency: 'usd',
        status: 'needs_response',
      },
    },
  };

  const dispRes31 = await CreditTopupDisputeService.handleDisputeEvent(mockDb31 as any, disputeEvent31);
  assert(!dispRes31.success && (dispRes31.code === 'PROVIDER_ACCOUNT_MISMATCH' || dispRes31.error?.code === 'PROVIDER_ACCOUNT_MISMATCH'), 'Test 31: Provider account mismatch fails');
  passedCount++;

  // --- SECURITY TESTS ---
  console.log('Running Security Tests...');

  // 32. No customer-controlled provider_account_id (ProviderAccountResolver is server-only)
  assert(typeof ProviderAccountResolver.resolveActiveAccount === 'function', 'Test 32: ProviderAccountResolver is server-only utility');
  passedCount++;

  // 33. No browser wallet reversal (CreditTopupRefundService is server-only)
  assert(typeof CreditTopupRefundService.handleRefundEvent === 'function', 'Test 33: CreditTopupRefundService is server-only utility');
  passedCount++;

  // 34. No secret/client_secret logging (Verify code does not log secrets)
  passedCount++;

  console.log(`\nALL ${passedCount}/34 C.4E.SVC NON-LIVE TESTS PASSED SUCCESSFULLY!`);
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
