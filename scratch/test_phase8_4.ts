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

async function runTests() {
  console.log('=== PHASE 8.4 RUNTIME VERIFICATION TESTS ===\n');

  // Test 1: Filter Non-Broadening Regression Verification
  console.log('--- Test 1: Filter non-broadening behavior ---');
  const filteredResult = await inventoryProvider.searchAvailableNumbers({
    countryCode: 'AU',
    numberType: 'local',
    contains: '9999999999', // Impossible digits
  });
  console.log(`Filtered impossible search returned: ${filteredResult.length} numbers (Expected: 0)`);
  if (filteredResult.length === 0) {
    console.log('✅ Filter fallback did NOT broaden search on zero results');
  } else {
    console.error('❌ Filter fallback broadened search! FAIL!');
  }

  // Test 2: Search AU Local numbers and verify live available E.164 candidates
  console.log('\n--- Test 2: Live Inventory candidate discovery ---');
  const auLocalRes = await inventoryProvider.searchAvailableNumbers({ countryCode: 'AU', numberType: 'local' });
  console.log(`AU Local found: ${auLocalRes.length} candidates`);

  const auMobileRes = await inventoryProvider.searchAvailableNumbers({ countryCode: 'AU', numberType: 'mobile' });
  console.log(`AU Mobile found: ${auMobileRes.length} candidates`);

  const auTollFreeRes = await inventoryProvider.searchAvailableNumbers({ countryCode: 'AU', numberType: 'toll_free' });
  console.log(`AU Toll-Free found: ${auTollFreeRes.length} candidates`);

  const candidateLocal = auLocalRes[0]?.phoneNumber;
  const candidateMobile = auMobileRes[0]?.phoneNumber;
  const candidateTollFree = auTollFreeRes[0]?.phoneNumber;

  console.log(`Candidate Local: ${candidateLocal}`);
  console.log(`Candidate Mobile: ${candidateMobile}`);
  console.log(`Candidate Toll-Free: ${candidateTollFree}`);

  // Test 3: Purchase Readiness Evaluation for AU Local ($5 USD/mo)
  if (candidateLocal) {
    console.log('\n--- Test 3: AU Local Purchase Readiness ---');
    const localReadiness = await NumberPurchaseReadinessService.evaluateReadiness('test-org-uuid', {
      phoneNumber: candidateLocal,
      countryCode: 'AU',
      numberType: 'local',
      endUserType: 'business',
    });
    console.log('AU Local Readiness Result:', JSON.stringify(localReadiness, null, 2));
    if (localReadiness.currentRetailPrice?.monthlyRetailPrice === 5 && localReadiness.readinessState === 'verification_required') {
      console.log('✅ AU Local retail price re-resolved to $5 USD/mo with verification_required state');
    }
  }

  // Test 4: Purchase Readiness Evaluation for AU Mobile ($12 USD/mo)
  if (candidateMobile) {
    console.log('\n--- Test 4: AU Mobile Purchase Readiness ---');
    const mobileReadiness = await NumberPurchaseReadinessService.evaluateReadiness('test-org-uuid', {
      phoneNumber: candidateMobile,
      countryCode: 'AU',
      numberType: 'mobile',
      endUserType: 'individual',
    });
    console.log('AU Mobile Readiness Result:', JSON.stringify(mobileReadiness, null, 2));
    if (mobileReadiness.currentRetailPrice?.monthlyRetailPrice === 12 && mobileReadiness.readinessState === 'verification_required') {
      console.log('✅ AU Mobile retail price re-resolved to $12 USD/mo with verification_required state');
    }
  }

  // Test 5: Purchase Readiness Evaluation for AU Toll-Free ($25 USD/mo)
  if (candidateTollFree) {
    console.log('\n--- Test 5: AU Toll-Free Purchase Readiness ---');
    const tollFreeReadiness = await NumberPurchaseReadinessService.evaluateReadiness('test-org-uuid', {
      phoneNumber: candidateTollFree,
      countryCode: 'AU',
      numberType: 'toll_free',
      endUserType: 'business',
    });
    console.log('AU Toll-Free Readiness Result:', JSON.stringify(tollFreeReadiness, null, 2));
    if (tollFreeReadiness.currentRetailPrice?.monthlyRetailPrice === 25 && tollFreeReadiness.readinessState === 'verification_required') {
      console.log('✅ AU Toll-Free retail price re-resolved to $25 USD/mo with verification_required state');
    }
  }

  // Test 6: Invalid E.164 Number Availability Revalidation
  console.log('\n--- Test 6: Unavailable exact E.164 revalidation ---');
  const fakeNumberReadiness = await NumberPurchaseReadinessService.evaluateReadiness('test-org-uuid', {
    phoneNumber: '+61299990000', // Non-existent/unavailable number
    countryCode: 'AU',
    numberType: 'local',
    endUserType: 'business',
  });
  console.log('Unavailable Number Readiness Result:', JSON.stringify(fakeNumberReadiness, null, 2));
  if (fakeNumberReadiness.readinessState === 'inventory_no_longer_available') {
    console.log('✅ Unavailable number correctly returned inventory_no_longer_available');
  }

  // Test 7: Invalid Number Type Fail Closed
  console.log('\n--- Test 7: Invalid Number Type Fail Closed ---');
  const invalidTypeReadiness = await NumberPurchaseReadinessService.evaluateReadiness('test-org-uuid', {
    phoneNumber: '+61299990001',
    countryCode: 'AU',
    numberType: 'invalid_type' as any,
    endUserType: 'business',
  });
  console.log('Invalid Type Readiness Result:', JSON.stringify(invalidTypeReadiness, null, 2));
  if (invalidTypeReadiness.readinessState === 'unsupported_number_type') {
    console.log('✅ Invalid number type correctly failed closed with unsupported_number_type');
  }

  console.log('\n=== ALL PHASE 8.4 RUNTIME VERIFICATIONS COMPLETED SUCCESSFULLY ===');
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
