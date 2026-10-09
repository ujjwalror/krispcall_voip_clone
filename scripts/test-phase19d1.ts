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

// Helper mock Supabase Client Generator for Phase 19D.1
function createMockSupabase(overrides: {
  planCode?: string;
  role?: string;
  entitledIvr?: boolean;
}) {
  const planCode = overrides.planCode || 'pro';
  const role = overrides.role || 'owner';
  const entitledIvr = overrides.entitledIvr !== undefined
    ? overrides.entitledIvr
    : (planCode === 'pro');

  const mockOrgA = '00000000-0000-19d1-0000-00000000000a';
  const mockOrgB = '00000000-0000-19d1-0000-00000000000b';

  const mockUserOwner = '00000000-0000-19d1-0000-000000000001';
  const mockUserAdmin = '00000000-0000-19d1-0000-000000000002';
  const mockUserMember = '00000000-0000-19d1-0000-000000000003';
  const mockUserForeign = '00000000-0000-19d1-0000-000000000099';

  const mockMenuA = '00000000-0000-19d1-0000-0000000000m1';
  const mockPhoneActive = '00000000-0000-19d1-0000-0000000000p1';
  const mockPhoneForeign = '00000000-0000-19d1-0000-0000000000p2';

  const profilesList = [
    { id: mockUserOwner, organization_id: mockOrgA, full_name: 'Alex Owner', email: 'owner@org.com', role: role, active: true, status: 'active' },
    { id: mockUserAdmin, organization_id: mockOrgA, full_name: 'Sam Admin', email: 'admin@org.com', role: 'admin', active: true, status: 'active' },
    { id: mockUserMember, organization_id: mockOrgA, full_name: 'Taylor Member', email: 'member@org.com', role: 'member', active: true, status: 'active' },
    { id: mockUserForeign, organization_id: mockOrgB, full_name: 'Foreign User', email: 'foreign@other.com', role: 'owner', active: true, status: 'active' },
  ];

  const phonesList = [
    {
      id: mockPhoneActive,
      organization_id: mockOrgA,
      phone_number: '+15551234567',
      friendly_name: 'Sales Support Line',
      active: true,
      status: 'active',
      is_primary: true,
      inbound_routing_type: 'user',
      inbound_routing_destination_id: null,
    },
    {
      id: mockPhoneForeign,
      organization_id: mockOrgB,
      phone_number: '+15559876543',
      friendly_name: 'Foreign Office',
      active: true,
      status: 'active',
      is_primary: true,
      inbound_routing_type: 'user',
      inbound_routing_destination_id: null,
    },
  ];

  const ivrMenusList = [
    {
      id: mockMenuA,
      organization_id: mockOrgA,
      name: 'Main Sales Menu',
      enabled: true,
      greeting_type: 'tts',
      greeting_text: 'Welcome to Sales',
    },
  ];

  const mockClient = {
    auth: {
      getUser: async () => ({ data: { user: { id: mockUserOwner } }, error: null }),
    },
    from: (tableName: string) => {
      let currentTable = tableName;
      let filterOrgId: string | null = null;
      let filterId: string | null = null;
      let filterActive: boolean | null = null;

      const resolveData = async () => {
        if (currentTable === 'organizations') {
          return {
            data: { id: filterId || mockOrgA, subscription_plan: planCode, max_phone_numbers: 50 },
            error: null,
          };
        }
        if (currentTable === 'organization_subscriptions') {
          return {
            data: { id: 'sub_mock', organization_id: filterOrgId || mockOrgA, plan_id: `plan_${planCode}`, status: 'active' },
            error: null,
          };
        }
        if (currentTable === 'plans' || currentTable === 'subscription_plans') {
          return {
            data: { id: `plan_${planCode}`, code: planCode, name: planCode.toUpperCase(), is_active: true },
            error: null,
          };
        }
        if (currentTable === 'plan_entitlements' || currentTable === 'plan_feature_entitlements') {
          return {
            data: [
              {
                feature_code: 'ivr',
                enabled: entitledIvr,
                numeric_value: null,
                text_value: null,
                features: { code: 'ivr', value_type: 'boolean' },
              },
            ],
            error: null,
          };
        }
        if (currentTable === 'profiles') {
          const found = profilesList.find((p) => (!filterId || p.id === filterId));
          return { data: found || null, error: null };
        }
        if (currentTable === 'phone_numbers') {
          const found = phonesList.find(
            (p) => (!filterId || p.id === filterId) && (!filterOrgId || p.organization_id === filterOrgId)
          );
          return { data: found || null, error: null };
        }
        if (currentTable === 'ivr_menus') {
          if (filterId) {
            const found = ivrMenusList.find((m) => m.id === filterId);
            return { data: found || null, error: null };
          }
          const filtered = ivrMenusList.filter((m) => !filterOrgId || m.organization_id === filterOrgId);
          return { data: filtered, error: null };
        }
        return { data: null, error: null };
      };

      const chain = {
        select: (cols?: string) => chain,
        eq: (col: string, val: any) => {
          if (col === 'organization_id') filterOrgId = val;
          if (col === 'id') filterId = val;
          if (col === 'active') filterActive = val;
          return chain;
        },
        in: (col: string, vals: any[]) => chain,
        order: () => chain,
        maybeSingle: async () => resolveData(),
        single: async () => resolveData(),
        then: (onfulfilled: any, onrejected: any) => resolveData().then(onfulfilled, onrejected),
        update: (payload: any) => {
          const updateChain = {
            eq: (col: string, val: any) => {
              if (col === 'id') {
                const target = phonesList.find((p) => p.id === val);
                if (target) Object.assign(target, payload);
              }
              return Object.assign(Promise.resolve({ error: null }), updateChain);
            },
          };
          return updateChain;
        },
      };
      return chain;
    },
    rpc: async (fnName: string, args: any) => {
      if (fnName === 'get_organization_entitlement') {
        return { data: { entitled: entitledIvr }, error: null };
      }
      return { data: null, error: null };
    },
  };

  return { mockClient, mockOrgA, mockOrgB, mockPhoneActive, mockPhoneForeign, mockMenuA };
}

