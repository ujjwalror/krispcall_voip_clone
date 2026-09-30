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

import { createAdminClient } from '../src/lib/supabase/admin';
import { computeDestinationFingerprint, getExperimentKeyVersion } from '../src/lib/telephony/experimentCrypto';

async function armFinalExperimentAuthorization() {
  const supabase = createAdminClient();
  const orgId = '00000000-0000-0000-0000-000000000001';
  const destNumber = process.env.LEVEL2_CONTROLLED_DESTINATION;
  const hmacKey = process.env.TELECOM_EXPERIMENT_HMAC_KEY;

  console.log('=== ARMING EXACTLY ONE FINAL LEVEL 2B EXPERIMENT AUTHORIZATION ===\n');

  if (!destNumber || !hmacKey) {
    console.error('Missing LEVEL2_CONTROLLED_DESTINATION or TELECOM_EXPERIMENT_HMAC_KEY');
    process.exit(1);
  }

  // 1. Compute destination fingerprint and key version
  const fingerprint = computeDestinationFingerprint(destNumber, hmacKey);
  const keyVersion = getExperimentKeyVersion(hmacKey);

  console.log(`Computed Destination Fingerprint: ${fingerprint.slice(0, 12)}...${fingerprint.slice(-8)}`);
  console.log(`Diagnostic Key Version: ${keyVersion}`);

  // 2. Clean up any existing unconsumed authorizations for this org just in case
  const { data: existingUnconsumed } = await supabase
    .from('telecom_experiment_authorizations')
    .select('id')
    .eq('organization_id', orgId)
    .eq('status', 'armed');

  if (existingUnconsumed && existingUnconsumed.length > 0) {
    console.log(`Cleaning up ${existingUnconsumed.length} unconsumed stale authorizations...`);
    for (const u of existingUnconsumed) {
      await supabase
        .from('telecom_experiment_authorizations')
        .update({ status: 'expired', expires_at: new Date(Date.now() - 1000).toISOString() })
        .eq('id', u.id);
    }
  }

  // 3. Insert EXACTLY ONE new authorization with 15 minute TTL
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const { data: newAuth, error: insertErr } = await supabase
    .from('telecom_experiment_authorizations')
    .insert({
      organization_id: orgId,
      destination_fingerprint: fingerprint,
      enforcement_mode: 'enforce',
      initial_exposure_seconds: 30,
      max_initial_exposure_seconds: 300,
      status: 'armed',
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (insertErr || !newAuth) {
    console.error('❌ Failed to arm experiment authorization:', insertErr?.message);
    process.exit(1);
  }

  console.log('\n✓ SUCCESSFULLY ARMED EXACTLY ONE EXPERIMENT AUTHORIZATION:');
  console.log(`  Authorization ID: ${newAuth.id}`);
  console.log(`  Organization ID: ${newAuth.organization_id}`);
  console.log(`  Status: ${newAuth.status}`);
  console.log(`  Enforcement Mode: ${newAuth.enforcement_mode}`);
  console.log(`  Initial Exposure Seconds: ${newAuth.initial_exposure_seconds}`);
  console.log(`  Max Initial Exposure Seconds: ${newAuth.max_initial_exposure_seconds}`);
  console.log(`  Expires At: ${newAuth.expires_at}`);

  // 4. Verify usable armed count = 1
  const { data: allAuths } = await supabase
    .from('telecom_experiment_authorizations')
    .select('id, status, expires_at')
    .eq('organization_id', orgId);

  let usableCount = 0;
  for (const a of allAuths || []) {
    const isExpired = new Date(a.expires_at).getTime() <= Date.now();
    if (a.status === 'armed' && !isExpired) {
      usableCount++;
    }
  }

  console.log(`\nVerification: Usable Armed Authorization Count = ${usableCount}`);
  if (usableCount !== 1) {
    console.error('❌ FAIL: Usable armed authorization count is not exactly 1!');
    process.exit(1);
  } else {
    console.log('✓ PASS: Usable armed authorization count is EXACTLY 1.');
  }
}

armFinalExperimentAuthorization().catch(console.error);
