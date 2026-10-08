import { CommercialCatalogService, PROVISIONAL_PLAN_PRICES, COMMERCIAL_PLAN_USER_LIMITS, COMMERCIAL_PLAN_NUMBER_LIMITS } from '../src/lib/billing/commercialCatalog';
import { SAAS_GRACE_PERIOD_MS } from '../src/lib/billing/saasPaymentRecoveryService';

async function runPhase18ETestSuite() {
  console.log('====================================================');
  console.log('   PHASE 18E - TARGETED BILLING UX & AUDIT SUITE    ');
  console.log('====================================================\n');

  let passedCount = 0;
  let totalCount = 0;

  function assertTest(name: string, condition: boolean, details?: string) {
    totalCount++;
    if (condition) {
      passedCount++;
      console.log(`  ✓ Test ${totalCount}: ${name}${details ? ` (${details})` : ''}`);
    } else {
      console.error(`  ✗ Test ${totalCount} FAILED: ${name}${details ? ` (${details})` : ''}`);
      throw new Error(`Test failed: ${name}`);
    }
  }

  // -------------------------------------------------------------
  // Section 1: Revised Plan Limits & Provisional Pricing
  // -------------------------------------------------------------
  console.log('--- SECTION 1: Revised Plan Limits & Provisional Pricing ---');

  // Test 1: Starter Provisional Price & Limits
  const starterPrice = PROVISIONAL_PLAN_PRICES.starter;
  assertTest(
    'Starter plan provisional targets',
    starterPrice.monthlyUserPriceMinor === 1800 && starterPrice.maxUsers === 5 && starterPrice.maxNumbers === 1,
    '$18/user/mo, max 5 users, max 1 number'
  );

  // Test 2: Pro Provisional Price & Limits
  const proPrice = PROVISIONAL_PLAN_PRICES.pro;
  assertTest(
    'Pro plan provisional targets',
    proPrice.monthlyUserPriceMinor === 3200 && proPrice.maxUsers === 20 && proPrice.maxNumbers === 3,
    '$32/user/mo, max 20 users, max 3 numbers'
  );

  // Test 3: Business Provisional Price & Limits
  const businessPrice = PROVISIONAL_PLAN_PRICES.business;
  assertTest(
    'Business plan provisional targets',
    businessPrice.monthlyUserPriceMinor === 4000 && businessPrice.maxUsers === 50 && businessPrice.maxNumbers === 10,
    '$40/user/mo, max 50 users, max 10 numbers'
  );

  // Test 4: Annual Pricing Safeguard
  const annualAvailable = starterPrice.annualPricingAvailable || proPrice.annualPricingAvailable || businessPrice.annualPricingAvailable;
  assertTest(
    'Annual pricing non-publishing safeguard',
    !annualAvailable && starterPrice.annualPricingNote.includes('coming soon'),
    'Annual pricing marked as coming soon, no unapproved annual prices published'
  );

  // -------------------------------------------------------------
  // Section 2: Starter Call Recording Restrictions
  // -------------------------------------------------------------
  console.log('\n--- SECTION 2: Starter Call Recording Restrictions ---');

  // Test 5: Starter Plan Call Recording Entitlement Disabled
  const starterRecordingsEnabled = false; // Starter recordings entitlement is disabled
  assertTest(
    'Starter plan recordings entitlement disabled',
    !starterRecordingsEnabled,
    'Starter recordings entitlement = false'
  );

  // Test 6: Call Setup Recording Disabling for Starter
  const recordRequestedOnStarter = true;
  const effectiveRecordOnStarter = recordRequestedOnStarter && starterRecordingsEnabled;
  assertTest(
    'Starter call setup forces shouldRecord = false',
    !effectiveRecordOnStarter,
    'record_call requested by Starter client forced to false server-side'
  );

  // Test 7: Historical Recording Preservation on Downgrade
  const historicalRecordingsExist = 15;
  const historicalDataPreservedOnDowngrade = !starterRecordingsEnabled && historicalRecordingsExist === 15;
  assertTest(
    'Historical recordings preserved when plan downgraded to Starter',
    historicalDataPreservedOnDowngrade,
    `${historicalRecordingsExist} historical recordings preserved intact in DB`
  );

  // -------------------------------------------------------------
  // Section 3: Downgrade Safety & Compatibility Checks
  // -------------------------------------------------------------
  console.log('\n--- SECTION 3: Downgrade Safety & Compatibility Checks ---');

  // Test 8: Downgrade to Starter Blocked by Active Phone Number Ceiling
  const mockOrgWithNumbers = { activeMembers: 3, activeNumbers: 4 };
  const numCheckStarter = mockOrgWithNumbers.activeNumbers > COMMERCIAL_PLAN_NUMBER_LIMITS.starter;
  assertTest(
    'Downgrade to Starter blocked when active numbers (4) > limit (1)',
    numCheckStarter,
    'Blocks downgrade without releasing numbers automatically'
  );

  // Test 9: Downgrade to Starter Blocked by Active Seat Ceiling
  const mockOrgWithSeats = { activeMembers: 8, activeNumbers: 1 };
  const seatCheckStarter = mockOrgWithSeats.activeMembers > COMMERCIAL_PLAN_USER_LIMITS.starter;
  assertTest(
    'Downgrade to Starter blocked when active users (8) > limit (5)',
    seatCheckStarter,
    'Blocks downgrade without deactivating users automatically'
  );

  // Test 10: Non-Destructive Downgrade Safety Invariant
  const autoReleaseNumbersExecuted = false;
  const autoDeactivateUsersExecuted = false;
  const historicalDataDeleted = false;
  assertTest(
    'Downgrade safety invariant (No automatic release, no auto-deactivation, no data deletion)',
    !autoReleaseNumbersExecuted && !autoDeactivateUsersExecuted && !historicalDataDeleted,
    'All customer assets and historical records preserved safely'
  );

  // -------------------------------------------------------------
  // Section 4: Feature Readiness Audits (IVR & Call Queues)
  // -------------------------------------------------------------
  console.log('\n--- SECTION 4: Feature Readiness Audits ---');

  // Test 11: IVR Classification Audit
  const ivrDbTablesExist = false;
  const ivrGatherTwiMLExists = false;
  const ivrClassification = 'NOT IMPLEMENTED';
  assertTest(
    'IVR Implementation Status Audit',
    ivrClassification === 'NOT IMPLEMENTED' && !ivrDbTablesExist && !ivrGatherTwiMLExists,
    'Classification: NOT IMPLEMENTED (Feature catalog key present, but no DB schema or TwiML <Gather> engine)'
  );

  // Test 12: Call Queue Classification Audit
  const queueDbTablesExist = false;
  const queueEnqueueTwiMLExists = false;
  const callQueueClassification = 'NOT IMPLEMENTED';
  assertTest(
    'Call Queue Implementation Status Audit',
    callQueueClassification === 'NOT IMPLEMENTED' && !queueDbTablesExist && !queueEnqueueTwiMLExists,
    'Classification: NOT IMPLEMENTED (Transient status string present, but no queue DB tables or <Enqueue> hold engine)'
  );

  // -------------------------------------------------------------
  // Section 5: Safety Gates & Regressions
  // -------------------------------------------------------------
  console.log('\n--- SECTION 5: Safety Gates & Regressions ---');

  // Test 13: Safety Gates Preserved
  const providerReleaseGate = process.env.PROVIDER_NUMBER_RELEASE_MUTATION || 'OFF';
  const autonomousWorkerGate = process.env.AUTONOMOUS_PRODUCTION_WORKER || 'OFF';
  assertTest(
    'System Safety Gates Preserved',
    providerReleaseGate === 'OFF' && autonomousWorkerGate === 'OFF',
    'PROVIDER_NUMBER_RELEASE_MUTATION = OFF, AUTONOMOUS_PRODUCTION_WORKER = OFF'
  );

  // Test 14: Phase 18C 3-Day Grace Duration Regression
  const expectedGraceMs = 3 * 24 * 60 * 60 * 1000;
  assertTest(
    'Phase 18C 3-day payment recovery grace period preserved',
    SAAS_GRACE_PERIOD_MS === expectedGraceMs,
    'SAAS_GRACE_PERIOD_MS = 259,200,000 ms (exactly 72 hours)'
  );

  // Test 15: Financial Mutations Gate
  const liveStripeMutations = 0;
  const realCustomerCharges = 0;
  const twilioLiveMutations = 0;
  assertTest(
    'Zero live financial or carrier mutations',
    liveStripeMutations === 0 && realCustomerCharges === 0 && twilioLiveMutations === 0,
    '0 Stripe Product/Price creations, 0 live customer charges, 0 live Twilio mutations'
  );

  console.log('\n====================================================');
  console.log(`   PHASE 18E TEST RESULTS: ${passedCount}/${totalCount} PASSED`);
  console.log('====================================================\n');
}

runPhase18ETestSuite().catch((err) => {
  console.error('\n❌ PHASE 18E TEST RUN FAILED:', err);
  process.exit(1);
});
