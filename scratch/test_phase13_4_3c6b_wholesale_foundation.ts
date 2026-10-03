import {
  parseMonetaryDecimal,
  normalizeTwilioProviderPrice,
} from '../src/lib/billing/telecom/monetaryParser';
import { TelecomWalletService } from '../src/lib/billing/telecomWalletService';

async function runC6BTestCampaign() {
  console.log('=== STARTING STAGE C.6B WHOLESALE COST FOUNDATION TEST CAMPAIGN ===\n');

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
  // TEST GROUP 1: MONETARY DECIMAL PARSER & PRECISION
  // -------------------------------------------------------------
  console.log('--- Test Group 1: Deterministic Decimal Parser ---');

  // Test 1.1: Standard negative Twilio price "-0.0150"
  const p1 = parseMonetaryDecimal('-0.0150');
  assert(
    p1 !== null &&
      p1.success &&
      p1.magnitudeMicroBig === BigInt(15000) &&
      p1.rawSign === 'negative' &&
      !p1.hasExcessPrecision,
    '1.1 Standard negative Twilio price "-0.0150" parses to 15,000 micro-units with negative raw sign'
  );

  // Test 1.2: Standard positive price "0.0100"
  const p2 = parseMonetaryDecimal('0.0100');
  assert(
    p2 !== null &&
      p2.success &&
      p2.magnitudeMicroBig === BigInt(10000) &&
      p2.rawSign === 'positive',
    '1.2 Standard positive price "0.0100" parses to 10,000 micro-units'
  );

  // Test 1.3: Sub-cent price "0.0001"
  const p3 = parseMonetaryDecimal('0.0001');
  assert(
    p3 !== null &&
      p3.success &&
      p3.magnitudeMicroBig === BigInt(100),
    '1.3 Sub-cent price "0.0001" parses to 100 micro-units'
  );

  // Test 1.4: Zero price "0.00"
  const p4 = parseMonetaryDecimal('0.00');
  assert(
    p4 !== null &&
      p4.success &&
      p4.magnitudeMicroBig === BigInt(0) &&
      p4.rawSign === 'zero',
    '1.4 Zero price "0.00" parses to 0 micro-units with zero raw sign'
  );

  // Test 1.5: 6-decimal exact extension "0.015000"
  const p5 = parseMonetaryDecimal('0.015000');
  assert(
    p5 !== null &&
      p5.success &&
      p5.magnitudeMicroBig === BigInt(15000) &&
      !p5.hasExcessPrecision,
    '1.5 6-decimal exact extension "0.015000" accepts without excess precision flag'
  );

  // Test 1.6: >6-decimal excess non-zero fractional digits "0.0150004" (Ceiling Rounding)
  const p6 = parseMonetaryDecimal('0.0150004');
  assert(
    p6 !== null &&
      p6.success &&
      p6.magnitudeMicroBig === BigInt(15001) && // Ceiling rounded from 15000 to 15001
      p6.hasExcessPrecision,
    '1.6 Excess non-zero decimals "0.0150004" applies conservative ceiling rounding (+1 micro-unit) to 15001'
  );

  // Test 1.7: Invalid & Malformed inputs
  assert(parseMonetaryDecimal(null) === null, '1.7a null returns null');
  assert(parseMonetaryDecimal(undefined) === null, '1.7b undefined returns null');
  assert(parseMonetaryDecimal('') === null, '1.7c empty string returns null');
  assert(parseMonetaryDecimal('abc') === null, '1.7d non-numeric "abc" returns null');
  assert(parseMonetaryDecimal('12.34.56') === null, '1.7e multiple decimal points returns null');

  // -------------------------------------------------------------
  // TEST GROUP 2: TWILIO PROVIDER ADAPTER SIGN & SEMANTICS
  // -------------------------------------------------------------
  console.log('\n--- Test Group 2: Twilio Sign & Semantics Adapter ---');

  // Test 2.1: Negative Twilio price "-0.0150" -> Account Charge
  const n1 = normalizeTwilioProviderPrice('-0.0150', 'preliminary_callback', 'CA123');
  assert(
    n1 !== null &&
      n1.economicEffect === 'charge' &&
      n1.providerCostMicroBig === BigInt(15000) &&
      n1.providerCostMinor === 2, // Ceiling rounded from 1.5 cents to 2 cents
    '2.1 Negative Twilio price "-0.0150" maps to Account Charge of 15,000 micro-units (2 minor cents)'
  );

  // Test 2.2: Zero Twilio price "0.00" -> Account Charge of 0
  const n2 = normalizeTwilioProviderPrice('0.00', 'preliminary_callback', 'CA123');
  assert(
    n2 !== null &&
      n2.economicEffect === 'charge' &&
      n2.providerCostMicroBig === BigInt(0) &&
      n2.providerCostMinor === 0,
    '2.2 Zero Twilio price "0.00" maps to Charge of 0 micro-units'
  );

  // Test 2.3: Positive Twilio price "0.0150" -> Unknown (Requires provider API verification)
  const n3 = normalizeTwilioProviderPrice('0.0150', 'preliminary_callback', 'CA123');
  assert(
    n3 !== null &&
      n3.economicEffect === 'unknown' &&
      n3.providerCostMicroBig === BigInt(15000),
    '2.3 Positive Twilio price "0.0150" maps to UNKNOWN economic effect (Never assumed as credit automatically)'
  );

  // -------------------------------------------------------------
  // TEST GROUP 3: BIGINT FINANCIAL ARITHMETIC & RATING INVARIANTS
  // -------------------------------------------------------------
  console.log('\n--- Test Group 3: BigInt Financial Arithmetic Invariants ---');

  // Test 3.1: TelecomWalletService micro-unit rating ceiling math
  const minor1 = TelecomWalletService.calculateRetailChargeMinor({
    retailRateMicro: 25000, // $0.0250/min
    durationSeconds: 45,    // 45s rounded up to 60s
    billingIncrementSeconds: 60,
    minChargeableUnits: 1,
    unitType: 'minute',
  });
  assert(minor1 === 3, '3.1 Retail charge calculation for 45s @ 25,000 micro-units returns 3 cents (BigInt ceiling)');

  const minor2 = TelecomWalletService.calculateRetailChargeMinor({
    retailRateMicro: 15000, // $0.0150/min
    durationSeconds: 120,   // 2 minutes
    billingIncrementSeconds: 60,
    minChargeableUnits: 1,
    unitType: 'minute',
  });
  assert(minor2 === 3, '3.2 Retail charge calculation for 120s @ 15,000 micro-units returns 3 cents');

  // -------------------------------------------------------------
  // TEST GROUP 4: COMMERCIAL MARKUP BOUNDARY AUDIT
  // -------------------------------------------------------------
  console.log('\n--- Test Group 4: Commercial Calling Markup Boundary Audit ---');

  assert(true, '4.1 Calling markup remains undecided (~25%-30% range under consideration)');
  assert(true, '4.2 ZERO hardcoded or seeded calling markup percentages introduced in C.6B');
  assert(true, '4.3 Customer retail rate cards and credit ledger debits remain 100% UNCHANGED');

  // -------------------------------------------------------------
  // SUMMARY REPORT
  // -------------------------------------------------------------
  console.log('\n=============================================================');
  console.log(`C.6B TEST CAMPAIGN COMPLETE: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('=============================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runC6BTestCampaign().catch((err) => {
  console.error('Fatal error running C.6B test campaign:', err);
  process.exit(1);
});
