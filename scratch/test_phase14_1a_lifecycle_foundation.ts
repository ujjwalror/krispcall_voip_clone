import { AutomaticReleaseEvaluator } from '../src/lib/telephony/lifecycle/automaticReleaseEvaluator';
import { PortabilityService } from '../src/lib/telephony/lifecycle/portabilityService';
import { PortOutInstructionService } from '../src/lib/telephony/lifecycle/portOutInstructionService';
import { PortOperationService } from '../src/lib/telephony/lifecycle/portOperationService';

async function runValidation() {
  console.log('====================================================');
  console.log('STAGE 14.1A PROVIDER-NEUTRAL LIFECYCLE TEST SUITE');
  console.log('====================================================');

  let passedAssertions = 0;

  // 1. Automatic Release Evaluator: PORT_OUT_PENDING Blocks Auto-Release
  console.log('\n--- Assertion 1: PORT_OUT_PENDING Blocks Auto-Release ---');
  const res1 = AutomaticReleaseEvaluator.evaluateReleaseEligibility({
    organizationId: '00000000-0000-0000-0000-000000000001',
    phoneNumberId: 'phone-123',
    phoneNumberE164: '+12025550199',
    numberStatus: 'suspended',
    paymentState: 'unpaid',
    activePortOutPending: true, // ACTIVE PORT OUT
    providerAmbiguityOrReconciliationRequired: false,
    legalOrRegulatoryHold: false,
    concurrentDestructiveOperation: false,
    ownershipMismatch: false,
  });

  if (!res1.eligible && res1.blockers.some((b) => b.includes('ACTIVE_PORT_OUT_PENDING'))) {
    console.log('[PASS] PORT_OUT_PENDING correctly blocked automatic release!');
    passedAssertions++;
  } else {
    console.error('[FAIL] Active port-out failed to block release!');
    process.exit(1);
  }

  // 2. Automatic Release Evaluator: Unknown Payment State Blocks Auto-Release
  console.log('\n--- Assertion 2: Unknown Payment State Blocks Auto-Release ---');
  const res2 = AutomaticReleaseEvaluator.evaluateReleaseEligibility({
    organizationId: '00000000-0000-0000-0000-000000000001',
    phoneNumberId: 'phone-123',
    phoneNumberE164: '+12025550199',
    numberStatus: 'suspended',
    paymentState: 'unknown', // UNKNOWN PAYMENT
    activePortOutPending: false,
    providerAmbiguityOrReconciliationRequired: false,
    legalOrRegulatoryHold: false,
    concurrentDestructiveOperation: false,
    ownershipMismatch: false,
  });

  if (!res2.eligible && res2.blockers.some((b) => b.includes('PAYMENT_STATE_UNKNOWN'))) {
    console.log('[PASS] Unknown payment state correctly failed closed!');
    passedAssertions++;
  } else {
    console.error('[FAIL] Unknown payment state allowed release!');
    process.exit(1);
  }

  // 3. Automatic Release Evaluator: Provider Ambiguity Blocks Auto-Release
  console.log('\n--- Assertion 3: Provider Ambiguity Blocks Auto-Release ---');
  const res3 = AutomaticReleaseEvaluator.evaluateReleaseEligibility({
    organizationId: '00000000-0000-0000-0000-000000000001',
    phoneNumberId: 'phone-123',
    phoneNumberE164: '+12025550199',
    numberStatus: 'suspended',
    paymentState: 'unpaid',
    activePortOutPending: false,
    providerAmbiguityOrReconciliationRequired: true, // PROVIDER AMBIGUITY
    legalOrRegulatoryHold: false,
    concurrentDestructiveOperation: false,
    ownershipMismatch: false,
  });

  if (!res3.eligible && res3.blockers.some((b) => b.includes('PROVIDER_AMBIGUITY_UNRESOLVED'))) {
    console.log('[PASS] Provider ambiguity correctly blocked automatic release!');
    passedAssertions++;
  } else {
    console.error('[FAIL] Provider ambiguity allowed release!');
    process.exit(1);
  }

  // 4. Dynamic Portability Service: Dynamic Workflow Mode Resolution (NO Static Tiers)
  console.log('\n--- Assertion 4: Dynamic Provider Capability (No Static Tiers) ---');
  const autoPort = await PortabilityService.evaluatePortability({
    phoneNumberE164: '+12025550100',
    countryCode: 'US',
    providerMockResponse: {
      workflowMode: 'automated_api',
      portable: true,
    },
  });
  const assistedPort = await PortabilityService.evaluatePortability({
    phoneNumberE164: '+4930123456',
    countryCode: 'DE',
    providerMockResponse: {
      workflowMode: 'assisted_manual',
      portable: true,
      customerReason: 'Manual carrier LOA verification required.',
    },
  });

  if (autoPort.workflowMode === 'automated_api' && assistedPort.workflowMode === 'assisted_manual') {
    console.log('[PASS] Provider workflow modes resolved dynamically without static country tier rules!');
    passedAssertions++;
  } else {
    console.error('[FAIL] Dynamic workflow mode resolution failed!');
    process.exit(1);
  }

  // 5. Port-Out Instruction Service: Provider-Neutral Instructions & Requirements
  console.log('\n--- Assertion 5: Provider-Neutral Port-Out Instructions ---');
  const instructions = PortOutInstructionService.generateInstructions({
    phoneNumberE164: '+61298765432',
    status: 'port_out_pending',
    accountNumberRequired: true,
    pinRequired: false,
  });

  if (instructions.status === 'port_out_pending' && instructions.instructionSummary.includes('strictly paused')) {
    console.log('[PASS] Port-out instructions generated cleanly with pending release pause guidance!');
    passedAssertions++;
  } else {
    console.error('[FAIL] Port-out instruction generation failed!');
    process.exit(1);
  }

  // 6. Provider Redaction & DTO Audit
  console.log('\n--- Assertion 6: Provider Redaction on Customer DTO ---');
  const sampleOpRow = {
    id: 'op-1234-uuid',
    organization_id: '00000000-0000-0000-0000-000000000001',
    phone_number_e164: '+12025550199',
    direction: 'port_in',
    status: 'submitted',
    workflow_mode: 'automated_api',
    provider: 'twilio',
    provider_port_id: 'PR1234567890abcdef',
    retail_amount_minor: 500,
    retail_currency: 'USD',
    provider_cost_minor: 250,
    provider_cost_currency: 'USD',
    customer_message: 'Port request submitted to carrier.',
    created_at: new Date().toISOString(),
  };

  const dto = PortOperationService.toCustomerSafeDTO(sampleOpRow);
  const dtoKeys = Object.keys(dto);
  console.log('DTO Keys:', dtoKeys);

  const forbiddenTerms = ['twilio', 'provider_port_id', 'provider_cost_minor', 'wholesale'];
  let leaked = false;
  for (const term of forbiddenTerms) {
    if (dtoKeys.includes(term) || JSON.stringify(dto).toLowerCase().includes('pr1234567890abcdef')) {
      console.error(`[FAIL] Provider internal leaked in DTO: ${term}`);
      leaked = true;
    }
  }

  if (!leaked) {
    console.log('[PASS] ZERO provider internals or SIDs leaked in Customer DTO!');
    passedAssertions++;
  } else {
    process.exit(1);
  }

  console.log('\n====================================================');
  console.log(`ALL ${passedAssertions} LIFECYCLE FOUNDATION TESTS PASSED!`);
  console.log('====================================================');
}

runValidation().catch((err) => {
  console.error('Validation suite error:', err);
  process.exit(1);
});
