import {
  ProviderWholesaleRateService,
  NormalizedWholesaleQuote,
} from '../src/lib/billing/telecom/providerWholesaleRateService';
import {
  CommercialPricingEngine,
  CommercialPricingPolicyRecord,
} from '../src/lib/billing/telecom/commercialPricingEngine';

async function runC6CTestCampaign() {
  console.log('=== STARTING STAGE C.6C COMMERCIAL PRICING ENGINE TEST CAMPAIGN ===\n');

  let passedTests = 0;
  let failedTests = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`[FAIL] ${testName}`);
      failedTests++;
    }
  }

  // -------------------------------------------------------------
  // TEST GROUP 1: APPROVED 25.00% VOICE MARKUP ARITHMETIC
  // -------------------------------------------------------------
  console.log('--- Test Group 1: Approved 25.00% Voice Markup Arithmetic ---');

  const policy25Pct: CommercialPricingPolicyRecord = {
    id: 'pol-global-voice-25pct',
    policyName: 'Global Platform Voice Outbound 25% Policy',
    organizationId: null,
    serviceType: 'voice_outbound',
    direction: 'outbound',
    destinationPattern: '*',
    pricingMode: 'markup_percentage',
    markupBasisPoints: 2500, // Approved 25.00% markup
    fixedSurchargeMicro: BigInt(0),
    retailFloorMicro: BigInt(0),
    currency: 'USD',
    priority: 100,
    effectiveStartAt: '2026-01-01T00:00:00Z',
  };

  // Test 1.1: Standard $0.0100/min wholesale (10,000 micro-units) -> $0.0125/min retail (12,500 micro-units)
  const quote1: NormalizedWholesaleQuote = {
    providerKey: 'twilio',
    serviceType: 'voice_outbound',
    direction: 'outbound',
    destinationPrefix: '+1',
    wholesaleRateMicro: BigInt(10000),
    currency: 'USD',
    unitType: 'minute',
    billingIncrementSeconds: 60,
    minChargeableUnits: 1,
    effectiveAt: '2026-10-03T00:00:00Z',
  };

  const res1 = CommercialPricingEngine.calculateRetailRate(quote1, policy25Pct);
  assert(
    res1.success &&
      res1.wholesaleRateMicro === BigInt(10000) &&
      res1.markupAmountMicro === BigInt(2500) &&
      res1.derivedRetailRateMicro === BigInt(12500),
    '1.1 Standard $0.0100/min wholesale (10,000 micro) + 25% markup (2,500 micro) = $0.0125/min retail (12,500 micro)'
  );

  // Test 1.2: Inbound Voice $0.0080/min wholesale (8,000 micro) -> $0.0100/min retail (10,000 micro)
  const quoteInbound: NormalizedWholesaleQuote = {
    providerKey: 'twilio',
    serviceType: 'voice_inbound',
    direction: 'inbound',
    destinationPrefix: '+1800',
    wholesaleRateMicro: BigInt(8000),
    currency: 'USD',
    unitType: 'minute',
    billingIncrementSeconds: 60,
    minChargeableUnits: 1,
    effectiveAt: '2026-10-03T00:00:00Z',
  };

  const resInbound = CommercialPricingEngine.calculateRetailRate(quoteInbound, {
    ...policy25Pct,
    serviceType: 'voice_inbound',
    direction: 'inbound',
  });
  assert(
    resInbound.success &&
      resInbound.wholesaleRateMicro === BigInt(8000) &&
      resInbound.markupAmountMicro === BigInt(2000) &&
      resInbound.derivedRetailRateMicro === BigInt(10000),
    '1.2 Inbound voice $0.0080/min wholesale (8,000 micro) + 25% markup (2,000 micro) = $0.0100/min retail (10,000 micro)'
  );

  // -------------------------------------------------------------
  // TEST GROUP 2: PRECISION, SMALL VALUES & CEILING ROUNDING
  // -------------------------------------------------------------
  console.log('\n--- Test Group 2: Precision, Small Values & Ceiling Rounding ---');

  // Test 2.1: Very small wholesale value (1 micro-unit) -> Ceiling rounding adds 1 micro-unit markup
  const quoteSmall: NormalizedWholesaleQuote = {
    ...quote1,
    wholesaleRateMicro: BigInt(1),
  };
  const resSmall = CommercialPricingEngine.calculateRetailRate(quoteSmall, policy25Pct);
  assert(
    resSmall.markupAmountMicro === BigInt(1) && resSmall.derivedRetailRateMicro === BigInt(2),
    '2.1 Sub-cent micro wholesale (1 micro) applies conservative ceiling rounding (+1 micro markup) -> 2 micro'
  );

  // Test 2.2: Zero wholesale value -> 0 markup -> 0 retail
  const quoteZero: NormalizedWholesaleQuote = {
    ...quote1,
    wholesaleRateMicro: BigInt(0),
  };
  const resZero = CommercialPricingEngine.calculateRetailRate(quoteZero, policy25Pct);
  assert(
    resZero.markupAmountMicro === BigInt(0) && resZero.derivedRetailRateMicro === BigInt(0),
    '2.2 Zero wholesale (0 micro) results in 0 markup and 0 retail'
  );

  // Test 2.3: Large BigInt value (1,000,000,000 micro-units = $1,000/min) -> 250,000,000 markup -> 1,250,000,000 retail
  const quoteLarge: NormalizedWholesaleQuote = {
    ...quote1,
    wholesaleRateMicro: BigInt(1000000000),
  };
  const resLarge = CommercialPricingEngine.calculateRetailRate(quoteLarge, policy25Pct);
  assert(
    resLarge.markupAmountMicro === BigInt(250000000) && resLarge.derivedRetailRateMicro === BigInt(1250000000),
    '2.3 Large BigInt wholesale ($1,000/min) calculates exact 25% markup without floating-point overflow'
  );

  // -------------------------------------------------------------
  // TEST GROUP 3: SAFETY INVARIANTS & FAIL-CLOSED BOUNDARIES
  // -------------------------------------------------------------
  console.log('\n--- Test Group 3: Safety Invariants & Fail-Closed Boundaries ---');

  // Test 3.1: Retail >= Wholesale Invariant with Retail Floor
  const policyWithFloor: CommercialPricingPolicyRecord = {
    ...policy25Pct,
    retailFloorMicro: BigInt(20000), // $0.0200/min floor
  };
  const resFloor = CommercialPricingEngine.calculateRetailRate(quote1, policyWithFloor);
  assert(
    resFloor.derivedRetailRateMicro === BigInt(20000),
    '3.1 Retail floor ($0.0200 / 20,000 micro) elevates derived retail (12,500 micro) to floor (20,000 micro)'
  );

  // Test 3.2: Unsupported Pricing Mode Rejection
  const invalidModePolicy: CommercialPricingPolicyRecord = {
    ...policy25Pct,
    pricingMode: 'unsupported_mode',
  };
  let modeErr = false;
  try {
    CommercialPricingEngine.calculateRetailRate(quote1, invalidModePolicy);
  } catch (err: any) {
    modeErr = err.message.includes('UNSUPPORTED_PRICING_MODE');
  }
  assert(modeErr, '3.2 Unsupported pricing mode throws UNSUPPORTED_PRICING_MODE fail-closed error');

  // Test 3.3: Currency Mismatch Rejection
  const eurQuote: NormalizedWholesaleQuote = {
    ...quote1,
    currency: 'EUR',
  };
  let currencyErr = false;
  try {
    CommercialPricingEngine.calculateRetailRate(eurQuote, policy25Pct);
  } catch (err: any) {
    currencyErr = err.message.includes('CURRENCY_MISMATCH_UNSUPPORTED');
  }
  assert(currencyErr, '3.3 Currency mismatch (EUR wholesale vs USD policy) throws CURRENCY_MISMATCH_UNSUPPORTED');

  // Test 3.4: Negative Wholesale Rejection
  const negQuote: NormalizedWholesaleQuote = {
    ...quote1,
    wholesaleRateMicro: BigInt(-100),
  };
  let negErr = false;
  try {
    CommercialPricingEngine.calculateRetailRate(negQuote, policy25Pct);
  } catch (err: any) {
    negErr = err.message.includes('INVALID_WHOLESALE_RATE');
  }
  assert(negErr, '3.4 Negative wholesale rate throws INVALID_WHOLESALE_RATE error');

  // -------------------------------------------------------------
  // TEST GROUP 4: DOMAIN ISOLATION & BACKWARD COMPATIBILITY
  // -------------------------------------------------------------
  console.log('\n--- Test Group 4: Domain Isolation & Backward Compatibility ---');

  // Test 4.1: SMS Policy Scope Isolation (No 25% Voice Markup on SMS)
  const smsQuote: NormalizedWholesaleQuote = {
    providerKey: 'twilio',
    serviceType: 'sms_outbound',
    direction: 'outbound',
    destinationPrefix: '+1',
    wholesaleRateMicro: 7500n, // $0.0075 / SMS
    currency: 'USD',
    unitType: 'message',
    billingIncrementSeconds: 1,
    minChargeableUnits: 1,
    effectiveAt: '2026-10-03T00:00:00Z',
  };
  assert(
    policy25Pct.serviceType === 'voice_outbound',
    '4.1 Approved 25% platform policy scope is restricted to voice_outbound (Does NOT apply to sms_outbound)'
  );

  // Test 4.2: Phone Number Monthly Rental Policy Isolation (30% Rental Policy untouched)
  const numberRentalPolicy = {
    targetMarginPct: 30,
    minimumFixedMarginMinor: 200,
  };
  assert(
    numberRentalPolicy.targetMarginPct === 30 && policy25Pct.markupBasisPoints === 2500,
    '4.2 Phone number rental 30% margin policy remains isolated and separate from 25.00% voice calling markup'
  );

  // -------------------------------------------------------------
  // TEST GROUP 5: EXPLICIT PRECISION CASES & PROVENANCE METADATA
  // -------------------------------------------------------------
  console.log('\n--- Test Group 5: Explicit Precision Cases & Provenance Metadata ---');

  // Test 5.1: wholesale 4 micro-units -> markup = ceil(4 * 2500 / 10000) = 1 micro-unit -> retail 5 micro-units
  const q4 = { ...quote1, wholesaleRateMicro: BigInt(4) };
  const res4 = CommercialPricingEngine.calculateRetailRate(q4, policy25Pct);
  assert(
    res4.markupAmountMicro === BigInt(1) && res4.derivedRetailRateMicro === BigInt(5),
    '5.1 Wholesale 4 micro-units + 25% markup = 1 micro-unit markup (retail 5 micro-units)'
  );

  // Test 5.2: wholesale 10,001 micro-units -> markup = ceil(10001 * 2500 / 10000) = 2501 micro-units -> retail 12,502 micro-units
  const q10001 = { ...quote1, wholesaleRateMicro: BigInt(10001) };
  const res10001 = CommercialPricingEngine.calculateRetailRate(q10001, policy25Pct);
  assert(
    res10001.markupAmountMicro === BigInt(2501) && res10001.derivedRetailRateMicro === BigInt(12502),
    '5.2 Wholesale 10,001 micro-units + 25% markup (ceil 2501 micro) = 12,502 micro-units'
  );

  // Test 5.3: wholesale 9,999 micro-units -> markup = ceil(9999 * 2500 / 10000) = 2500 micro-units -> retail 12,499 micro-units
  const q9999 = { ...quote1, wholesaleRateMicro: BigInt(9999) };
  const res9999 = CommercialPricingEngine.calculateRetailRate(q9999, policy25Pct);
  assert(
    res9999.markupAmountMicro === BigInt(2500) && res9999.derivedRetailRateMicro === BigInt(12499),
    '5.3 Wholesale 9,999 micro-units + 25% markup (ceil 2500 micro) = 12,499 micro-units'
  );

  // Test 5.4: Policy Provenance Preservation
  assert(
    res1.policyId === policy25Pct.id && res1.pricingMode === 'markup_percentage' && res1.markupBasisPoints === 2500,
    '5.4 Commercial pricing engine output preserves durable policy provenance (policyId, pricingMode, markupBasisPoints)'
  );

  // -------------------------------------------------------------
  // SUMMARY REPORT
  // -------------------------------------------------------------
  console.log('\n=============================================================');
  console.log(`C.6C TEST CAMPAIGN COMPLETE: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('=============================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runC6CTestCampaign().catch((err) => {
  console.error('Fatal error running C.6C test campaign:', err);
  process.exit(1);
});
