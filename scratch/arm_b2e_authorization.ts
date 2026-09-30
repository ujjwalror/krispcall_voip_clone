import fs from 'fs';
import path from 'path';

(globalThis as any).WebSocket = class {};

import { createClient } from '@supabase/supabase-js';
import { computeDestinationFingerprint, getExperimentKeyVersion } from '../src/lib/telephony/experimentCrypto';

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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SECRET_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

async function main() {
  console.log('==================================================');
  console.log('ARMING ONE FINAL B.2E CONTROLLED EXPERIMENT');
  console.log('==================================================\n');

  const orgId = '00000000-0000-0000-0000-000000000001';
  const destination = process.env.LEVEL2_CONTROLLED_DESTINATION || '+919193399740';
  const hmacKey = process.env.TELECOM_EXPERIMENT_HMAC_KEY!;

  // 1. RECONFIRM CLEAN BASELINE BEFORE ARMING
  const { data: ledgerRows } = await supabase
    .from('billing_credit_ledger')
    .select('*')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });
  const fundedBalance = ledgerRows?.[0]?.balance_after_minor || 0;

  const { data: activeRes } = await supabase
    .from('telecom_usage_reservations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'active');
  const activeExposure = activeRes?.length || 0;

  const { data: armedAuthsBefore } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'armed')
    .gt('expires_at', new Date().toISOString());
  const prevArmedCount = armedAuthsBefore?.length || 0;

  const { data: claimedAuthsBefore } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'claimed')
    .gt('claim_expires_at', new Date().toISOString());
  const prevClaimedCount = claimedAuthsBefore?.length || 0;

  const { data: pendingOps } = await supabase
    .from('telecom_usage_reservations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'pending');
  const unresolvedFinOps = pendingOps?.length || 0;
  const unresolvedProvOps = 0;

  if (fundedBalance !== 100 || activeExposure !== 0 || prevArmedCount !== 0 || prevClaimedCount !== 0 || unresolvedFinOps !== 0) {
    console.error('STOP — DO NOT ARM. Baseline violation detected:', {
      fundedBalance,
      activeExposure,
      prevArmedCount,
      prevClaimedCount,
      unresolvedFinOps
    });
    process.exit(1);
  }

  console.log('✓ Baseline clean: Funded Balance = 100 minor USD, Exposure = 0, Armed = 0, Claimed = 0, Unresolved = 0');

  // 2. COMPUTE FINGERPRINT & ARM EXACTLY ONE AUTHORIZATION
  const destFingerprint = computeDestinationFingerprint(destination, hmacKey);

  console.log(`✓ Destination: ${destination}`);
  console.log(`✓ Destination Fingerprint: ${destFingerprint}`);

  const { data: armResult, error: armErr } = await supabase.rpc('arm_telecom_experiment_authorization_atomic', {
    p_organization_id: orgId,
    p_destination_fingerprint: destFingerprint,
    p_initial_exposure_seconds: 30,
    p_max_initial_exposure_seconds: 300,
    p_ttl_seconds: 900, // 15 min TTL
  });

  if (armErr || !armResult?.success) {
    console.error('FAILED TO ARM AUTHORIZATION:', armErr || armResult);
    process.exit(1);
  }

  const authId = armResult.authorization_id;

  // 3. READ BACK AUTHORIZATION ROW
  const { data: authRow, error: fetchErr } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('id', authId)
    .single();

  if (fetchErr || !authRow) {
    console.error('FAILED TO READ BACK ARMED AUTHORIZATION:', fetchErr);
    process.exit(1);
  }

  // Double-check no second authorization was created
  const { data: armedAuthsAfter } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'armed');

  const secondAuthCreated = (armedAuthsAfter?.length || 0) > 1;

  console.log('\n=== ARMED AUTHORIZATION DETAILS ===');
  console.log('Authorization ID:', authRow.id);
  console.log('Status:', authRow.status);
  console.log('Bound Call ID:', authRow.bound_call_id);
  console.log('Claimed At:', authRow.claimed_at);
  console.log('Claim Expires At:', authRow.claim_expires_at);
  console.log('Expires At:', authRow.expires_at);

  const expiresDate = new Date(authRow.expires_at);
  const expiryUtc = expiresDate.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // Format to Asia/Kolkata (+05:30)
  const kolkataOffsetMs = 5.5 * 60 * 60 * 1000;
  const kolkataDate = new Date(expiresDate.getTime() + kolkataOffsetMs);
  const kolkataIso = kolkataDate.toISOString().replace('T', ' ').slice(0, 19) + ' IST (+05:30)';

  const nowMs = Date.now();
  const remainingMs = Math.max(0, expiresDate.getTime() - nowMs);
  const remainingMinutes = (remainingMs / 60000).toFixed(1);
  const remainingSeconds = Math.floor(remainingMs / 1000);

  console.log(`Expiry UTC: ${expiryUtc}`);
  console.log(`Expiry Asia/Kolkata: ${kolkataIso}`);
  console.log(`Practical remaining window: ${remainingMinutes} minutes (${remainingSeconds} seconds)\n`);

  console.log('Second Auth Created:', secondAuthCreated ? 'YES' : 'NO');
}

main().catch(err => {
  console.error('Error in arm_b2e_authorization:', err);
  process.exit(1);
});
