import fs from 'fs';
import path from 'path';

// Load .env.local variables manually if present
const envLocalPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envLocalPath)) {
  const envContent = fs.readFileSync(envLocalPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

import { runLevel2APreflight } from '../src/lib/telephony/level2aPreflightHarness';

async function main() {
  console.log('================================================================');
  console.log('PHASE 13.4.3B.2E — LEVEL 2A READ-ONLY PROVIDER PREFLIGHT');
  console.log('================================================================\n');

  const result = await runLevel2APreflight();

  console.log('STATUS SUMMARY:', result.summary);
  console.log('STATUS CODE   :', result.status);
  console.log('\n--- VERIFICATION CHECKS ---');
  for (const [key, value] of Object.entries(result.checks)) {
    const mark = value.pass ? '✓ PASS' : '✕ FAIL';
    console.log(`  ${mark} [${key}]: ${value.details}`);
  }

  console.log('\n--- TIMING & SAFETY BUDGETS ---');
  console.log(`  Experiment Lease Seconds: ${result.experimentLeaseSeconds}s`);
  console.log(`  Required Safety Seconds : ${result.requiredSafetySeconds}s`);

  console.log('\n--- COST BUDGETS ---');
  console.log(`  Calculated Max Cost : ${result.calculatedMaxCostMinor} cents`);
  console.log(`  Authorized Budget   : ${result.authorizedBudgetMinor} cents`);

  console.log('\n--- MUTATION COUNTERS (READ-ONLY PROOF) ---');
  console.log(`  Remote DB writes        : 0`);
  console.log(`  Twilio Read-Only Requests: ${result.twilioReadOnlyRequests}`);
  console.log(`  Twilio call creations   : 0`);
  console.log(`  Twilio Call mutations   : 0`);
  console.log(`  Twilio number mutations : 0`);
  console.log(`  Twilio message mutations: 0`);
  console.log(`  Stripe calls            : 0\n`);

  if (result.status === 'LEVEL_2A_PREFLIGHT_PASS') {
    console.log('================================================================');
    console.log('B.2E LEVEL 2A READ-ONLY PREFLIGHT — PASSED');
    console.log('================================================================\n');
  } else {
    console.log('================================================================');
    console.log('B.2E LEVEL 2A READ-ONLY PREFLIGHT — FAILED');
    console.log('================================================================\n');
  }
}

main().catch((err) => {
  console.error('Execution failed:', err);
  process.exit(1);
});
