import { parseTwilioWholesalePrice } from '../src/lib/billing/telecom/wholesaleMoneyParser';
import { FreshnessPolicy } from '../src/lib/billing/telecom/freshnessPolicy';
import { TwilioPricingAdapter, TwilioCountryVoiceResponse } from '../src/lib/billing/telecom/providers/twilioPricingAdapter';
import { ProviderWholesaleCacheResolver } from '../src/lib/billing/telecom/providerWholesaleCacheResolver';
import { CustomerRetailPricingService } from '../src/lib/billing/telecom/customerRetailPricingService';
import { CommercialPricingEngine } from '../src/lib/billing/telecom/commercialPricingEngine';
import { NormalizedWholesaleQuote } from '../src/lib/billing/telecom/providers/providerPricingInterface';

async function runTests() {
  console.log('================================================================');
  console.log('STAGE C.6D.2 — TWILIO VOICE WHOLESALE PRICING FOUNDATION TESTS');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
      failed++;
    }
  }

  // ------------------------------------------------------------------
  // 1. Exact Decimal Wholesale Money Parser Tests
  // ------------------------------------------------------------------
  console.log('--- 1. Wholesale Money Parser Tests ---');
  
  const p1 = parseTwilioWholesalePrice('0.013', '0.0150');
  assert(p1.success && p1.priceMicroBig === BigInt(13000), 'Parse valid positive currentPrice (0.013 -> 13000 micro)');
  assert(p1.basePriceMicroBig === BigInt(15000), 'Parse valid basePrice (0.0150 -> 15000 micro)');

  const p2 = parseTwilioWholesalePrice('0.00', '0.00');
  assert(p2.success && p2.isZero && p2.priceMicroBig === BigInt(0), 'Parse valid zero cost currentPrice (0.00 -> 0 micro, isZero=true)');

  const p3 = parseTwilioWholesalePrice('-0.015');
  assert(!p3.success && p3.failureReason === 'NEGATIVE_WHOLESALE_RATE', 'Reject negative wholesale rate (-0.015 -> fail closed)');

  const p4 = parseTwilioWholesalePrice(null);
  assert(!p4.success && p4.failureReason === 'MISSING_CURRENT_PRICE', 'Reject missing currentPrice (null -> fail closed)');

  const p5 = parseTwilioWholesalePrice('invalid_price');
  assert(!p5.success && p5.failureReason === 'MALFORMED_CURRENT_PRICE', 'Reject malformed currentPrice string -> fail closed');

  // ------------------------------------------------------------------
  // 2. Freshness Policy Tests
  // ------------------------------------------------------------------
  console.log('\n--- 2. Freshness Policy Tests ---');

  const now = new Date('2026-10-03T12:00:00Z');
  const fetchedAt = '2026-10-03T10:00:00Z'; // 2 hours ago
  const { softStaleAtIso, hardExpiresAtIso } = FreshnessPolicy.calculateTimestamps(fetchedAt, {
    softStaleHours: 24,
    hardExpiryHours: 48,
  });

  const stateFresh = FreshnessPolicy.evaluateState(softStaleAtIso, hardExpiresAtIso, now.toISOString());
  assert(stateFresh === 'FRESH', 'Recent fetched date (2h old) evaluated as FRESH');

  const staleTime = new Date('2026-10-04T15:00:00Z'); // 29 hours ago
  const stateStale = FreshnessPolicy.evaluateState(softStaleAtIso, hardExpiresAtIso, staleTime.toISOString());
  assert(stateStale === 'SOFT_STALE', 'Fetched date 29h old evaluated as SOFT_STALE');

  const expiredTime = new Date('2026-10-05T15:00:00Z'); // 53 hours ago
  const stateExpired = FreshnessPolicy.evaluateState(softStaleAtIso, hardExpiresAtIso, expiredTime.toISOString());
  assert(stateExpired === 'EXPIRED', 'Fetched date 53h old evaluated as EXPIRED');

  // ------------------------------------------------------------------
  // 3. Twilio Pricing Adapter Response Parsing (Non-Live)
  // ------------------------------------------------------------------
  console.log('\n--- 3. Twilio Pricing Adapter Response Parsing (Non-Live) ---');

  const mockAdapter = new TwilioPricingAdapter();
  const mockCountryPayload: TwilioCountryVoiceResponse = {
    country: 'Australia',
    isoCountry: 'AU',
    priceUnit: 'USD',
    outboundCallPrices: [
      {
        friendlyName: 'Australia Mobile',
        currentPrice: '0.0250',
        basePrice: '0.0300',
        destinationPrefixes: ['614'],
        originationPrefixes: ['*'],
      },
      {
        friendlyName: 'Australia Landline',
        currentPrice: '0.0120',
        basePrice: '0.0150',
        destinationPrefixes: ['61'],
        originationPrefixes: ['*'],
      },
    ],
    inboundCallPrices: [
      { numberType: 'local', currentPrice: '0.0080', basePrice: '0.0100' },
      { numberType: 'tollFree', currentPrice: '0.0200', basePrice: '0.0250' },
    ],
  };

  const parsedRecords = mockAdapter.parseCountryVoiceResponse(mockCountryPayload, 'default', fetchedAt);
  assert(parsedRecords.length === 4, 'Parsed 4 records from country voice response (2 outbound prefixes, 2 inbound types)');
  
  const auMobile = parsedRecords.find((r) => r.destinationPrefix === '614');
  assert(auMobile?.currentPriceMicro === BigInt(25000), 'AU Mobile current_price_micro parsed to 25000 micro-units ($0.025)');
  assert(auMobile?.basePriceMicro === BigInt(30000), 'AU Mobile base_price_micro parsed to 30000 micro-units ($0.030)');

  const auLocalInbound = parsedRecords.find((r) => r.serviceType === 'voice_inbound' && r.numberType === 'local');
  assert(auLocalInbound?.currentPriceMicro === BigInt(8000), 'AU Local Inbound current_price_micro parsed to 8000 micro-units ($0.008)');

  // ------------------------------------------------------------------
  // 4. Provider Wholesale Cache Resolver Tests (Mock DB)
  // ------------------------------------------------------------------
  console.log('\n--- 4. Provider Wholesale Cache Resolver Tests ---');

  const mockDbClient: any = {
    from: (table: string) => ({
      select: () => ({
        eq: (col1: string, val1: any) => ({
          eq: (col2: string, val2: any) => ({
            eq: (col3: string, val3: any) => ({
              eq: (col4: string, val4: any) => ({
                eq: (col5: string, val5: any) => ({
                  eq: (col6: string, val6: any) => ({
                    eq: (col7: string, val7: any) => {
                      if (table === 'provider_voice_pricing_cache' && val3 === 'voice_outbound') {
                        return {
                          data: [
                            {
                              provider_account_id: 'default',
                              provider_key: 'twilio',
                              service_type: 'voice_outbound',
                              direction: 'outbound',
                              iso_country: 'AU',
                              destination_prefix: '614',
                              origination_prefix: '*',
                              current_price_micro: 25000,
                              base_price_micro: 30000,
                              currency: 'USD',
                              price_unit: 'minute',
                              billing_increment_seconds: 60,
                              min_chargeable_units: 1,
                              fetched_at: fetchedAt,
                              soft_stale_at: softStaleAtIso,
                              hard_expires_at: hardExpiresAtIso,
                              is_active: true,
                              version: 1,
                            },
                            {
                              provider_account_id: 'default',
                              provider_key: 'twilio',
                              service_type: 'voice_outbound',
                              direction: 'outbound',
                              iso_country: 'AU',
                              destination_prefix: '61',
                              origination_prefix: '*',
                              current_price_micro: 12000,
                              base_price_micro: 15000,
                              currency: 'USD',
                              price_unit: 'minute',
                              billing_increment_seconds: 60,
                              min_chargeable_units: 1,
                              fetched_at: fetchedAt,
                              soft_stale_at: softStaleAtIso,
                              hard_expires_at: hardExpiresAtIso,
                              is_active: true,
                              version: 1,
                            },
                          ],
                          error: null,
                        };
                      }
                      return { data: [], error: null };
                    },
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  };

  const resolvedQuote = await ProviderWholesaleCacheResolver.resolveWholesaleQuote(mockDbClient, {
    serviceType: 'voice_outbound',
    direction: 'outbound',
    destinationPhoneNumber: '+61412345678',
    isoCountry: 'AU',
    currency: 'USD',
    timestamp: now.toISOString(),
  });

  assert(resolvedQuote.destinationPrefix === '614', 'Longest prefix match selected +614 prefix over +61');
  assert(resolvedQuote.currentPriceMicro === BigInt(25000), 'Resolved currentPriceMicro = 25000 micro-units ($0.025)');
  assert(resolvedQuote.freshnessState === 'FRESH', 'Resolved freshness state = FRESH');

  // Test Ambiguous Origination Matching Failure
  const ambiguousDbClient: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      data: [
                        { destination_prefix: '614', origination_prefix: '+1', current_price_micro: 25000, soft_stale_at: softStaleAtIso, hard_expires_at: hardExpiresAtIso, currency: 'USD' },
                        { destination_prefix: '614', origination_prefix: '+44', current_price_micro: 35000, soft_stale_at: softStaleAtIso, hard_expires_at: hardExpiresAtIso, currency: 'USD' },
                      ],
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  };

  let ambiguousFailed = false;
  try {
    await ProviderWholesaleCacheResolver.resolveWholesaleQuote(ambiguousDbClient, {
      serviceType: 'voice_outbound',
      direction: 'outbound',
      destinationPhoneNumber: '+61412345678',
      originationPhoneNumber: null, // Unknown origination
      isoCountry: 'AU',
    });
  } catch (err: any) {
    ambiguousFailed = err.message.includes('AMBIGUOUS_WHOLESALE_PRICING');
  }
  assert(ambiguousFailed, 'Ambiguous origination matching failed closed (AMBIGUOUS_WHOLESALE_PRICING)');

  // ------------------------------------------------------------------
  // 5. Customer Retail Pricing Redaction
  // ------------------------------------------------------------------
  console.log('\n--- 5. Customer Retail Pricing Redaction Tests ---');

  const internalRateCard: any = {
    id: 'derived-card-1',
    rateCode: 'DYNAMIC_VOICE_OUTBOUND',
    serviceType: 'voice_outbound',
    direction: 'outbound',
    destinationPattern: '+614',
    destinationName: 'Australia Mobile',
    retailRateMicro: 31250, // 25000 wholesale + 25% markup (6250) = 31250 micro
    wholesaleCostMicro: 25000,
    unitType: 'minute',
    billingIncrementSeconds: 60,
    minChargeableUnits: 1,
    currency: 'USD',
    isActive: true,
  };

  const customerDTO = CustomerRetailPricingService.toCustomerSafeDTO(internalRateCard);
  assert(customerDTO.success === true, 'Customer DTO created successfully');
  assert(customerDTO.retailRateMicro === 31250, 'Customer DTO contains retailRateMicro (31250)');
  assert(customerDTO.retailRateMinorDisplay.includes('$0.0313'), 'Formatted retail rate display string present ($0.0313 / min)');

  const keys = Object.keys(customerDTO);
  assert(!keys.includes('provider') && !keys.includes('wholesaleCostMicro') && !keys.includes('markupBasisPoints'),
    'Customer DTO strictly redacts provider name, wholesale cost, and markup basis points');

  // ------------------------------------------------------------------
  // 6. C.6C 2500 Basis Points Calling Markup Compatibility
  // ------------------------------------------------------------------
  console.log('\n--- 6. C.6C 25% Calling Markup Integration Compatibility ---');

  const wholesaleQuote: NormalizedWholesaleQuote = {
    providerKey: 'twilio',
    providerAccountId: 'default',
    serviceType: 'voice_outbound',
    direction: 'outbound',
    isoCountry: 'AU',
    destinationPrefix: '614',
    originationPrefix: '*',
    numberType: null,
    currency: 'USD',
    currentPriceMicro: BigInt(20000), // $0.0200/min wholesale
    wholesaleRateMicro: BigInt(20000),
    basePriceMicro: BigInt(25000),
    priceUnit: 'minute',
    billingIncrementSeconds: 60,
    minChargeableUnits: 1,
    fetchedAt: fetchedAt,
    softStaleAt: softStaleAtIso,
    hardExpiresAt: hardExpiresAtIso,
    freshnessState: 'FRESH',
    sourceApiVersion: 'v2',
    pricingFingerprint: 'fp1',
    version: 1,
    isZero: false,
  };

  const c6cPolicy: any = {
    id: 'global-voice-policy',
    policyName: 'Global Voice 25% Policy',
    pricingMode: 'markup_percentage',
    markupBasisPoints: 2500, // 25.00% markup
    fixedSurchargeMicro: BigInt(0),
    retailFloorMicro: BigInt(0),
    currency: 'USD',
  };

  const derivedRetail = CommercialPricingEngine.calculateRetailRate(wholesaleQuote, c6cPolicy);
  assert(derivedRetail.wholesaleRateMicro === BigInt(20000), 'Wholesale input = 20000 micro ($0.0200)');
  assert(derivedRetail.markupAmountMicro === BigInt(5000), 'Markup amount = 5000 micro ($0.0050 = 25% of $0.020)');
  assert(derivedRetail.derivedRetailRateMicro === BigInt(25000), 'Derived customer retail rate = 25000 micro ($0.0250/min)');

  // ------------------------------------------------------------------
  // 7. Advanced Origination Scopes (ALL, ROW, *) & Inbound Normalization
  // ------------------------------------------------------------------
  console.log('\n--- 7. Advanced Origination Scopes (ALL, ROW, *) & Inbound Normalization ---');

  const origScopeDbClient: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      data: [
                        { destination_prefix: '614', origination_prefix: 'ALL', current_price_micro: 20000, soft_stale_at: softStaleAtIso, hard_expires_at: hardExpiresAtIso, currency: 'USD', iso_country: 'AU', is_active: true },
                        { destination_prefix: '614', origination_prefix: '+1', current_price_micro: 30000, soft_stale_at: softStaleAtIso, hard_expires_at: hardExpiresAtIso, currency: 'USD', iso_country: 'AU', is_active: true },
                      ],
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  };

  // Specific numeric origination +1 must take precedence over ALL
  const specRes = await ProviderWholesaleCacheResolver.resolveWholesaleQuote(origScopeDbClient, {
    serviceType: 'voice_outbound',
    direction: 'outbound',
    destinationPhoneNumber: '+61412345678',
    originationPhoneNumber: '+14155550199',
    isoCountry: 'AU',
  });
  assert(specRes.currentPriceMicro === BigInt(30000), 'Specific numeric origination (+1) takes precedence over universal ALL pattern (30000 micro)');

  // General origination matches universal ALL pattern when no numeric match applies
  const genRes = await ProviderWholesaleCacheResolver.resolveWholesaleQuote(origScopeDbClient, {
    serviceType: 'voice_outbound',
    direction: 'outbound',
    destinationPhoneNumber: '+61412345678',
    originationPhoneNumber: '+442079460000',
    isoCountry: 'AU',
  });
  assert(genRes.currentPriceMicro === BigInt(20000), 'General non-+1 origination matches universal ALL pattern (20000 micro)');

  console.log('\n================================================================');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Unhandled test exception:', err);
  process.exit(1);
});
