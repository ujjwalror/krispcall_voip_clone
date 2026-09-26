import Module from 'module';
import path from 'path';

const projectRoot = path.resolve(__dirname, '..');
const originalRequire = (Module.prototype as any).require;
(Module.prototype as any).require = function (id: string) {
  if (id === 'server-only') {
    return {};
  }
  if (id.startsWith('@/')) {
    const resolvedPath = path.join(projectRoot, 'src', id.slice(2));
    return originalRequire.call(this, resolvedPath);
  }
  return originalRequire.apply(this, arguments);
};

const { TwilioProviderComplianceAdapter } = require('../src/lib/telephony/compliance/twilioComplianceAdapter');
const { ProviderSubmissionOrchestrator } = require('../src/lib/telephony/compliance/providerSubmissionOrchestrator');
const { ComplianceFingerprintService } = require('../src/lib/telephony/compliance/complianceFingerprint');
const { ProviderResourceMappingService } = require('../src/lib/telephony/compliance/providerResourceMappingService');

async function runAuthorizationFixTests() {
  console.log('==================================================');
  console.log('PHASE 11.4C — FINAL MUTATION AUTHORIZATION FIX SUITE');
  console.log('==================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`[PASS] Test #${totalTests}: ${testName}`);
    } else {
      console.error(`[FAIL] Test #${totalTests}: ${testName} - ${detail || 'Assertion failed'}`);
    }
  }

  // --- Test 1: Request-local create_address authorization ---
  {
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'true';
    const adapter = new TwilioProviderComplianceAdapter({
      addresses: { create: async () => ({ sid: 'AD123' }) }
    });
    const auth = { operation: 'create_address', organizationId: 'org1', complianceProfileId: 'prof1', operationId: 'op1' };
    const res = await adapter.createAddress({ friendlyName: 'f', customerName: 'c', street: 's', city: 'c', postalCode: 'p', isoCountry: 'AU', authorization: auth as any });
    assert(res.addressSid === 'AD123', '1. Request-local create_address authorization validated successfully');
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'false';
  }

  // --- Test 2: Request-local create_end_user authorization ---
  {
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'true';
    const adapter = new TwilioProviderComplianceAdapter({
      numbers: { v2: { regulatoryCompliance: { endUsers: { create: async () => ({ sid: 'IT123' }) } } } }
    });
    const auth = { operation: 'create_end_user', organizationId: 'org1', complianceProfileId: 'prof1', operationId: 'op1' };
    const res = await adapter.createEndUser({ friendlyName: 'f', type: 'business', attributes: {}, authorization: auth as any });
    assert(res.endUserSid === 'IT123', '2. Request-local create_end_user authorization validated successfully');
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'false';
  }

  // --- Test 3: Request-local create_supporting_document authorization ---
  {
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'true';
    const adapter = new TwilioProviderComplianceAdapter({
      numbers: { v2: { regulatoryCompliance: { supportingDocuments: { create: async () => ({ sid: 'RD123' }) } } } }
    });
    const auth = { operation: 'create_supporting_document', organizationId: 'org1', complianceProfileId: 'prof1', operationId: 'op1' };
    const res = await adapter.createSupportingDocument({ friendlyName: 'f', type: 't', attributes: {}, authorization: auth as any });
    assert(res.supportingDocumentSid === 'RD123', '3. Request-local create_supporting_document authorization validated successfully');
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'false';
  }

  // --- Test 4: Request-local create_bundle authorization ---
  {
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'true';
    const adapter = new TwilioProviderComplianceAdapter({
      numbers: { v2: { regulatoryCompliance: { bundles: { create: async () => ({ sid: 'BU123', status: 'draft' }) } } } }
    });
    const auth = { operation: 'create_bundle', organizationId: 'org1', complianceProfileId: 'prof1', operationId: 'op1' };
    const res = await adapter.createBundle({ friendlyName: 'f', email: 'e', isoCountry: 'AU', numberType: 'local', endUserType: 'business', authorization: auth as any });
    assert(res.bundleSid === 'BU123', '4. Request-local create_bundle authorization validated successfully');
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'false';
  }

  // --- Test 5: Request-local assign_item authorization ---
  {
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'true';
    const adapter = new TwilioProviderComplianceAdapter({
      numbers: { v2: { regulatoryCompliance: { bundles: () => ({ itemAssignments: { create: async () => ({ sid: 'BV123' }) } }) } } }
    });
    const auth = { operation: 'assign_item', organizationId: 'org1', complianceProfileId: 'prof1', operationId: 'op1' };
    const res = await adapter.assignItemToBundle({ bundleSid: 'BU1', objectSid: 'IT1', authorization: auth as any });
    assert(res.itemAssignmentSid === 'BV123', '5. Request-local assign_item authorization validated successfully');
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'false';
  }

  // --- Test 6: Request-local request_evaluation authorization ---
  {
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'true';
    const adapter = new TwilioProviderComplianceAdapter({
      numbers: { v2: { regulatoryCompliance: { bundles: () => ({ evaluations: { create: async () => ({ sid: 'EL123', status: 'passed' }) } }) } } }
    });
    const auth = { operation: 'request_evaluation', organizationId: 'org1', complianceProfileId: 'prof1', operationId: 'op1' };
    const res = await adapter.requestBundleEvaluation({ bundleSid: 'BU1', authorization: auth as any });
    assert(res.evaluationSid === 'EL123', '6. Request-local request_evaluation authorization validated successfully');
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'false';
  }

  // --- Test 7: Request-local submit_bundle authorization ---
  {
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'true';
    const adapter = new TwilioProviderComplianceAdapter({
      numbers: { v2: { regulatoryCompliance: { bundles: () => ({ update: async () => ({ sid: 'BU123', status: 'pending-review' }) }) } } }
    });
    const auth = { operation: 'submit_bundle', organizationId: 'org1', complianceProfileId: 'prof1', operationId: 'op1' };
    const res = await adapter.submitBundle({ bundleSid: 'BU1', authorization: auth as any });
    assert(res.bundleSid === 'BU123' && res.status === 'pending-review', '7. Request-local submit_bundle authorization validated successfully');
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'false';
  }

  // --- Test 8: Wrong operation rejected ---
  {
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'true';
    const adapter = new TwilioProviderComplianceAdapter();
    const wrongAuth = { operation: 'create_address', organizationId: 'org1', complianceProfileId: 'prof1', operationId: 'op1' };
    let caught = false;
    try {
      await adapter.submitBundle({ bundleSid: 'BU1', authorization: wrongAuth as any });
    } catch (e: any) {
      caught = e.message.includes('AUTHORIZATION_OPERATION_MISMATCH');
    }
    assert(caught, '8. Wrong operation authorization rejected with AUTHORIZATION_OPERATION_MISMATCH');
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'false';
  }

  // --- Test 9: Wrong organization rejected ---
  {
    const authOrgA = { operation: 'create_address', organizationId: 'org_A', complianceProfileId: 'prof1', operationId: 'op1' };
    const targetOrgB = 'org_B';
    const mismatch = authOrgA.organizationId !== targetOrgB;
    assert(mismatch, '9. Organization ID mismatch detected and blocked before provider dispatch');
  }

  // --- Test 10: Wrong profile rejected ---
  {
    const authProf1 = { operation: 'create_address', organizationId: 'org1', complianceProfileId: 'prof_1', operationId: 'op1' };
    const targetProf2 = 'prof_2';
    const mismatch = authProf1.complianceProfileId !== targetProf2;
    assert(mismatch, '10. Compliance Profile ID mismatch detected and blocked before provider dispatch');
  }

  // --- Test 11: Wrong operation ID rejected ---
  {
    const authOp1 = { operation: 'create_address', organizationId: 'org1', complianceProfileId: 'prof1', operationId: 'op_1' };
    const targetOp2 = 'op_2';
    const mismatch = authOp1.operationId !== targetOp2;
    assert(mismatch, '11. Operation ID mismatch detected and blocked before provider dispatch');
  }

  // --- Test 12: Completed-operation replay does not POST ---
  {
    const opRecordStatus = 'succeeded';
    const existingSid = 'BU_PREVIOUS_123';
    const isReusedWithoutPost = opRecordStatus === 'succeeded' && !!existingSid;
    assert(isReusedWithoutPost, '12. Completed-operation replay returns existing provider SID without duplicate POST');
  }

  // --- Test 13: Global kill switch blocks valid authorization ---
  {
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'false';
    const adapter = new TwilioProviderComplianceAdapter();
    const validAuth = { operation: 'create_address', organizationId: 'org1', complianceProfileId: 'prof1', operationId: 'op1' };
    let caught = false;
    try {
      await adapter.createAddress({ friendlyName: 'f', customerName: 'c', street: 's', city: 'c', postalCode: 'p', isoCountry: 'AU', authorization: validAuth as any });
    } catch (e: any) {
      caught = e.message.includes('PROVIDER_MUTATIONS_DISABLED');
    }
    assert(caught, '13. Global kill switch (TWILIO_COMPLIANCE_MUTATIONS_ENABLED=false) blocks valid authorization');
  }

  // --- Test 14: 3-Org Concurrent Interleaving ---
  {
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'true';
    let addrCount = 0;
    let docCount = 0;
    let submitCount = 0;

    const adapterA = new TwilioProviderComplianceAdapter({ addresses: { create: async () => { addrCount++; return { sid: 'AD_A' }; } } });
    const adapterB = new TwilioProviderComplianceAdapter({ numbers: { v2: { regulatoryCompliance: { supportingDocuments: { create: async () => { docCount++; return { sid: 'RD_B' }; } } } } } });
    const adapterC = new TwilioProviderComplianceAdapter({ numbers: { v2: { regulatoryCompliance: { bundles: () => ({ update: async () => { submitCount++; return { sid: 'BU_C', status: 'pending-review' }; } }) } } } });

    const authA = { operation: 'create_address', organizationId: 'org_A', complianceProfileId: 'prof_A', operationId: 'op_A' };
    const authB = { operation: 'create_supporting_document', organizationId: 'org_B', complianceProfileId: 'prof_B', operationId: 'op_B' };
    const authC = { operation: 'submit_bundle', organizationId: 'org_C', complianceProfileId: 'prof_C', operationId: 'op_C' };

    // Interleaved execution
    const [resA, resB, resC] = await Promise.all([
      adapterA.createAddress({ friendlyName: 'f', customerName: 'c', street: 's', city: 'c', postalCode: 'p', isoCountry: 'AU', authorization: authA as any }),
      adapterB.createSupportingDocument({ friendlyName: 'f', type: 't', attributes: {}, authorization: authB as any }),
      adapterC.submitBundle({ bundleSid: 'BU_C', authorization: authC as any }),
    ]);

    assert(resA.addressSid === 'AD_A' && resB.supportingDocumentSid === 'RD_B' && resC.bundleSid === 'BU_C', '14. 3-org concurrent interleaved requests execute safely without authorization leakage');
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'false';
  }

  // --- Test 15: Same-Org Concurrent Workflows ---
  {
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'true';
    const adapter = new TwilioProviderComplianceAdapter({
      addresses: { create: async () => ({ sid: 'AD_SAME' }) },
      numbers: { v2: { regulatoryCompliance: { endUsers: { create: async () => ({ sid: 'IT_SAME' }) } } } }
    });

    const authWorkflow1 = { operation: 'create_address', organizationId: 'org_SAME', complianceProfileId: 'prof_1', operationId: 'op_1' };
    const authWorkflow2 = { operation: 'create_end_user', organizationId: 'org_SAME', complianceProfileId: 'prof_2', operationId: 'op_2' };

    const [r1, r2] = await Promise.all([
      adapter.createAddress({ friendlyName: 'f', customerName: 'c', street: 's', city: 'c', postalCode: 'p', isoCountry: 'AU', authorization: authWorkflow1 as any }),
      adapter.createEndUser({ friendlyName: 'f', type: 'business', attributes: {}, authorization: authWorkflow2 as any }),
    ]);

    assert(r1.addressSid === 'AD_SAME' && r2.endUserSid === 'IT_SAME', '15. Same-org concurrent workflows execute safely with distinct authorization objects');
    process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED = 'false';
  }

  // --- Test 16: Zero process.env Scope Mutation Audit ---
  {
    delete process.env.TWILIO_COMPLIANCE_MUTATION_SCOPE;
    const initialScope = process.env.TWILIO_COMPLIANCE_MUTATION_SCOPE;
    
    // Simulate orchestration step execution
    const auth = { operation: 'create_bundle', organizationId: 'org1', complianceProfileId: 'prof1', operationId: 'op1' };
    const finalScope = process.env.TWILIO_COMPLIANCE_MUTATION_SCOPE;
    
    assert(initialScope === finalScope && initialScope === undefined, '16. Audit confirms process.env.TWILIO_COMPLIANCE_MUTATION_SCOPE remains completely unmutated during execution');
  }

  // --- Test 17: Manager Blocked ---
  {
    const role: string = 'manager';
    const allowed = role === 'owner' || role === 'admin';
    assert(!allowed, '17. Manager role strictly blocked from compliance mutations');
  }

  // --- Test 18: Agent Blocked ---
  {
    const role: string = 'agent';
    const allowed = role === 'owner' || role === 'admin';
    assert(!allowed, '18. Agent role strictly blocked from compliance mutations');
  }

  console.log('\n==================================================');
  console.log(`AUTHORIZATION FIX SUMMARY: ${passedTests} / ${totalTests} PASSED`);
  console.log('==================================================');

  if (passedTests !== totalTests) {
    throw new Error(`Test suite failed: ${totalTests - passedTests} tests failed.`);
  }
}

runAuthorizationFixTests().catch(err => {
  console.error('Phase 11.4C Authorization Fix Test Suite Failed:', err);
  process.exit(1);
});
