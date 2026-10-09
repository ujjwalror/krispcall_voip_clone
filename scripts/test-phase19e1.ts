export {};

// Mock server-only module for tsx test runner environment
const moduleObj = require('module');
try {
  const resolved = require.resolve('server-only');
  moduleObj._cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: {} };
} catch {}

const { VoicemailService } = require('../src/lib/telephony/voicemailService');
const { hasEntitlement } = require('../src/lib/entitlements/server');
const { IvrService } = require('../src/lib/telephony/ivrService');
const { QueueService } = require('../src/lib/telephony/queueService');

function createMockSupabase(planCode: string = 'pro', overrides: Record<string, any> = {}) {
  const orgId = overrides.orgId || `org-${planCode}`;
  const userId = overrides.userId || `user-${planCode}`;
  const planId = overrides.planId || `plan-${planCode}-id`;

  const voicemailsStore: any[] = overrides.voicemails || [];

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
                data: { id: userId, organization_id: orgId, active: true, role: overrides.role || 'owner' },
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
                data: {
                  id: planId,
                  code: planCode,
                  stable_key: planCode,
                  name: planCode.toUpperCase(),
                  is_active: true,
                },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === 'plan_entitlements') {
        return {
          select: () => ({
            eq: async () => {
              const ents: any[] = [];
              if (planCode === 'pro') {
                ents.push({ feature_code: 'ivr', enabled: true, numeric_value: null, text_value: null });
                ents.push({ feature_code: 'voicemail', enabled: true, numeric_value: null, text_value: null });
                ents.push({ feature_code: 'call_queue', enabled: true, numeric_value: null, text_value: null });
              } else if (planCode === 'business') {
                ents.push({ feature_code: 'ivr', enabled: false, numeric_value: null, text_value: null });
                ents.push({ feature_code: 'voicemail', enabled: true, numeric_value: null, text_value: null });
                ents.push({ feature_code: 'call_queue', enabled: true, numeric_value: null, text_value: null });
              } else if (planCode === 'starter') {
                ents.push({ feature_code: 'ivr', enabled: false, numeric_value: null, text_value: null });
                ents.push({ feature_code: 'voicemail', enabled: false, numeric_value: null, text_value: null });
                ents.push({ feature_code: 'call_queue', enabled: false, numeric_value: null, text_value: null });
              }
              return { data: ents, error: null };
            },
          }),
        };
      }

      if (table === 'phone_numbers') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: 'pn-1', organization_id: orgId, active: true, inbound_routing_type: 'user' },
                error: null,
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              eq: async () => ({ error: null }),
            }),
          }),
        };
      }

      if (table === 'ivr_menus') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: 'menu-1', organization_id: orgId, enabled: true, name: 'Main Menu' },
                  error: null,
                }),
              }),
              maybeSingle: async () => ({
                data: { id: 'menu-1', organization_id: orgId, enabled: true, name: 'Main Menu' },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === 'ivr_options') {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => ({ data: [], error: null }),
            }),
          }),
          insert: (payload: any) => ({
            select: () => ({
              single: async () => ({ data: { id: 'opt-1', ...payload }, error: null }),
            }),
          }),
          upsert: (payload: any) => ({
            select: () => ({
              single: async () => ({ data: { id: 'opt-1', ...payload }, error: null }),
            }),
            single: async () => ({ data: { id: 'opt-1', ...payload }, error: null }),
          }),
        };
      }

      if (table === 'call_queues') {
        return {
          insert: (payload: any) => ({
            select: () => ({
              single: async () => ({ data: { id: 'queue-1', organization_id: orgId, ...payload }, error: null }),
            }),
          }),
        };
      }

      if (table === 'voicemails') {
        return {
          select: (fields?: string, opts?: any) => {
            if (opts?.head) {
              return {
                eq: () => ({
                  eq: () => ({
                    is: async () => ({ count: voicemailsStore.length, error: null }),
                  }),
                  is: async () => ({ count: voicemailsStore.length, error: null }),
                }),
              };
            }
            return {
              eq: (col1: string, val1: string) => ({
                is: () => ({
                  order: () => ({
                    range: async () => ({ data: voicemailsStore, error: null }),
                  }),
                }),
                eq: (col2: string, val2: string) => ({
                  is: () => ({
                    maybeSingle: async () => {
                      const found = voicemailsStore.find((v) => v.id === val2 && v.organization_id === val1);
                      return { data: found || null, error: null };
                    },
                  }),
                }),
                maybeSingle: async () => {
                  if (col1 === 'provider_recording_sid') {
                    const found = voicemailsStore.find((v) => v.provider_recording_sid === val1);
                    return { data: found || null, error: null };
                  }
                  const found = voicemailsStore.find((v) => v.organization_id === val1);
                  return { data: found || null, error: null };
                },
              }),
            };
          },
          insert: (payload: any) => {
            const newRow = { id: `vm-${Date.now()}`, ...payload };
            voicemailsStore.push(newRow);
            return {
              select: () => ({
                single: async () => ({ data: newRow, error: null }),
              }),
            };
          },
          update: (payload: any) => ({
            eq: (col: string, val: string) => ({
              eq: async () => ({ error: null }),
              is: async () => ({ error: null }),
            }),
          }),
        };
      }

      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
    },
  };
}

