export {};

// Mock server-only module for tsx test runner environment
const moduleObj = require('module');
try {
  const resolved = require.resolve('server-only');
  moduleObj._cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: {} };
} catch {}

const assert = require('assert');
const { IvrService } = require('../src/lib/telephony/ivrService');

function createMockSupabase(planCode: string = 'pro') {
  const orgId = `org-${planCode}`;
  const userId = `user-${planCode}`;
  const planId = `plan-${planCode}-id`;

  return {
    auth: {
      getUser: async () => ({ data: { user: { id: userId } }, error: null }),
    },
    from: (table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: userId, organization_id: orgId, active: true, role: 'owner' },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'organization_subscriptions') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: `sub-${planCode}`, organization_id: orgId, plan_id: planId, status: 'active' },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'plans') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: planId, code: planCode, stable_key: planCode, name: planCode, is_active: true },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'plan_entitlements') {
        return {
          select: () => ({
            eq: () => ({
              then: (resolve: any) => {
                const ents: any[] = [];
                if (planCode === 'pro') {
                  ents.push({ feature_code: 'ivr', enabled: true, numeric_value: null, text_value: null });
                  ents.push({ feature_code: 'voicemail', enabled: true, numeric_value: null, text_value: null });
                  ents.push({ feature_code: 'call_queue', enabled: true, numeric_value: null, text_value: null });
                } else if (planCode === 'business') {
                  ents.push({ feature_code: 'ivr', enabled: false, numeric_value: null, text_value: null });
                  ents.push({ feature_code: 'voicemail', enabled: true, numeric_value: null, text_value: null });
                  ents.push({ feature_code: 'call_queue', enabled: true, numeric_value: null, text_value: null });
                } else {
                  ents.push({ feature_code: 'ivr', enabled: false, numeric_value: null, text_value: null });
                  ents.push({ feature_code: 'voicemail', enabled: false, numeric_value: null, text_value: null });
                  ents.push({ feature_code: 'call_queue', enabled: false, numeric_value: null, text_value: null });
                }
                resolve({ data: ents, error: null });
              },
            }),
          }),
        };
      }
      if (table === 'ivr_menus') {
        return {
          insert: (data: any) => ({
            select: () => ({
              single: async () => ({
                data: { id: 'menu-1', organization_id: orgId, ...data },
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      };
    },
  };
}

async function runTests() {
  console.log('====================================================');
  console.log('  VOIP HUB — PHASE 19E.2 COMPREHENSIVE TEST SUITE   ');
  console.log('====================================================\n');

  // ---------------------------------------------------------
  // 1. ENTITLEMENT MATRIX VERIFICATION
  // ---------------------------------------------------------
  console.log('[TEST 1] Starter plan IVR entitlement is FALSE (Denied)');
  const starterMock = createMockSupabase('starter');
  const starterIvr = await IvrService.createIvrMenu('org-starter', { name: 'Test Menu' }, starterMock as any);
  assert.strictEqual(starterIvr.success, false);
  assert.strictEqual(starterIvr.message.includes('not enabled'), true);
  console.log('[PASS] Starter plan IVR entitlement is FALSE');

  console.log('[TEST 2] Pro plan IVR entitlement is TRUE (Allowed)');
  const proMock = createMockSupabase('pro');
  const proIvr = await IvrService.createIvrMenu('org-pro', { name: 'Pro Menu' }, proMock as any);
  assert.strictEqual(proIvr.success, true);
  console.log('[PASS] Pro plan IVR entitlement is TRUE');

  console.log('[TEST 3] Business plan IVR entitlement remains FALSE (Disabled)');
  const bizMock = createMockSupabase('business');
  const bizIvr = await IvrService.createIvrMenu('org-business', { name: 'Biz Menu' }, bizMock as any);
  assert.strictEqual(bizIvr.success, false);
  assert.strictEqual(bizIvr.message.includes('not enabled'), true);
  console.log('[PASS] Business plan IVR entitlement remains FALSE');

  // ---------------------------------------------------------
  // 2. VALIDATION & SECURITY CHECKS
  // ---------------------------------------------------------
  console.log('[TEST 4] Voicemail destination is valid for entitled Pro');
  const vmVal = await IvrService.validateDestination('org-pro', 'voicemail', null, null, proMock as any);
  assert.strictEqual(vmVal.valid, true);
  console.log('[PASS] Voicemail destination is valid for entitled Pro');

  console.log('[TEST 5] Voicemail destination is denied for Starter');
  const starterVmVal = await IvrService.validateDestination('org-starter', 'voicemail', null, null, starterMock as any);
  assert.strictEqual(starterVmVal.valid, false);
  console.log('[PASS] Voicemail destination is denied for Starter');

  console.log('[TEST 6] Self-referential Call Menu loop is strictly rejected');
  const selfLoopVal = await IvrService.validateDestination('org-pro', 'ivr', 'menu-1', 'menu-1', proMock as any);
  assert.strictEqual(selfLoopVal.valid, false);
  assert.strictEqual(selfLoopVal.message.includes('cannot route to itself'), true);
  console.log('[PASS] Self-referential Call Menu loop is strictly rejected');

  console.log('[TEST 7] Hangup destination is valid');
  const hangupVal = await IvrService.validateDestination('org-pro', 'hangup', null, null, proMock as any);
  assert.strictEqual(hangupVal.valid, true);
  console.log('[PASS] Hangup destination is valid');

  console.log('[TEST 8] User destination requires destination ID');
  const emptyUserVal = await IvrService.validateDestination('org-pro', 'user', '', null, proMock as any);
  assert.strictEqual(emptyUserVal.valid, false);
  console.log('[PASS] User destination requires destination ID');

  console.log('[TEST 9] Call Queue destination is denied when deferred in V1');
  const queueVal = await IvrService.validateDestination('org-pro', 'call_queue', 'queue-1', null, proMock as any);
  assert.strictEqual(queueVal.valid, false);
  console.log('[PASS] Call Queue destination is denied when deferred in V1');

  console.log('====================================================');
  console.log(' RESULTS: ALL 9 PHASE 19E.2 TESTS PASSED CLEANLY');
  console.log('====================================================\n');
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
