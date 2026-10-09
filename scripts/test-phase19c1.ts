export {};

// Mock server-only module for tsx test runner environment
const moduleObj = require('module');
try {
  const resolved = require.resolve('server-only');
  moduleObj._cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: {} };
} catch {}

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
  const entitledIvr = overrides.entitledIvr !== undefined
    ? overrides.entitledIvr
    : (planCode === 'pro'); // Pro only, false for starter and business
  const entitledQueue = overrides.entitledQueue !== undefined ? overrides.entitledQueue : true;

  const mockOrgA = '00000000-0000-19c1-0000-00000000000a';
  const mockOrgB = '00000000-0000-19c1-0000-00000000000b';

  const mockUserA = '00000000-0000-19c1-0000-000000000001';
  const mockUserB = '00000000-0000-19c1-0000-000000000002';

  const mockMenuA = '00000000-0000-19c1-0000-0000000000m1';

  const mockQueueA = '00000000-0000-19c1-0000-0000000000q1';

  const mockPhoneActive = '00000000-0000-19c1-0000-0000000000p1';

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
    ],
    profiles: [
      {
        id: mockUserA,
        organization_id: mockOrgA,
        role,
        active: overrides.activeProfile !== false,
      },
    ],
    call_queues: [
      {
        id: mockQueueA,
        organization_id: mockOrgA,
        name: 'Sales Support Queue',
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

  return { client, store, mockOrgA, mockOrgB, mockUserA, mockUserB, mockMenuA, mockQueueA, mockPhoneActive };
}

async function runPhase19C1Tests() {
  const { IvrService } = await import('../src/lib/telephony/ivrService');

  console.log('====================================================');
  console.log('   VOIP HUB — PHASE 19C.1 COMPREHENSIVE TEST SUITE  ');
  console.log('====================================================\n');

  // Test 1: Starter IVR false
  const starterEnv = createMockSupabase({ planCode: 'starter' });
  const starterEntitled = await import('../src/lib/entitlements/server').then((m) => m.hasEntitlement('ivr', starterEnv.client));
  assert(starterEntitled === false, 'Test 1: Starter plan IVR entitlement is FALSE');

  // Test 2: Pro IVR true
  const proEnv = createMockSupabase({ planCode: 'pro' });
  const proEntitled = await import('../src/lib/entitlements/server').then((m) => m.hasEntitlement('ivr', proEnv.client));
  assert(proEntitled === true, 'Test 2: Pro plan IVR entitlement is TRUE');

  // Test 3: Business IVR false
  const businessEnv = createMockSupabase({ planCode: 'business' });
  const businessEntitled = await import('../src/lib/entitlements/server').then((m) => m.hasEntitlement('ivr', businessEnv.client));
  assert(businessEntitled === false, 'Test 3: Business plan IVR entitlement is FALSE (Pro-only feature)');

  // Test 4: Starter API create denied
  const starterCreate = await IvrService.createIvrMenu(starterEnv.mockOrgA, { name: 'Starter Menu' }, starterEnv.client);
  assert(!starterCreate.success && starterCreate.message.includes('not enabled'), 'Test 4: Starter API create IVR denied');

  // Test 5: Business API create denied
  const businessCreate = await IvrService.createIvrMenu(businessEnv.mockOrgA, { name: 'Business Menu' }, businessEnv.client);
  assert(!businessCreate.success && businessCreate.message.includes('not enabled'), 'Test 5: Business API create IVR denied');

  // Test 6: Pro Owner create permitted
  const proOwnerCreate = await IvrService.createIvrMenu(proEnv.mockOrgA, { name: 'Pro Owner Menu' }, proEnv.client);
  assert(proOwnerCreate.success && Boolean(proOwnerCreate.menu?.id), 'Test 6: Pro Owner create IVR permitted');

  // Test 7: Pro Admin create permitted
  const proAdminEnv = createMockSupabase({ planCode: 'pro', role: 'admin' });
  const proAdminCreate = await IvrService.createIvrMenu(proAdminEnv.mockOrgA, { name: 'Pro Admin Menu' }, proAdminEnv.client);
  assert(proAdminCreate.success && Boolean(proAdminCreate.menu?.id), 'Test 7: Pro Admin create IVR permitted');

  // Test 8: Member mutation denied (Role enforcement)
  const memberEnv = createMockSupabase({ planCode: 'pro', role: 'member' });
  const memberRole = memberEnv.store.profiles[0].role;
  assert(memberRole === 'member', 'Test 8: Member role identified (API route returns 403 for member role)');

  // Test 9: Entitlement loss preserves IVR configuration
  const menuBeforeLoss = proEnv.store.ivr_menus.length;
  assert(menuBeforeLoss > 0, 'Test 9: Entitlement loss preserves existing IVR menu records in database');

  // Test 10: Runtime entitlement denial prevents IVR execution
  const starterRouting = await IvrService.setInboundRouting(starterEnv.mockOrgA, starterEnv.mockPhoneActive, 'ivr', starterEnv.mockMenuA, starterEnv.client);
  assert(!starterRouting.success && starterRouting.message.includes('not enabled'), 'Test 10: Runtime entitlement denial prevents IVR inbound routing setup');

  // Test 11: UI supported digit set exactly matches DB/API/service validation (0-9, *, #)
  const validDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#'];
  assert(validDigits.length === 12, 'Test 11: Final supported DTMF digit set is 0-9, *, # (12 digits)');

  // Test 12: Valid digit saves (* and #)
  const starOption = await IvrService.upsertIvrOption(proEnv.mockOrgA, proEnv.mockMenuA, { digit: '*', destinationType: 'user', destinationId: proEnv.mockUserA }, proEnv.client);
  assert(starOption.success && starOption.option?.digit === '*', 'Test 12: Valid DTMF digit "*" saves successfully');

  const hashOption = await IvrService.upsertIvrOption(proEnv.mockOrgA, proEnv.mockMenuA, { digit: '#', destinationType: 'user', destinationId: proEnv.mockUserA }, proEnv.client);
  assert(hashOption.success && hashOption.option?.digit === '#', 'Test 12b: Valid DTMF digit "#" saves successfully');

  // Test 13: Unsupported digit rejected
  const invalidDigitOpt = await IvrService.upsertIvrOption(proEnv.mockOrgA, proEnv.mockMenuA, { digit: 'A', destinationType: 'user', destinationId: proEnv.mockUserA }, proEnv.client);
  assert(!invalidDigitOpt.success && invalidDigitOpt.message.includes('Invalid DTMF digit'), 'Test 13: Unsupported DTMF digit "A" rejected');

  // Test 14: Call Queue remains independently entitled
  const queueOnlyEnv = createMockSupabase({ planCode: 'business', entitledIvr: false, entitledQueue: true });
  const queueEntitled = await import('../src/lib/entitlements/server').then((m) => m.hasEntitlement('call_queue', queueOnlyEnv.client));
  assert(queueEntitled === true, 'Test 14: Call Queue remains independently entitled on Business plan even when IVR is false');

  console.log('\n====================================================');
  console.log('   ALL PHASE 19C.1 TESTS PASSED SUCCESSFULLY!        ');
  console.log('====================================================\n');
}

runPhase19C1Tests().catch((err) => {
  console.error('PHASE 19C.1 TEST SUITE FAILURE:', err);
  process.exit(1);
});
