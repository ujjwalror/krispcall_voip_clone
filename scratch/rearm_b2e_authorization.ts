import fs from 'fs';
import path from 'path';

(globalThis as any).WebSocket = class {};

import { createClient } from '@supabase/supabase-js';
import { computeDestinationFingerprint } from '../src/lib/telephony/experimentCrypto';

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

async function rearmExperiment() {
  console.log('==================================================');
  console.log('RE-ARMING FINAL B.2E CONTROLLED EXPERIMENT');
  console.log('==================================================\n');

  const orgId = '00000000-0000-0000-0000-000000000001';
  const prevAuthId = '69dddf7d-e3d9-415c-85ce-76b1f705ecaf';
  const destination = process.env.LEVEL2_CONTROLLED_DESTINATION || '+919193399740';
  const hmacKey = process.env.TELECOM_EXPERIMENT_HMAC_KEY!;

  // 1. VERIFY EXPIRED AUTHORIZATION
  const { data: prevAuthRow } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('id', prevAuthId)
    .single();

  const nowIso = new Date().toISOString();
  const isPrevExpired = !prevAuthRow || prevAuthRow.status === 'expired' || new Date(prevAuthRow.expires_at).getTime() <= Date.now();

  console.log(`✓ Previous Auth ID: ${prevAuthId}`);
  console.log(`✓ Previous Auth Status in DB: ${prevAuthRow?.status}`);
  console.log(`✓ Previous Auth Expiry: ${prevAuthRow?.expires_at}`);
  console.log(`✓ Previous Auth Unusable: ${isPrevExpired ? 'YES' : 'NO'}`);

  // 2. VERIFY CLEAN BASELINE
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

  const { data: claimedAuthsBefore } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'claimed')
    .gt('claim_expires_at', nowIso);
  const activeClaimedCount = claimedAuthsBefore?.length || 0;

  const { data: pendingOps } = await supabase
    .from('telecom_usage_reservations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'pending');
  const unresolvedFinOps = pendingOps?.length || 0;
  const unresolvedProvOps = 0;

  if (fundedBalance !== 100 || activeExposure !== 0 || activeClaimedCount !== 0 || unresolvedFinOps !== 0) {
    console.error('STOP — DO NOT ARM. Baseline violation:', {
      fundedBalance,
      activeExposure,
      activeClaimedCount,
      unresolvedFinOps
    });
    process.exit(1);
  }

  console.log('✓ Baseline Clean: Funded = 100 minor USD, Exposure = 0, Claimed = 0, Unresolved = 0');

  // 3. ARM ONE FRESH REPLACEMENT AUTHORIZATION
  const destFingerprint = computeDestinationFingerprint(destination, hmacKey);

  const { data: armResult, error: armErr } = await supabase.rpc('arm_telecom_experiment_authorization_atomic', {
    p_organization_id: orgId,
    p_destination_fingerprint: destFingerprint,
    p_initial_exposure_seconds: 30,
    p_max_initial_exposure_seconds: 300,
    p_ttl_seconds: 900, // 15 min TTL
  });

  if (armErr || !armResult?.success) {
    console.error('FAILED TO ARM REPLACEMENT AUTHORIZATION:', armErr || armResult);
    process.exit(1);
  }

  const newAuthId = armResult.authorization_id;

  // READ BACK NEW AUTHORIZATION
  const { data: newAuthRow, error: fetchErr } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('id', newAuthId)
    .single();

  if (fetchErr || !newAuthRow) {
    console.error('FAILED TO FETCH NEW AUTHORIZATION:', fetchErr);
    process.exit(1);
  }

  // Check no second authorization created
  const { data: armedAuthsAfter } = await supabase
    .from('telecom_experiment_authorizations')
    .select('*')
    .eq('organization_id', orgId)
    .eq('status', 'armed');
  const secondAuthCreated = (armedAuthsAfter?.length || 0) > 1;

  const expiresDate = new Date(newAuthRow.expires_at);
  const expiryUtc = expiresDate.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  const kolkataOffsetMs = 5.5 * 60 * 60 * 1000;
  const kolkataDate = new Date(expiresDate.getTime() + kolkataOffsetMs);
  const kolkataIso = kolkataDate.toISOString().replace('T', ' ').slice(0, 19) + ' IST (+05:30)';

  const remainingMs = Math.max(0, expiresDate.getTime() - Date.now());
  const remainingMinutes = (remainingMs / 60000).toFixed(1);
  const remainingSeconds = Math.floor(remainingMs / 1000);

  console.log('\n=== NEW ARMED REPLACEMENT AUTHORIZATION ===');
  console.log('New Auth ID:', newAuthRow.id);
  console.log('Status:', newAuthRow.status);
  console.log('Bound Call ID:', newAuthRow.bound_call_id);
  console.log('Claimed At:', newAuthRow.claimed_at);
  console.log('Claim Expires At:', newAuthRow.claim_expires_at);
  console.log('Expiry UTC:', expiryUtc);
  console.log('Expiry Asia/Kolkata:', kolkataIso);
  console.log(`Practical remaining window: ${remainingMinutes} min (${remainingSeconds}s)`);
  console.log('Second Replacement Auth Created:', secondAuthCreated ? 'YES' : 'NO');
}

rearmExperiment().catch(err => {
  console.error('Error in rearmExperiment:', err);
  process.exit(1);
});
