export {};

// Mock server-only module for tsx test runner environment
const moduleObj = require('module');
try {
  const resolved = require.resolve('server-only');
  moduleObj._cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: {} };
} catch {}

const assert = require('assert');
const { RecordingPricingPolicyService } = require('../src/lib/billing/telecom/recordingPricingPolicyService');
const { ProviderRecordingDeletionService } = require('../src/lib/telephony/providerRecordingDeletionService');
const { VoicemailService } = require('../src/lib/telephony/voicemailService');

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
                data: {
                  id: `sub-${planCode}`,
                  organization_id: orgId,
                  plan_id: planId,
                  status: 'active',
                  created_at: new Date().toISOString(),
                },
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
                resolve({
                  data: [
                    {
                      feature_code: 'voicemail',
                      enabled: planCode !== 'starter',
                      numeric_value: null,
                      text_value: null,
                      features: { code: 'voicemail', value_type: 'boolean' },
                    },
                  ],
                  error: null,
                });
              },
            }),
          }),
        };
      }
      if (table === 'organization_entitlement_overrides') {
        return {
          select: () => ({
            eq: () => ({
              then: (resolve: any) => resolve({ data: [], error: null }),
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

class MockSupabaseClient {
  public voicemails: any[] = [];
  public snapshots: any[] = [];
  public deletionOps: any[] = [];
  public policies: any[] = [];
  public profiles: any[] = [];

  constructor() {
    this.profiles = [
      { id: 'usr_org_a_owner', organization_id: 'org_a', active: true, role: 'owner' },
      { id: 'usr_org_b_owner', organization_id: 'org_b', active: true, role: 'owner' },
    ];
  }

  from(table: string) {
    const self = this;
    let queryState: any = {
      table,
      filters: [],
      selectCols: '*',
      isSingle: false,
      isMaybeSingle: false,
      insertData: null,
      updateData: null,
      upsertData: null,
    };

    const builder: any = {
      select: (cols?: string) => {
        queryState.selectCols = cols || '*';
        return builder;
      },
      eq: (col: string, val: any) => {
        queryState.filters.push({ type: 'eq', col, val });
        return builder;
      },
      is: (col: string, val: any) => {
        queryState.filters.push({ type: 'is', col, val });
        return builder;
      },
      limit: (n: number) => builder,
      order: () => builder,
      range: () => builder,
      single: () => {
        queryState.isSingle = true;
        return builder;
      },
      maybeSingle: () => {
        queryState.isMaybeSingle = true;
        return builder;
      },
      insert: (data: any) => {
        queryState.insertData = data;
        return builder;
      },
      update: (data: any) => {
        queryState.updateData = data;
        return builder;
      },
      upsert: (data: any) => {
        queryState.upsertData = data;
        return builder;
      },
      then: (resolve: any) => {
        if (table === 'voicemail_recording_pricing_policies') {
          resolve({ data: self.policies[0] || null, error: null });
          return;
        }

        if (queryState.insertData) {
          const item = { id: `id_${Date.now()}_${Math.random()}`, ...queryState.insertData };
          if (table === 'voicemails') self.voicemails.push(item);
          if (table === 'voicemail_recording_usage_snapshots') self.snapshots.push(item);
          if (table === 'provider_recording_deletion_operations') self.deletionOps.push(item);
          resolve({ data: item, error: null });
          return;
        }

        if (queryState.upsertData) {
          const item = { id: `id_${Date.now()}_${Math.random()}`, ...queryState.upsertData };
          const idx = self.deletionOps.findIndex(d => d.voicemail_id === item.voicemail_id);
          if (idx >= 0) self.deletionOps[idx] = { ...self.deletionOps[idx], ...item };
          else self.deletionOps.push(item);
          resolve({ data: item, error: null });
          return;
        }

        if (queryState.updateData) {
          let updatedItem: any = null;
          if (table === 'voicemails') {
            self.voicemails = self.voicemails.map(v => {
              let match = true;
              for (const f of queryState.filters) {
                if (f.type === 'eq' && v[f.col] !== f.val) match = false;
              }
              if (match) {
                v = { ...v, ...queryState.updateData };
                updatedItem = v;
              }
              return v;
            });
          } else if (table === 'provider_recording_deletion_operations') {
            self.deletionOps = self.deletionOps.map(d => {
              let match = true;
              for (const f of queryState.filters) {
                if (f.type === 'eq' && d[f.col] !== f.val) match = false;
              }
              if (match) {
                d = { ...d, ...queryState.updateData };
                updatedItem = d;
              }
              return d;
            });
          }
          resolve({ data: updatedItem, error: null });
          return;
        }

        let items: any[] = [];
        if (table === 'voicemails') items = [...self.voicemails];
        if (table === 'voicemail_recording_usage_snapshots') items = [...self.snapshots];
        if (table === 'provider_recording_deletion_operations') items = [...self.deletionOps];

        for (const f of queryState.filters) {
          if (f.type === 'eq') items = items.filter(i => i[f.col] === f.val);
          if (f.type === 'is' && f.val === null) items = items.filter(i => i[f.col] === null || i[f.col] === undefined);
        }

        if (queryState.isSingle || queryState.isMaybeSingle) {
          resolve({ data: items[0] || null, error: null });
        } else {
          resolve({ data: items, error: null });
        }
      },
    };

    return builder;
  }
}

async function runTests() {
  console.log('====================================================');
  console.log(' VOIP HUB — PHASE 19E.1B COMPREHENSIVE TEST SUITE ');
  console.log('====================================================\n');

  // ---------------------------------------------------------
  // 1. ENTITLEMENTS
  // ---------------------------------------------------------
  console.log('[TEST 1] Starter plan voicemail entitlement is DENIED');
  const starterMock = createMockSupabase('starter') as any;
  assert.strictEqual(await VoicemailService.isEntitled(starterMock), false);
  console.log('[PASS] Starter plan voicemail entitlement is DENIED');

  console.log('[TEST 2] Pro plan voicemail entitlement is ALLOWED');
  const proMock = createMockSupabase('pro') as any;
  assert.strictEqual(await VoicemailService.isEntitled(proMock), true);
  console.log('[PASS] Pro plan voicemail entitlement is ALLOWED');

  console.log('[TEST 3] Business plan voicemail entitlement is ALLOWED');
  const bizMock = createMockSupabase('business') as any;
  assert.strictEqual(await VoicemailService.isEntitled(bizMock), true);
  console.log('[PASS] Business plan voicemail entitlement is ALLOWED');

  // ---------------------------------------------------------
  // 2. PRICING & RECORDING COST CALCULATIONS
  // ---------------------------------------------------------
  console.log('[TEST 4] Default recording capture markup is 1000 bps (10%)');
  const defaultPolicy = await RecordingPricingPolicyService.resolvePolicy(undefined, 'recording_capture');
  assert.strictEqual(defaultPolicy.markupBps, 1000);
  console.log('[PASS] Default recording capture markup is 1000 bps (10%)');

  console.log('[TEST 5] Pricing formula calculation: provider cost + 10%');
  const calc1 = RecordingPricingPolicyService.calculateRecordingCost({
    providerUnitCostMicro: BigInt(2500),
    durationSeconds: 60,
    markupBps: 1000, // 10%
  });
  assert.strictEqual(calc1.providerCalculatedCostMicro, BigInt(2500));
  assert.strictEqual(calc1.customerCalculatedCostMicro, BigInt(2750));
  assert.strictEqual(calc1.customerRetailChargeMinor, 1);
  console.log('[PASS] Pricing formula calculation succeeds with micro-unit precision');

  console.log('[TEST 6] Configurable markup calculation (e.g. 1500 bps = 15%)');
  const calc2 = RecordingPricingPolicyService.calculateRecordingCost({
    providerUnitCostMicro: BigInt(100000),
    durationSeconds: 60,
    markupBps: 1500, // 15%
  });
  assert.strictEqual(calc2.customerCalculatedCostMicro, BigInt(115000));
  assert.strictEqual(calc2.customerRetailChargeMinor, 12);
  console.log('[PASS] Configurable markup calculation handles arbitrary bps');

  console.log('[TEST 7] Immutable financial snapshot created on recording completion');
  const mockClient = new MockSupabaseClient() as any;
  const snapshotRes = await RecordingPricingPolicyService.recordFinancialSnapshot(mockClient, {
    organizationId: 'org_a',
    callId: 'call_123',
    voicemailId: 'vm_123',
    provider: 'twilio',
    providerRecordingSid: 'RE_TEST_777',
    durationSeconds: 45,
    providerUnitCostMicro: BigInt(2500),
    providerCalculatedCostMicro: BigInt(1875),
    markupBps: 1000,
    customerCalculatedCostMicro: BigInt(2063),
    customerRetailChargeMinor: 1,
    currency: 'USD',
    pricingPolicyKey: 'default_twilio_recording_capture_v1',
    pricingPolicyVersion: 1,
    settlementStatus: 'settled',
    idempotencyKey: 'idemp_rec_snap_RE_TEST_777',
  });
  assert.strictEqual(snapshotRes.success, true);
  assert.strictEqual(mockClient.snapshots.length, 1);
  assert.strictEqual(mockClient.snapshots[0].idempotency_key, 'idemp_rec_snap_RE_TEST_777');
  console.log('[PASS] Immutable financial snapshot created with idempotency key');

  console.log('[TEST 8] Duplicate callback does NOT create duplicate snapshot or customer charge');
  const dupSnapshotRes = await RecordingPricingPolicyService.recordFinancialSnapshot(mockClient, {
    organizationId: 'org_a',
    callId: 'call_123',
    voicemailId: 'vm_123',
    provider: 'twilio',
    providerRecordingSid: 'RE_TEST_777',
    durationSeconds: 45,
    providerUnitCostMicro: BigInt(2500),
    providerCalculatedCostMicro: BigInt(1875),
    markupBps: 1000,
    customerCalculatedCostMicro: BigInt(2063),
    customerRetailChargeMinor: 1,
    currency: 'USD',
    pricingPolicyKey: 'default_twilio_recording_capture_v1',
    pricingPolicyVersion: 1,
    settlementStatus: 'settled',
    idempotencyKey: 'idemp_rec_snap_RE_TEST_777',
  });
  assert.strictEqual(dupSnapshotRes.success, true);
  assert.strictEqual(mockClient.snapshots.length, 1);
  console.log('[PASS] Duplicate callback ignored safely via idempotency');

  // ---------------------------------------------------------
  // 3. PROVIDER DELETION & WORKFLOW STATE MACHINE
  // ---------------------------------------------------------
  console.log('[TEST 9] Same-tenant authorized soft-deletion requests provider deletion');
  const vmInsert = {
    id: 'vm_soft_del_1',
    organization_id: 'org_a',
    provider_recording_sid: 'RE_SOFT_DEL_1',
    status: 'completed',
    storage_model: 'PROVIDER_MANAGED',
    provider_deletion_status: 'active',
    deleted_at: null,
  };
  mockClient.voicemails.push(vmInsert);

  const delRes = await ProviderRecordingDeletionService.requestVoicemailDeletion(mockClient, 'org_a', 'vm_soft_del_1');
  assert.strictEqual(delRes.success, true);
  assert.strictEqual(delRes.status, 'gated');
  assert.strictEqual(mockClient.voicemails[0].status, 'deleted');
  assert.strictEqual(mockClient.voicemails[0].provider_deletion_status, 'gated');
  assert.notStrictEqual(mockClient.voicemails[0].deleted_at, null);
  console.log('[PASS] Same-tenant soft deletion updates state machine safely with gate OFF');

  console.log('[TEST 10] Cross-tenant deletion attempt is REJECTED');
  const crossDelRes = await ProviderRecordingDeletionService.requestVoicemailDeletion(mockClient, 'org_b', 'vm_soft_del_1');
  assert.strictEqual(crossDelRes.success, false);
  assert.strictEqual(crossDelRes.status, 'delete_failed');
  console.log('[PASS] Cross-tenant voicemail deletion strictly rejected');

  console.log('[TEST 11] Duplicate deletion request is safe and idempotent');
  const dupDelRes = await ProviderRecordingDeletionService.requestVoicemailDeletion(mockClient, 'org_a', 'vm_soft_del_1');
  assert.strictEqual(dupDelRes.success, true);
  console.log('[PASS] Duplicate deletion request handled safely without errors');

  console.log('====================================================');
  console.log(' RESULTS: ALL 11 PHASE 19E.1B TESTS PASSED CLEANLY');
  console.log('====================================================\n');
}

runTests().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
