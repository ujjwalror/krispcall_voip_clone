import { TelecomProviderPricingSyncService, BatchPricingSyncResult } from '../src/lib/billing/telecom/telecomPricingSyncService';
import { TwilioPricingAdapter, TwilioCountryVoiceResponse, ParsedWholesalePricingRecord } from '../src/lib/billing/telecom/providers/twilioPricingAdapter';
import { ProviderWholesaleCacheResolver } from '../src/lib/billing/telecom/providerWholesaleCacheResolver';
import { CustomerRetailPricingService } from '../src/lib/billing/telecom/customerRetailPricingService';
import { CommercialPricingEngine } from '../src/lib/billing/telecom/commercialPricingEngine';

async function runStageC6D4PricingSyncTests() {
  console.log('================================================================');
  console.log('STAGE C.6D.4 — DURABLE VOICE PRICING SYNC & INGESTION TESTS');
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

  const mockDbClient: any = {
    rpc: async (functionName: string, params: any) => {
      if (functionName === 'upsert_provider_voice_pricing_record_atomic') {
        // Mock atomic RPC behavior
        return {
          data: { status: 'inserted', version: 1, price_changed: false },
          error: null,
        };
      }
      if (functionName === 'record_provider_voice_price_sync_run_atomic') {
        return {
          data: { success: true, sync_run_id: 'mock_sync_run_123' },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };

  // ------------------------------------------------------------------
  // 1. Mutation Gate Safeguard Tests
  // ------------------------------------------------------------------
  console.log('--- 1. Mutation Gate Safeguard Tests ---');

  // Ensure default gate is off when TELECOM_PRICING_SYNC_ENABLED is unset
  const originalEnv = process.env.TELECOM_PRICING_SYNC_ENABLED;
  delete process.env.TELECOM_PRICING_SYNC_ENABLED;

  const syncService = new TelecomProviderPricingSyncService();
  const disabledResult = await syncService.syncApprovedCountries(mockDbClient);

  assert(disabledResult.gateStatus === 'disabled', 'Mutation gate evaluated as disabled when TELECOM_PRICING_SYNC_ENABLED is off');
  assert(disabledResult.success === false, 'Sync service returns success = false when mutation gate is off');
  assert(disabledResult.totalRecordsInserted === 0, 'Zero DB insertions performed when mutation gate is off');

  // Restore env if needed
  if (originalEnv !== undefined) {
    process.env.TELECOM_PRICING_SYNC_ENABLED = originalEnv;
  }

  // ------------------------------------------------------------------
  // 2. Deterministic Mock Adapter Ingestion Tests
  // ------------------------------------------------------------------
  console.log('\n--- 2. Deterministic Mock Adapter Ingestion Tests ---');

  const mockUsResponse: TwilioCountryVoiceResponse = {
    country: 'United States',
    isoCountry: 'US',
    priceUnit: 'USD',
    outboundCallPrices: [
      { friendlyName: 'US Mainland', currentPrice: '0.0140', basePrice: '0.0140', destinationPrefixes: ['1'], originationPrefixes: ['ALL'] },
      { friendlyName: 'US Alaska', currentPrice: '0.0945', basePrice: '0.0945', destinationPrefixes: ['1907'], originationPrefixes: ['ALL'] },
    ],
    inboundCallPrices: [
      { numberType: 'local', currentPrice: '0.0085', basePrice: '0.0085' },
      { numberType: 'toll free', currentPrice: '0.0220', basePrice: '0.0220' },
    ],
  };

  const mockAuResponse: TwilioCountryVoiceResponse = {
    country: 'Australia',
    isoCountry: 'AU',
    priceUnit: 'USD',
    outboundCallPrices: [
      { friendlyName: 'AU Fixed', currentPrice: '0.0252', basePrice: '0.0252', destinationPrefixes: ['612', '613'], originationPrefixes: ['ROW'] },
      { friendlyName: 'AU Mobile', currentPrice: '0.0250', basePrice: '0.0250', destinationPrefixes: ['614'], originationPrefixes: ['ROW'] },
    ],
    inboundCallPrices: [
      { numberType: 'local', currentPrice: '0.0100', basePrice: '0.0100' },
      { numberType: 'mobile', currentPrice: '0.0100', basePrice: '0.0100' },
      { numberType: 'toll free', currentPrice: '0.0500', basePrice: '0.0500' },
    ],
  };

  const mockInResponse: TwilioCountryVoiceResponse = {
    country: 'India',
    isoCountry: 'IN',
    priceUnit: 'USD',
    outboundCallPrices: [
      { friendlyName: 'India Standard', currentPrice: '0.0350', basePrice: '0.0350', destinationPrefixes: ['91'], originationPrefixes: ['*'] },
    ],
    inboundCallPrices: [], // Empty inbound array (live India response scenario)
  };

  const adapter = new TwilioPricingAdapter();
  const usParsed = adapter.parseCountryVoiceResponse(mockUsResponse, 'acc_123', '2026-10-03T12:00:00Z');
  const auParsed = adapter.parseCountryVoiceResponse(mockAuResponse, 'acc_123', '2026-10-03T12:00:00Z');
  const inParsed = adapter.parseCountryVoiceResponse(mockInResponse, 'acc_123', '2026-10-03T12:00:00Z');

  assert(usParsed.length === 4, 'US parsed 4 records (2 outbound prefixes, 2 inbound types)');
  assert(auParsed.length === 6, 'AU parsed 6 records (3 outbound prefix combos, 3 inbound types)');
  assert(inParsed.length === 1, 'IN parsed 1 outbound record and 0 inbound records');

  // Ingest parsed records into DB via atomic RPC
  const ingestUsRes = await syncService.ingestParsedRecordsAtomic(mockDbClient, usParsed);
  assert(ingestUsRes.inserted === 4 && ingestUsRes.rejected === 0, 'Ingested 4 US records via atomic RPC with 0 rejections');

  // ------------------------------------------------------------------
  // 3. Repeated Sync Idempotency & Versioning Logic
  // ------------------------------------------------------------------
  console.log('\n--- 3. Idempotency & Versioning Logic ---');

  // Case A: Identical price refresh -> Refreshed (0 version increment)
  const refreshDbClient: any = {
    rpc: async (func: string) => {
      if (func === 'upsert_provider_voice_pricing_record_atomic') {
        return { data: { status: 'refreshed', version: 1, price_changed: false }, error: null };
      }
      return { data: null, error: null };
    },
  };

  const refreshRes = await syncService.ingestParsedRecordsAtomic(refreshDbClient, usParsed);
  assert(refreshRes.refreshed === 4 && refreshRes.inserted === 0 && refreshRes.versioned === 0,
    'Repeated sync with identical prices is idempotent (4 refreshed, 0 inserted, 0 versioned)');

  // Case B: Price change -> Versioning (prior version deactivated, new version inserted with version = 2)
  const versioningDbClient: any = {
    rpc: async (func: string) => {
      if (func === 'upsert_provider_voice_pricing_record_atomic') {
        return { data: { status: 'versioned', version: 2, prior_version: 1, price_changed: true }, error: null };
      }
      return { data: null, error: null };
    },
  };

  const versionRes = await syncService.ingestParsedRecordsAtomic(versioningDbClient, usParsed);
  assert(versionRes.versioned === 4 && versionRes.inserted === 0 && versionRes.refreshed === 0,
    'Price change correctly triggers versioning (4 records versioned to version 2)');

  // ------------------------------------------------------------------
  // 4. Partial Country Failure Safety
  // ------------------------------------------------------------------
  console.log('\n--- 4. Partial Country Failure Safety ---');

  const partialMockAdapter: any = {
    providerKey: 'twilio',
    syncCountryPricing: async (iso: string) => {
      if (iso === 'IN') {
        return { success: false, providerKey: 'twilio', providerAccountId: 'default', isoCountry: 'IN', recordsObserved: 0, syncRunId: 'sync_err', fingerprint: 'fp_err', errorMessage: 'Simulated network timeout' };
      }
      return { success: true, providerKey: 'twilio', providerAccountId: 'default', isoCountry: iso, recordsObserved: 4, syncRunId: 'sync_ok', fingerprint: 'fp_ok' };
    },
  };

  const partialSyncService = new TelecomProviderPricingSyncService(partialMockAdapter);
  const partialResult = await partialSyncService.syncApprovedCountries(mockDbClient, {
    countries: ['US', 'AU', 'IN'],
    allowMutationWithoutGate: true,
  });

  assert(partialResult.totalCountriesAttempted === 3, 'Attempted 3 countries in scope');
  assert(partialResult.totalCountriesSucceeded === 2, '2 countries (US, AU) succeeded');
  assert(partialResult.totalCountriesFailed === 1, '1 country (IN) failed safely without crashing overall loop');
  assert(partialResult.countrySummaries.find((s) => s.isoCountry === 'IN')?.status === 'failed', 'IN marked with status = failed in summary');

  // ------------------------------------------------------------------
  // 5. India Empty Inbound Handling
  // ------------------------------------------------------------------
  console.log('\n--- 5. India Empty Inbound Handling ---');

  const inInboundRecords = inParsed.filter((r) => r.serviceType === 'voice_inbound');
  assert(inInboundRecords.length === 0, 'India country response returned 0 inbound pricing records (inboundCallPrices = [])');

  const inOutboundRecords = inParsed.filter((r) => r.serviceType === 'voice_outbound');
  assert(inOutboundRecords.length === 1 && inOutboundRecords[0].currentPriceMicro === BigInt(35000), 'India outbound rate (35000 micro = $0.035) preserved');

  // ------------------------------------------------------------------
  // 6. Customer Redaction & 25% Markup Invariant
  // ------------------------------------------------------------------
  console.log('\n--- 6. Customer Redaction & 25% Markup Invariant ---');

  const auMobileRate = auParsed.find((r) => r.destinationPrefix === '614');
  assert(auMobileRate !== undefined, 'AU mobile rate parsed');

  const quote: any = {
    providerKey: 'twilio',
    providerAccountId: 'default',
    serviceType: 'voice_outbound',
    direction: 'outbound',
    isoCountry: 'AU',
    destinationPrefix: '614',
    originationPrefix: 'ROW',
    currency: 'USD',
    currentPriceMicro: auMobileRate!.currentPriceMicro,
    wholesaleRateMicro: auMobileRate!.currentPriceMicro,
    unitType: 'minute',
    billingIncrementSeconds: 60,
    minChargeableUnits: 1,
  };

  const globalPolicy: any = {
    id: 'global-voice-policy',
    policyName: 'Global Voice 25% Policy',
    pricingMode: 'markup_percentage',
    markupBasisPoints: 2500,
    fixedSurchargeMicro: BigInt(0),
    retailFloorMicro: BigInt(0),
    currency: 'USD',
  };

  const derived = CommercialPricingEngine.calculateRetailRate(quote, globalPolicy);
  assert(derived.derivedRetailRateMicro === BigInt(31250), 'AU Mobile retail rate = 31250 micro ($0.0313/min)');

  const customerDTO = CustomerRetailPricingService.toCustomerSafeDTO({
    serviceType: 'voice_outbound',
    direction: 'outbound',
    destinationPattern: '614',
    destinationName: 'Australia Mobile',
    retailRateMicro: Number(derived.derivedRetailRateMicro),
    currency: 'USD',
    billingIncrementSeconds: 60,
    minChargeableUnits: 1,
  } as any);

  const keys = Object.keys(customerDTO);
  assert(!keys.includes('provider') && !keys.includes('wholesaleCostMicro') && !keys.includes('markupBasisPoints'),
    'Customer DTO strictly redacts provider name, wholesale cost, and markup basis points');

  console.log('\n================================================================');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runStageC6D4PricingSyncTests().catch((err) => {
  console.error('Unhandled test exception:', err);
  process.exit(1);
});