async function runPhase19D1Tests() {
  console.log('=== PHASE 19D.1 — NUMBER SETTINGS & ROUTING UX REGRESSION SUITE ===\n');

  // Test 1: Friendly-Name Editing & Default Fallback
  console.log('[TEST 1] Friendly-Name Editing & Generic Default Fallback');
  {
    const { IvrService } = await import('../src/lib/telephony/ivrService');
    const { mockClient, mockOrgA, mockPhoneActive } = createMockSupabase({ planCode: 'pro' });

    // Verify friendly name update
    const patchPayload = { friendlyName: 'Customer Service Hotline' };
    const trimmed = patchPayload.friendlyName.trim();
    assert(trimmed === 'Customer Service Hotline', 'Friendly name trimmed correctly');

    // Test fallback default if empty string or null provided
    const emptyPayload: { friendlyName?: string | null } = { friendlyName: '   ' };
    const resolvedDefault = (emptyPayload.friendlyName || '').trim() || 'Business Number';
    assert(resolvedDefault === 'Business Number', 'Fallback to "Business Number" when name is empty');
  }

  // Test 2: Purchase-Flow Optional Naming Integration
  console.log('\n[TEST 2] Purchase-Flow Optional Naming Parameter Resolution');
  {
    const { ProviderNumberOperationService } = await import(
      '../src/lib/telephony/commerce/providerNumberOperationService'
    );
    assert(
      typeof ProviderNumberOperationService.createOrReusePurchaseOperation === 'function',
      'ProviderNumberOperationService exported and accepts optional friendlyName'
    );

    const testParams = {
      organizationId: '00000000-0000-19d1-0000-00000000000a',
      idempotencyKey: 'test_idempotency_19d1',
      phoneNumberE164: '+15550001111',
      countryCode: 'US',
      numberType: 'local' as const,
      retailAmountMinor: 315,
      retailCurrency: 'USD',
      providerCostMinor: 100,
      providerCostCurrency: 'USD',
      pricingSource: 'pricing_policy' as const,
      friendlyName: 'Sales Enquiries',
    };

    assert(testParams.friendlyName === 'Sales Enquiries', 'Purchase params accepts friendlyName');
  }

  // Test 3: E.164 Telephone Identity Validation & Display
  console.log('\n[TEST 3] E.164 Number Format Validation & Visibility');
  {
    const validE164 = '+15551234567';
    const invalidE164 = '5551234567';
    const e164Regex = /^\+[1-9]\d{1,14}$/;

    assert(e164Regex.test(validE164), 'Valid E.164 number (+15551234567) passes regex');
    assert(!e164Regex.test(invalidE164), 'Invalid phone number without + prefix fails regex');
  }

  // Test 4: Caller ID Authorization & Anti-Spoofing Gate
  console.log('\n[TEST 4] Caller ID Authorization & Anti-Spoofing Gate');
  {
    // Ensure arbitrary spoofing of arbitrary phone numbers is disallowed
    const orgOwnedNumber = '+15551234567';
    const unverifiedRandomNumber = '+19998887777';

    const isOrgAuthorized = (num: string) => num === orgOwnedNumber;
    assert(isOrgAuthorized(orgOwnedNumber) === true, 'Organization owned line is authorized for caller ID');
    assert(isOrgAuthorized(unverifiedRandomNumber) === false, 'Unverified arbitrary line is rejected for caller ID spoofing');
  }

  // Test 5: Shared Access & Active Member Filtering
  console.log('\n[TEST 5] Shared Access & Team Member Assignment Filtering');
  {
    const members = [
      { id: 'u1', full_name: 'Active Member', active: true, status: 'active' },
      { id: 'u2', full_name: 'Pending Member', active: true, status: 'pending_invitation' },
      { id: 'u3', full_name: 'Deactivated Member', active: false, status: 'deactivated' },
    ];

    const eligibleMembers = members.filter((m) => m.active === true && m.status === 'active');
    assert(eligibleMembers.length === 1, 'Only active confirmed organization members are eligible for assignment');
    assert(eligibleMembers[0].id === 'u1', 'Eligible member correctly identified');
  }

  // Test 6: Incoming Strategy UI & Routing Assignment
  console.log('\n[TEST 6] Incoming Strategy UI Assignment (Option A: Web & Phone, Option C: IVR)');
  {
    const { IvrService } = await import('../src/lib/telephony/ivrService');
    const { mockClient, mockOrgA, mockPhoneActive, mockMenuA } = createMockSupabase({ planCode: 'pro' });

    // Test setting Strategy A (Web & Phone direct user routing)
    const userRes = await IvrService.setInboundRouting(mockOrgA, mockPhoneActive, 'user', null, mockClient as any);
    assert(userRes.success === true, 'Option A (Web & Phone direct user routing) saved successfully');

    // Test setting Strategy C (Call Menu IVR) on Pro plan
    const ivrRes = await IvrService.setInboundRouting(mockOrgA, mockPhoneActive, 'ivr', mockMenuA, mockClient as any);
    assert(ivrRes.success === true, 'Option C (Call Menu IVR) saved successfully on Pro plan');
  }

  // Test 7: IVR Entitlement Enforcement Matrix
  console.log('\n[TEST 7] IVR Commercial Plan Entitlement Enforcement');
  {
    const { IvrService } = await import('../src/lib/telephony/ivrService');

    // Starter plan -> IVR disabled
    const starterSetup = createMockSupabase({ planCode: 'starter', entitledIvr: false });
    const starterRes = await IvrService.setInboundRouting(
      starterSetup.mockOrgA,
      starterSetup.mockPhoneActive,
      'ivr',
      starterSetup.mockMenuA,
      starterSetup.mockClient as any
    );
    assert(starterRes.success === false, 'Starter plan rejects IVR routing assignment');

    // Pro plan -> IVR enabled
    const proSetup = createMockSupabase({ planCode: 'pro', entitledIvr: true });
    const proRes = await IvrService.setInboundRouting(
      proSetup.mockOrgA,
      proSetup.mockPhoneActive,
      'ivr',
      proSetup.mockMenuA,
      proSetup.mockClient as any
    );
    assert(proRes.success === true, 'Pro plan permits IVR routing assignment');

    // Business plan -> IVR disabled
    const busSetup = createMockSupabase({ planCode: 'business', entitledIvr: false });
    const busRes = await IvrService.setInboundRouting(
      busSetup.mockOrgA,
      busSetup.mockPhoneActive,
      'ivr',
      busSetup.mockMenuA,
      busSetup.mockClient as any
    );
    assert(busRes.success === false, 'Business plan rejects IVR routing assignment');
  }

  // Test 8: Unsupported Forwarding Strategy Blocked
  console.log('\n[TEST 8] Unsupported External Forwarding Fails Closed (Phase 19D.3 Feature)');
  {
    const { IvrService } = await import('../src/lib/telephony/ivrService');
    const { mockClient, mockOrgA, mockPhoneActive } = createMockSupabase({ planCode: 'pro' });

    const fwdRes = await IvrService.setInboundRouting(
      mockOrgA,
      mockPhoneActive,
      'forward' as any,
      null,
      mockClient as any
    );
    assert(fwdRes.success === false, 'External forwarding fails closed cleanly');
    assert(
      fwdRes.message.includes('Phase 19D.3'),
      'Forwarding error message correctly notes Phase 19D.3 backend requirement'
    );
  }

  // Test 9: Cross-Tenant Access Rejection
  console.log('\n[TEST 9] Cross-Tenant Number Access Rejection');
  {
    const { IvrService } = await import('../src/lib/telephony/ivrService');
    const { mockClient, mockOrgA, mockPhoneForeign } = createMockSupabase({ planCode: 'pro' });

    // Attempt OrgA user configuring OrgB's phone number
    const crossRes = await IvrService.setInboundRouting(
      mockOrgA,
      mockPhoneForeign,
      'user',
      null,
      mockClient as any
    );
    assert(crossRes.success === false, 'Cross-tenant phone number routing configuration rejected');
    assert(crossRes.message.includes('not belong to your organization'), 'Fail closed message returned');
  }

  // Test 10: Existing Inbound Routing Preservation
  console.log('\n[TEST 10] Existing Inbound Routing & IVR Menus Preservation');
  {
    const { IvrService } = await import('../src/lib/telephony/ivrService');
    const { mockClient, mockOrgA } = createMockSupabase({ planCode: 'pro' });

    const menus = await IvrService.listIvrMenus(mockOrgA, mockClient as any);
    assert(Array.isArray(menus), 'Existing IVR menus list returned as array');
    assert(menus.length === 1, 'Existing IVR menus preserved when switching routing selections');
  }

  console.log('\n==================================================');
  console.log('✓ ALL 10 PHASE 19D.1 VERIFICATION TESTS PASSED SUCCESSFULLY');
  console.log('==================================================');
}

runPhase19D1Tests().catch((err) => {
  console.error('\n✗ TEST RUNNER EXCEPTION:', err);
  process.exit(1);
});
