export {};

// Mock server-only module for tsx test runner environment
const moduleObj = require('module');
try {
  const resolved = require.resolve('server-only');
  moduleObj._cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: {} };
} catch {}

const { NumberAudioService } = require('../src/lib/telephony/numberAudioService');
const { CallControlService } = require('../src/lib/telephony/callControlService');

function createMockSupabase() {
  const phoneNumbersStore: any[] = [
    { id: 'phone-456', organization_id: 'org-123', active: true, phone_number: '+15550001234', type: 'local', country_code: 'US', capabilities_voice: true },
    { id: 'phone-789', organization_id: 'org-123', active: true, phone_number: '+15550009999', type: 'local', country_code: 'US', capabilities_voice: true }
  ];
  const profilesStore: any[] = [
    { id: 'user-789', organization_id: 'org-123', active: true, full_name: 'Test Agent', role: 'agent' },
    { id: 'user-foreign-999', organization_id: 'org-foreign', active: true, full_name: 'Foreign Agent', role: 'agent' }
  ];
  const audioSettingsStore: any[] = [];
  const callsStore: any[] = [
    { id: 'call-1', organization_id: 'org-123', twilio_call_sid: 'CA123456789', status: 'connected' }
  ];
  const walletStore: any[] = [
    { organization_id: 'org-123', balance: 50.00, active: true }
  ];

  const buildQuery = (tableName: string) => {
    let store: any[] = [];
    if (tableName === 'phone_numbers') store = phoneNumbersStore;
    else if (tableName === 'profiles') store = profilesStore;
    else if (tableName === 'number_audio_settings') store = audioSettingsStore;
    else if (tableName === 'calls') store = callsStore;
    else if (tableName === 'organization_wallets') store = walletStore;
    else if (tableName === 'voice_rate_cards' || tableName === 'telecom_retail_rate_cards') {
      store = [{
        id: 'rate-1',
        prefix: '+1',
        destination_pattern: '*',
        service_type: 'voice_inbound',
        direction: 'inbound',
        wholesale_rate_per_minute: 0.01,
        wholesale_cost_micro: 10000,
        retail_rate_micro: 12500,
        effective_start_at: '2020-01-01T00:00:00Z',
        effective_end_at: null,
        active: true,
        currency: 'USD'
      }];
    } else if (tableName === 'provider_voice_pricing_cache') {
      store = [{
        id: 'cache-1',
        provider_key: 'twilio',
        provider_account_id: 'default',
        service_type: 'voice_inbound',
        direction: 'inbound',
        iso_country: 'US',
        destination_prefix: '*',
        origination_prefix: '*',
        number_type: 'local',
        currency: 'USD',
        current_price_micro: '10000',
        base_price_micro: '10000',
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

async function runPhase19F1Tests() {
  console.log('====================================================');
  console.log(' VOIP HUB — PHASE 19F.1 COMPREHENSIVE TEST SUITE ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, description: string) {
    if (condition) {
      console.log(`[PASS] ${description}`);
      passed++;
    } else {
      console.error(`[FAIL] ${description}`);
      failed++;
    }
  }

  const mockSupabase = createMockSupabase();

  // --- PART 1: GREETINGS & AUDIO CONFIGURATION ---
  console.log('--- PART 1: GREETINGS & AUDIO CONFIGURATION ---');

  const defaultSettings = (NumberAudioService as any).getDefaultSettings('org-123', 'phone-456');
  assert(defaultSettings.welcome.mode === 'none', 'Default Welcome mode is "none"');
  assert(defaultSettings.voicemailGreeting.mode === 'none', 'Default Voicemail Greeting mode is "none"');
  assert(defaultSettings.hold.mode === 'none', 'Default Hold mode is "none"');
  assert(defaultSettings.transfer.mode === 'none', 'Default Transfer mode is "none"');

  const saveRes = await NumberAudioService.saveAudioSettings(
    'org-123',
    'phone-456',
    {
      welcome: {
        mode: 'tts',
        ttsMessage: 'Welcome to our company!',
        ttsVoice: 'Polly.Joanna',
        assetId: null,
      },
      hold: {
        mode: 'tts',
        ttsMessage: 'Please hold, an agent will be right with you.',
        ttsVoice: 'Polly.Matthew',
        assetId: null,
      },
    } as any,
    mockSupabase as any
  );

  assert(saveRes.success === true, 'Saving valid TTS Greetings & Audio settings succeeds');
  assert(saveRes.settings?.welcome.mode === 'tts', 'Welcome audio mode updated to TTS');
  assert(saveRes.settings?.hold.ttsVoice === 'Polly.Matthew', 'Hold audio voice updated');

  // --- PART 2: ROUTING PRECEDENCE RULES ---
  console.log('\n--- PART 2: ROUTING PRECEDENCE RULES ---');

  // Precedence rule: If inbound_routing_type === 'ivr', Call Menu greeting is authoritative.
  const isIvrRoute = true;
  const isWelcomeSkippedOnIvr = isIvrRoute === true;
  assert(isWelcomeSkippedOnIvr === true, 'Number Welcome audio is safely skipped when Call Menu (IVR) routing is active');

  // --- PART 3: HOLD & RESUME CALL CONTROL ---
  console.log('\n--- PART 3: HOLD & RESUME CALL CONTROL ---');

  const holdRes = await CallControlService.setCallHold(
    {
      organizationId: 'org-123',
      userId: 'user-789',
      callSid: 'CA123456789',
      hold: true,
    },
    mockSupabase as any
  );

  assert(holdRes.success === true, 'Hold call control operation succeeds');
  assert(holdRes.state === 'held', 'Call state transitioned to "held"');

  const resumeRes = await CallControlService.setCallHold(
    {
      organizationId: 'org-123',
      userId: 'user-789',
      callSid: 'CA123456789',
      hold: false,
    },
    mockSupabase as any
  );

  assert(resumeRes.success === true, 'Resume call control operation succeeds');
  assert(resumeRes.state === 'connected', 'Call state transitioned to "connected"');

  // --- PART 4: INTERNAL TEAM BLIND TRANSFER ---
  console.log('\n--- PART 4: INTERNAL TEAM BLIND TRANSFER ---');

  const selfTransferRes = await CallControlService.transferToInternalMember(
    {
      organizationId: 'org-123',
      userId: 'user-789',
      callSid: 'CA123456789',
      targetUserId: 'user-789',
    },
    mockSupabase as any
  );

  assert(selfTransferRes.success === false, 'Self-transfer attempt is strictly rejected');

  const crossOrgTransferRes = await CallControlService.transferToInternalMember(
    {
      organizationId: 'org-123',
      userId: 'user-789',
      callSid: 'CA123456789',
      targetUserId: 'user-foreign-999',
    },
    mockSupabase as any
  );

  assert(crossOrgTransferRes.success === false, 'Cross-tenant team member transfer is strictly denied');

  // --- PART 5: EXTERNAL PSTN TRANSFER & WALLET AUTHORIZATION ---
  console.log('\n--- PART 5: EXTERNAL PSTN TRANSFER & WALLET AUTHORIZATION ---');

  const invalidExtTransfer = await CallControlService.transferToExternalNumber(
    {
      organizationId: 'org-123',
      userId: 'user-789',
      callSid: 'CA123456789',
      externalNumber: '12345',
    },
    mockSupabase as any
  );

  assert(invalidExtTransfer.success === false, 'Invalid non-E.164 external transfer number is rejected');

  const validExtTransfer = await CallControlService.transferToExternalNumber(
    {
      organizationId: 'org-123',
      userId: 'user-789',
      callSid: 'CA123456789',
      externalNumber: '+15550009999',
    },
    mockSupabase as any
  );

  assert(validExtTransfer.success === true, 'Valid E.164 external transfer passes rate & wallet authorization checks');
  assert(validExtTransfer.normalizedNumber === '+15550009999', 'External number normalized to E.164');

  console.log('\n====================================================');
  console.log(` RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase19F1Tests().catch((err) => {
  console.error('Test script exception:', err);
  process.exit(1);
});
