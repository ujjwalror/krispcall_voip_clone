import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Setup encryption key
if (!process.env.COMPLIANCE_ENCRYPTION_KEY) {
  process.env.COMPLIANCE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
}

import { ProviderComplianceAdapter } from '@/lib/telephony/compliance/providerComplianceAdapter';
import { ProviderSubmissionOrchestrator } from '@/lib/telephony/compliance/providerSubmissionOrchestrator';
import { TwilioPreflightService } from '@/lib/telephony/compliance/twilioPreflightService';
import { ComplianceProfileService } from '@/lib/telephony/compliance/complianceProfileService';
import { ProviderResourceMappingService } from '@/lib/telephony/compliance/providerResourceMappingService';
import { NumberPurchaseReadinessService } from '@/lib/telephony/marketplace/purchaseReadinessService';

/**
 * Synthetic Mock Provider Adapter for testing complete Phase 11.3 orchestration flows
 */
class MockProviderComplianceAdapter implements ProviderComplianceAdapter {
  public liveMutationCalls = 0;
  public addressCalls = 0;
  public endUserCalls = 0;
  public docCalls = 0;
  public bundleCalls = 0;
  public assignmentCalls = 0;
  public evalCalls = 0;
  public submitCalls = 0;
  public evalShouldFail = false;
  public timeoutOnStep: string | null = null;

  async createAddress(params: any) {
    this.addressCalls++;
    this.liveMutationCalls++;
    if (this.timeoutOnStep === 'create_address') throw new Error('ETIMEDOUT: Network provider timeout');
    return { addressSid: `AD_mock_${Date.now()}_${Math.floor(Math.random() * 1000)}` };
  }

  async createEndUser(params: any) {
    this.endUserCalls++;
    this.liveMutationCalls++;
    if (this.timeoutOnStep === 'create_end_user') throw new Error('ETIMEDOUT: Network provider timeout');
    return { endUserSid: `IT_mock_${Date.now()}_${Math.floor(Math.random() * 1000)}` };
  }

  async createSupportingDocument(params: any) {
    this.docCalls++;
    this.liveMutationCalls++;
    if (this.timeoutOnStep === 'create_supporting_document') throw new Error('ETIMEDOUT: Network provider timeout');
    return { supportingDocumentSid: `RD_mock_${Date.now()}_${Math.floor(Math.random() * 1000)}` };
  }

  async createBundle(params: any) {
    this.bundleCalls++;
    this.liveMutationCalls++;
    if (this.timeoutOnStep === 'create_bundle') throw new Error('ETIMEDOUT: Network provider timeout');
    return { bundleSid: `BU_mock_${Date.now()}_${Math.floor(Math.random() * 1000)}`, status: 'draft' };
  }

  async assignItemToBundle(params: any) {
    this.assignmentCalls++;
    this.liveMutationCalls++;
    if (this.timeoutOnStep === 'assign_item_to_bundle') throw new Error('ETIMEDOUT: Network provider timeout');
    return { itemAssignmentSid: `BV_mock_${Date.now()}_${Math.floor(Math.random() * 1000)}` };
  }

  async requestBundleEvaluation(params: any) {
    this.evalCalls++;
    this.liveMutationCalls++;
    if (this.evalShouldFail) {
      return { evaluationSid: `EL_mock_${Date.now()}`, status: 'failed', results: [{ friendlyName: 'Address Check', status: 'failed' }] };
    }
    return { evaluationSid: `EL_mock_${Date.now()}`, status: 'passed' };
  }

  async submitBundle(params: any) {
    this.submitCalls++;
    this.liveMutationCalls++;
    if (this.timeoutOnStep === 'submit_bundle') throw new Error('ETIMEDOUT: Network provider timeout');
    return { bundleSid: params.bundleSid, status: 'pending-review' };
  }

  async getResourceStatus(resourceType: string, resourceSid: string) {
    return { status: 'pending-review', details: { sid: resourceSid, status: 'pending-review' } };
  }
}

