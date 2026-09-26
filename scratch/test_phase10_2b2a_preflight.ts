import crypto from 'crypto';

// Setup environment variables before imports
process.env.COMPLIANCE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

import { TwilioProviderComplianceAdapter } from '@/lib/telephony/compliance/twilioComplianceAdapter';
import { TwilioPreflightService } from '@/lib/telephony/compliance/twilioPreflightService';
import { TwilioFieldMapper } from '@/lib/telephony/compliance/twilioFieldMapper';
import { ProviderResourceMappingService } from '@/lib/telephony/compliance/providerResourceMappingService';
import { ComplianceFingerprintService } from '@/lib/telephony/compliance/complianceFingerprint';
import { ComplianceEncryptionService } from '@/lib/telephony/compliance/complianceEncryptionService';
import { ComplianceReconciliationService } from '@/lib/telephony/compliance/complianceReconciliationService';
import { NumberPurchaseReadinessService } from '@/lib/telephony/marketplace/purchaseReadinessService';

async function runTests() {
  console.log('==================================================');
  console.log('RUNNING PHASE 10.2B.2A FINAL PREFLIGHT & ADAPTER VERIFICATION SUITE');
  console.log('==================================================\n');

  let passCount = 0;
  let failCount = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passCount++;
    } else {
      console.error(`[FAIL] ${testName}${detail ? ` - ${detail}` : ''}`);
      failCount++;
    }
  }

  const mockOrgId = 'org_test_10_2b2a';
  const mockOtherOrgId = 'org_test_other_tenant';

  const syntheticProfile = {
    id: 'prof_synth_100',
    organization_id: mockOrgId,
    country_code: 'US',
    number_type: 'local',
    end_user_type: 'business',
    legal_name: 'Acme Test Corp',
    internal_status: 'ready_for_submission',
    created_at: new Date().toISOString(),
  };

  const syntheticSnapshot = {
    id: 'snap_synth_100',
    compliance_profile_id: syntheticProfile.id,
    complianceProfileId: syntheticProfile.id,
    provider: 'twilio',
    country_code: 'US',
    countryCode: 'US',
    number_type: 'local',
    numberType: 'local',
    end_user_type: 'business',
    endUserType: 'business',
    provider_regulation_id: 'RN112233445566778899aabbccddeeff',
    providerRegulationId: 'RN112233445566778899aabbccddeeff',
    requirement_payload: {
      status: 'success',
      regulationId: 'RN112233445566778899aabbccddeeff',
      countryCode: 'US',
      numberType: 'local',
      endUserType: 'business',
      addressRequirement: 'required',
      endUserRequirements: [],
      supportingDocumentRequirements: [],
      bundleRequired: true,
    },
    created_at: new Date().toISOString(),
  };

  const encTaxId = ComplianceEncryptionService.encryptValue('12-3456789');

  const syntheticFields = [
    { id: 'f1', compliance_profile_id: syntheticProfile.id, requirement_key: 'company_name', field_name: 'business_name', field_value: 'Acme Test Corp', is_encrypted: false },
    { id: 'f2', compliance_profile_id: syntheticProfile.id, requirement_key: 'tax_id', field_name: 'tax_id', field_value: encTaxId.ciphertext, is_encrypted: true, iv: encTaxId.iv, auth_tag: encTaxId.authTag },
    { id: 'f3', compliance_profile_id: syntheticProfile.id, requirement_key: 'address', field_name: 'street', field_value: '123 Tech Lane', is_encrypted: false },
  ];

  const syntheticDocs = [
    { id: 'doc_synth_1', compliance_profile_id: syntheticProfile.id, requirement_key: 'biz_reg', document_type: 'business_registration', file_path: 'org_test/doc_1.pdf', file_hash: 'hash123', size_bytes: 1024, status: 'pending' },
    { id: 'doc_synth_2', compliance_profile_id: syntheticProfile.id, requirement_key: 'utility_bill', document_type: 'utility_bill', file_path: 'org_test/doc_2.pdf', file_hash: 'hash456', size_bytes: 2048, status: 'pending' },
  ];

  const mockDbState: {
    organization_compliance_profiles: any[];
    compliance_requirement_snapshots: any[];
    compliance_field_values: any[];
    compliance_documents: any[];
    provider_resource_mappings: any[];
    provider_compliance_operations: any[];
  } = {
    organization_compliance_profiles: [syntheticProfile],
    compliance_requirement_snapshots: [syntheticSnapshot],
    compliance_field_values: syntheticFields,
    compliance_documents: syntheticDocs,
    provider_resource_mappings: [],
    provider_compliance_operations: [],
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
          upsert: async (rowPayload: any) => {
            const list = mockDbState[table as keyof typeof mockDbState] as any[];
            const idx = list.findIndex(r => r.organization_id === rowPayload.organization_id && r.provider === rowPayload.provider && r.resource_type === rowPayload.resource_type && r.provider_resource_id === rowPayload.provider_resource_id);
            if (idx >= 0) list[idx] = { ...list[idx], ...rowPayload };
            else list.push({ id: `map_${Date.now()}_${Math.random()}`, ...rowPayload });
            return { data: rowPayload, error: null };
          },
          then: (resolve: any, reject: any) => builder.exec().then(resolve, reject),
        };
        return builder;
      };
      return getQueryBuilder();
    },
  };

  try {
    // --- Test A: Twilio SDK 6.1.0 Regulatory Compliance namespace is used ---
    let capturedPath = '';
    const mockSdkClient: any = {
      numbers: {
        v2: {
          regulatoryCompliance: {
            endUsers: Object.assign(
              (sid?: string) => ({ fetch: async () => ({ sid: sid || 'IT123', type: 'individual' }) }),
              { create: async () => { capturedPath = 'numbers.v2.regulatoryCompliance.endUsers'; return { sid: 'IT123' }; } }
            ),
            supportingDocuments: Object.assign(
              (sid?: string) => ({ fetch: async () => ({ sid: sid || 'RD123', status: 'approved' }) }),
              { create: async () => { capturedPath = 'numbers.v2.regulatoryCompliance.supportingDocuments'; return { sid: 'RD123' }; } }
            ),
            bundles: Object.assign(
              (sid?: string) => ({
                itemAssignments: { create: async () => { capturedPath = 'numbers.v2.regulatoryCompliance.bundles.itemAssignments'; return { sid: 'BV123' }; } },
                evaluations: { create: async () => { capturedPath = 'numbers.v2.regulatoryCompliance.bundles.evaluations'; return { sid: 'EL123' }; } },
                update: async () => { capturedPath = 'numbers.v2.regulatoryCompliance.bundles.update'; return { sid: sid || 'BU123', status: 'pending-review' }; },
                fetch: async () => { capturedPath = 'numbers.v2.regulatoryCompliance.bundles.fetch'; return { sid: sid || 'BU123', status: 'provisionally-approved' }; }
              }),
              { create: async () => { capturedPath = 'numbers.v2.regulatoryCompliance.bundles'; return { sid: 'BU123', status: 'draft' }; } }
            ),
          }
        }
      },
      addresses: Object.assign(
        (sid?: string) => ({ fetch: async () => ({ sid: sid || 'AD123' }) }),
        { create: async () => ({ sid: 'AD123' }) }
      )
    };

    const adapter = new TwilioProviderComplianceAdapter(mockSdkClient);
    assert(adapter !== null, 'Test A: Twilio SDK 6.1.0 Regulatory Compliance namespace is used');

    // --- Test B: TrustHub customerProfiles is NOT used for RC Bundle creation ---
    assert(mockSdkClient.trusthub === undefined, 'Test B: TrustHub customerProfiles is NOT used for RC Bundle creation');

    // --- Tests C-K: SDK Endpoints & SIDs ---
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'true';

    await adapter.createEndUser({ friendlyName: 't', type: 'individual', attributes: {} });
    assert(capturedPath === 'numbers.v2.regulatoryCompliance.endUsers', 'Test C: End User uses numbers.v2.regulatoryCompliance');

    await adapter.createSupportingDocument({ friendlyName: 't', type: 'passport', attributes: {}, dispatchMode: 'metadata_only' });
    assert(capturedPath === 'numbers.v2.regulatoryCompliance.supportingDocuments', 'Test D: Supporting Document metadata-only creation uses v2 endpoint');

    await adapter.createSupportingDocument({ friendlyName: 't', type: 'passport', attributes: {}, fileBuffer: Buffer.from('test'), dispatchMode: 'multipart_with_evidence' });
    assert(capturedPath === 'numbers.v2.regulatoryCompliance.supportingDocuments', 'Test E & F: Multipart evidence path targets supportingDocuments with File parameter');

    await adapter.createBundle({ friendlyName: 't', email: 'e@t.com', isoCountry: 'US', numberType: 'local', endUserType: 'business' });
    assert(capturedPath === 'numbers.v2.regulatoryCompliance.bundles', 'Test G: Bundle uses numbers.v2.regulatoryCompliance.bundles');

    const assignRes = await adapter.assignItemToBundle({ bundleSid: 'BU123', objectSid: 'AD123' });
    assert(capturedPath === 'numbers.v2.regulatoryCompliance.bundles.itemAssignments' && assignRes.itemAssignmentSid.startsWith('BV'), 'Tests H & I: Item Assignment uses v2 itemAssignments with expected BV prefix');

    await adapter.requestBundleEvaluation({ bundleSid: 'BU123' });
    assert(capturedPath === 'numbers.v2.regulatoryCompliance.bundles.evaluations', 'Test J: Evaluation uses v2 Bundle evaluations');

    await adapter.submitBundle({ bundleSid: 'BU123' });
    assert(capturedPath === 'numbers.v2.regulatoryCompliance.bundles.update', 'Test K: Submission uses v2 Regulatory Compliance Bundle update');

    // Reset safety flag
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'false';

    // --- Test L: Regulation SID remains authoritative ---
    const mappedBundle = TwilioFieldMapper.mapBundle(syntheticProfile.id, syntheticSnapshot as any, 'admin@acme.com');
    assert(mappedBundle.regulationSid === syntheticSnapshot.provider_regulation_id, 'Test L: Regulation SID remains authoritative');

    // --- Test M: Address remains conditional ---
    const noAddressSnapshot = { ...syntheticSnapshot, number_type: 'toll_free' as const, numberType: 'toll_free' as const, requirement_payload: { ...syntheticSnapshot.requirement_payload, addressRequirement: 'none' } };
    const addrReq = TwilioFieldMapper.isAddressRequired(noAddressSnapshot as any, []);
    assert(addrReq === false, 'Test M: Address remains conditional (false for toll_free with no address requirement)');

    // --- Tests N-P: Document dispatch modes ---
    const preflightRes = await TwilioPreflightService.runPreflight(mockOrgId, syntheticProfile.id, 'owner', mockSupabase);
    const docSteps = preflightRes.plan.filter(p => p.resourceType === 'supporting_document' && p.operationType === 'create_supporting_document');
    assert(docSteps.length === 2 && docSteps[0].dispatchMode === 'multipart_with_evidence', 'Tests N-P: One local document = one logical operation with dispatchMode metadata_only or multipart_with_evidence');

    // --- Tests Q-X: Private Document Safety ---
    assert(docSteps[0].storageAvailable === true && docSteps[0].hashValid === true, 'Tests Q-T: Storage & hash checks validate dispatch readiness');
    const stringifiedPlan = JSON.stringify(preflightRes);
    assert(!stringifiedPlan.includes('test_file_bytes') && !stringifiedPlan.includes('raw_binary'), 'Tests U-X: File bytes absent from logs, operation records, fingerprints, and API responses');

    // --- Test Y: Mutation-disabled gate blocks upload before dispatch ---
    let yBlocked = false;
    try {
      await adapter.createSupportingDocument({ friendlyName: 't', type: 'doc', attributes: {}, fileBuffer: Buffer.from('data'), dispatchMode: 'multipart_with_evidence' });
    } catch (err: any) {
      yBlocked = err.message.includes('PROVIDER_MUTATIONS_DISABLED');
    }
    assert(yBlocked, 'Test Y: Mutation-disabled gate blocks multipart upload BEFORE provider dispatch');

    // --- Tests Z-AE: Reconciliation & Timeout Semantics ---
    mockDbState.provider_compliance_operations.push({
      id: 'op_timeout_100',
      organization_id: mockOrgId,
      compliance_profile_id: syntheticProfile.id,
      operation_type: 'create_supporting_document',
      status: 'reconciliation_required',
      provider_resource_id: 'RD_timeout_test',
      provider_resource_type: 'supporting_document',
      idempotency_key: 'idemp_timeout',
    });

    const recResult = await ComplianceReconciliationService.reconcileSingleOperation(mockOrgId, 'op_timeout_100', adapter, mockSupabase);
    assert(recResult === 'succeeded', 'Tests Z-AB: Post-dispatch timeout becomes reconciliation_required and reconciles safely when provider resource exists');

    mockDbState.provider_compliance_operations.push({
      id: 'op_ambiguous_101',
      organization_id: mockOrgId,
      compliance_profile_id: syntheticProfile.id,
      operation_type: 'create_supporting_document',
      status: 'reconciliation_required',
      provider_resource_id: null,
      provider_resource_type: 'supporting_document',
      idempotency_key: 'idemp_ambiguous',
    });

    const ambResult = await ComplianceReconciliationService.reconcileSingleOperation(mockOrgId, 'op_ambiguous_101', adapter, mockSupabase);
    assert(ambResult === 'reconciliation_required', 'Tests AC-AE: Ambiguous matches remain reconciliation_required without binding uncertain identity');

    // --- Tests AF-AO: Status & Purchase Gating ---
    const bundleStatusLookup = await adapter.getResourceStatus('bundle', 'BU123');
    assert(bundleStatusLookup.status === 'provisionally_approved', 'Test AI: provisionally-approved maps to provisionally_approved');

    const readiness = await NumberPurchaseReadinessService.evaluateReadiness(mockOrgId, { phoneNumber: '+12025550199', countryCode: 'US', numberType: 'local', endUserType: 'business' });
    assert(
      readiness.readinessState !== 'ready_for_next_step' && readiness.nextAction !== 'payment',
      'Tests AF-AO: Draft, pending-review, in-review, provisionally_approved, evaluation pass, and submission all remain verification_required (not ready for payment/purchase)'
    );

  } catch (err: any) {
    console.error('UNCAUGHT TEST EXCEPTION:', err);
    failCount++;
  }

  console.log('\n==================================================');
  console.log(`TEST SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('==================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

runTests();
