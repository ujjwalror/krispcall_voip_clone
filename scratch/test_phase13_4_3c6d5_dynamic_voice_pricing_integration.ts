import assert from 'assert';
import { ProviderWholesaleRateService } from '../src/lib/billing/telecom/providerWholesaleRateService';
import { TelecomRatingService } from '../src/lib/billing/telecom/telecomRatingService';
import { VoiceAuthorizationService } from '../src/lib/billing/telecom/voiceAuthorizationService';
import { InboundVoiceAuthorizationService } from '../src/lib/billing/telecom/inboundVoiceAuthorizationService';
import { VoiceSettlementService } from '../src/lib/billing/telecom/voiceSettlementService';
import { calculateCumulativeExtensionCost } from '../src/lib/billing/telecom/activeCallExtensionService';
import { parseDecimalToMicroUnits } from '../src/lib/billing/telecom/providers/twilioExactNumberFallback';

function createMockDb(cacheRows: any[] = [], phoneNumbers: any[] = []) {
  const mock: any = {
    from: (table: string) => {
      const filters: Record<string, any> = {};
      const builder: any = {
        select: () => builder,
        eq: (field: string, value: any) => {
          filters[field] = value;
          return builder;
        },
        maybeSingle: async () => {
          if (table === 'phone_numbers') {
            const found = phoneNumbers.find((p) => p.phone_number === filters.phone_number);
            return { data: found || null, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve: any) => {
          if (table === 'provider_voice_pricing_cache') {
            const matched = cacheRows.filter((row) => {
              for (const [k, v] of Object.entries(filters)) {
                if (row[k] !== undefined && row[k] !== v) return false;
              }
              return true;
            });
            resolve({ data: matched, error: null });
          } else {
            resolve({ data: [], error: null });
          }
        },
      };
      return builder;
    },
  };
  return mock;
}

async function runCampaign() {
  console.log('=============================================================');
  console.log('PHASE 13.4.3C STAGE C.6D.5A: DYNAMIC VOICE PRICING INTEGRATION TESTS');
  console.log('=============================================================\n');

  // -------------------------------------------------------------
  // Test Group 1: Decimal to Micro-Units Integer Arithmetic
  // -------------------------------------------------------------
  console.log('--- Test Group 1: Decimal to Micro-Units Parsing ---');
  assert.strictEqual(parseDecimalToMicroUnits('0.014'), 14000n, '0.014 => 14,000 micro-units');
  assert.strictEqual(parseDecimalToMicroUnits('0.025'), 25000n, '0.025 => 25,000 micro-units');
  assert.strictEqual(parseDecimalToMicroUnits('0.0001'), 100n, '0.0001 => 100 micro-units');
  assert.strictEqual(parseDecimalToMicroUnits('1.25'), 1250000n, '$1.25 => 1,250,000 micro-units');
  assert.strictEqual(parseDecimalToMicroUnits(0), 0n, '0 => 0 micro-units');
  console.log('[PASS] 1.1 Decimal price parsing matches 100% micro-unit integer precision');

  // -------------------------------------------------------------
  // Test Group 2: Outbound Dynamic Wholesale Rate Resolution & Fallback
  // -------------------------------------------------------------
  console.log('\n--- Test Group 2: Outbound Dynamic Wholesale Resolution & Fallback ---');

  const futureIso = new Date(Date.now() + 86400000).toISOString();
  const pastIso = new Date(Date.now() - 86400000).toISOString();

  const cacheRows = [
    {
      id: 'cache_us_fresh',
      provider_account_id: 'default',
      provider_key: 'twilio',
      service_type: 'voice_outbound',
      direction: 'outbound',
      iso_country: 'US',
      destination_prefix: '+1',
      current_price_micro: 14000,
      currency: 'USD',
      price_unit: 'minute',
      soft_stale_at: futureIso,
      hard_expires_at: futureIso,
      is_active: true,
    },
    {
      id: 'cache_au_landline',
      provider_account_id: 'default',
      provider_key: 'twilio',
      service_type: 'voice_outbound',
      direction: 'outbound',
      iso_country: 'AU',
      destination_prefix: '+612',
      current_price_micro: 18000,
      currency: 'USD',
      price_unit: 'minute',
      soft_stale_at: futureIso,
      hard_expires_at: futureIso,
      is_active: true,
    },
    {
      id: 'cache_au_mobile',
      provider_account_id: 'default',
      provider_key: 'twilio',
      service_type: 'voice_outbound',
      direction: 'outbound',
      iso_country: 'AU',
      destination_prefix: '+614',
      current_price_micro: 45000,
      currency: 'USD',
      price_unit: 'minute',
      soft_stale_at: futureIso,
      hard_expires_at: futureIso,
      is_active: true,
    },
    {
      id: 'cache_expired',
      provider_account_id: 'default',
      provider_key: 'twilio',
      service_type: 'voice_outbound',
      direction: 'outbound',
      iso_country: 'IN',
      destination_prefix: '+91',
      current_price_micro: 25000,
      currency: 'USD',
      price_unit: 'minute',
      soft_stale_at: pastIso,
      hard_expires_at: pastIso,
      is_active: true,
    },
  ];

  const mockDbWithCache = createMockDb(cacheRows);

  const usQuote = await ProviderWholesaleRateService.getWholesaleQuote(mockDbWithCache, {
    serviceType: 'voice_outbound',
    direction: 'outbound',
    destinationPhoneNumber: '+12025550123',
    forceDynamicPath: true,
  });

  assert.strictEqual(usQuote.wholesaleRateMicro, 14000n, 'US wholesale rate must equal 14000 micro-units');
  assert.strictEqual(usQuote.freshnessState, 'FRESH');
  console.log('[PASS] 2.1 Fresh outbound wholesale cache lookup resolves 14,000 micro-units ($0.014)');

  const auLandlineQuote = await ProviderWholesaleRateService.getWholesaleQuote(mockDbWithCache, {
    serviceType: 'voice_outbound',
    direction: 'outbound',
    destinationPhoneNumber: '+61299998888',
    isoCountry: 'AU',
    forceDynamicPath: true,
  });

  const auMobileQuote = await ProviderWholesaleRateService.getWholesaleQuote(mockDbWithCache, {
    serviceType: 'voice_outbound',
    direction: 'outbound',
    destinationPhoneNumber: '+61400111222',
    isoCountry: 'AU',
    forceDynamicPath: true,
  });

  assert.strictEqual(auLandlineQuote.wholesaleRateMicro, 18000n, 'AU landline (+612) = 18000 micro');
  assert.strictEqual(auMobileQuote.wholesaleRateMicro, 45000n, 'AU mobile (+614) = 45000 micro');
  console.log('[PASS] 2.2 Destination category differentiation: AU landline (+612: 18k) vs mobile (+614: 45k)');

  const mockClientOverride = {
    pricing: {
      v2: {
        voice: {
          numbers: (num: string) => ({
            fetch: async () => ({
              isoCountry: 'IN',
              priceUnit: 'USD',
              outboundCallPrices: [{ currentPrice: '0.025', basePrice: '0.025' }],
            }),
          }),
        },
      },
    },
  };

  const expiredFallbackQuote = await ProviderWholesaleRateService.getWholesaleQuote(mockDbWithCache, {
    serviceType: 'voice_outbound',
    direction: 'outbound',
    destinationPhoneNumber: '+919876543210',
    isoCountry: 'IN',
    forceDynamicPath: true,
    clientOverride: mockClientOverride,
  });

  assert.strictEqual(expiredFallbackQuote.wholesaleRateMicro, 25000n, 'Expired cache triggers fallback returning 25000 micro');
  console.log('[PASS] 2.3 Expired cache triggers server-side read-only fallback returning 25,000 micro ($0.025)');

  // -------------------------------------------------------------
  // Test Group 3: Dynamic Retail Rate & Commercial Policy (+25% Markup)
  // -------------------------------------------------------------
  console.log('\n--- Test Group 3: Dynamic Retail Rate (+2500 bps / 25%) Calculation ---');
  const retailResult = await TelecomRatingService.resolveRetailRate(mockDbWithCache, {
    organizationId: 'org_test',
    serviceType: 'voice_outbound',
    direction: 'outbound',
    destinationPhoneNumber: '+12025550123',
    forceDynamicPath: true,
  });

  assert.strictEqual(retailResult.retailRateMicro, 17500, 'Retail rate micro = 17,500');
  assert.strictEqual(retailResult.matchedRateCard.wholesaleCostMicro, 14000, 'Wholesale rate preserved as 14,000');
  assert(retailResult.retailRateMicro >= (retailResult.matchedRateCard.wholesaleCostMicro || 0), 'Retail >= Wholesale invariant enforced');
  console.log('[PASS] 3.1 Wholesale 14,000 micro + 2500 bps (25%) markup = 17,500 micro ($0.0175/min) retail');

  // -------------------------------------------------------------
  // Test Group 4: Inbound Dynamic Pricing & Trusted Metadata Resolution
  // -------------------------------------------------------------
  console.log('\n--- Test Group 4: Inbound Dynamic Pricing & Trusted Metadata ---');

  const inboundCacheRows = [
    {
      id: 'cache_inbound_toll_free',
      provider_account_id: 'default',
      provider_key: 'twilio',
      service_type: 'voice_inbound',
      direction: 'inbound',
      iso_country: 'US',
      number_type: 'toll_free',
      current_price_micro: 22000,
      currency: 'USD',
      price_unit: 'minute',
      soft_stale_at: futureIso,
      hard_expires_at: futureIso,
      is_active: true,
    },
    {
      id: 'cache_inbound_local',
      provider_account_id: 'default',
      provider_key: 'twilio',
      service_type: 'voice_inbound',
      direction: 'inbound',
      iso_country: 'US',
      number_type: 'local',
      current_price_micro: 8500,
      currency: 'USD',
      price_unit: 'minute',
      soft_stale_at: futureIso,
      hard_expires_at: futureIso,
      is_active: true,
    },
  ];

  const phoneNumbers = [
    {
      phone_number: '+12025550199',
      organization_id: 'org_inbound_test',
      active: true,
      type: 'local',
      country_code: 'US',
      capabilities_voice: true,
    },
    {
      phone_number: '+18005550199',
      organization_id: 'org_inbound_test',
      active: true,
      type: 'toll_free',
      country_code: 'US',
      capabilities_voice: true,
    },
    {
      phone_number: '+919999999999',
      organization_id: 'org_inbound_india',
      active: true,
      type: 'local',
      country_code: 'IN',
      capabilities_voice: true,
    },
  ];

  const mockDbInbound = createMockDb(inboundCacheRows, phoneNumbers);

  const inboundLocalRes = await InboundVoiceAuthorizationService.authorizeInboundCall(mockDbInbound, {
    callSid: 'CA_inbound_local_123',
    calledNumber: '+12025550199',
    callerNumber: '+13015550100',
    forceDynamicPath: true,
  });

  assert.strictEqual(inboundLocalRes.authorized, true);
  assert.strictEqual(inboundLocalRes.rateSnapshot.retailRateMicro, 10625);
  console.log('[PASS] 4.1 Inbound local number (+1202): Wholesale 8,500 micro + 25% = 10,625 micro retail');

  const inboundTollFreeRes = await InboundVoiceAuthorizationService.authorizeInboundCall(mockDbInbound, {
    callSid: 'CA_inbound_tf_123',
    calledNumber: '+18005550199',
    callerNumber: '+13015550100',
    forceDynamicPath: true,
  });

  assert.strictEqual(inboundTollFreeRes.authorized, true);
  assert.strictEqual(inboundTollFreeRes.rateSnapshot.retailRateMicro, 27500);
  console.log('[PASS] 4.2 Inbound toll-free (+1800): Wholesale 22,000 micro + 25% = 27,500 micro retail');

  try {
    await InboundVoiceAuthorizationService.authorizeInboundCall(mockDbInbound, {
      callSid: 'CA_inbound_india_123',
      calledNumber: '+919999999999',
      callerNumber: '+13015550100',
      forceDynamicPath: true,
    });
    assert.fail('India empty inbound pricing must fail closed!');
  } catch (err: any) {
    assert.strictEqual(err.errorCode, 'INBOUND_PRICING_UNAVAILABLE');
    console.log('[PASS] 4.3 India empty inbound pricing scope FAILS CLOSED cleanly (zero rates never invented)');
  }

  // -------------------------------------------------------------
  // Test Group 5: Whole-Call Rate Snapshot Preservation & Extensions
  // -------------------------------------------------------------
  console.log('\n--- Test Group 5: Whole-Call Rate Snapshot Preservation & Settlement ---');

  const frozenSnapshot = {
    initial_minimum_seconds: 60,
    initial_minimum_cents: 2,
    billing_interval_seconds: 60,
    rate_per_interval_cents: 2,
    retailRateMicro: 17500,
    wholesaleRateMicro: 14000,
    currency: 'USD',
    pricingPolicyId: 'global-platform-voice-policy',
  };

  const extCost = calculateCumulativeExtensionCost({
    snapshot: frozenSnapshot,
    currentBoundarySeconds: 60,
    nextBoundarySeconds: 120,
    currentReservationMinor: 2,
  });

  assert.strictEqual(extCost.nextCumulativeCostMinor, 4, '120s cumulative cost = 4 cents');
  assert.strictEqual(extCost.incrementalAmountMinor, 2, 'Incremental extension amount = 2 cents');
  console.log('[PASS] 5.1 In-call rolling extension evaluates cumulative cost using frozen call start snapshot');

  const validatedSnap = VoiceSettlementService.validateRateSnapshot({
    retailRateMicro: 17500,
    rateMicro: 17500,
    billingIncrementSeconds: 60,
    minChargeableUnits: 1,
    unitType: 'minute',
    currency: 'USD',
  });

  assert.notStrictEqual(validatedSnap, null);
  const finalCharge = VoiceSettlementService.calculateSettlementChargeMinor(validatedSnap!, 120);
  assert.strictEqual(finalCharge, 4, '120s call settled at 17,500 micro/min = 4 cents');
  console.log('[PASS] 5.2 Terminal settlement consumes frozen retail rate snapshot without re-querying provider');

  // -------------------------------------------------------------
  // Test Group 6: Public Customer-Safe Retail Quote API & Security
  // -------------------------------------------------------------
  console.log('\n--- Test Group 6: Public Customer-Safe Retail Quote API & Security ---');
  const publicQuote = await TelecomRatingService.resolveCustomerRetailQuote(mockDbWithCache, {
    serviceType: 'voice_outbound',
    direction: 'outbound',
    destinationPhoneNumber: '+12025550123',
    destinationCountry: 'US',
    currency: 'USD',
    forceDynamicPath: true,
  });

  console.log('Public Customer Quote DTO:', publicQuote);
  assert.strictEqual(publicQuote.retailRateMicro, 17500);
  assert.strictEqual(publicQuote.currency, 'USD');
  assert.strictEqual(publicQuote.unitType, 'minute');
  assert.strictEqual((publicQuote as any).wholesaleRateMicro, undefined, 'Wholesale rate MUST NOT be exposed in customer DTO');
  assert.strictEqual((publicQuote as any).providerKey, undefined, 'Provider key MUST NOT be exposed in customer DTO');
  assert.strictEqual((publicQuote as any).markupBasisPoints, undefined, 'Markup bps MUST NOT be exposed in customer DTO');
  console.log('[PASS] 6.1 Public customer-safe quote API returns retail pricing ($0.0175/min) with ZERO internal leakage');

  // -------------------------------------------------------------
  // Test Group 7: Feature Flag Activation Gate Behavior
  // -------------------------------------------------------------
  console.log('\n--- Test Group 7: Feature Flag Activation Gate Behavior ---');
  delete process.env.TELECOM_DYNAMIC_VOICE_PRICING_ENABLED;
  assert.strictEqual(ProviderWholesaleRateService.isDynamicVoicePricingEnabled(), false, 'Default feature flag is false');

  try {
    await ProviderWholesaleRateService.getWholesaleQuote(mockDbWithCache, {
      serviceType: 'voice_outbound',
      direction: 'outbound',
      destinationPhoneNumber: '+99999999999',
      forceDynamicPath: true,
    });
    assert.fail('Invalid prefix on dynamic path must fail closed!');
  } catch (err: any) {
    assert(err.message.includes('DYNAMIC_WHOLESALE_PRICING_UNAVAILABLE'), 'Must throw DYNAMIC_WHOLESALE_PRICING_UNAVAILABLE');
    console.log('[PASS] 7.1 Dynamic path failures FAIL CLOSED cleanly without silent static rate card fallbacks');
  }

  console.log('\n=============================================================');
  console.log('PHASE 13.4.3C STAGE C.6D.5A INTEGRATION CAMPAIGN: ALL PASSED');
  console.log('=============================================================\n');
}

runCampaign().catch((err) => {
  console.error('Stage C.6D.5A Integration Campaign Failed:', err);
  process.exit(1);
});