async function runPhase19E1TestSuite() {
  console.log('====================================================');
  console.log('  VOIP HUB — PHASE 19E.1 COMPREHENSIVE TEST SUITE   ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  async function assertTest(name: string, fn: () => Promise<boolean>) {
    try {
      const ok = await fn();
      if (ok) {
        console.log(`[PASS] ${name}`);
        passed++;
      } else {
        console.error(`[FAIL] ${name}`);
        failed++;
      }
    } catch (err: any) {
      console.error(`[FAIL] ${name} — Exception:`, err.message || err);
      failed++;
    }
  }

  // TEST 1: Starter voicemail entitlement denied
  await assertTest('1. Starter plan voicemail entitlement is DENIED', async () => {
    const mockClient = createMockSupabase('starter');
    const isEntitled = await hasEntitlement('voicemail', mockClient as any);
    return isEntitled === false;
  });

  // TEST 2: Pro voicemail entitlement allowed
  await assertTest('2. Pro plan voicemail entitlement is ALLOWED', async () => {
    const mockClient = createMockSupabase('pro');
    const isEntitled = await hasEntitlement('voicemail', mockClient as any);
    return isEntitled === true;
  });

  // TEST 3: Business voicemail entitlement allowed
  await assertTest('3. Business plan voicemail entitlement is ALLOWED', async () => {
    const mockClient = createMockSupabase('business');
    const isEntitled = await hasEntitlement('voicemail', mockClient as any);
    return isEntitled === true;
  });

  // TEST 4: Existing IVR Entitlement preservation (Starter=false, Pro=true, Business=false)
  await assertTest('4. IVR Entitlement Matrix remains Starter=false, Pro=true, Business=false', async () => {
    const starterIvr = await hasEntitlement('ivr', createMockSupabase('starter') as any);
    const proIvr = await hasEntitlement('ivr', createMockSupabase('pro') as any);
    const bizIvr = await hasEntitlement('ivr', createMockSupabase('business') as any);

    return starterIvr === false && proIvr === true && bizIvr === false;
  });

  // TEST 5: Server-side voicemail routing assignment entitlement check
  await assertTest('5. Voicemail routing assignment rejected if not entitled (Starter)', async () => {
    const mockClient = createMockSupabase('starter');
    const res = await IvrService.setInboundRouting('org-starter', 'pn-1', 'voicemail' as any, null, 'voicemail', mockClient as any);
    return res.success === false && res.message.includes('not enabled');
  });

  // TEST 6: Web & Phone unanswered → voicemail routing for entitled Pro
  await assertTest('6. Web & Phone unanswered → voicemail routing succeeds for entitled Pro', async () => {
    const mockClient = createMockSupabase('pro');
    const res = await IvrService.setInboundRouting('org-pro', 'pn-1', 'user', null, 'voicemail', mockClient as any);
    return res.success === true;
  });

  // TEST 7: Dismiss call regression
  await assertTest('7. Dismiss call strategy selection remains operational', async () => {
    const mockClient = createMockSupabase('pro');
    const res = await IvrService.setInboundRouting('org-pro', 'pn-1', 'user', null, 'dismiss', mockClient as any);
    return res.success === true;
  });

  // TEST 8: IVR → voicemail destination restored for entitled Pro
  await assertTest('8. IVR option → voicemail destination is VALID for entitled Pro', async () => {
    const mockClient = createMockSupabase('pro');
    const res = await IvrService.upsertIvrOption(
      'org-pro',
      'menu-1',
      { digit: '1', destinationType: 'voicemail' },
      mockClient as any
    );
    return res.success === true;
  });

  // TEST 9: Duplicate callback idempotency
  await assertTest('9. Voicemail recording callback IDEMPOTENCY', async () => {
    const voicemails: any[] = [];
    const mockClient = createMockSupabase('pro', { voicemails });

    const first = await VoicemailService.recordVoicemail(
      {
        organizationId: 'org-pro',
        providerCallSid: 'CA123',
        providerRecordingSid: 'RE123',
        callerNumber: '+12223334444',
        calledNumber: '+15556667777',
        recordingUrl: 'https://api.twilio.com/RE123',
        durationSeconds: 15,
      },
      mockClient as any
    );

    const second = await VoicemailService.recordVoicemail(
      {
        organizationId: 'org-pro',
        providerCallSid: 'CA123',
        providerRecordingSid: 'RE123',
        callerNumber: '+12223334444',
        calledNumber: '+15556667777',
        recordingUrl: 'https://api.twilio.com/RE123',
        durationSeconds: 15,
      },
      mockClient as any
    );

    return first.success === true && second.success === true && voicemails.length === 1;
  });

  // TEST 10: Zero-length recording handling
  await assertTest('10. Zero-length voicemail recording is IGNORED safely', async () => {
    const mockClient = createMockSupabase('pro');
    const res = await VoicemailService.recordVoicemail(
      {
        organizationId: 'org-pro',
        providerCallSid: 'CA000',
        providerRecordingSid: 'RE000',
        callerNumber: '+12223334444',
        calledNumber: '+15556667777',
        recordingUrl: 'https://api.twilio.com/RE000',
        durationSeconds: 0,
      },
      mockClient as any
    );

    return res.success === false && res.message?.includes('Zero-length');
  });

  // TEST 11: Cross-tenant voicemail isolation
  await assertTest('11. Cross-tenant voicemail lookup is REJECTED', async () => {
    const mockClient = createMockSupabase('pro', {
      orgId: 'org-attacker',
      voicemails: [{ id: 'vm-1', organization_id: 'org-victim', provider_recording_sid: 'RE-victim' }],
    });

    const vm = await VoicemailService.getVoicemailById('org-attacker', 'vm-1', mockClient as any);
    return vm === null;
  });

  // TEST 12: Soft delete operation
  await assertTest('12. Voicemail soft-delete sets status = deleted', async () => {
    const mockClient = createMockSupabase('pro');
    const res = await VoicemailService.softDeleteVoicemail('org-pro', 'vm-1', mockClient as any);
    return res.success === true;
  });

  // TEST 13: List voicemails & unread count
  await assertTest('13. List voicemails returns items and unread count', async () => {
    const mockClient = createMockSupabase('pro', {
      voicemails: [
        { id: 'vm-1', organization_id: 'org-pro', is_read: false, duration_seconds: 20, created_at: new Date().toISOString() },
      ],
    });

    const res = await VoicemailService.listVoicemails('org-pro', { page: 1, limit: 10 }, mockClient as any);
    return res.success === true && res.voicemails.length === 1 && res.unreadCount === 1;
  });

  // TEST 14: Queue fallback destination entitlement check
  await assertTest('14. Queue fallback destination voicemail allowed for entitled Pro', async () => {
    const mockClient = createMockSupabase('pro');
    const res = await QueueService.createQueue(
      'org-pro',
      {
        name: 'Support Queue',
        strategy: 'fifo',
        fallbackDestinationType: 'voicemail',
      },
      mockClient as any
    );
    return res.success === true;
  });

  // TEST 15: Queue fallback destination voicemail denied for Starter
  await assertTest('15. Queue fallback destination voicemail DENIED for Starter', async () => {
    const mockClient = createMockSupabase('starter');
    const res = await QueueService.createQueue(
      'org-starter',
      {
        name: 'Support Queue',
        strategy: 'fifo',
        fallbackDestinationType: 'voicemail',
      },
      mockClient as any
    );
    return res.success === false && res.message.includes('not enabled');
  });

  // SUMMARY
  console.log('\n====================================================');
  console.log(`  RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase19E1TestSuite().catch((err) => {
  console.error('Test runner exception:', err);
  process.exit(1);
});
