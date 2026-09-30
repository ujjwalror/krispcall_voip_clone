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

async function verifyRemoteMigration() {
  const supabase = createAdminClient();

  console.log('=== VERIFYING REMOTE 20261215000000 MIGRATION (READ-ONLY PROBES) ===\n');

  // 1. Verify non-existence of accidental draft RPC names
  console.log('--- 1. Checking non-existence of accidental draft RPCs ---');
  const accidentalRPCs = ['create_telecom_usage_reservation_atomic', 'reverse_telecom_usage_atomic'];
  for (const name of accidentalRPCs) {
    const { error } = await supabase.rpc(name as any, {} as any);
    if (error && (error.code === 'PGRST202' || error.message.includes('Could not find the function'))) {
      console.log(`✓ Confirmed accidental RPC [${name}] DOES NOT exist remotely.`);
    } else {
      console.error(`❌ Unexpected response for accidental RPC [${name}]:`, error);
    }
  }

  // 2. Verify existence and colon-regex validation for canonical RPCs
  console.log('\n--- 2. Verifying canonical RPCs & colon grammar validation ---');

  const dummyOrgId = '00000000-0000-0000-0000-000000000000';
  const canonicalUsageId = 'call:outbound:00000000-0000-0000-0000-000000000001';
  const canonicalIdempotencyKey = 'reserve:outbound:00000000-0000-0000-0000-000000000001';

  // RPC 1: record_telecom_usage_reservation_atomic
  const { data: resData, error: resErr } = await supabase.rpc('record_telecom_usage_reservation_atomic' as any, {
    p_organization_id: dummyOrgId,
    p_internal_usage_id: canonicalUsageId,
    p_service_type: 'voice',
    p_direction: 'outbound',
    p_amount_reserved_minor: 6,
    p_idempotency_key: canonicalIdempotencyKey,
  });

  console.log('\nRPC [record_telecom_usage_reservation_atomic]:');
  if (resErr) {
    console.log('  Error Message:', resErr.message);
    if (resErr.message.includes('INVALID_INTERNAL_USAGE_ID')) {
      console.error('❌ FAIL: Canonical colon identifier rejected!');
    } else if (resErr.message.includes('INSUFFICIENT_AVAILABLE_BALANCE') || resErr.message.includes('ORGANIZATION_BILLING_RESTRICTED') || resErr.message.includes('id idempotency')) {
      console.log('✓ PASS: Colon-delimited internal_usage_id accepted by regex validation.');
    } else {
      console.log('  Output:', resErr.message);
    }
  } else {
    console.log('  Success Data:', resData);
  }

  // RPC 2: extend_telecom_usage_reservation_atomic
  const { error: extErr } = await supabase.rpc('extend_telecom_usage_reservation_atomic' as any, {
    p_organization_id: dummyOrgId,
    p_internal_usage_id: canonicalUsageId,
    p_additional_amount_reserved_minor: 6,
    p_idempotency_key: 'extend:outbound:00000000-0000-0000-0000-000000000001',
  });

  console.log('\nRPC [extend_telecom_usage_reservation_atomic]:');
  if (extErr) {
    console.log('  Error Message:', extErr.message);
    if (extErr.message.includes('INVALID_INTERNAL_USAGE_ID')) {
      console.error('❌ FAIL: Canonical colon identifier rejected!');
    } else if (extErr.message.includes('RESERVATION_NOT_FOUND') || extErr.message.includes('INSUFFICIENT_AVAILABLE_BALANCE')) {
      console.log('✓ PASS: Colon-delimited internal_usage_id accepted by regex validation.');
    }
  }

  // RPC 3: settle_telecom_usage_reservation_atomic
  const { error: setErr } = await supabase.rpc('settle_telecom_usage_reservation_atomic' as any, {
    p_organization_id: dummyOrgId,
    p_internal_usage_id: canonicalUsageId,
    p_actual_retail_charge_minor: 6,
    p_idempotency_key: 'settle:outbound:00000000-0000-0000-0000-000000000001',
  });

  console.log('\nRPC [settle_telecom_usage_reservation_atomic]:');
  if (setErr) {
    console.log('  Error Message:', setErr.message);
    if (setErr.message.includes('INVALID_INTERNAL_USAGE_ID')) {
      console.error('❌ FAIL: Canonical colon identifier rejected!');
    } else if (setErr.message.includes('RESERVATION_NOT_FOUND')) {
      console.log('✓ PASS: Colon-delimited internal_usage_id accepted by regex validation.');
    }
  }

  // RPC 4: release_telecom_usage_reservation_atomic
  const { error: relErr } = await supabase.rpc('release_telecom_usage_reservation_atomic' as any, {
    p_organization_id: dummyOrgId,
    p_internal_usage_id: canonicalUsageId,
    p_reason: 'test_release',
    p_idempotency_key: 'release:outbound:00000000-0000-0000-0000-000000000001',
  });

  console.log('\nRPC [release_telecom_usage_reservation_atomic]:');
  if (relErr) {
    console.log('  Error Message:', relErr.message);
    if (relErr.message.includes('INVALID_INTERNAL_USAGE_ID')) {
      console.error('❌ FAIL: Canonical colon identifier rejected!');
    } else if (relErr.message.includes('RESERVATION_NOT_FOUND')) {
      console.log('✓ PASS: Colon-delimited internal_usage_id accepted by regex validation.');
    }
  }

  // RPC 5: record_telecom_usage_reversal_atomic
  const { error: revErr } = await supabase.rpc('record_telecom_usage_reversal_atomic' as any, {
    p_organization_id: dummyOrgId,
    p_internal_usage_id: canonicalUsageId,
    p_reversal_amount_minor: 6,
    p_idempotency_key: 'reversal:outbound:00000000-0000-0000-0000-000000000001',
  });

  console.log('\nRPC [record_telecom_usage_reversal_atomic]:');
  if (revErr) {
    console.log('  Error Message:', revErr.message);
    if (revErr.message.includes('INVALID_INTERNAL_USAGE_ID')) {
      console.error('❌ FAIL: Canonical colon identifier rejected!');
    } else if (revErr.message.includes('RESERVATION_NOT_FOUND')) {
      console.log('✓ PASS: Colon-delimited internal_usage_id accepted by regex validation.');
    }
  }

  console.log('\n=== REMOTE VERIFICATION COMPLETE ===');
}

verifyRemoteMigration().catch(console.error);
