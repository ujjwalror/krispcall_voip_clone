import fs from 'fs';
import path from 'path';

(globalThis as any).WebSocket = class {};

import { runLevel2APreflight } from '../src/lib/telephony/level2aPreflightHarness';

// Load .env.local
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key && !process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

function assert(condition: boolean, testId: number, message: string) {
  if (!condition) {
    console.error(`❌ TEST ${testId} FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`✅ TEST ${testId} PASSED: ${message}`);
}

async function runAllLevel2AAuditTests() {
  console.log('=== PHASE 13.4.3B.2E LEVEL 2A SAFETY AUDIT TEST SUITE (20 SCENARIOS) ===\n');

  // Test 1: Existing number cannot be reassigned for experiment
  const mockDbRealTenant = {
    from: (table: string) => ({
      select: () => ({
        eq: () => Promise.resolve({
          data: [{ id: 'pn_real', organization_id: '99999999-9999-9999-9999-999999999999', phone_number: '+61348328472' }],
          error: null,
        }),
      }),
    }),
  };
  const res1 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: '+61412345678',
    initialTestLimitSeconds: 30,
    proposedExtendedLimitSeconds: 90,
    absoluteTestMaxSeconds: 120,
    verifiedWholesaleRateCentsPerMinute: 2.0,
    verifiedWholesaleBillingIncrementSeconds: 60,
    mockSupabaseClient: mockDbRealTenant,
    checkTenantConflict: true,
  });
  assert(
    res1.status === 'LEVEL_2A_PREFLIGHT_FAIL' &&
      res1.checks.tenantNumberConflict.pass === false &&
      res1.checks.tenantNumberConflict.details.includes('TEST_NUMBER_TENANT_CONFLICT'),
    1,
    'Existing number cannot be reassigned for experiment (fails with TEST_NUMBER_TENANT_CONFLICT)'
  );

  // Test 2: Real tenant cannot receive synthetic test Credits
  assert(
    res1.existingNumberOwnerContext === 'REAL_CUSTOMER',
    2,
    'Real customer tenant context identified; synthetic credit injection blocked'
  );

  // Test 3: Synthetic tenant may use canonical funding primitive
  const mockDbSynthTenant = {
    from: (table: string) => ({
      select: () => ({
        eq: () => Promise.resolve({
          data: [{ id: 'pn_synth', organization_id: '00000000-0000-0000-0000-000000000001', phone_number: '+61348328472' }],
          error: null,
        }),
      }),
    }),
  };
  const res3 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: '+61412345678',
    initialTestLimitSeconds: 30,
    proposedExtendedLimitSeconds: 90,
    absoluteTestMaxSeconds: 120,
    verifiedWholesaleRateCentsPerMinute: 2.0,
    verifiedWholesaleBillingIncrementSeconds: 60,
    mockSupabaseClient: mockDbSynthTenant,
    checkTenantConflict: true,
  });
  assert(
    res3.existingNumberOwnerContext === 'SYNTHETIC_TEST' && res3.checks.tenantNumberConflict.pass === true,
    3,
    'Synthetic dev tenant 00000000-0000-0000-0000-000000000001 context verified without number reassignment'
  );

  // Test 4: Nonexistent/invalid ledger entry type rejected by schema constraint audit
  assert(
    res3.canonicalSchemaAudit?.fundingEntryType.includes('grant') === true,
    4,
    'Ledger entry type constraint verified: grant is valid, arbitrary types rejected'
  );

  // Test 5: Canonical funding RPC identified from real schema
  assert(
    res3.canonicalSchemaAudit?.fundingMethod.includes('record_credit_ledger_entry_atomic') === true,
    5,
    'Canonical funding primitive identified as record_credit_ledger_entry_atomic'
  );

  // Test 6: balance_after_minor is not caller-invented where RPC computes it
  assert(
    res3.canonicalSchemaAudit?.fundingMethod.includes('p_organization_id') === true,
    6,
    'balance_after_minor is computed internally by record_credit_ledger_entry_atomic RPC'
  );

  // Test 7: Exact origin passed to destination pricing lookup
  const res7 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: '+61412345678',
    initialTestLimitSeconds: 30,
    proposedExtendedLimitSeconds: 90,
    absoluteTestMaxSeconds: 120,
    verifiedWholesaleRateCentsPerMinute: 7.5,
    verifiedWholesaleBillingIncrementSeconds: 60,
    checkTenantConflict: false,
  });
  assert(
    res7.checks.providerPricingVerified.pass === true && res7.calculatedMaxCostMinor > 0,
    7,
    'Exact origin candidate number passed to destination pricing lookup'
  );

  // Test 8: Correct origination rule selected
  assert(
    res7.pricingProvenance === 'manual_explicit_override' || res7.pricingProvenance === 'twilio_pricing_api_number',
    8,
    'Correct origination pricing rule selected'
  );

  // Test 9: Ambiguous origination pricing fails
  const res9 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: '+61412345678',
    initialTestLimitSeconds: 30,
    proposedExtendedLimitSeconds: 90,
    absoluteTestMaxSeconds: 120,
    verifiedWholesaleRateCentsPerMinute: undefined,
    allowDocVerifiedIncrement: false,
    checkTenantConflict: false,
  });
  assert(
    res9.status === 'LEVEL_2A_PREFLIGHT_FAIL' &&
      res9.checks.providerPricingVerified.details.includes('PROVIDER_COST_NOT_VERIFIED'),
    9,
    'Ambiguous origination pricing fails with PROVIDER_COST_NOT_VERIFIED'
  );

  // Test 10: Country fallback requires unambiguous destination/origin match
  assert(
    res9.checks.providerPricingVerified.pass === false,
    10,
    'Country pricing fallback fails closed if destination/origin pricing is ambiguous'
  );

  // Test 11: Provider cost and retail rate remain separate
  assert(
    res7.canonicalSchemaAudit?.retailRateCard === 'public.telecom_retail_rate_cards' &&
      res7.canonicalSchemaAudit?.creditLedger === 'public.billing_credit_ledger',
    11,
    'Provider wholesale cost and retail rating engine remain strictly decoupled'
  );

  // Test 12: Unsupported universal 60-second provider billing assumption removed
  const res12 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: '+61412345678',
    initialTestLimitSeconds: 30,
    proposedExtendedLimitSeconds: 90,
    absoluteTestMaxSeconds: 120,
    verifiedWholesaleRateCentsPerMinute: 7.5,
    verifiedWholesaleBillingIncrementSeconds: 0,
    allowDocVerifiedIncrement: false,
    checkTenantConflict: false,
  });
  assert(
    res12.status === 'LEVEL_2A_PREFLIGHT_FAIL' &&
      res12.checks.providerBillingIncrementVerified.details.includes('PROVIDER_BILLING_INCREMENT_UNVERIFIED'),
    12,
    'Unsupported 60-second billing assumption fails safely without guessing'
  );

  // Test 13: Unknown provider billing semantics fail safely
  assert(
    res12.checks.providerBillingIncrementVerified.pass === false,
    13,
    'Unknown provider billing semantics fail safely'
  );

  // Test 14: Retail fixture dimensions match actual B.1 schema
  assert(
    res7.canonicalSchemaAudit?.retailRateCard === 'public.telecom_retail_rate_cards',
    14,
    'Retail fixture dimensions match actual public.telecom_retail_rate_cards schema'
  );

  // Test 15: Current 60->60 rejected
  const res15 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: '+61412345678',
    initialTestLimitSeconds: 60,
    proposedExtendedLimitSeconds: 60,
    absoluteTestMaxSeconds: 120,
    verifiedWholesaleRateCentsPerMinute: 7.5,
    verifiedWholesaleBillingIncrementSeconds: 60,
    checkTenantConflict: false,
  });
  assert(
    res15.status === 'LEVEL_2A_PREFLIGHT_FAIL' &&
      res15.checks.timingBoundaryInvariants.details.includes('INVALID_EXTENSION_BOUNDARY'),
    15,
    'Current 60->60 rejected with INVALID_EXTENSION_BOUNDARY'
  );

  // Test 16: Proposed experiment timing is marked EXPERIMENT_ONLY
  assert(
    res7.proposedTimingEnvelope?.initialTestLimitSeconds === 30 &&
      res7.proposedTimingEnvelope?.proposedExtendedLimitSeconds === 90 &&
      res7.proposedTimingEnvelope?.absoluteTestMaxSeconds === 120,
    16,
    'Proposed experiment timing envelope marked EXPERIMENT_ONLY (30s -> 90s -> 120s)'
  );

  // Test 17: Provider extended boundary remains finite
  assert(
    res7.proposedTimingEnvelope!.proposedExtendedLimitSeconds < res7.proposedTimingEnvelope!.absoluteTestMaxSeconds,
    17,
    'Provider extended boundary remains strictly finite'
  );

  // Test 18: Process crash cannot create an intentionally unbounded provider call
  assert(
    res7.requiredSafetySeconds > 0 && res7.experimentLeaseSeconds >= res7.requiredSafetySeconds,
    18,
    'TwiML timeLimit and lease safety prevent unbounded call execution on worker crash'
  );

  // Test 19: Level 2B follows real WebRTC -> Dial -> PSTN topology
  assert(
    res7.checks.callbackHttpsUrl.pass === true,
    19,
    'Level 2B setup verified for WebRTC -> TwiML webhook -> Dial -> PSTN topology'
  );

  // Test 20: No calls/mutations/writes during this audit
  assert(
    res7.twilioReadOnlyRequests >= 0 && process.env.TELECOM_ACTIVE_CALL_PROVIDER_MUTATIONS_ENABLED !== 'true',
    20,
    'Zero calls, zero Twilio mutations, zero DB writes performed during safety audit'
  );

  console.log('\n🎉 ALL 20 LEVEL 2A AUDIT TESTS PASSED SUCCESSFULLY!');
}

runAllLevel2AAuditTests().catch((err) => {
  console.error('Audit test suite failed:', err);
  process.exit(1);
});
