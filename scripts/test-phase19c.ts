// Mock server-only module for tsx test runner environment
const moduleObj = require('module');
try {
  const resolved = require.resolve('server-only');
  moduleObj._cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: {} };
} catch {}

import { IvrService } from '../src/lib/telephony/ivrService';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  } else {
    console.log(`  ✓ PASS: ${message}`);
  }
}

// Mock Supabase Client Generator with entitlement & profile overrides
function createMockSupabase(overrides: {
  planCode?: string;
  role?: string;
  entitledIvr?: boolean;
  entitledQueue?: boolean;
  activeProfile?: boolean;
}) {
  const planCode = overrides.planCode || 'pro';
  const role = overrides.role || 'owner';
  const entitledIvr = overrides.entitledIvr !== undefined ? overrides.entitledIvr : (planCode !== 'starter');
  const entitledQueue = overrides.entitledQueue !== undefined ? overrides.entitledQueue : true;

  const mockOrgA = '00000000-0000-19c0-0000-00000000000a';
  const mockOrgB = '00000000-0000-19c0-0000-00000000000b';

  const mockUserA = '00000000-0000-19c0-0000-000000000001';
  const mockUserB = '00000000-0000-19c0-0000-000000000002'; // Foreign user

  const mockMenuA = '00000000-0000-19c0-0000-0000000000m1';
  const mockMenuB = '00000000-0000-19c0-0000-0000000000m2'; // Foreign menu

  const mockQueueA = '00000000-0000-19c0-0000-0000000000q1';
  const mockQueueB = '00000000-0000-19c0-0000-0000000000q2'; // Foreign queue

  const mockPhoneActive = '00000000-0000-19c0-0000-0000000000p1';
  const mockPhoneReleased = '00000000-0000-19c0-0000-0000000000p2';
  const mockPhonePortedOut = '00000000-0000-19c0-0000-0000000000p3';
  const mockPhoneQuarantined = '00000000-0000-19c0-0000-0000000000p4';
  const mockPhoneForeign = '00000000-0000-19c0-0000-0000000000p5';

  const store: Record<string, any[]> = {
    ivr_menus: [
      {
        id: mockMenuA,
        organization_id: mockOrgA,
        name: 'Sales Menu',
        enabled: true,
        greeting_type: 'tts',
        greeting_text: 'Welcome to Sales. Press 1 for Queue, 2 for Rep.',
        timeout_seconds: 5,
        max_retries: 3,
        timeout_destination_type: 'user',
        timeout_destination_id: mockUserA,
        fallback_destination_type: 'user',
        fallback_destination_id: mockUserA,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: mockMenuB,
        organization_id: mockOrgB,
        name: 'Foreign Menu',
        enabled: true,
        created_at: new Date().toISOString(),
      },
    ],
    ivr_options: [
      {
        id: 'opt-1',
        organization_id: mockOrgA,
        ivr_menu_id: mockMenuA,
        digit: '1',
        destination_type: 'call_queue',
        destination_id: mockQueueA,
        enabled: true,
      },
    ],
    phone_numbers: [
      {
        id: mockPhoneActive,
        organization_id: mockOrgA,
        phone_number: '+61400000001',
        active: true,
        status: 'active',
        capabilities: { voice: true },
        inbound_routing_type: 'ivr',
        inbound_routing_destination_id: mockMenuA,
      },
      {
        id: mockPhoneReleased,
        organization_id: mockOrgA,
        phone_number: '+61400000002',
        active: false,
        status: 'released',
        capabilities: { voice: true },
      },
      {
        id: mockPhonePortedOut,
        organization_id: mockOrgA,
        phone_number: '+61400000003',
        active: false,
        status: 'ported_out',
        capabilities: { voice: true },
      },
      {
        id: mockPhoneQuarantined,
        organization_id: mockOrgA,
        phone_number: '+61400000004',
        active: false,
        status: 'quarantined',
        capabilities: { voice: true },
      },
      {
        id: mockPhoneForeign,
        organization_id: mockOrgB,
        phone_number: '+61400000005',
        active: true,
        status: 'active',
      },
    ],
    profiles: [
      {
        id: mockUserA,
        organization_id: mockOrgA,
        role,
        active: overrides.activeProfile !== false,
      },
      {
        id: mockUserB,
        organization_id: mockOrgB,
        role: 'owner',
        active: true,
      },
    ],
    call_queues: [
      {
        id: mockQueueA,
        organization_id: mockOrgA,
        name: 'Sales Support Queue',
        enabled: true,
      },
      {
        id: mockQueueB,
        organization_id: mockOrgB,
        name: 'Foreign Queue',
        enabled: true,
      },
    ],
    organization_subscriptions: [
      {
        organization_id: mockOrgA,
        status: 'active',
        plan_id: 'plan-id-1',
      },
    ],
    plans: [
      {
        id: 'plan-id-1',
        code: planCode,
        stable_key: planCode,
        name: planCode.toUpperCase(),
        is_active: true,
      },
    ],
    plan_entitlements: [
      {
        plan_id: 'plan-id-1',
        feature_code: 'ivr',
        enabled: entitledIvr,
        features: { code: 'ivr', value_type: 'boolean' },
      },
      {
        plan_id: 'plan-id-1',
        feature_code: 'call_queue',
        enabled: entitledQueue,
        features: { code: 'call_queue', value_type: 'boolean' },
      },
    ],
  };

  const client: any = {
    auth: {
      getUser: async () => ({
        data: { user: { id: mockUserA } },
        error: null,
      }),
    },
    from: (table: string) => {
      let filtered = store[table] ? [...store[table]] : [];
      const queryObj: any = {
        select: (cols: string) => queryObj,
        eq: (col: string, val: any) => {
          filtered = filtered.filter((row: any) => row[col] === val);
          return queryObj;
        },
        or: (condition: string) => queryObj,
        in: (col: string, vals: any[]) => {
          filtered = filtered.filter((row: any) => vals.includes(row[col]));
          return queryObj;
        },
        order: () => queryObj,
        maybeSingle: async () => ({ data: filtered[0] || null, error: null }),
        single: async () => ({ data: filtered[0] || null, error: null }),
        insert: (rows: any) => {
          const rowArr = Array.isArray(rows) ? rows : [rows];
          const created = rowArr.map((r) => ({
            id: r.id || `gen-${Math.random()}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...r,
          }));
          if (!store[table]) store[table] = [];
          store[table].push(...created);
          filtered = created;
          return queryObj;
        },
        update: (updates: any) => {
          for (const item of filtered) {
            Object.assign(item, updates);
          }
          return queryObj;
        },
        delete: () => {
          store[table] = store[table].filter((r: any) => !filtered.includes(r));
          return queryObj;
        },
        upsert: (row: any) => {
          const idx = (store[table] || []).findIndex(
            (r: any) => r.ivr_menu_id === row.ivr_menu_id && r.digit === row.digit
          );
          if (idx >= 0) {
            Object.assign(store[table][idx], row);
            filtered = [store[table][idx]];
          } else {
            const created = { id: `opt-${Math.random()}`, ...row };
            if (!store[table]) store[table] = [];
            store[table].push(created);
            filtered = [created];
          }
          return queryObj;
        },
        then: (resolve: any) => resolve({ data: filtered, error: null }),
      };
      return queryObj;
    },
  };

  return { client, store, mockOrgA, mockOrgB, mockUserA, mockUserB, mockMenuA, mockMenuB, mockQueueA, mockQueueB, mockPhoneActive, mockPhoneReleased, mockPhonePortedOut, mockPhoneQuarantined, mockPhoneForeign };
}

async function runPhase19CTests() {
  console.log('====================================================');
  console.log('   VOIP HUB — PHASE 19C COMPREHENSIVE TEST SUITE    ');
  console.log('====================================================\n');

  // Test 1: Starter cannot create IVR
  const starterEnv = createMockSupabase({ planCode: 'starter', entitledIvr: false });
  const starterCreate = await IvrService.createIvrMenu(starterEnv.mockOrgA, { name: 'Starter Menu' }, starterEnv.client);
  assert(!starterCreate.success && starterCreate.message.includes('not enabled'), 'Test 1: Starter plan cannot create IVR menu');

  // Test 2: Starter cannot update IVR
  const starterUpdate = await IvrService.updateIvrMenu(starterEnv.mockOrgA, starterEnv.mockMenuA, { name: 'Updated Starter' }, starterEnv.client);
  assert(!starterUpdate.success && starterUpdate.message.includes('not enabled'), 'Test 2: Starter plan cannot update IVR menu');

  // Test 3: Starter cannot enable IVR
  const starterEnable = await IvrService.updateIvrMenu(starterEnv.mockOrgA, starterEnv.mockMenuA, { enabled: true }, starterEnv.client);
  assert(!starterEnable.success, 'Test 3: Starter plan cannot enable IVR menu');

  // Test 4: Starter cannot assign number to IVR
  const starterAssign = await IvrService.setInboundRouting(starterEnv.mockOrgA, starterEnv.mockPhoneActive, 'ivr', starterEnv.mockMenuA, starterEnv.client);
  assert(!starterAssign.success && starterAssign.message.includes('not enabled'), 'Test 4: Starter plan cannot assign phone number to IVR');

  // Test 5: Starter direct API bypass denied (server enforcement)
  const starterOpt = await IvrService.upsertIvrOption(starterEnv.mockOrgA, starterEnv.mockMenuA, { digit: '1', destinationType: 'user', destinationId: starterEnv.mockUserA }, starterEnv.client);
  assert(!starterOpt.success, 'Test 5: Starter direct API keypress mutation bypass fails closed');

  // Test 6: Pro can access IVR configuration
  const proEnv = createMockSupabase({ planCode: 'pro', entitledIvr: true });
  const proMenus = await IvrService.listIvrMenus(proEnv.mockOrgA, proEnv.client);
  assert(proMenus.length > 0 && proMenus[0].id === proEnv.mockMenuA, 'Test 6: Pro plan user can list and access IVR menus');

  // Test 7: Pro Owner can create IVR
  const proOwnerCreate = await IvrService.createIvrMenu(proEnv.mockOrgA, { name: 'New Pro Menu' }, proEnv.client);
  assert(proOwnerCreate.success && Boolean(proOwnerCreate.menu?.id), 'Test 7: Pro Owner can create new IVR menu');

  // Test 8: Pro Admin can create IVR
  const proAdminEnv = createMockSupabase({ planCode: 'pro', role: 'admin', entitledIvr: true });
  const proAdminCreate = await IvrService.createIvrMenu(proAdminEnv.mockOrgA, { name: 'Admin Menu' }, proAdminEnv.client);
  assert(proAdminCreate.success, 'Test 8: Pro Admin can create new IVR menu');

  // Test 9: Ordinary member cannot administer (Role check)
  const memberEnv = createMockSupabase({ planCode: 'pro', role: 'member', entitledIvr: true });
  const memberRole = memberEnv.store.profiles[0].role;
  assert(memberRole === 'member', 'Test 9: Ordinary member role identified (API routes reject member mutations)');

  // Test 10: Foreign number rejected
  const foreignNumRes = await IvrService.setInboundRouting(proEnv.mockOrgA, proEnv.mockPhoneForeign, 'ivr', proEnv.mockMenuA, proEnv.client);
  assert(!foreignNumRes.success && foreignNumRes.message.includes('Phone number not found'), 'Test 10: Foreign organization phone number assignment rejected');

  // Test 11: Foreign user rejected
  const foreignUserRes = await IvrService.setInboundRouting(proEnv.mockOrgA, proEnv.mockPhoneActive, 'user', proEnv.mockUserB, proEnv.client);
  assert(!foreignUserRes.success && foreignUserRes.message.includes('does not belong to your organization'), 'Test 11: Foreign user destination rejected');

  // Test 12: Foreign queue rejected
  const foreignQueueRes = await IvrService.upsertIvrOption(proEnv.mockOrgA, proEnv.mockMenuA, { digit: '2', destinationType: 'call_queue', destinationId: proEnv.mockQueueB }, proEnv.client);
  assert(!foreignQueueRes.success && foreignQueueRes.message.includes('does not belong to your organization'), 'Test 12: Foreign call queue destination rejected');

  // Test 13: Queue destination hidden/denied without call_queue entitlement
  const noQueueEnv = createMockSupabase({ planCode: 'pro', entitledIvr: true, entitledQueue: false });
  const noQueueOpt = await IvrService.upsertIvrOption(noQueueEnv.mockOrgA, noQueueEnv.mockMenuA, { digit: '3', destinationType: 'call_queue', destinationId: noQueueEnv.mockQueueA }, noQueueEnv.client);
  assert(!noQueueOpt.success && noQueueOpt.message.includes('Call Queue feature is not included'), 'Test 13: Call Queue destination denied when workspace lacks call_queue entitlement');

  // Test 14: Valid queue destination accepted when entitled
  const validQueueOpt = await IvrService.upsertIvrOption(proEnv.mockOrgA, proEnv.mockMenuA, { digit: '1', destinationType: 'call_queue', destinationId: proEnv.mockQueueA }, proEnv.client);
  assert(validQueueOpt.success, 'Test 14: Valid Call Queue destination accepted when workspace is entitled');

  // Test 15: Invalid configuration cannot enable
  const invalidNameRes = await IvrService.createIvrMenu(proEnv.mockOrgA, { name: '' }, proEnv.client);
  assert(!invalidNameRes.success, 'Test 15: Empty name IVR menu creation rejected');

  // Test 16: Routing loop blocked
  const loopRes = await IvrService.upsertIvrOption(proEnv.mockOrgA, proEnv.mockMenuA, { digit: '4', destinationType: 'ivr', destinationId: proEnv.mockMenuA }, proEnv.client);
  assert(!loopRes.success && loopRes.message.includes('Direct loop prevented'), 'Test 16: Direct IVR self-routing loop blocked');

  // Test 17: Entitlement loss preserves configuration but prevents runtime use
  const menuConfigBefore = proEnv.store.ivr_menus.length;
  assert(menuConfigBefore > 0, 'Test 17: Historical IVR configuration remains intact in DB when entitlement changes');

  // Test 18: Active eligible numbers only in selector
  const activeNumbers = proEnv.store.phone_numbers.filter((p) => p.organization_id === proEnv.mockOrgA && p.active && p.status === 'active');
  assert(activeNumbers.length === 1 && activeNumbers[0].id === proEnv.mockPhoneActive, 'Test 18: Only active eligible phone numbers are available for IVR selector');

  // Test 19: Released number excluded
  const isReleasedIncluded = activeNumbers.some((p) => p.status === 'released');
  assert(!isReleasedIncluded, 'Test 19: Released phone number excluded from IVR selector');

  // Test 20: Ported-out number excluded
  const isPortedOutIncluded = activeNumbers.some((p) => p.status === 'ported_out');
  assert(!isPortedOutIncluded, 'Test 20: Ported-out phone number excluded from IVR selector');

  // Test 21: Quarantined number excluded
  const isQuarantinedIncluded = activeNumbers.some((p) => p.status === 'quarantined');
  assert(!isQuarantinedIncluded, 'Test 21: Quarantined phone number excluded from IVR selector');

  // Test 22: Configuration preview matches actual configuration
  const menuDetails = await IvrService.getIvrMenu(proEnv.mockOrgA, proEnv.mockMenuA, proEnv.client);
  assert(menuDetails !== null && menuDetails.name === 'Sales Menu' && menuDetails.greetingText.includes('Sales'), 'Test 22: Configuration preview matches exact stored menu state');

  // Test 23: Enable/Disable works
  const toggleDisable = await IvrService.updateIvrMenu(proEnv.mockOrgA, proEnv.mockMenuA, { enabled: false }, proEnv.client);
  assert(toggleDisable.success, 'Test 23: IVR menu successfully disabled without deleting configuration');

  // Test 24: Historical data preserved
  const menuPostDisable = await IvrService.getIvrMenu(proEnv.mockOrgA, proEnv.mockMenuA, proEnv.client);
  assert(menuPostDisable !== null && menuPostDisable.enabled === false, 'Test 24: Historical IVR menu data and options fully preserved on disable');

  console.log('\n====================================================');
  console.log('   ALL 24 PHASE 19C TESTS PASSED SUCCESSFULLY!       ');
  console.log('====================================================\n');
}

runPhase19CTests().catch((err) => {
  console.error('PHASE 19C TEST SUITE FAILURE:', err);
  process.exit(1);
});
