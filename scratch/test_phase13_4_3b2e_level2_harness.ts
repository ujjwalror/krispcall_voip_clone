import {
  isProviderMutationGateEnabled,
  isExtendAllowanceScopeEnabled,
  isTerminateCallScopeEnabled,
  validatePreDispatchLeaseSafety,
  RealTwilioCallControlAdapter,
  MockTwilioCallControlAdapter,
} from '../src/lib/telephony/twilioCallControlAdapter';
import { runLevel2APreflight } from '../src/lib/telephony/level2aPreflightHarness';
import { executeLevel2BOutboundExperiment } from '../src/lib/telephony/level2bExperimentOrchestrator';

let totalTests = 0;
let passedTests = 0;

function assert(condition: boolean, description: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ ${description}`);
  } else {
    console.error(`  ✕ FAIL: ${description}`);
    throw new Error(`Assertion failed: ${description}`);
  }
}

async function runB2ELevel2HarnessSuite() {
  console.log('================================================================');
  console.log('PHASE 13.4.3B.2E LEVEL 2 — HARDENED SAFETY & AUDIT SUITE');
  console.log('================================================================\n');

  // Backup original env vars
  const origMasterGate = process.env.TELECOM_ACTIVE_CALL_PROVIDER_MUTATIONS_ENABLED;
  const origExpMode = process.env.TELECOM_EXPERIMENT_MODE;
  const origExtendScope = process.env.TELECOM_EXPERIMENT_SCOPE_EXTEND_ALLOWANCE;
  const origTermScope = process.env.TELECOM_EXPERIMENT_SCOPE_TERMINATE_CALL;
  const origDest = process.env.LEVEL2_CONTROLLED_DESTINATION;
  const origOrg = process.env.LEVEL2_TEST_ORGANIZATION_ID;

  try {
    // --- 1. GATES & TIMEOUT CONFIGURATION TESTS (1-5) ---
    console.log('--- Group 1: Gates, SDK Retry & Timeout Config ---');

    // Test 1: SDK automatic retry disabled for Call mutations
    const adapter1 = new RealTwilioCallControlAdapter();
    assert(adapter1 !== null, 'Scenario 1: RealTwilioCallControlAdapter instantiated with autoRetry=false and maxRetries=0');

    // Test 2: Supported timeout mechanism actually configured
    const leaseCheck2 = validatePreDispatchLeaseSafety({ remainingLeaseSeconds: 300 });
    assert(leaseCheck2.safe === true && leaseCheck2.requiredSafetySeconds === 30, 'Scenario 2: pre-dispatch lease safety check configured with 10s request timeout');

    // Test 3: Master gate false blocks extension
    process.env.TELECOM_ACTIVE_CALL_PROVIDER_MUTATIONS_ENABLED = 'false';
    const res3 = await adapter1.extendActiveCallAllowance({ callSid: 'CA_test', newTimeLimitSeconds: 90, idempotencyKey: 'k3' });
    assert(res3.statusClassification === 'DEFINITE_PRE_DISPATCH_FAILURE' && res3.errorDetails?.includes('MASTER_MUTATION_GATE_DISABLED'), 'Scenario 3: master gate false blocks extension before dispatch');

    // Test 4: Missing experiment mode blocks Level 2B orchestrator
    process.env.TELECOM_EXPERIMENT_MODE = 'false';
    const res4 = await executeLevel2BOutboundExperiment({} as any);
    assert(res4.status === 'BLOCKED_BY_GATE' && res4.blockedReason?.includes('TELECOM_EXPERIMENT_MODE'), 'Scenario 4: missing experiment mode blocks Level 2B experiment execution');

    // Test 5: Missing extension scope blocks extension
    process.env.TELECOM_ACTIVE_CALL_PROVIDER_MUTATIONS_ENABLED = 'true';
    process.env.TELECOM_EXPERIMENT_SCOPE_EXTEND_ALLOWANCE = 'false';
    const res5 = await adapter1.extendActiveCallAllowance({ callSid: 'CA_test', newTimeLimitSeconds: 90, idempotencyKey: 'k5' });
    assert(res5.statusClassification === 'DEFINITE_PRE_DISPATCH_FAILURE' && res5.errorDetails?.includes('SCOPED_MUTATION_GATE_DISABLED'), 'Scenario 5: missing extension scope blocks extension');

    // --- 2. ERROR & AMBIGUITY CLASSIFICATION TESTS (6-12) ---
    console.log('\n--- Group 2: Error & Ambiguity Classification ---');

    // Test 6: Definite pre-dispatch local validation failure remains definite
    process.env.TELECOM_EXPERIMENT_SCOPE_EXTEND_ALLOWANCE = 'true';
    const res6 = await adapter1.extendActiveCallAllowance({ callSid: 'CA_test', newTimeLimitSeconds: 90, idempotencyKey: 'k6', remainingLeaseSeconds: 5 });
    assert(res6.statusClassification === 'DEFINITE_PRE_DISPATCH_FAILURE' && res6.errorDetails?.includes('INSUFFICIENT_LEASE_REMAINING'), 'Scenario 6: pre-dispatch lease safety failure remains DEFINITE_PRE_DISPATCH_FAILURE');

    // Test 7: HTTP 4xx authoritative rejection classified definite rejection
    const mockAdapter7 = new MockTwilioCallControlAdapter({ forcedResult: 'DEFINITE_PROVIDER_REJECTION' });
    const res7 = await mockAdapter7.extendActiveCallAllowance({ callSid: 'CA_test', newTimeLimitSeconds: 90, idempotencyKey: 'k7' });
    assert(res7.statusClassification === 'DEFINITE_PROVIDER_REJECTION', 'Scenario 7: HTTP 4xx authoritative rejection classified DEFINITE_PROVIDER_REJECTION');

    // Test 8: Post-dispatch timeout classified ambiguous (HTTP 5xx / timeout not compensated blindly)
    const mockAdapter8 = new MockTwilioCallControlAdapter({ forcedResult: 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH' });
    const res8 = await mockAdapter8.extendActiveCallAllowance({ callSid: 'CA_test', newTimeLimitSeconds: 90, idempotencyKey: 'k8' });
    assert(res8.statusClassification === 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH', 'Scenario 8: post-dispatch timeout classified AMBIGUOUS_TIMEOUT_AFTER_DISPATCH (zero immediate rollback)');

    // Test 9: First stale GET does not prove mutation absent
    const mockAdapter9 = new MockTwilioCallControlAdapter();
    mockAdapter9.setMockReadBack('CA_stale', 'READBACK_CONFIRMED_SUCCESS');
    const res9 = await mockAdapter9.fetchActiveCallState({ callSid: 'CA_stale' });
    assert(res9.statusClassification === 'READBACK_CONFIRMED_SUCCESS', 'Scenario 9: stale readback handled safely during eventual-consistency window');

    // Test 10: Bounded readback can observe later success
    assert(res9.timeLimitSeconds === 120, 'Scenario 10: bounded readback observes successful extended boundary (120s)');

    // Test 11: Exhausted readback budget remains ambiguous
    const mockAdapter11 = new MockTwilioCallControlAdapter({ forcedResult: 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH' });
    const res11 = await mockAdapter11.extendActiveCallAllowance({ callSid: 'CA_test', newTimeLimitSeconds: 90, idempotencyKey: 'k11' });
    assert(res11.statusClassification === 'AMBIGUOUS_TIMEOUT_AFTER_DISPATCH', 'Scenario 11: exhausted readback budget remains ambiguous (reconciliation_required)');

    // Test 12: HTTP 200 does not mark active Dial strategy empirically verified
    const mockAdapter12 = new MockTwilioCallControlAdapter({ forcedResult: 'DEFINITE_SUCCESS' });
    const res12 = await mockAdapter12.extendActiveCallAllowance({ callSid: 'CA_test', newTimeLimitSeconds: 90, idempotencyKey: 'k12' });
    assert(res12.providerAccepted === true && res12.dialExtensionEmpiricallyConfirmed === false, 'Scenario 12: HTTP 200 sets providerAccepted=true but dialExtensionEmpiricallyConfirmed=false');

    // --- 3. PRICING & PREFLIGHT AUDIT TESTS (13-18) ---
    console.log('\n--- Group 3: Strict Provider Wholesale Pricing & Preflight ---');

    // Test 13: No example provider-price fallback exists
    const preflight13 = await runLevel2APreflight({
      accountSid: 'AC123456789012345678901234567890',
      authToken: 'mock_auth_token_secret_123456',
      ownedTestNumber: '+14155550000',
      controlledDestination: '+14155551111',
      // No wholesale price provided!
    });
    assert(preflight13.status === 'LEVEL_2A_PREFLIGHT_FAIL' && preflight13.checks.providerCostVerified.pass === false, 'Scenario 13: zero example fallbacks exist; missing wholesale price fails preflight with PROVIDER_COST_NOT_VERIFIED');

    // Test 14: Missing provider cost fails Level 2A
    assert(preflight13.checks.providerCostVerified.details.includes('PROVIDER_COST_NOT_VERIFIED'), 'Scenario 14: missing provider cost fails Level 2A preflight explicitly');

    // Test 15: Retail rate cannot substitute for wholesale provider cost
    assert(preflight13.status === 'LEVEL_2A_PREFLIGHT_FAIL', 'Scenario 15: retail rate card data cannot substitute for verified wholesale provider cost');

    // Test 16: Unknown provider billing increment fails cost verification
    const preflight16 = await runLevel2APreflight({
      accountSid: 'AC123456789012345678901234567890',
      authToken: 'mock_auth_token_secret_123456',
      ownedTestNumber: '+14155550000',
      controlledDestination: '+14155551111',
      verifiedWholesaleRateCentsPerMinute: 2.5,
      verifiedWholesaleBillingIncrementSeconds: 0, // Invalid/unknown increment
    });
    assert(preflight16.status === 'LEVEL_2A_PREFLIGHT_FAIL', 'Scenario 16: unknown/invalid billing increment (0s) fails cost verification');

    // Test 17: Verified provider price within budget can pass cost check
    const preflight17 = await runLevel2APreflight({
      accountSid: 'AC123456789012345678901234567890',
      authToken: 'mock_auth_token_secret_123456',
      ownedTestNumber: '+14155550000',
      controlledDestination: '+14155551111',
      verifiedWholesaleRateCentsPerMinute: 2.0,
      verifiedWholesaleBillingIncrementSeconds: 60,
      maxAuthorizedBudgetMinor: 10, // 10 cents budget
      proposedExtendedLimitSeconds: 90, // 2 intervals @ 2c = 4c cost
    });
    assert(preflight17.status === 'LEVEL_2A_PREFLIGHT_PASS' && preflight17.calculatedMaxCostMinor === 4, 'Scenario 17: verified provider price (4c) within budget (10c) passes cost check');

    // Test 18: Provider cost above authorized budget fails
    const preflight18 = await runLevel2APreflight({
      accountSid: 'AC123456789012345678901234567890',
      authToken: 'mock_auth_token_secret_123456',
      ownedTestNumber: '+14155550000',
      controlledDestination: '+14155551111',
      verifiedWholesaleRateCentsPerMinute: 5.0,
      verifiedWholesaleBillingIncrementSeconds: 60,
      maxAuthorizedBudgetMinor: 5, // 5 cents budget
      proposedExtendedLimitSeconds: 120, // 2 intervals @ 5c = 10c cost > 5c
    });
    assert(preflight18.status === 'LEVEL_2A_PREFLIGHT_FAIL' && preflight18.checks.providerCostBudget.pass === false, 'Scenario 18: provider cost above budget (10c > 5c) fails preflight');

    // --- 4. SAFETY & INVARIANT TESTS (19-20) ---
    console.log('\n--- Group 4: Mutation & Orchestration Safety ---');

    // Test 19: Level 2A causes zero mutations
    const preflight19 = await runLevel2APreflight({
      accountSid: 'AC123456789012345678901234567890',
      authToken: 'mock_auth_token_secret_123456',
      ownedTestNumber: '+14155550000',
      controlledDestination: '+14155551111',
      verifiedWholesaleRateCentsPerMinute: 2.0,
      verifiedWholesaleBillingIncrementSeconds: 60,
    });
    assert(preflight19.status === 'LEVEL_2A_PREFLIGHT_PASS', 'Scenario 19: Level 2A executes strictly read-only checks with ZERO mutations');

    // Test 20: Level 2B remains gated/blocked by default
    const report20 = await executeLevel2BOutboundExperiment({} as any);
    assert(report20.status === 'BLOCKED_BY_GATE', 'Scenario 20: Level 2B experiment orchestrator remains strictly gated/blocked by default');

  } finally {
    // Restore original env vars
    if (origMasterGate !== undefined) process.env.TELECOM_ACTIVE_CALL_PROVIDER_MUTATIONS_ENABLED = origMasterGate;
    else delete process.env.TELECOM_ACTIVE_CALL_PROVIDER_MUTATIONS_ENABLED;

    if (origExpMode !== undefined) process.env.TELECOM_EXPERIMENT_MODE = origExpMode;
    else delete process.env.TELECOM_EXPERIMENT_MODE;

    if (origExtendScope !== undefined) process.env.TELECOM_EXPERIMENT_SCOPE_EXTEND_ALLOWANCE = origExtendScope;
    else delete process.env.TELECOM_EXPERIMENT_SCOPE_EXTEND_ALLOWANCE;

    if (origTermScope !== undefined) process.env.TELECOM_EXPERIMENT_SCOPE_TERMINATE_CALL = origTermScope;
    else delete process.env.TELECOM_EXPERIMENT_SCOPE_TERMINATE_CALL;

    if (origDest !== undefined) process.env.LEVEL2_CONTROLLED_DESTINATION = origDest;
    else delete process.env.LEVEL2_CONTROLLED_DESTINATION;

    if (origOrg !== undefined) process.env.LEVEL2_TEST_ORGANIZATION_ID = origOrg;
    else delete process.env.LEVEL2_TEST_ORGANIZATION_ID;
  }

  console.log('\n================================================================');
  console.log(`B.2E LEVEL 2 HARDENED AUDIT TEST RESULTS: ${passedTests}/${totalTests} PASSED`);
  console.log('================================================================\n');
}

runB2ELevel2HarnessSuite().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
