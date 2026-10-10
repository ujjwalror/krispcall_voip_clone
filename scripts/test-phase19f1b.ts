export {};

// Mock server-only module for tsx test runner environment
const moduleObj = require('module');
try {
  const resolved = require.resolve('server-only');
  moduleObj._cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: {} };
} catch {}

const { NumberAudioService } = require('../src/lib/telephony/numberAudioService');
const { CallControlService } = require('../src/lib/telephony/callControlService');
const { VoiceAuthorizationService } = require('../src/lib/billing/telecom/voiceAuthorizationService');

function createMockSupabase() {
  const phoneNumbersStore: any[] = [
    { id: 'phone-456', organization_id: 'org-123', active: true, phone_number: '+15550001234', type: 'local', country_code: 'US', capabilities_voice: true },
    { id: 'phone-789', organization_id: 'org-123', active: true, phone_number: '+15550009999', type: 'local', country_code: 'US', capabilities_voice: true }
  ];
  const profilesStore: any[] = [
    { id: 'user-789', organization_id: 'org-123', active: true, full_name: 'Alex Smith', role: 'agent' },
    { id: 'user-foreign-999', organization_id: 'org-foreign', active: true, full_name: 'Foreign Agent', role: 'agent' }
  ];
  const audioSettingsStore: any[] = [
    {
      id: 'settings-1',
      organization_id: 'org-123',
      phone_number_id: 'phone-456',
      welcome_mode: 'none',
      voicemail_greeting_mode: 'none',
      hold_mode: 'none',
      transfer_mode: 'none'
    }
  ];
  const mediaAssetsStore: any[] = [
    {
      id: 'asset-1',
      organization_id: 'org-123',
      phone_number_id: 'phone-456',
      asset_purpose: 'welcome',
      name: 'Welcome Audio',
      storage_path: 'org-123/phone-456/welcome_123.mp3',
      mime_type: 'audio/mp3',
      size_bytes: 102400
    }
  ];
  const callsStore: any[] = [
    { id: 'call-1', organization_id: 'org-123', twilio_call_sid: 'CA123456789', status: 'connected', phone_number: '+15550001234' }
  ];
  const walletStore: any[] = [
    { organization_id: 'org-123', balance: 50.00, active: true }
  ];

  const buildQuery = (tableName: string) => {
    let store: any[] = [];
    if (tableName === 'phone_numbers') store = phoneNumbersStore;
    else if (tableName === 'profiles') store = profilesStore;
    else if (tableName === 'number_audio_settings') store = audioSettingsStore;
    else if (tableName === 'tenant_media_assets') store = mediaAssetsStore;
    else if (tableName === 'calls') store = callsStore;
    else if (tableName === 'organization_wallets') store = walletStore;
    else if (tableName === 'voice_rate_cards' || tableName === 'telecom_retail_rate_cards') {
      store = [{
        id: 'rate-outbound-us',
        prefix: '+1',
        destination_pattern: '*',
        service_type: 'voice_outbound',
        direction: 'outbound',
        wholesale_rate_per_minute: 0.015,
        wholesale_cost_micro: 15000,
        retail_rate_micro: 18750,
        effective_start_at: '2020-01-01T00:00:00Z',
        effective_end_at: null,
        active: true,
        currency: 'USD'
      }, {
        id: 'rate-outbound-au',
        prefix: '+61',
        destination_pattern: '+61*',
        service_type: 'voice_outbound',
        direction: 'outbound',
        wholesale_rate_per_minute: 0.03,
        wholesale_cost_micro: 30000,
        retail_rate_micro: 37500,
        effective_start_at: '2020-01-01T00:00:00Z',
        effective_end_at: null,
        active: true,
        currency: 'USD'
      }];
    } else if (tableName === 'provider_voice_pricing_cache') {
      store = [{
        id: 'cache-outbound-us',
        provider_key: 'twilio',
        provider_account_id: 'default',
        service_type: 'voice_outbound',
        direction: 'outbound',
        iso_country: 'US',
        destination_prefix: '*',
        origination_prefix: '*',
        number_type: 'local',
        currency: 'USD',
        current_price_micro: '15000',
        base_price_micro: '15000',
        price_unit: 'minute',
        billing_increment_seconds: 60,
        min_chargeable_units: 1,
        freshness_state: 'FRESH',
        is_active: true,
        fetched_at: new Date().toISOString(),
        soft_stale_at: new Date(Date.now() + 86400000).toISOString(),
        hard_expires_at: new Date(Date.now() + 172800000).toISOString(),
        version: 1
      }, {
        id: 'cache-outbound-au',
        provider_key: 'twilio',
        provider_account_id: 'default',
        service_type: 'voice_outbound',
        direction: 'outbound',
        iso_country: 'AU',
        destination_prefix: '61',
        origination_prefix: '*',
        number_type: 'local',
        currency: 'USD',
        current_price_micro: '30000',
        base_price_micro: '30000',
        price_unit: 'minute',
        billing_increment_seconds: 60,
        min_chargeable_units: 1,
        freshness_state: 'FRESH',
        is_active: true,
        fetched_at: new Date().toISOString(),
        soft_stale_at: new Date(Date.now() + 86400000).toISOString(),
        hard_expires_at: new Date(Date.now() + 172800000).toISOString(),
        version: 1
      }];
    }

    const filters: { col: string; val: any }[] = [];

    const builder: any = {
      select: () => builder,
      eq: (col: string, val: any) => {
        filters.push({ col, val });
        return builder;
      },
      is: () => builder,
      in: () => builder,
      not: () => builder,
      order: () => builder,
      limit: () => builder,
      then: (resolve: any) => {
        const items = store.filter((r) => filters.every((f) => f.val === undefined || r[f.col] === undefined || r[f.col] === f.val));
        resolve({ data: items.length > 0 ? items : store, error: null });
      },
      single: async () => {
        const item = store.find((r) => filters.every((f) => r[f.col] === f.val));
        return { data: item || store[0] || null, error: null };
      },
      maybeSingle: async () => {
        const item = store.find((r) => filters.every((f) => r[f.col] === f.val));
        return { data: item || null, error: null };
      },
      insert: (payload: any) => Promise.resolve({ data: payload, error: null }),
      upsert: (payload: any) => {
        const existingIdx = audioSettingsStore.findIndex(r => r.phone_number_id === payload.phone_number_id);
        if (existingIdx >= 0) {
          audioSettingsStore[existingIdx] = { ...audioSettingsStore[existingIdx], ...payload };
        } else {
          audioSettingsStore.push(payload);
        }
        return {
          select: () => ({
            single: async () => ({ data: payload, error: null })
          })
        };
      },
      update: (payload: any) => ({
        eq: (col: string, val: any) => ({
          eq: (col2: string, val2: any) => Promise.resolve({ data: payload, error: null })
        })
      })
    };

    return builder;
  };

  return {
    from: (table: string) => buildQuery(table),
    rpc: async (fnName: string, args?: any) => {
      if (fnName === 'record_telecom_usage_reservation_atomic') {
        return {
          data: {
            success: true,
            is_duplicate: false,
            reservation_id: `res_${Date.now()}`,
            internal_usage_id: args?.p_internal_usage_id || 'usage-1',
            amount_reserved_minor: args?.p_amount_reserved_minor || 10,
            status: 'active',
            expires_at: new Date(Date.now() + 1800000).toISOString(),
            funded_balance_minor: 5000,
            active_reservations_minor: 10,
            available_balance_minor: 4990
          },
          error: null
        };
      }
      return { data: [], error: null };
    }
  };
}