async function runSyntheticOrchestrationSuite() {
  console.log('==================================================');
  console.log('RUNNING PHASE 11.3 SYNTHETIC ORCHESTRATION SUITE');
  console.log('==================================================\n');

  const mockOrgId = 'org_phase11_3_test';
  const mockProfileId = 'prof_phase11_3_test';
  const mockUserId = 'usr_owner_11_3';

  // In-memory DB state
  const mockDbState: {
    profiles: any[];
    organization_compliance_profiles: any[];
    compliance_requirement_snapshots: any[];
    compliance_field_values: any[];
    compliance_documents: any[];
    provider_compliance_operations: any[];
    provider_resource_mappings: any[];
  } = {
    profiles: [
      { id: 'usr_owner_11_3', role: 'owner', organization_id: mockOrgId },
      { id: 'usr_admin_11_3', role: 'admin', organization_id: mockOrgId },
      { id: 'usr_agent_11_3', role: 'agent', organization_id: mockOrgId },
      { id: 'usr_other_11_3', role: 'owner', organization_id: 'org_other_tenant' },
    ],
    organization_compliance_profiles: [
      {
        id: mockProfileId,
        organization_id: mockOrgId,
        end_user_type: 'business',
        country_code: 'AU',
        legal_name: 'Synthetic Telecom Corp',
        status: 'ready_for_submission',
        created_by: mockUserId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
    compliance_requirement_snapshots: [
      {
        id: 'snap_11_3',
        compliance_profile_id: mockProfileId,
        provider: 'twilio',
        provider_regulation_id: 'RN_au_business_local',
        country_code: 'AU',
        number_type: 'local',
        end_user_type: 'business',
        requirement_payload: {
          status: 'success',
          regulationId: 'RN_au_business_local',
          countryCode: 'AU',
          numberType: 'local',
          endUserType: 'business',
          addressRequirement: 'required',
          endUserRequirements: [{ type: 'business_registration_number' }],
          supportingDocumentRequirements: [{ type: 'business_registration_proof' }],
          bundleRequired: true,
        },
        retrieved_at: new Date().toISOString(),
      },
    ],
    compliance_field_values: [
      {
        id: 'fv_1',
        compliance_profile_id: mockProfileId,
        requirement_key: 'business_registration_number',
        field_name: 'business_registration_number',
        field_value: 'ABN-123456789',
        is_encrypted: false,
      },
    ],
    compliance_documents: [
      {
        id: 'doc_11_3_proof',
        organization_id: mockOrgId,
        compliance_profile_id: mockProfileId,
        requirement_key: 'business_registration_proof',
        document_type: 'business_registration_proof',
        file_path: 'private/org_phase11_3/doc_11_3.pdf',
        original_filename: 'abn_certificate.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1024 * 100,
        file_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        status: 'uploaded',
      },
    ],
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

        let updatePayload: any = null;

        const builder: any = {
          select: () => builder,
          eq: (col: string, val: any) => { filters.push({ col, val }); return builder; },
          in: (col: string, vals: any[]) => { filters.push({ col, val: vals }); return builder; },
          order: () => builder,
          limit: (n: number) => { limitVal = n; return builder; },
          single: () => { isSingle = true; return builder.exec(); },
          maybeSingle: () => { isMaybeSingle = true; return builder.exec(); },
          update: (payload: any) => { updatePayload = payload; return builder; },
          exec: async () => {
            let list = mockDbState[table as keyof typeof mockDbState] || [];
            for (const f of filters) {
              if (Array.isArray(f.val)) {
                list = list.filter((r: any) => f.val.includes(r[f.col]));
              } else {
                list = list.filter((r: any) => r[f.col] === f.val);
              }
            }
            if (updatePayload) {
              for (const r of list) {
                Object.assign(r, updatePayload);
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
            const inserted = { id: `id_${Date.now()}_${Math.random()}`, ...rowPayload };
            list.push(inserted);
            return {
              select: () => ({
                single: async () => ({ data: inserted, error: null }),
                exec: async () => ({ data: [inserted], error: null }),
              }),
            };
          },
          upsert: (rowPayload: any) => {
            const list = mockDbState[table as keyof typeof mockDbState] as any[];
            const idx = list.findIndex(
              r => r.organization_id === rowPayload.organization_id &&
                   r.provider === rowPayload.provider &&
                   r.resource_type === rowPayload.resource_type &&
                   r.provider_resource_id === rowPayload.provider_resource_id
            );
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
    // TEST 1: Preflight Verification
    console.log('[TEST 1] Running preflight check on synthetic profile...');
    const preflight = await TwilioPreflightService.runPreflight(mockOrgId, mockProfileId, 'owner', mockSupabase);
    console.log(`[TEST 1 RESULT] Preflight Ready=${preflight.ready}, Errors=${preflight.errors.length}, Steps=${preflight.plan.length}`);
    if (!preflight.ready) throw new Error('Preflight failed unexpected');

    // TEST 2: Fresh Full Orchestration Execution
    console.log('\n[TEST 2] Executing fresh full submission orchestration via Mock Adapter...');
    const mockAdapter = new MockProviderComplianceAdapter();
    const result1 = await ProviderSubmissionOrchestrator.executeSubmissionPipeline(
      mockOrgId,
      mockProfileId,
      'owner',
      mockAdapter,
      mockUserId,
      mockSupabase
    );

    console.log(`[TEST 2 RESULT] Orchestration Succeeded! Bundle SID: ${result1.bundleSid}, Status: ${result1.bundleStatus}`);
    console.log(`[TEST 2 STATS] Operations Executed: ${result1.operationsExecuted}, Reused: ${result1.operationsReused}`);
    console.log(`[TEST 2 CALLS] Address Calls: ${mockAdapter.addressCalls}, EndUser Calls: ${mockAdapter.endUserCalls}, Doc Calls: ${mockAdapter.docCalls}, Bundle Calls: ${mockAdapter.bundleCalls}, Assignment Calls: ${mockAdapter.assignmentCalls}, Eval Calls: ${mockAdapter.evalCalls}, Submit Calls: ${mockAdapter.submitCalls}`);

    if (result1.operationsExecuted !== 9) throw new Error(`Expected 9 operations executed, got ${result1.operationsExecuted}`);

    // TEST 3: Idempotency & Restartability (Second Run Reuses All Steps)
    console.log('\n[TEST 3] Re-running orchestrator to test idempotency and restartability...');
    const mockAdapter2 = new MockProviderComplianceAdapter();
    const result2 = await ProviderSubmissionOrchestrator.executeSubmissionPipeline(
      mockOrgId,
      mockProfileId,
      'owner',
      mockAdapter2,
      mockUserId,
      mockSupabase
    );

    console.log(`[TEST 3 RESULT] Idempotency Verified! Bundle SID: ${result2.bundleSid}`);
    console.log(`[TEST 3 STATS] Operations Executed: ${result2.operationsExecuted}, Reused: ${result2.operationsReused}`);
    console.log(`[TEST 3 CALLS] Total Mock Mutations on Second Run: ${mockAdapter2.liveMutationCalls}`);

    if (result2.operationsExecuted !== 0 || result2.operationsReused !== 9 || mockAdapter2.liveMutationCalls !== 0) {
      throw new Error(`Idempotency failed! Re-execution did not reuse all operations cleanly.`);
    }

    // TEST 4: Bundle Evaluation Failure Handling
    console.log('\n[TEST 4] Testing bundle evaluation failure handling...');
    // Create new profile needing submission where evaluation fails
    const failProfileId = 'prof_eval_fail';
    mockDbState.organization_compliance_profiles.push({
      id: failProfileId,
      organization_id: mockOrgId,
      end_user_type: 'individual',
      country_code: 'US',
      legal_name: 'Eval Fail User',
      status: 'ready_for_submission',
    });
    mockDbState.compliance_requirement_snapshots.push({
      id: 'snap_fail',
      compliance_profile_id: failProfileId,
      provider: 'twilio',
      provider_regulation_id: 'RN_us_individual_local',
      country_code: 'US',
      number_type: 'local',
      end_user_type: 'individual',
      requirement_payload: { status: 'success', regulationId: 'RN_us_individual_local', addressRequirement: null, endUserRequirements: [], supportingDocumentRequirements: [], bundleRequired: true },
    });

    const mockAdapterFail = new MockProviderComplianceAdapter();
    mockAdapterFail.evalShouldFail = true;

    let evalFailedAsExpected = false;
    try {
      await ProviderSubmissionOrchestrator.executeSubmissionPipeline(mockOrgId, failProfileId, 'owner', mockAdapterFail, mockUserId, mockSupabase);
    } catch (err: any) {
      if (err.message.includes('EVALUATION_FAILED')) {
        evalFailedAsExpected = true;
      }
    }
    console.log(`[TEST 4 RESULT] Evaluation Failure Handling: Blocked submission before dispatch = ${evalFailedAsExpected}, Submit Calls = ${mockAdapterFail.submitCalls}`);
    if (!evalFailedAsExpected || mockAdapterFail.submitCalls !== 0) {
      throw new Error('Evaluation failure did not block submission!');
    }

    // TEST 5: Ambiguous Network Timeout & Reconciliation Required Handling
    console.log('\n[TEST 5] Testing provider timeout & reconciliation_required boundary...');
    const timeoutProfileId = 'prof_timeout';
    mockDbState.organization_compliance_profiles.push({
      id: timeoutProfileId,
      organization_id: mockOrgId,
      end_user_type: 'business',
      country_code: 'AU',
      legal_name: 'Timeout Corp',
      status: 'ready_for_submission',
    });
    mockDbState.compliance_requirement_snapshots.push({
      id: 'snap_timeout',
      compliance_profile_id: timeoutProfileId,
      provider: 'twilio',
      provider_regulation_id: 'RN_au_business_local',
      country_code: 'AU',
      number_type: 'local',
      end_user_type: 'business',
      requirement_payload: { status: 'success', regulationId: 'RN_au_business_local', addressRequirement: null, endUserRequirements: [], supportingDocumentRequirements: [], bundleRequired: true },
    });

    const mockAdapterTimeout = new MockProviderComplianceAdapter();
    mockAdapterTimeout.timeoutOnStep = 'create_end_user';

    let reconciliationTriggered = false;
    try {
      await ProviderSubmissionOrchestrator.executeSubmissionPipeline(mockOrgId, timeoutProfileId, 'owner', mockAdapterTimeout, mockUserId, mockSupabase);
    } catch (err: any) {
      if (err.message.includes('RECONCILIATION_REQUIRED')) {
        reconciliationTriggered = true;
      }
    }
    console.log(`[TEST 5 RESULT] Timeout marked operation reconciliation_required = ${reconciliationTriggered}`);
    if (!reconciliationTriggered) throw new Error('Timeout did not set reconciliation_required!');

    // TEST 6: RBAC Authorization Verification
    console.log('\n[TEST 6] Testing RBAC authorization (Agent & Cross-Tenant denied)...');
    let agentDenied = false;
    try {
      await ProviderSubmissionOrchestrator.executeSubmissionPipeline(mockOrgId, mockProfileId, 'agent', new MockProviderComplianceAdapter(), 'usr_agent_11_3', mockSupabase);
    } catch (err: any) {
      if (err.message.includes('UNAUTHORIZED_ROLE')) agentDenied = true;
    }

    let crossTenantDenied = false;
    try {
      await ProviderSubmissionOrchestrator.executeSubmissionPipeline('org_other_tenant', mockProfileId, 'owner', new MockProviderComplianceAdapter(), 'usr_other_11_3', mockSupabase);
    } catch (err: any) {
      if (err.message.includes('FORBIDDEN') || err.message.includes('not found')) crossTenantDenied = true;
    }
    console.log(`[TEST 6 RESULT] Agent Denied = ${agentDenied}, Cross-Tenant Profile Denied = ${crossTenantDenied}`);
    if (!agentDenied || !crossTenantDenied) throw new Error('RBAC security checks failed!');

    // TEST 7: Purchase Readiness Locked State Verification
    console.log('\n[TEST 7] Testing Purchase Readiness locked state for non-approved profiles...');
    const readiness = await NumberPurchaseReadinessService.evaluateReadiness(mockOrgId, {
      phoneNumber: '+6125550199',
      countryCode: 'AU',
      numberType: 'local',
      endUserType: 'business',
    });
    console.log(`[TEST 7 RESULT] Purchase Readiness state=${readiness.readinessState}, verificationRequired=${readiness.verificationRequired}`);
    if ((readiness.readinessState as string) === 'ready') throw new Error('Purchase Readiness was unlocked for unapproved profile!');

    console.log('\n==================================================');
    console.log('ALL PHASE 11.3 SYNTHETIC TEST SCENARIOS PASSED 100%');
    console.log('==================================================');

  } catch (err: any) {
    console.error('SYNTHETIC TEST SUITE EXCEPTION:', err);
    process.exit(1);
  }
}

runSyntheticOrchestrationSuite();
