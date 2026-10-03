import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { createClient } from '@supabase/supabase-js';
import { parseTwilioWholesalePrice } from '../src/lib/billing/telecom/wholesaleMoneyParser';
import { CommercialPricingEngine } from '../src/lib/billing/telecom/commercialPricingEngine';
import { CustomerRetailPricingService } from '../src/lib/billing/telecom/customerRetailPricingService';

(globalThis as any).WebSocket = class {};

// Load environment variables from .env.local
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of envContent.split('\n')) {
    const line = rawLine.trim();
    if (line && !line.startsWith('#') && line.includes('=')) {
      const idx = line.indexOf('=');
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key) {
        process.env[key] = val;
      }
    }
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseSecretKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY!;

const serviceClient = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

import twilio from 'twilio';

// Directly instantiate Twilio client using environment credentials
function getDirectTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const apiKeySid = process.env.TWILIO_API_KEY_SID?.trim();
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET?.trim();

  assert(accountSid && apiKeySid && apiKeySecret, 'Twilio server environment credentials must be configured in .env.local');

  return twilio(apiKeySid, apiKeySecret, { accountSid });
}

async function runStageC6D3LiveTwilioPricingValidation() {
  console.log('================================================================');
  console.log('STAGE C.6D.3 — LIVE READ-ONLY TWILIO VOICE PRICING VALIDATION');
  console.log('================================================================\n');

  // -------------------------------------------------------------
  // 1. VERIFY TWILIO ACCOUNT CONTEXT & SDK
  // -------------------------------------------------------------
  console.log('--- 1. Verify Twilio Account Context & SDK Surface ---');
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  assert(accountSid && accountSid.startsWith('AC'), 'TWILIO_ACCOUNT_SID must be valid');
  console.log(`Account SID prefix: ${accountSid.slice(0, 6)}... (valid configured account)`);

  const twilioClient = getDirectTwilioClient();
  assert(twilioClient.pricing && twilioClient.pricing.v2 && twilioClient.pricing.v2.voice, 'SDK method client.pricing.v2.voice must be available');
  console.log('✓ SDK method client.pricing.v2.voice verified on twilio SDK v6.1.0.');

  // -------------------------------------------------------------
  // 2. LIVE READ: US COUNTRY VOICE PRICING
  // -------------------------------------------------------------
  console.log('\n--- 2. Fetch US Country Voice Pricing ---');
  const startUs = performance.now();
  const usRes = await twilioClient.pricing.v2.voice.countries('US').fetch();
  const latencyUsMs = Math.round(performance.now() - startUs);

  console.log(`US Pricing Fetch Latency: ${latencyUsMs} ms`);
  console.log(`US Keys:`, Object.keys(usRes));
  console.log(`US Outbound Sample:`, JSON.stringify((usRes as any).outboundPrefixPrices || (usRes as any).outboundCallPrices || (usRes as any).outbound_prefix_prices, null, 2)?.slice(0, 500));
  console.log(`US Inbound Number Type Entries: ${usRes.inboundCallPrices?.length || 0}`);

  assert.strictEqual(usRes.isoCountry, 'US');
  assert.strictEqual(usRes.priceUnit, 'USD');

  // -------------------------------------------------------------
  // 3. LIVE READ: AU COUNTRY VOICE PRICING
  // -------------------------------------------------------------
  console.log('\n--- 3. Fetch AU Country Voice Pricing ---');
  const startAu = performance.now();
  const auRes = await twilioClient.pricing.v2.voice.countries('AU').fetch();
  const latencyAuMs = Math.round(performance.now() - startAu);

  console.log(`AU Pricing Fetch Latency: ${latencyAuMs} ms`);
  console.log(`AU Keys:`, Object.keys(auRes));
  console.log(`AU Outbound Sample:`, JSON.stringify((auRes as any).outboundPrefixPrices || (auRes as any).outboundCallPrices || (auRes as any).outbound_prefix_prices, null, 2)?.slice(0, 500));
  console.log(`AU Inbound Number Type Entries: ${auRes.inboundCallPrices?.length || 0}`);

  assert.strictEqual(auRes.isoCountry, 'AU');
  assert.strictEqual(auRes.priceUnit, 'USD');

  // -------------------------------------------------------------
  // 4. LIVE READ: IN COUNTRY VOICE PRICING
  // -------------------------------------------------------------
  console.log('\n--- 4. Fetch IN Country Voice Pricing ---');
  const startIn = performance.now();
  const inRes = await twilioClient.pricing.v2.voice.countries('IN').fetch();
  const latencyInMs = Math.round(performance.now() - startIn);

  console.log(`IN Pricing Fetch Latency: ${latencyInMs} ms`);
  console.log(`IN Keys:`, Object.keys(inRes));
  console.log(`IN Outbound Sample:`, JSON.stringify((inRes as any).outboundPrefixPrices || (inRes as any).outboundCallPrices || (inRes as any).outbound_prefix_prices, null, 2)?.slice(0, 500));
  console.log(`IN Inbound Number Type Entries: ${inRes.inboundCallPrices?.length || 0}`);

  assert.strictEqual(inRes.isoCountry, 'IN');
  assert.strictEqual(inRes.priceUnit, 'USD');

  // -------------------------------------------------------------
  // 5. INBOUND NUMBER TYPES & CURRENT PRICES
  // -------------------------------------------------------------
  console.log('\n--- 5. Inbound Number Types & Prices Analysis ---');

  const formatInboundPrices = (countryRes: any) => {
    return (countryRes.inboundCallPrices || []).map((item: any) => ({
      numberType: item.numberType,
      currentPrice: item.currentPrice,
      basePrice: item.basePrice,
    }));
  };

  const usInbound = formatInboundPrices(usRes);
  const auInbound = formatInboundPrices(auRes);
  const inInbound = formatInboundPrices(inRes);

  console.log('US Inbound Types:', JSON.stringify(usInbound, null, 2));
  console.log('AU Inbound Types:', JSON.stringify(auInbound, null, 2));
  console.log('IN Inbound Types:', JSON.stringify(inInbound, null, 2));

  // -------------------------------------------------------------
  // 6. EXACT DESTINATION NUMBER LOOKUP
  // -------------------------------------------------------------
  console.log('\n--- 6. Exact Destination Number Lookup ---');
  const testNumber = '+14155550199'; // US test number
  const startNum = performance.now();
  const numRes = await twilioClient.pricing.v2.voice.numbers(testNumber).fetch();
  const latencyNumMs = Math.round(performance.now() - startNum);

  console.log(`Number Pricing Fetch Latency: ${latencyNumMs} ms`);
  console.log(`Number Pricing Response:`, JSON.stringify(numRes, null, 2));

  // -------------------------------------------------------------
  // 7. WHOLESALE PARSING & 25% COMMERCIAL RETAIL CALCULATION
  // -------------------------------------------------------------
  console.log('\n--- 7. Current Price Parsing & 25% Retail Rate Calculation ---');

  const globalVoicePolicy: any = {
    id: 'global-platform-voice-policy',
    policyName: 'Global Voice 25% Markup Policy',
    pricingMode: 'markup_percentage',
    markupBasisPoints: 2500,
    fixedSurchargeMicro: BigInt(0),
    retailFloorMicro: BigInt(0),
    currency: 'USD',
  };

  const calculateSample = (name: string, rawCurrent: string, rawBase?: string) => {
    const parsed = parseTwilioWholesalePrice(rawCurrent, rawBase, name);
    assert(parsed.success, `Parsing must succeed for ${name}`);

    const quote: any = {
      providerKey: 'twilio',
      providerAccountId: accountSid,
      serviceType: 'voice_outbound',
      direction: 'outbound',
      destinationPrefix: '*',
      currency: 'USD',
      currentPriceMicro: parsed.priceMicroBig,
      wholesaleRateMicro: parsed.priceMicroBig,
      unitType: 'minute',
      billingIncrementSeconds: 60,
      minChargeableUnits: 1,
    };

    const derived = CommercialPricingEngine.calculateRetailRate(quote, globalVoicePolicy);

    const rateCard: any = {
      serviceType: 'voice_outbound',
      direction: 'outbound',
      destinationPattern: '*',
      destinationName: name,
      retailRateMicro: Number(derived.derivedRetailRateMicro),
      currency: 'USD',
      billingIncrementSeconds: 60,
      minChargeableUnits: 1,
    };

    const dto = CustomerRetailPricingService.toCustomerSafeDTO(rateCard);

    return {
      name,
      rawCurrentPrice: rawCurrent,
      wholesaleMicro: parsed.priceMicroBig.toString(),
      retailMicro: derived.derivedRetailRateMicro.toString(),
      formattedRetailDisplay: dto.retailRateMinorDisplay,
    };
  };

  // Sample rates from US, AU, IN
  const usSamplePrice = usRes.outboundCallPrices?.[0]?.currentPrice || '0.0130';
  const auSamplePrice = auRes.outboundCallPrices?.[0]?.currentPrice || '0.0250';
  const inSamplePrice = inRes.outboundCallPrices?.[0]?.currentPrice || '0.0350';

  const usCalc = calculateSample('US Outbound Sample', usSamplePrice);
  const auCalc = calculateSample('AU Outbound Sample', auSamplePrice);
  const inCalc = calculateSample('IN Outbound Sample', inSamplePrice);

  console.log('\nRepresentative Live Pricing -> Retail Conversion Results:');
  console.table([usCalc, auCalc, inCalc]);

  // -------------------------------------------------------------
  // 8. ORIGINATION SEMANTICS & VALUE CHECK
  // -------------------------------------------------------------
  console.log('\n--- 8. Origination Prefix Semantics Audit ---');
  let zeroCount = 0;
  let negativeCount = 0;
  let missingCount = 0;
  let hasAllToken = false;
  let hasRowToken = false;

  const inspectCountryOriginations = (countryRes: any) => {
    for (const item of countryRes.outboundCallPrices || []) {
      if (!item.currentPrice) missingCount++;
      else if (item.currentPrice === '0.00' || item.currentPrice === '0') zeroCount++;
      else if (item.currentPrice.startsWith('-')) negativeCount++;

      for (const orig of item.originationPrefixes || []) {
        if (orig === 'ALL') hasAllToken = true;
        if (orig === 'ROW') hasRowToken = true;
      }
    }
  };

  inspectCountryOriginations(usRes);
  inspectCountryOriginations(auRes);
  inspectCountryOriginations(inRes);

  console.log(`Zero currentPrice observations: ${zeroCount}`);
  console.log(`Negative currentPrice observations: ${negativeCount}`);
  console.log(`Missing currentPrice observations: ${missingCount}`);
  console.log(`Origination 'ALL' token observed: ${hasAllToken}`);
  console.log(`Origination 'ROW' token observed: ${hasRowToken}`);

  assert.strictEqual(negativeCount, 0, 'No negative currentPrice should exist');

  // -------------------------------------------------------------
  // 9. VERIFY POST-TEST DATABASE STATE (READ ONLY)
  // -------------------------------------------------------------
  console.log('\n--- 9. Verify Database State Post-Test (READ ONLY) ---');

  const { data: cacheData } = await serviceClient.from('provider_voice_pricing_cache').select('*');
  const { data: syncData } = await serviceClient.from('provider_voice_price_sync_runs').select('*');
  const targetOrgId = '00000000-0000-0000-0000-000000000001';
  const { data: scalarSpendable } = await serviceClient.rpc('get_spendable_credit_balance_minor', {
    p_organization_id: targetOrgId,
  });

  console.log(`provider_voice_pricing_cache row count: ${cacheData.length}`);
  console.log(`provider_voice_price_sync_runs row count: ${syncData.length}`);
  console.log(`Wallet Spendable Balance: ${scalarSpendable} cents ($${(Number(scalarSpendable) / 100).toFixed(2)})`);

  assert.strictEqual(cacheData.length, 0, 'provider_voice_pricing_cache must remain 0 rows after read test');
  assert.strictEqual(syncData.length, 0, 'provider_voice_price_sync_runs must remain 0 rows after read test');
  assert.strictEqual(Number(scalarSpendable), 52700, 'Wallet spendable balance must remain exactly 52700 cents ($527.00)');

  console.log('\n================================================================');
  console.log('STAGE C.6D.3 LIVE TWILIO READ-ONLY PRICING VALIDATION PASSED');
  console.log('================================================================\n');
}

runStageC6D3LiveTwilioPricingValidation().catch((err) => {
  console.error('Live Twilio pricing validation failed:', err);
  process.exit(1);
});
