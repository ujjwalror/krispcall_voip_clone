import fs from 'fs';
import path from 'path';

(globalThis as any).WebSocket = class {};

import { runLevel2APreflight } from '../src/lib/telephony/level2aPreflightHarness';

// Load .env.local
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key && !process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

async function executeRealLevel2APreflight() {
  console.log('=== EXECUTE REAL LEVEL 2A READ-ONLY PREFLIGHT ===\n');

  const destination = process.env.LEVEL2_CONTROLLED_DESTINATION;
  if (!destination) {
    console.error('CONTROLLED_TEST_DESTINATION_REQUIRED');
    process.exit(1);
  }

  const result = await runLevel2APreflight({
    initialTestLimitSeconds: 30,
    proposedExtendedLimitSeconds: 90,
    absoluteTestMaxSeconds: 120,
    experimentLeaseDurationSeconds: 300,
    allowDocVerifiedIncrement: true,
    checkTenantConflict: true,
  });

  console.log('Preflight Execution Status:', result.status);
  console.log('Summary:', result.summary);
  console.log('Calculated Max Cost Minor (cents):', result.calculatedMaxCostMinor);
  console.log('Authorized Budget Minor (cents):', result.authorizedBudgetMinor);
  console.log('Twilio Read-Only Requests:', result.twilioReadOnlyRequests);
  console.log('Pricing Provenance:', result.pricingProvenance);
  console.log('Billing Increment Provenance:', result.billingIncrementProvenance);
  console.log('Candidate Number Type:', result.candidateNumberType);
  console.log('Existing Owner Context:', result.existingNumberOwnerContext);
  console.log('Account Details:', result.accountDetails);
  console.log('Owned Numbers:', result.ownedNumbersDetails);
  console.log('Tenant Conflict Details:', result.tenantConflictDetails);
  console.log('Checks Summary:');
  for (const [key, val] of Object.entries(result.checks)) {
    console.log(`  - ${key}: ${val.pass ? 'PASS' : 'FAIL'} (${val.details})`);
  }
}

executeRealLevel2APreflight().catch((err) => {
  console.error('Level 2A execution failed:', err);
  process.exit(1);
});
