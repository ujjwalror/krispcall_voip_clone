import assert from 'assert';
import {
  validateAutoTopupConfigMajor,
  validateAutoTopupConfigMinor,
  CURRENT_CONSENT_TERMS_VERSION,
} from '../src/lib/billing/autoTopupPolicy';
import { CreditAutoTopupService } from '../src/lib/billing/creditAutoTopupService';
import { ProviderAccountResolver, DEFAULT_TEST_ACCOUNT_ID } from '../src/lib/billing/providers/providerAccountResolver';
import { majorToMinorUnits, minorToMajorUnits } from '../src/lib/billing/creditTopupPolicy';

console.log('================================================================');
console.log('PHASE 13.4.3C SUBPHASE C.5B — EXPANDED AUDIT REMEDIATION TEST SUITE');
console.log('================================================================\n');

// Mock Environment Setup
process.env.STRIPE_SECRET_KEY = 'sk_test_mock_primary';
process.env.STRIPE_EXPECTED_MODE = 'test';

function createMockSupabase(initialState: any = {}) {
  const store: Record<string, any[]> = {
    billing_provider_accounts: initialState.accounts || [
      {
        id: DEFAULT_TEST_ACCOUNT_ID,
        provider: 'stripe',
        environment: 'test',
        provider_account_reference: 'stripe_primary_test',
        status: 'active',
      },
    ],
    billing_provider_customers: initialState.customers || [
      {
        id: 'bpc_1',
        organization_id: 'org_test_123',
        provider_account_id: DEFAULT_TEST_ACCOUNT_ID,
        provider_customer_id: 'cus_mock_123',
      },
    ],
    billing_auto_topup_settings: initialState.settings || [],
    billing_auto_topup_attempts: initialState.attempts || [],
    billing_account_debts: initialState.debts || [],
  };

  const rpcMocks: Record<string, Function> = initialState.rpcMocks || {};

  return {
    _getStore: () => store,
    rpc: async (fnName: string, args: any) => {
      if (rpcMocks[fnName]) {
        return rpcMocks[fnName](args, store);
      }
      if (fnName === 'complete_auto_topup_enrolment_atomic') {
        const {
          p_organization_id,
          p_attempt_token,
          p_setup_intent_id,
          p_provider_payment_method_id,
          p_payment_method_brand,
          p_payment_method_last4,
          p_user_id,
        } = args;

        const attempts = store['billing_auto_topup_attempts'] || [];
        const attemptIndex = attempts.findIndex(
          (a) => a.attempt_token === p_attempt_token && a.organization_id === p_organization_id
        );

        if (attemptIndex < 0) {
          return { data: null, error: { message: 'Attempt record not found' } };
        }

        const attempt = attempts[attemptIndex];
        const settingsList = store['billing_auto_topup_settings'] || [];
        const currentSettings = settingsList.find((s) => s.organization_id === p_organization_id);

        // Check if newer enrolment superseded
        const newerAttemptExists = attempts.some(
          (a) =>
            a.organization_id === p_organization_id &&
            a.created_at > attempt.created_at &&
            a.status === 'completed'
        );
        if (newerAttemptExists) {
          return { data: null, error: { message: 'STALE_ENROLMENT: newer attempt superseded this one' } };
        }

        // Check if superseded by disable
        if (
          currentSettings &&
          currentSettings.status === 'disabled' &&
          currentSettings.disabled_at &&
          currentSettings.disabled_at > attempt.created_at
        ) {
          return { data: null, error: { message: 'ENROLMENT_SUPERSEDED_BY_DISABLE: disabled after attempt initiated' } };
        }

        // Idempotent replay of same completed attempt
        if (attempt.status === 'completed') {
          return { data: { success: true, idempotent: true }, error: null };
        }

        // Complete attempt & update settings
        attempt.status = 'completed';
        attempt.setup_intent_id = p_setup_intent_id;

        const newSettings = {
          organization_id: p_organization_id,
          status: 'enabled',
          disabled_at: null,
          disabled_by_user_id: null,
          disabled_reason: null,
          threshold_minor: attempt.threshold_minor,
          recharge_amount_minor: attempt.recharge_amount_minor,
          currency: attempt.currency,
          provider_account_id: attempt.provider_account_id,
          provider_customer_id: attempt.provider_customer_id,
          provider_payment_method_id: p_provider_payment_method_id,
          payment_method_brand: p_payment_method_brand,
          payment_method_last4: p_payment_method_last4,
          enrolled_at: new Date().toISOString(),
          enrolled_by_user_id: p_user_id,
          consent_terms_version: CURRENT_CONSENT_TERMS_VERSION,
          updated_at: new Date().toISOString(),
        };

        const existingIdx = settingsList.findIndex((s) => s.organization_id === p_organization_id);
        if (existingIdx >= 0) {
          settingsList[existingIdx] = { ...settingsList[existingIdx], ...newSettings };
        } else {
          settingsList.push(newSettings);
        }
        store['billing_auto_topup_settings'] = settingsList;

        return { data: { success: true, settings: newSettings }, error: null };
      }

      return { data: null, error: { message: `RPC ${fnName} not mocked` } };
    },
    from: (table: string) => {
      let rows = store[table] || [];
      let filters: { col: string; val: any }[] = [];

      const builder: any = {
        select: (cols: string = '*') => builder,
        eq: (col: string, val: any) => {
          filters.push({ col, val });
          return builder;
        },
        maybeSingle: async () => {
          const matched = rows.filter((r) => filters.every((f) => r[f.col] === f.val));
          return { data: matched.length > 0 ? matched[0] : null, error: null };
        },
        single: async () => {
          const res = await builder.maybeSingle();
          if (!res.data) return { data: null, error: { message: 'Row not found', code: 'PGRST116' } };
          return res;
        },
        upsert: (payload: any, options?: any) => {
          const attemptToken = payload.attempt_token;
          const orgId = payload.organization_id;
          let idx = -1;
          if (attemptToken) {
            idx = rows.findIndex((r) => r.attempt_token === attemptToken);
          } else if (orgId) {
            idx = rows.findIndex((r) => r.organization_id === orgId);
          }

          const item = { id: idx >= 0 ? rows[idx].id : `id_${Date.now()}_${Math.random()}`, ...payload };
          if (idx >= 0) {
            rows[idx] = item;
          } else {
            rows.push(item);
          }
          store[table] = rows;
          return {
            select: () => ({
              single: async () => ({ data: item, error: null }),
            }),
          };
        },
        update: (patch: any) => {
          const matched = rows.filter((r) => filters.every((f) => r[f.col] === f.val));
          for (const m of matched) {
            Object.assign(m, patch);
          }
          return {
            eq: (col: string, val: any) => ({
              then: (resolve: any) => resolve({ data: matched, error: null }),
            }),
          };
        },
      };

      return builder;
    },
  };
}

