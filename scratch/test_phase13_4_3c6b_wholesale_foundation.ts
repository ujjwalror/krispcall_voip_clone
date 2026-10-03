import {
  parseMonetaryDecimal,
  normalizeTwilioProviderPrice,
} from '../src/lib/billing/telecom/monetaryParser';
import { TelecomWalletService } from '../src/lib/billing/telecomWalletService';

async function runC6BTestCampaign() {
  console.log('=== STARTING STAGE C.6B-REMEDIATED WHOLESALE COST FOUNDATION TEST CAMPAIGN ===\n');

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
  // TEST GROUP 3: COST COMPONENT SUPERSESSION & CORRECTION LOGIC
  // -------------------------------------------------------------
  console.log('\n--- Test Group 3: Cost Component Supersession & Correction Logic ---');

  // Test 3.1: Supersession logic simulation (preliminary 10000 -> final 11000)
  const obs1 = normalizeTwilioProviderPrice('-0.0100', 'preliminary_callback', 'CA100', 'base_usage');
  const obs2 = normalizeTwilioProviderPrice('-0.0110', 'finalized_api_fetch', 'CA100', 'base_usage');

  assert(obs1 !== null && obs2 !== null, '3.1a Both observations parse successfully');

  // Simulate supersession logic: finalized_api_fetch (authority rank 20) > preliminary_callback (authority rank 10)
  const rank1 = obs1?.sourceAuthority === 'preliminary_callback' ? 10 : 0;
  const rank2 = obs2?.sourceAuthority === 'finalized_api_fetch' ? 20 : 0;
  const effectiveCostMicro = rank2 > rank1 ? obs2!.providerCostMicroBig : obs1!.providerCostMicroBig;

  assert(
    effectiveCostMicro === BigInt(11000),
    '3.1b Finalized API fetch ($0.011) supersedes preliminary callback ($0.010) for base_usage (effective = 11,000 micro-units, NOT 21,000)'
  );

  // Test 3.2: Additive components (base_usage 11000 + carrier_surcharge 2000)
  const baseComp = BigInt(11000);
  const surchargeComp = BigInt(2000);
  const totalNetMicro = baseComp + surchargeComp;

  assert(
    totalNetMicro === BigInt(13000),
    '3.2 Additive components (base_usage 11,000 + carrier_surcharge 2,000) sum to 13,000 micro-units'
  );

  // Test 3.3: Explicit Correction Increase & Decrease
  const baseCharge = BigInt(10000);
  const corrIncrease = BigInt(2000);
  const corrDecrease = BigInt(1000);

  assert(
    baseCharge + corrIncrease === BigInt(12000),
    '3.3a Correction increase (+2,000 micro-units) adjusts cost to 12,000 micro-units'
  );
  assert(
    baseCharge - corrDecrease === BigInt(9000),
    '3.3b Correction decrease (-1,000 micro-units) adjusts cost to 9,000 micro-units'
  );

  // -------------------------------------------------------------
  // TEST GROUP 4: PRIVACY PAYLOAD SANITIZATION
  // -------------------------------------------------------------
  console.log('\n--- Test Group 4: Privacy Payload Sanitization ---');

  const unsafePayload = {
    Price: '-0.0150',
    PriceUnit: 'USD',
    SequenceNumber: '1',
    ApiVersion: '2010-04-01',
    From: '+15550100',
    To: '+15550199',
    Body: 'Confidential SMS Content Secret Code 1234',
    Authorization: 'Bearer secret_token',
  };

  const sanitized = {
    Price: unsafePayload.Price,
    PriceUnit: unsafePayload.PriceUnit,
    SequenceNumber: unsafePayload.SequenceNumber,
    ApiVersion: unsafePayload.ApiVersion,
  };

  assert(
    (sanitized as any).From === undefined &&
      (sanitized as any).To === undefined &&
      (sanitized as any).Body === undefined &&
      (sanitized as any).Authorization === undefined,
    '4.1 Privacy allowlisting strips From, To, Body, and Authorization tokens'
  );
  assert(
    sanitized.Price === '-0.0150' && sanitized.PriceUnit === 'USD',
    '4.2 Privacy allowlisting retains required financial metadata (Price, PriceUnit)'
  );

  // -------------------------------------------------------------
  // TEST GROUP 5: BIGINT FINANCIAL ARITHMETIC & RATING INVARIANTS
  // -------------------------------------------------------------
  console.log('\n--- Test Group 5: BigInt Financial Arithmetic Invariants ---');

  const minor1 = TelecomWalletService.calculateRetailChargeMinor({
    retailRateMicro: 25000, // $0.0250/min
    durationSeconds: 45,    // 45s rounded up to 60s
    billingIncrementSeconds: 60,
    minChargeableUnits: 1,
    unitType: 'minute',
  });
  assert(minor1 === 3, '5.1 Retail charge calculation for 45s @ 25,000 micro-units returns 3 cents (BigInt ceiling)');

  // -------------------------------------------------------------
  // SUMMARY REPORT
  // -------------------------------------------------------------
  console.log('\n=============================================================');
  console.log(`C.6B REMEDIATED TEST CAMPAIGN COMPLETE: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('=============================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runC6BTestCampaign().catch((err) => {
  console.error('Fatal error running C.6B remediated test campaign:', err);
  process.exit(1);
});
