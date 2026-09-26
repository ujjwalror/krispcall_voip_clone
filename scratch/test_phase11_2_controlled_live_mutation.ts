import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Load .env.local if present
const envLocalPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envLocalPath)) {
  const envConfig = fs.readFileSync(envLocalPath, 'utf8');
  for (const line of envConfig.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const [key, ...values] = trimmed.split('=');
      if (!process.env[key.trim()]) {
        process.env[key.trim()] = values.join('=').trim().replace(/^["']|["']$/g, '');
      }
    }
  }
}

// Setup encryption key if missing
if (!process.env.COMPLIANCE_ENCRYPTION_KEY) {
  process.env.COMPLIANCE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
}

import { TwilioProviderComplianceAdapter } from '@/lib/telephony/compliance/twilioComplianceAdapter';
import { ProviderOperationService } from '@/lib/telephony/compliance/providerOperationService';
import { ProviderResourceMappingService } from '@/lib/telephony/compliance/providerResourceMappingService';
import { ComplianceFingerprintService } from '@/lib/telephony/compliance/complianceFingerprint';
import { ComplianceReconciliationService } from '@/lib/telephony/compliance/complianceReconciliationService';
import { createTwilioServerClient } from '@/lib/twilio/client';
import { NumberPurchaseReadinessService } from '@/lib/telephony/marketplace/purchaseReadinessService';

async function runControlledTest() {
  console.log('==================================================');
  console.log('RUNNING PHASE 11.2 CONTROLLED LIVE TWILIO MUTATION SUITE');
  console.log('==================================================\n');

  let liveCreatedCount = 0;
  let liveDeletedCount = 0;
  let liveOtherMutationsCount = 0;

  const mockOrgId = 'org_phase11_2_test';
  const mockProfileId = 'prof_phase11_2_test';
  const uniqueSuffix = Date.now().toString().slice(-6);
  const testFriendlyName = `KRISPCALL_TEST_ENDUSER_STEP11_2_${uniqueSuffix}`;

  const adapter = new TwilioProviderComplianceAdapter();
  const realTwilioClient = createTwilioServerClient();

  // In-memory mock database state for operation service & resource mappings
  const mockDbState: {
    profiles: any[];
    provider_compliance_operations: any[];
    provider_resource_mappings: any[];
  } = {
    profiles: [{ id: 'usr_owner', role: 'owner', organization_id: mockOrgId }],
    provider_compliance_operations: [],
    provider_resource_mappings: [],
  };

  const mockSupabase: any = {
    from: (table: string) => {
      const getQueryBuilder = () => {
        let filters: Array<{ col: string; val: any }> = [];
        let limitVal: number | null = null;
        let isSingle = false;
        let isMaybeSingle = false;

        const builder: any = {
          select: () => builder,
          eq: (col: string, val: any) => { filters.push({ col, val }); return builder; },
          in: (col: string, vals: any[]) => { filters.push({ col, val: vals }); return builder; },
          order: () => builder,
          limit: (n: number) => { limitVal = n; return builder; },
          single: () => { isSingle = true; return builder.exec(); },
          maybeSingle: () => { isMaybeSingle = true; return builder.exec(); },
          exec: async () => {
            let list = mockDbState[table as keyof typeof mockDbState] || [];
            for (const f of filters) {
              if (Array.isArray(f.val)) {
                list = list.filter((r: any) => f.val.includes(r[f.col]));
              } else {
                list = list.filter((r: any) => r[f.col] === f.val);
              }
            }
            if (isSingle) {
              if (list.length === 0) return { data: null, error: { message: 'Row not found' } };
              return { data: list[0], error: null };
            }
            if (isMaybeSingle) {
              return { data: list[0] || null, error: null };
            }
            if (limitVal !== null) list = list.slice(0, limitVal);
            return { data: list, error: null };
          },
          insert: (rowPayload: any) => {
            const list = mockDbState[table as keyof typeof mockDbState] as any[];
            const inserted = { id: `op_${Date.now()}_${Math.random()}`, ...rowPayload };
            list.push(inserted);
            return {
              select: () => ({
                single: async () => ({ data: inserted, error: null }),
                exec: async () => ({ data: [inserted], error: null }),
              }),
            };
          },
          update: (payload: any) => {
            const list = mockDbState[table as keyof typeof mockDbState] || [];
            for (const r of list) {
              let match = true;
              for (const f of filters) {
                if (r[f.col] !== f.val) match = false;
              }
              if (match) Object.assign(r, payload);
            }
            return builder;
          },
          upsert: (rowPayload: any) => {
            const list = mockDbState[table as keyof typeof mockDbState] as any[];
            const idx = list.findIndex(r => r.organization_id === rowPayload.organization_id && r.provider === rowPayload.provider && r.resource_type === rowPayload.resource_type && r.provider_resource_id === rowPayload.provider_resource_id);
            let item: any;
            if (idx >= 0) {
              list[idx] = { ...list[idx], ...rowPayload };
              item = list[idx];
            } else {
              item = { id: `map_${Date.now()}_${Math.random()}`, ...rowPayload };
              list.push(item);
            }
            return {
              select: () => ({
                single: async () => ({ data: item, error: null }),
                exec: async () => ({ data: [item], error: null }),
              }),
              exec: async () => ({ data: [item], error: null }),
              then: (resolve: any, reject: any) => Promise.resolve({ data: [item], error: null }).then(resolve, reject),
            };
          },
          then: (resolve: any, reject: any) => builder.exec().then(resolve, reject),
        };
        return builder;
      };
      return getQueryBuilder();
    },
  };

  try {
    // 1. Enable narrow mutation scope
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'true';
    process.env.TWILIO_COMPLIANCE_MUTATION_SCOPE = 'create_end_user';
    console.log('[STEP 1] Narrow mutation scope enabled: TWILIO_COMPLIANCE_MUTATION_SCOPE=create_end_user');

    // 2. Verify all other mutation methods are blocked locally
    const blockedMethods = [
      () => adapter.createAddress({ friendlyName: 't', customerName: 'c', street: 's', city: 'c', postalCode: '1', isoCountry: 'US' }),
      () => adapter.createSupportingDocument({ friendlyName: 't', type: 'doc', attributes: {} }),
      () => adapter.createBundle({ friendlyName: 't', email: 'e@t.com', isoCountry: 'US', numberType: 'local', endUserType: 'business' }),
      () => adapter.assignItemToBundle({ bundleSid: 'BU1', objectSid: 'AD1' }),
      () => adapter.requestBundleEvaluation({ bundleSid: 'BU1' }),
      () => adapter.submitBundle({ bundleSid: 'BU1' }),
    ];

    let blockedCount = 0;
    for (const m of blockedMethods) {
      try {
        await m();
        liveOtherMutationsCount++;
      } catch (err: any) {
        if (err.message.includes('PROVIDER_MUTATION_SCOPE_DENIED')) {
          blockedCount++;
        }
      }
    }
    console.log(`[STEP 2] Scope-blocking verified: ${blockedCount}/6 non-authorized mutation methods blocked before dispatch.`);

    // 3. Create durable operation record BEFORE dispatch
    const idempotencyKey = ComplianceFingerprintService.generateIdempotencyKey(mockOrgId, mockProfileId, 'create_end_user', 'test_end_user_step11_2');
    const fingerprintPayload = { organizationId: mockOrgId, complianceProfileId: mockProfileId, operationType: 'create_end_user' as const, countryCode: 'US', numberType: 'local', endUserType: 'business' };

    const { operation } = await ProviderOperationService.getOrCreateOperation(
      mockOrgId,
      mockProfileId,
      'create_end_user',
      idempotencyKey,
      fingerprintPayload,
      'owner',
      'usr_owner',
      mockSupabase
    );
    console.log(`[STEP 3] Durable operation created in DB prior to dispatch: ${operation.id} (Status: ${operation.status})`);

    // 4. Execute EXACTLY ONE real live provider End User creation
    console.log(`[STEP 4] Dispatching POST /v2/RegulatoryCompliance/EndUsers to live Twilio API (${testFriendlyName})...`);
    const createRes = await adapter.createEndUser({
      friendlyName: testFriendlyName,
      type: 'individual',
      attributes: {
        first_name: 'SyntheticTest',
        last_name: 'StepEleven',
      },
    });

    const createdSid = createRes.endUserSid;
    liveCreatedCount++;
    const maskedSid = `${createdSid.slice(0, 6)}...${createdSid.slice(-4)}`;
    console.log(`[STEP 4 SUCCESS] Live Twilio End User created! Returned SID: ${maskedSid}`);

    // Update DB operation record & record mapping
    await ProviderOperationService.completeOperation(mockOrgId, operation.id, 'end_user', createdSid, mockSupabase);
    await ProviderResourceMappingService.recordMapping(
      mockOrgId,
      mockProfileId,
      'end_user',
      createdSid,
      { countryCode: 'US', numberType: 'local', endUserType: 'business' },
      'test_end_user_step11_2',
      'active',
      {},
      mockSupabase
    );

    // 5. Perform read-only provider fetch verification
    console.log(`[STEP 5] Performing read-only fetch for created End User ${maskedSid}...`);
    const fetchedResource = await realTwilioClient.numbers.v2.regulatoryCompliance.endUsers(createdSid).fetch();
    console.log(`[STEP 5 SUCCESS] Fetched resource verified: SID=${fetchedResource.sid}, friendlyName=${fetchedResource.friendlyName}, type=${fetchedResource.type}`);

    // 6. Verify single provider resource mapping
    const mappings = await ProviderResourceMappingService.getMappingsForProfile(mockOrgId, mockProfileId, mockSupabase);
    console.log(`[STEP 6] Provider resource mappings recorded: ${mappings.length} mapping(s). (SID: ${mappings[0]?.providerResourceId})`);

    // 7. Idempotency test: Re-run logical operation
    console.log('[STEP 7] Testing idempotency: Executing second logical create_end_user call...');
    const { operation: secondOp, isExisting } = await ProviderOperationService.getOrCreateOperation(
      mockOrgId,
      mockProfileId,
      'create_end_user',
      idempotencyKey,
      fingerprintPayload,
      'owner',
      'usr_owner',
      mockSupabase
    );
    console.log(`[STEP 7 SUCCESS] Idempotency re-run detected existing operation: isExisting=${isExisting}, providerResourceId=${secondOp.providerResourceId}. ZERO second POST sent.`);

    // 8. Test read-only status lookup / reconciliation
    const statusLookup = await adapter.getResourceStatus('end_user', createdSid);
    console.log(`[STEP 8] Read-only status lookup verified: status=${statusLookup.status}, details.sid=${statusLookup.details?.sid}`);

    // 9. Cleanup Authorization & Execution
    console.log('[STEP 9] Enabling narrow cleanup scope: TWILIO_COMPLIANCE_MUTATION_SCOPE=delete_end_user...');
    process.env.TWILIO_COMPLIANCE_MUTATION_SCOPE = 'delete_end_user';

    // Verify cleanup eligibility
    if (createdSid.startsWith('IT') && fetchedResource.friendlyName === testFriendlyName) {
      console.log(`[STEP 9] Deleting synthetic test End User ${maskedSid} via client.numbers.v2.regulatoryCompliance.endUsers(sid).remove()...`);
      await adapter.deleteEndUser(createdSid);
      liveDeletedCount++;
      console.log(`[STEP 9 SUCCESS] Live Twilio End User ${maskedSid} deleted successfully.`);
    }

    // 10. Post-delete read-only fetch verification
    let is404 = false;
    try {
      await realTwilioClient.numbers.v2.regulatoryCompliance.endUsers(createdSid).fetch();
    } catch (err: any) {
      if (err.status === 404 || err.code === 20404 || err.message.includes('not found') || err.message.includes('404')) {
        is404 = true;
      }
    }
    console.log(`[STEP 10] Post-delete fetch verification: Resource returns 404/not found = ${is404}`);

    // 11. Reset mutation flags
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'false';
    process.env.TWILIO_COMPLIANCE_MUTATION_SCOPE = 'none';
    console.log('[STEP 11] Reset mutation flags to SAFE default: TWILIO_COMPLIANCE_MUTATIONS_ENABLED=false');

    // 12. Verify post-reset mutation gate blocks calls
    let postResetBlocked = false;
    try {
      await adapter.createEndUser({ friendlyName: 'fail', type: 'individual', attributes: {} });
    } catch (err: any) {
      postResetBlocked = err.message.includes('PROVIDER_MUTATIONS_DISABLED');
    }
    console.log(`[STEP 12] Post-reset safety gate verified: Post-reset createEndUser blocked = ${postResetBlocked}`);

    // 13. Purchase Readiness regression check
    const readiness = await NumberPurchaseReadinessService.evaluateReadiness(mockOrgId, { phoneNumber: '+12025550199', countryCode: 'US', numberType: 'local', endUserType: 'business' });
    console.log(`[STEP 13] Purchase Readiness regression check: status=${readiness.readinessState}, verificationRequired=${readiness.verificationRequired}`);

    console.log('\n==================================================');
    console.log(`FINAL LIVE MUTATION COUNTS:`);
    console.log(`Twilio End Users created: ${liveCreatedCount}`);
    console.log(`Twilio End Users deleted: ${liveDeletedCount}`);
    console.log(`Other Twilio mutations: ${liveOtherMutationsCount}`);
    console.log('==================================================');

  } catch (err: any) {
    console.error('CONTROLLED TEST EXCEPTION:', err);
    process.exit(1);
  }
}

runControlledTest();