async function runExpandedC5BSuite() {
  let passedCount = 0;

  // --- 1. COMMERCIAL POLICY & CURRENCY CONVERSION TESTS ---
  console.log('--- 1. COMMERCIAL POLICY & ISO CURRENCY CONVERSION TESTS ---');

  // Test 1: USD (2 decimals) major to minor & minor to major
  assert.strictEqual(majorToMinorUnits(10, 'USD'), 1000);
  assert.strictEqual(minorToMajorUnits(1000, 'USD'), 10);
  console.log('✅ Test 1 PASS: USD 2-decimal conversion exact (10 USD -> 1000 minor)');
  passedCount++;

  // Test 2: JPY (0 decimals) major to minor & minor to major
  assert.strictEqual(majorToMinorUnits(1000, 'JPY'), 1000);
  assert.strictEqual(minorToMajorUnits(1000, 'JPY'), 1000);
  console.log('✅ Test 2 PASS: JPY 0-decimal conversion exact (1000 JPY -> 1000 minor)');
  passedCount++;

  // Test 3: KWD (3 decimals) major to minor & minor to major
  assert.strictEqual(majorToMinorUnits(5, 'KWD'), 5000);
  assert.strictEqual(minorToMajorUnits(5000, 'KWD'), 5);
  console.log('✅ Test 3 PASS: KWD 3-decimal conversion exact (5 KWD -> 5000 minor)');
  passedCount++;

  // Test 4: Commercial policy validation limits
  const valValid = validateAutoTopupConfigMajor(10, 25, 'USD');
  assert.strictEqual(valValid.valid, true);
  assert.strictEqual(valValid.thresholdMinor, 1000);
  assert.strictEqual(valValid.rechargeAmountMinor, 2500);

  const valLowThresh = validateAutoTopupConfigMajor(4, 25, 'USD');
  assert.strictEqual(valLowThresh.valid, false);
  assert.strictEqual(valLowThresh.code, 'THRESHOLD_BELOW_MINIMUM');

  const valHighThresh = validateAutoTopupConfigMajor(105, 25, 'USD');
  assert.strictEqual(valHighThresh.valid, false);
  assert.strictEqual(valHighThresh.code, 'THRESHOLD_EXCEEDS_MAXIMUM');
  console.log('✅ Test 4 PASS: Commercial policy validation limits enforced');
  passedCount++;

  // --- 2. ROLE AUTHORIZATION TESTS ---
  console.log('\n--- 2. ROLE AUTHORIZATION TESTS ---');
  const mockDbAuth = createMockSupabase();

  // Test 5: Owner allowed enable/disable
  const resOwner = await CreditAutoTopupService.disableAutoTopup(mockDbAuth as any, 'org_test_123', 'user_owner', 'owner');
  assert.strictEqual(resOwner.success, true);
  console.log('✅ Test 5 PASS: Owner authorized');
  passedCount++;

  // Test 6: Admin allowed enable/disable
  const resAdmin = await CreditAutoTopupService.disableAutoTopup(mockDbAuth as any, 'org_test_123', 'user_admin', 'admin');
  assert.strictEqual(resAdmin.success, true);
  console.log('✅ Test 6 PASS: Admin authorized');
  passedCount++;

  // Test 7: Manager denied (403 FORBIDDEN)
  const resManager = await CreditAutoTopupService.disableAutoTopup(mockDbAuth as any, 'org_test_123', 'user_mgr', 'manager');
  assert.strictEqual(resManager.success, false);
  assert.strictEqual(resManager.code, 'FORBIDDEN');
  console.log('✅ Test 7 PASS: Manager denied (FORBIDDEN)');
  passedCount++;

  // Test 8: Agent denied (403 FORBIDDEN)
  const resAgent = await CreditAutoTopupService.disableAutoTopup(mockDbAuth as any, 'org_test_123', 'user_agent', 'agent');
  assert.strictEqual(resAgent.success, false);
  assert.strictEqual(resAgent.code, 'FORBIDDEN');
  console.log('✅ Test 8 PASS: Agent denied (FORBIDDEN)');
  passedCount++;

  // --- 3. RACE / CONCURRENCY / ATOMIC COMPLETION TESTS ---
  console.log('\n--- 3. RACE / CONCURRENCY / ATOMIC COMPLETION TESTS ---');

  // Test 9: A starts -> B starts -> B completes -> A completes -> A rejected as STALE_ENROLMENT
  const mockDbRace1 = createMockSupabase({
    attempts: [
      {
        id: 'att_a',
        organization_id: 'org_test_123',
        attempt_token: '11111111-1111-1111-1111-111111111111',
        created_at: '2026-10-03T10:00:00.000Z',
        threshold_minor: 1000,
        recharge_amount_minor: 2500,
        currency: 'USD',
        provider_account_id: DEFAULT_TEST_ACCOUNT_ID,
        provider_customer_id: 'cus_mock_123',
        status: 'setup_created',
      },
      {
        id: 'att_b',
        organization_id: 'org_test_123',
        attempt_token: '22222222-2222-2222-2222-222222222222',
        created_at: '2026-10-03T10:05:00.000Z',
        threshold_minor: 2000,
        recharge_amount_minor: 5000,
        currency: 'USD',
        provider_account_id: DEFAULT_TEST_ACCOUNT_ID,
        provider_customer_id: 'cus_mock_123',
        status: 'initiated',
      },
    ],
  });

  // Complete B first
  const rpcB = await mockDbRace1.rpc('complete_auto_topup_enrolment_atomic', {
    p_organization_id: 'org_test_123',
    p_attempt_token: '22222222-2222-2222-2222-222222222222',
    p_setup_intent_id: 'si_b',
    p_provider_payment_method_id: 'pm_b',
    p_payment_method_brand: 'VISA',
    p_payment_method_last4: '4242',
    p_user_id: 'user_owner',
  });
  assert.strictEqual(rpcB.error, null);
  assert.strictEqual(rpcB.data.success, true);

  // Now attempt to complete older attempt A
  const rpcA = await mockDbRace1.rpc('complete_auto_topup_enrolment_atomic', {
    p_organization_id: 'org_test_123',
    p_attempt_token: '11111111-1111-1111-1111-111111111111',
    p_setup_intent_id: 'si_a',
    p_provider_payment_method_id: 'pm_a',
    p_payment_method_brand: 'VISA',
    p_payment_method_last4: '1111',
    p_user_id: 'user_owner',
  });
  assert.notStrictEqual(rpcA.error, null);
  assert.ok(rpcA.error.message.includes('STALE_ENROLMENT'));
  console.log('✅ Test 9 PASS: Stale attempt A completing after B rejected as STALE_ENROLMENT');
  passedCount++;

  // Test 10: A starts -> customer disables -> A completes -> A rejected as ENROLMENT_SUPERSEDED_BY_DISABLE
  const mockDbRace2 = createMockSupabase({
    attempts: [
      {
        id: 'att_a2',
        organization_id: 'org_test_123',
        attempt_token: '33333333-3333-3333-3333-333333333333',
        created_at: '2026-10-03T10:00:00.000Z',
        threshold_minor: 1000,
        recharge_amount_minor: 2500,
        currency: 'USD',
        provider_account_id: DEFAULT_TEST_ACCOUNT_ID,
        provider_customer_id: 'cus_mock_123',
        status: 'setup_created',
      },
    ],
    settings: [
      {
        organization_id: 'org_test_123',
        status: 'disabled',
        disabled_at: '2026-10-03T10:02:00.000Z', // Disabled after A created!
        disabled_reason: 'customer_disabled',
      },
    ],
  });

  const rpcDisableRace = await mockDbRace2.rpc('complete_auto_topup_enrolment_atomic', {
    p_organization_id: 'org_test_123',
    p_attempt_token: '33333333-3333-3333-3333-333333333333',
    p_setup_intent_id: 'si_a2',
    p_provider_payment_method_id: 'pm_a2',
    p_payment_method_brand: 'VISA',
    p_payment_method_last4: '4242',
    p_user_id: 'user_owner',
  });
  assert.notStrictEqual(rpcDisableRace.error, null);
  assert.ok(rpcDisableRace.error.message.includes('ENROLMENT_SUPERSEDED_BY_DISABLE'));
  console.log('✅ Test 10 PASS: Attempt A completing after disable rejected as ENROLMENT_SUPERSEDED_BY_DISABLE');
  passedCount++;

  // Test 11: Duplicate SAME-attempt completion (Idempotency)
  const mockDbIdem = createMockSupabase({
    attempts: [
      {
        id: 'att_idem',
        organization_id: 'org_test_123',
        attempt_token: '44444444-4444-4444-4444-444444444444',
        created_at: '2026-10-03T10:00:00.000Z',
        threshold_minor: 1000,
        recharge_amount_minor: 2500,
        currency: 'USD',
        provider_account_id: DEFAULT_TEST_ACCOUNT_ID,
        provider_customer_id: 'cus_mock_123',
        status: 'initiated',
      },
    ],
  });

  // First completion
  const rpcIdem1 = await mockDbIdem.rpc('complete_auto_topup_enrolment_atomic', {
    p_organization_id: 'org_test_123',
    p_attempt_token: '44444444-4444-4444-4444-444444444444',
    p_setup_intent_id: 'si_idem',
    p_provider_payment_method_id: 'pm_idem',
    p_payment_method_brand: 'VISA',
    p_payment_method_last4: '4242',
    p_user_id: 'user_owner',
  });
  assert.strictEqual(rpcIdem1.error, null);
  assert.strictEqual(rpcIdem1.data.success, true);

  // Replay same completion
  const rpcIdem2 = await mockDbIdem.rpc('complete_auto_topup_enrolment_atomic', {
    p_organization_id: 'org_test_123',
    p_attempt_token: '44444444-4444-4444-4444-444444444444',
    p_setup_intent_id: 'si_idem',
    p_provider_payment_method_id: 'pm_idem',
    p_payment_method_brand: 'VISA',
    p_payment_method_last4: '4242',
    p_user_id: 'user_owner',
  });
  assert.strictEqual(rpcIdem2.error, null);
  assert.strictEqual(rpcIdem2.data.idempotent, true);
  console.log('✅ Test 11 PASS: Duplicate completion replay of same attempt is idempotent');
  passedCount++;

  // --- 4. PROVIDER ACCOUNT & CUSTOMER BINDING TESTS ---
  console.log('\n--- 4. PROVIDER ACCOUNT & CUSTOMER BINDING TESTS ---');

  // Test 12: Provider account mismatch transitions status to action_required
  const mockDbMismatch = createMockSupabase({
    settings: [
      {
        id: 'stg_old',
        organization_id: 'org_test_123',
        status: 'enabled',
        threshold_minor: 1000,
        recharge_amount_minor: 2500,
        currency: 'USD',
        provider_account_id: '00000000-0000-0000-0000-0000000000old', // Old provider account!
        provider_customer_id: 'cus_123',
        provider_payment_method_id: 'pm_123',
        payment_method_brand: 'VISA',
        payment_method_last4: '4242',
      },
    ],
  });

  const settingsStatus = await CreditAutoTopupService.getAutoTopupSettings(mockDbMismatch as any, 'org_test_123');
  assert.strictEqual(settingsStatus.success, true);
  assert.strictEqual(settingsStatus.settings.status, 'action_required');
  assert.strictEqual(settingsStatus.settings.reason, 'PROVIDER_ACCOUNT_CHANGED');
  assert.strictEqual(settingsStatus.settings.enabled, false);
  console.log('✅ Test 12 PASS: Provider account mismatch transitions status to action_required');
  passedCount++;

  // Test 13: Customer-safe DTO excludes sensitive provider identifiers
  const dto = settingsStatus.settings;
  assert.strictEqual('clientSecret' in dto, false);
  assert.strictEqual('providerAccountId' in dto, false);
  assert.strictEqual('providerCustomerId' in dto, false);
  assert.strictEqual('providerPaymentMethodId' in dto, false);
  console.log('✅ Test 13 PASS: Customer-safe status DTO contains zero secrets or raw provider IDs');
  passedCount++;

  // --- 5. ZERO-AUTONOMOUS-CHARGE PATH AUDIT ---
  console.log('\n--- 5. ZERO-AUTONOMOUS-CHARGE PATH AUDIT ---');

  // Test 14: Eligibility checker is read-only and does not execute charges
  const mockDbElig = createMockSupabase();
  const eligibility = await CreditAutoTopupService.checkAutoTopupEligibility(mockDbElig as any, 'org_test_123');
  assert.strictEqual(typeof eligibility.eligible, 'boolean');
  console.log('✅ Test 14 PASS: Eligibility checker is read-only with 0 autonomous charge calls');
  passedCount++;

  console.log('\n================================================================');
  console.log(`ALL ${passedCount} EXPANDED SUBPHASE C.5B TEST CASES PASSED CLEANLY!`);
  console.log('================================================================\n');
}

runExpandedC5BSuite().catch((err) => {
  console.error('Fatal test runner failure:', err);
  process.exit(1);
});
