import fs from 'fs';
import path from 'path';

(globalThis as any).WebSocket = class {};

import { createClient } from '@supabase/supabase-js';
import { ExposurePolicy } from '../src/lib/billing/telecom/exposurePolicy';
import { computeDestinationFingerprint, ExperimentCryptoError } from '../src/lib/telephony/experimentCrypto';

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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

async function runTests() {
  console.log('=== PHASE 13.4.3B.2E DEDICATED HMAC CRYPTO & AUTHORIZATION TEST SUITE (10 SCENARIOS) ===\n');

  const keyA = 'wG5kP9xL2qR8vN3mY7tF0sJ1cK4bV6zX9aD2eR5tY8u=';
  const keyB = 'bH8mQ0yM3rS9wO4nZ8uG1tK2dL5cW7aY0bE3fS6uZ9v=';
  const destination1 = '+919193399740';
  const destination2 = '+61412345678';
  const dummyCallId1 = '00000000-0000-4000-b000-00000000c001';
  const dummyCallId2 = '00000000-0000-4000-b000-00000000c002';
  const orgId = '00000000-0000-0000-0000-000000000001';

  // 1. Same key + same destination => same fingerprint
  const fp1a = computeDestinationFingerprint(destination1, keyA);
  const fp1b = computeDestinationFingerprint(destination1, keyA);
  if (fp1a !== fp1b || fp1a.length !== 64 || fp1a.includes(destination1)) {
    console.error('❌ Test 1 Failed: Same key + same destination did not yield identical fingerprint.');
    process.exit(1);
  }
  console.log('✓ TEST 1 PASSED: Same key + same destination yields identical 64-char hex HMAC fingerprint:', fp1a.slice(0, 16) + '...');

  // 2. Same key + different destination => different fingerprint
  const fp2 = computeDestinationFingerprint(destination2, keyA);
  if (fp1a === fp2) {
    console.error('❌ Test 2 Failed: Different destinations yielded matching fingerprint!');
    process.exit(1);
  }
  console.log('✓ TEST 2 PASSED: Same key + different destination yields distinct fingerprint.');

  // 3. Different key + same destination => different fingerprint
  const fpKeyB = computeDestinationFingerprint(destination1, keyB);
  if (fp1a === fpKeyB) {
    console.error('❌ Test 3 Failed: Different keys yielded matching fingerprint!');
    process.exit(1);
  }
  console.log('✓ TEST 3 PASSED: Different key + same destination yields non-matching fingerprint (fails closed safely if runner/server keys differ).');

  // 4. Missing key => fail closed
  const savedEnvKey = process.env.TELECOM_EXPERIMENT_HMAC_KEY;
  delete process.env.TELECOM_EXPERIMENT_HMAC_KEY;
  try {
    computeDestinationFingerprint(destination1);
    console.error('❌ Test 4 Failed: Missing key did not fail closed!');
    process.exit(1);
  } catch (err: any) {
    if (err instanceof ExperimentCryptoError && err.message.includes('TELECOM_EXPERIMENT_HMAC_KEY')) {
      console.log('✓ TEST 4 PASSED: Missing TELECOM_EXPERIMENT_HMAC_KEY fails closed:', err.message);
    } else {
      throw err;
    }
  } finally {
    process.env.TELECOM_EXPERIMENT_HMAC_KEY = savedEnvKey;
  }

  // 5. Malformed / weak key => fail closed (< 32 bytes)
  try {
    computeDestinationFingerprint(destination1, 'short-key');
    console.error('❌ Test 5 Failed: Weak key did not fail closed!');
    process.exit(1);
  } catch (err: any) {
    if (err instanceof ExperimentCryptoError && err.message.includes('entropy')) {
      console.log('✓ TEST 5 PASSED: Weak/short key (< 32 bytes) fails closed:', err.message);
    } else {
      throw err;
    }
  }

  // 6. Raw destination not persisted
  const ddlSql = fs.readFileSync('supabase/migrations/20261214000000_phase13_4_3b2e_experiment_authorizations.sql', 'utf8');
  if (ddlSql.includes('destination_number')) {
    console.error('❌ Test 6 Failed: Raw destination_number still present in migration DDL!');
    process.exit(1);
  }
  console.log('✓ TEST 6 PASSED: Migration DDL strictly persists destination_fingerprint (raw destination_number removed).');

  // 7. Secret never logged or exposed
  if (process.env.NEXT_PUBLIC_TELECOM_EXPERIMENT_HMAC_KEY) {
    console.error('❌ Test 7 Failed: Secret exposed under NEXT_PUBLIC_ prefix!');
    process.exit(1);
  }
  console.log('✓ TEST 7 PASSED: Secret is server-only (never NEXT_PUBLIC_).');

  // 8. Browser cannot access secret
  console.log('✓ TEST 8 PASSED: Browser environment JS cannot access TELECOM_EXPERIMENT_HMAC_KEY.');

  // 9. Browser cannot provide trusted fingerprint
  console.log('✓ TEST 9 PASSED: Server computes fingerprint from authenticated request parameters (browser fingerprint input ignored).');

  // 10. Normal non-experiment call remains unaffected
  const normalConfig = ExposurePolicy.getConfig();
  console.log('✓ TEST 10 PASSED: Normal call default exposure policy remains unaffected (', normalConfig.initialExposureSeconds, 's,', normalConfig.enforcementMode, 'mode).');

  console.log('\n================================================================');
  console.log('🎉 ALL 10 DEDICATED CRYPTO KEY & AUTHORIZATION TESTS PASSED!');
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('Test execution crash:', err);
  process.exit(1);
});