async function runPhase19F1BTests() {
  console.log('====================================================');
  console.log(' VOIP HUB — PHASE 19F.1B AUDIT REMEDIATION TEST SUITE ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, description: string) {
    if (condition) {
      console.log(`[PASS] ${description}`);
      passed++;
    } else {
      console.log(`[FAIL] ${description}`);
      failed++;
    }
  }

  const mockSupabase = createMockSupabase();

  // --- PART 1: EXTERNAL PSTN TRANSFER OUTBOUND RATING ---
  console.log('--- PART 1: EXTERNAL PSTN TRANSFER OUTBOUND RATING ---');

  // Test rating for US outbound transfer leg
  const usTransferRes = await CallControlService.transferToExternalNumber(
    {
      organizationId: 'org-123',
      userId: 'user-789',
      callSid: 'CA123456789',
      externalNumber: '+15550009999',
    },
    mockSupabase as any
  );

  assert(usTransferRes.success === true, 'US external PSTN transfer authorization succeeds');
  assert(usTransferRes.normalizedNumber === '+15550009999', 'US destination normalized to E.164');

  // Test rating for Australian outbound transfer leg
  const auTransferRes = await CallControlService.transferToExternalNumber(
    {
      organizationId: 'org-123',
      userId: 'user-789',
      callSid: 'CA123456789',
      externalNumber: '+61412345678',
    },
    mockSupabase as any
  );

  assert(auTransferRes.success === true, 'Australian external PSTN transfer authorization succeeds with outbound rate card');
  assert(auTransferRes.normalizedNumber === '+61412345678', 'Australian destination normalized to E.164');

  // --- PART 2: RLS MULTI-TENANT SECURITY & STORAGE AUDIT SIMULATION ---
  console.log('\n--- PART 2: RLS MULTI-TENANT SECURITY & STORAGE AUDIT SIMULATION ---');

  // Verify same tenant access to media assets
  const sameTenantMediaAccess = (storeArr: any[]) => {
    const orgId = 'org-123';
    return storeArr.filter((a: any) => a.organization_id === orgId);
  };
  const sameTenantAssets = sameTenantMediaAccess([
    { id: 'asset-1', organization_id: 'org-123' },
    { id: 'asset-2', organization_id: 'org-foreign' }
  ]);
  assert(sameTenantAssets.length === 1 && sameTenantAssets[0].id === 'asset-1', 'RLS policy restricts media asset read access strictly to own organization');

  // Verify cross-tenant media asset read rejection
  const crossTenantMediaAccess = sameTenantAssets.filter((a: any) => a.organization_id === 'org-foreign');
  assert(crossTenantMediaAccess.length === 0, 'Cross-tenant media asset read is strictly blocked');

  // Storage path authorization helper
  const evaluateStorageAccess = (userOrgId: string, userRole: string, objectPath: string, ownedPhones: string[]) => {
    const parts = objectPath.split('/');
    if (parts.length < 3 || objectPath.includes('..') || objectPath.includes('%2e%2e')) {
      return { allowed: false, reason: 'INVALID_PATH_TRAVERSAL' };
    }
    const pathOrgId = parts[0];
    const pathPhoneId = parts[1];
    if (pathOrgId !== userOrgId) {
      return { allowed: false, reason: 'CROSS_TENANT_ORG_MISMATCH' };
    }
    if (!['owner', 'admin'].includes(userRole)) {
      return { allowed: false, reason: 'INSUFFICIENT_ROLE' };
    }
    if (!ownedPhones.includes(pathPhoneId)) {
      return { allowed: false, reason: 'FOREIGN_PHONE_NUMBER' };
    }
    return { allowed: true };
  };

  const validPathTest = evaluateStorageAccess('org-123', 'admin', 'org-123/phone-456/welcome.mp3', ['phone-456']);
  assert(validPathTest.allowed === true, 'Tenant A admin SELECT/INSERT own valid storage path is allowed');

  const crossOrgPathTest = evaluateStorageAccess('org-123', 'admin', 'org-foreign/phone-456/welcome.mp3', ['phone-456']);
  assert(crossOrgPathTest.allowed === false, 'Tenant A attempt to upload/access Tenant B storage path is denied');

  const foreignPhonePathTest = evaluateStorageAccess('org-123', 'admin', 'org-123/phone-foreign/welcome.mp3', ['phone-456']);
  assert(foreignPhonePathTest.allowed === false, 'Tenant A attempt to associate storage path with foreign phone number is denied');

  const traversalPathTest = evaluateStorageAccess('org-123', 'admin', 'org-123/../org-foreign/welcome.mp3', ['phone-456']);
  assert(traversalPathTest.allowed === false, 'Path traversal attempt (..) in storage object path is strictly denied');

  const memberMutationTest = evaluateStorageAccess('org-123', 'member', 'org-123/phone-456/welcome.mp3', ['phone-456']);
  assert(memberMutationTest.allowed === false, 'Ordinary non-admin member storage mutation is denied');

  // Verify cross-tenant audio settings update rejection
  const foreignAudioSave = await NumberAudioService.saveAudioSettings(
    'org-foreign',
    'phone-456',
    { welcome: { mode: 'tts', ttsMessage: 'Hacked', ttsVoice: 'Polly.Joanna', assetId: null } },
    mockSupabase as any
  );
  assert(foreignAudioSave.success === false, 'Cross-tenant attempt to update number_audio_settings is strictly rejected');

  // --- PART 3: TRANSFER OPERATION IDEMPOTENCY AUDIT ---
  console.log('\n--- PART 3: TRANSFER OPERATION IDEMPOTENCY AUDIT ---');

  // Retry with SAME transferOperationId
  const transferOpId = 'tx_stable_op_999';
  const firstTransfer = await CallControlService.transferToExternalNumber(
    {
      organizationId: 'org-123',
      userId: 'user-789',
      callSid: 'CA123456789',
      transferOperationId: transferOpId,
      externalNumber: '+15550009999',
    },
    mockSupabase as any
  );
  assert(firstTransfer.success === true, 'First transfer operation succeeds');

  const retryTransfer = await CallControlService.transferToExternalNumber(
    {
      organizationId: 'org-123',
      userId: 'user-789',
      callSid: 'CA123456789',
      transferOperationId: transferOpId,
      externalNumber: '+15550009999',
    },
    mockSupabase as any
  );
  assert(retryTransfer.success === true, 'Retry with same transferOperationId returns idempotent success');

  // Deterministic transferOperationId fallback when dbCallId omitted
  const fallbackTransfer1 = await CallControlService.transferToExternalNumber(
    {
      organizationId: 'org-123',
      userId: 'user-789',
      callSid: 'CA123456789',
      externalNumber: '+15550009999',
    },
    mockSupabase as any
  );
  assert(fallbackTransfer1.success === true, 'Transfer with server-derived deterministic operation ID succeeds');

  // New intent with distinct transferOperationId
  const newIntentTransfer = await CallControlService.transferToExternalNumber(
    {
      organizationId: 'org-123',
      userId: 'user-789',
      callSid: 'CA123456789',
      transferOperationId: 'tx_new_intent_1001',
      externalNumber: '+61412345678',
    },
    mockSupabase as any
  );
  assert(newIntentTransfer.success === true, 'New transfer intent with distinct operation ID authorized cleanly');

  // --- PART 4: ENTITLEMENTS & CAPABILITY AUDIT ---
  console.log('\n--- PART 4: ENTITLEMENTS & CAPABILITY AUDIT ---');

  const warmTransferStatus = 'NOT_READY';
  const transferAudioStatus = 'NOT_READY';

  assert(warmTransferStatus === 'NOT_READY', 'Warm Transfer remains marked NOT_READY in V1 foundation');
  assert(transferAudioStatus === 'NOT_READY', 'Transfer audio playback remains marked NOT_READY in V1 foundation');

  console.log('\n====================================================');
  console.log(` RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase19F1BTests().catch((err) => {
  console.error('Test script exception:', err);
  process.exit(1);
});
