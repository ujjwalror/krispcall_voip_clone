import fs from 'fs';
import path from 'path';

const envPath = path.resolve('.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.substring(0, idx).trim();
      const val = trimmed.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
      process.env[key] = val;
    }
  }
}

import { getExperimentKeyVersion } from '../src/lib/telephony/experimentCrypto';

async function testDiagnosticUnit() {
  console.log('=== TESTING TEMPORARY TELECOM EXPERIMENT DIAGNOSTIC ===\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string) {
    if (condition) {
      console.log(`✓ PASS: ${label}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${label}`);
      failed++;
    }
  }

  // 1. Compute direct version
  const localVer = getExperimentKeyVersion();
  assert(localVer === '376a83c5', `Local key version matches expected 376a83c5 (got ${localVer})`);

  // 2. Mock diagnostic route response logic
  function mockDiagnosticResponse(user: { id: string } | null, profileRole: string | null) {
    if (!user) {
      return { status: 401, body: { error: 'Unauthorized. Authenticated session required.' } };
    }
    if (!profileRole || !['owner', 'admin'].includes(profileRole.toLowerCase())) {
      return { status: 403, body: { error: 'Forbidden. Diagnostic access requires Owner or Admin role.' } };
    }
    return { status: 200, body: { experimentKeyVersion: getExperimentKeyVersion() } };
  }

  // Test 4.1: Unauthenticated request -> 401
  const r1 = mockDiagnosticResponse(null, null);
  assert(r1.status === 401, 'Unauthenticated request denied with 401');

  // Test 4.2: Non-admin request (e.g. agent/manager) -> 403
  const r2 = mockDiagnosticResponse({ id: 'agent-1' }, 'agent');
  assert(r2.status === 403, 'Agent role denied with 403');
  const r3 = mockDiagnosticResponse({ id: 'mgr-1' }, 'manager');
  assert(r3.status === 403, 'Manager role denied with 403');

  // Test 4.3: Authorized admin / owner -> 200 with experimentKeyVersion
  const r4 = mockDiagnosticResponse({ id: 'admin-1' }, 'admin');
  assert(r4.status === 200 && r4.body.experimentKeyVersion === '376a83c5', 'Admin role allowed with 200 and version 376a83c5');

  const r5 = mockDiagnosticResponse({ id: 'owner-1' }, 'owner');
  assert(r5.status === 200 && r5.body.experimentKeyVersion === '376a83c5', 'Owner role allowed with 200 and version 376a83c5');

  // Test 4.4: Verify response payload contains zero secret or destination fingerprint
  const keys = Object.keys(r4.body);
  assert(keys.length === 1 && keys[0] === 'experimentKeyVersion', 'Response payload contains ONLY experimentKeyVersion field');
  const bodyStr = JSON.stringify(r4.body);
  assert(!bodyStr.includes('secret') && !bodyStr.includes('fingerprint') && !bodyStr.includes('keyBytes'), 'Payload contains zero sensitive material');

  console.log(`\nSUMMARY: ${passed} PASSED / ${failed} FAILED\n`);
  if (failed > 0) process.exit(1);
}

testDiagnosticUnit().catch(console.error);
