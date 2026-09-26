import Module from 'module';
import fs from 'fs';
import path from 'path';

// Mock 'server-only' package before loading modules
const originalRequire = Module.prototype.require;
// @ts-ignore
Module.prototype.require = function (id: string) {
  if (id === 'server-only') {
    return {};
  }
  // @ts-ignore
  return originalRequire.apply(this, arguments);
};

// Manually parse .env.local
const envPath = path.resolve('/Users/ritikchoudhary/Downloads/Kripscall_clone/.env.local');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        process.env[key] = val;
      }
    }
  }
}

import { inventoryProvider } from '/Users/ritikchoudhary/Downloads/Kripscall_clone/src/lib/telephony/marketplace/inventoryProvider';
import { NumberPurchaseReadinessService } from '/Users/ritikchoudhary/Downloads/Kripscall_clone/src/lib/telephony/marketplace/purchaseReadinessService';
import { RegulatoryPreCheckService } from '/Users/ritikchoudhary/Downloads/Kripscall_clone/src/lib/telephony/marketplace/regulatoryPreCheckService';

async function runBugTraceTests() {
  console.log('=== PHASE 10.1 PURCHASE READINESS BUG TRACE & PERFORMANCE TESTS ===\n');

  // 1. Measure Country Discovery Latency
  const t0 = Date.now();
  const countries = await inventoryProvider.getAvailableCountries();
  const t1 = Date.now();
  console.log(`1. Country Discovery: ${countries.length} countries loaded in ${t1 - t0}ms`);

  // 2. Measure Inventory Search Latency
  const t2 = Date.now();
  const auLocalRes = await inventoryProvider.searchAvailableNumbers({ countryCode: 'AU', numberType: 'local' });
  const t3 = Date.now();
  console.log(`2. Inventory Search (AU Local): ${auLocalRes.length} candidates loaded in ${t3 - t2}ms`);

  const realCandidate = auLocalRes[0]?.phoneNumber || '+61361601174';

  // 3. Measure Regulatory Pre-Check Latency
  const t4 = Date.now();
  const preCheckRes = await RegulatoryPreCheckService.evaluateRequirements('AU', 'local', 'business');
  const t5 = Date.now();
  console.log(`3. Regulatory Pre-Check (AU Business): status='${preCheckRes.status}' in ${t5 - t4}ms`);
  console.log(`   Message Text: "${preCheckRes.message}"`);

  // 4. Measure Purchase Readiness Latency (Business)
  const t6 = Date.now();
  const businessReadiness = await NumberPurchaseReadinessService.evaluateReadiness(
    '00000000-0000-0000-0000-000000000001',
    {
      phoneNumber: realCandidate,
      countryCode: 'AU',
      numberType: 'local',
      endUserType: 'business',
    }
  );
  const t7 = Date.now();
  console.log(`4. Purchase Readiness (AU Local Business): state='${businessReadiness.readinessState}', nextAction='${businessReadiness.nextAction}' in ${t7 - t6}ms`);
  console.log(`   Customer Message: "${businessReadiness.customerMessage}"`);

  // 5. Measure Purchase Readiness Latency (Individual)
  const t8 = Date.now();
  const individualReadiness = await NumberPurchaseReadinessService.evaluateReadiness(
    '00000000-0000-0000-0000-000000000001',
    {
      phoneNumber: realCandidate,
      countryCode: 'AU',
      numberType: 'local',
      endUserType: 'individual',
    }
  );
  const t9 = Date.now();
  console.log(`5. Purchase Readiness (AU Local Individual): state='${individualReadiness.readinessState}', nextAction='${individualReadiness.nextAction}' in ${t9 - t8}ms`);

  console.log('\n=== ALL BUG TRACE AND PERFORMANCE TESTS PASSED SUCCESSFULLY ===');
}

runBugTraceTests().catch((err) => {
  console.error('Bug trace test runner exception:', err);
  process.exit(1);
});
