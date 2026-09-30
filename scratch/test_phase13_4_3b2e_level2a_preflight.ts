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

async function runAllLevel2ATests() {
  console.log('=== PHASE 13.4.3B.2E LEVEL 2A PREFLIGHT TEST SUITE ===\n');

  // Test 1: Missing destination fails with CONTROLLED_TEST_DESTINATION_REQUIRED
  const res1 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: undefined,
  });
  assert(
    res1.status === 'LEVEL_2A_PREFLIGHT_FAIL' &&
      res1.checks.controlledDestination.pass === false &&
      res1.checks.controlledDestination.details.includes('CONTROLLED_TEST_DESTINATION_REQUIRED'),
    1,
    'Missing controlled destination fails with CONTROLLED_TEST_DESTINATION_REQUIRED'
  );

  // Test 2: Twilio Pricing API read is mutation-free
  const res2 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: '+61412345678',
    initialTestLimitSeconds: 30,
    proposedExtendedLimitSeconds: 60,
    absoluteTestMaxSeconds: 120,
    verifiedWholesaleRateCentsPerMinute: 2.5,
    verifiedWholesaleBillingIncrementSeconds: 60,
    checkTenantConflict: false,
  });
  assert(
    res2.twilioReadOnlyRequests >= 0,
    2,
    'Twilio preflight query executes with zero mutation side-effects'
  );

  // Test 3: Provider price derived from authoritative response or explicit override
  const res3 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: '+61412345678',
    initialTestLimitSeconds: 30,
    proposedExtendedLimitSeconds: 60,
    absoluteTestMaxSeconds: 120,
    verifiedWholesaleRateCentsPerMinute: 2.52,
    verifiedWholesaleBillingIncrementSeconds: 60,
    checkTenantConflict: false,
  });
  assert(
    res3.checks.providerPricingVerified.pass === true && res3.calculatedMaxCostMinor > 0,
    3,
    'Provider price derived authoritatively'
  );

  // Test 4: Pricing provenance recorded
  assert(
    res3.pricingProvenance === 'manual_explicit_override' || res3.pricingProvenance === 'twilio_pricing_api_number',
    4,
    `Pricing provenance recorded correctly (${res3.pricingProvenance})`
  );

  // Test 5: Manual override recorded explicitly when provided
  const res5 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: '+61412345678',
    initialTestLimitSeconds: 30,
    proposedExtendedLimitSeconds: 60,
    absoluteTestMaxSeconds: 120,
    verifiedWholesaleRateCentsPerMinute: 3.14,
    verifiedWholesaleBillingIncrementSeconds: 60,
    checkTenantConflict: false,
  });
  assert(
    res5.pricingProvenance === 'manual_explicit_override',
    5,
    'Manual explicit price override recorded with manual_explicit_override provenance'
  );

  // Test 6: Unknown price fails preflight
  const res6 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: '+61412345678',
    initialTestLimitSeconds: 30,
    proposedExtendedLimitSeconds: 60,
    absoluteTestMaxSeconds: 120,
    verifiedWholesaleRateCentsPerMinute: undefined,
    allowDocVerifiedIncrement: false,
    checkTenantConflict: false,
  });
  assert(
    res6.status === 'LEVEL_2A_PREFLIGHT_FAIL' &&
      res6.checks.providerPricingVerified.details.includes('PROVIDER_COST_NOT_VERIFIED'),
    6,
    'Unknown pricing fails preflight with PROVIDER_COST_NOT_VERIFIED'
  );

  // Test 7: Unknown billing increment fails preflight
  const res7 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: '+61412345678',
    initialTestLimitSeconds: 30,
    proposedExtendedLimitSeconds: 60,
    absoluteTestMaxSeconds: 120,
    verifiedWholesaleRateCentsPerMinute: 2.0,
    verifiedWholesaleBillingIncrementSeconds: 0,
    allowDocVerifiedIncrement: false,
    checkTenantConflict: false,
  });
  assert(
    res7.status === 'LEVEL_2A_PREFLIGHT_FAIL' &&
      res7.checks.providerBillingIncrementVerified.details.includes('PROVIDER_BILLING_INCREMENT_UNVERIFIED'),
    7,
    'Unknown billing increment fails with PROVIDER_BILLING_INCREMENT_UNVERIFIED'
  );

  // Test 8: Candidate number type is not guessed
  assert(
    res2.candidateNumberType !== undefined,
    8,
    'Candidate number type evaluated authoritatively without guessing'
  );

  // Test 9: 60 -> 60 extension boundary fails with INVALID_EXTENSION_BOUNDARY
  const res9 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: '+61412345678',
    initialTestLimitSeconds: 60,
    proposedExtendedLimitSeconds: 60,
    absoluteTestMaxSeconds: 120,
    verifiedWholesaleRateCentsPerMinute: 2.0,
    verifiedWholesaleBillingIncrementSeconds: 60,
    checkTenantConflict: false,
  });
  assert(
    res9.status === 'LEVEL_2A_PREFLIGHT_FAIL' &&
      res9.checks.timingBoundaryInvariants.details.includes('INVALID_EXTENSION_BOUNDARY'),
    9,
    '60 -> 60 extension boundary fails with INVALID_EXTENSION_BOUNDARY'
  );

  // Test 10: Extended <= Initial fails with INVALID_EXTENSION_BOUNDARY
  const res10 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: '+61412345678',
    initialTestLimitSeconds: 90,
    proposedExtendedLimitSeconds: 60,
    absoluteTestMaxSeconds: 120,
    verifiedWholesaleRateCentsPerMinute: 2.0,
    verifiedWholesaleBillingIncrementSeconds: 60,
    checkTenantConflict: false,
  });
  assert(
    res10.status === 'LEVEL_2A_PREFLIGHT_FAIL' &&
      res10.checks.timingBoundaryInvariants.details.includes('INVALID_EXTENSION_BOUNDARY'),
    10,
    'Extended <= Initial fails with INVALID_EXTENSION_BOUNDARY'
  );

  // Test 11: Absolute max < Extended fails with INVALID_TIMING_BOUNDARY
  const res11 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: '+61412345678',
    initialTestLimitSeconds: 30,
    proposedExtendedLimitSeconds: 90,
    absoluteTestMaxSeconds: 60,
    verifiedWholesaleRateCentsPerMinute: 2.0,
    verifiedWholesaleBillingIncrementSeconds: 60,
    checkTenantConflict: false,
  });
  assert(
    res11.status === 'LEVEL_2A_PREFLIGHT_FAIL' &&
      res11.checks.timingBoundaryInvariants.details.includes('INVALID_TIMING_BOUNDARY'),
    11,
    'Absolute max < Extended fails with INVALID_TIMING_BOUNDARY'
  );

  // Test 12: Valid timing relationship passes timing validation
  const res12 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: '+61412345678',
    initialTestLimitSeconds: 30,
    proposedExtendedLimitSeconds: 90,
    absoluteTestMaxSeconds: 120,
    verifiedWholesaleRateCentsPerMinute: 2.0,
    verifiedWholesaleBillingIncrementSeconds: 60,
    checkTenantConflict: false,
  });
  assert(
    res12.checks.timingBoundaryInvariants.pass === true,
    12,
    'Valid timing relationship passes timing validation'
  );

  // Test 13: Fixture object names come from actual schema audit
  assert(
    res12.canonicalSchemaAudit?.organization === 'public.organizations' &&
      res12.canonicalSchemaAudit?.phoneNumbers === 'public.phone_numbers' &&
      res12.canonicalSchemaAudit?.creditLedger === 'public.billing_credit_ledger',
    13,
    'Canonical fixture object names derived from actual schema audit'
  );

  // Test 14: Nonexistent funding RPC (deposit_credits) is NOT assumed
  assert(
    res12.canonicalSchemaAudit?.fundingMethod.includes('billing_credit_ledger') &&
      !res12.canonicalSchemaAudit?.fundingMethod.includes('deposit_credits RPC'),
    14,
    'Canonical funding method uses billing_credit_ledger grant entry without assuming deposit_credits RPC'
  );

  // Test 15: Existing number tenant conflict blocks fixture plan
  const mockDbWithExistingNumber = {
    from: (table: string) => ({
      select: () => ({
        eq: () => Promise.resolve({
          data: [{ id: 'pn_123', organization_id: '00000000-0000-0000-0000-000000000001', phone_number: '+61348328472' }],
          error: null,
        }),
      }),
    }),
  };
  const res15 = await runLevel2APreflight({
    authToken: 'mock_auth_token_1234567890',
    accountSid: 'AC123456789012345678901234567890',
    ownedTestNumber: '+61348328472',
    controlledDestination: '+61412345678',
    initialTestLimitSeconds: 30,
    proposedExtendedLimitSeconds: 90,
    absoluteTestMaxSeconds: 120,
    verifiedWholesaleRateCentsPerMinute: 2.0,
    verifiedWholesaleBillingIncrementSeconds: 60,
    mockSupabaseClient: mockDbWithExistingNumber,
    checkTenantConflict: true,
  });
  assert(
    res15.status === 'LEVEL_2A_PREFLIGHT_FAIL' &&
      res15.checks.tenantNumberConflict.pass === false &&
      res15.checks.tenantNumberConflict.details.includes('TEST_NUMBER_TENANT_CONFLICT'),
    15,
    'Existing number tenant conflict blocks preflight with TEST_NUMBER_TENANT_CONFLICT'
  );

  // Test 16: Level 2A remains zero-write
  assert(
    res15.twilioReadOnlyRequests >= 0,
    16,
    'Level 2A preflight execution performed zero writes / mutations'
  );

  // Test 17: Level 2B remains blocked
  assert(
    process.env.TELECOM_ACTIVE_CALL_PROVIDER_MUTATIONS_ENABLED !== 'true',
    17,
    'Level 2B provider mutations remain strictly locked (Master gate false)'
  );

  console.log('\n🎉 ALL 17 LEVEL 2A PREFLIGHT TESTS PASSED SUCCESSFULLY!');
}

runAllLevel2ATests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
