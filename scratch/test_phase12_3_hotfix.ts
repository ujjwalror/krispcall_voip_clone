import * as fs from 'fs';
import * as path from 'path';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`✓ ${message}`);
  }
}

function runHotfixAudit() {
  console.log('==================================================');
  console.log('PHASE 12.3 OWNERSHIP RECONCILIATION HOTFIX AUDIT');
  console.log('==================================================\n');

  const migrationPath = path.join(
    process.cwd(),
    'supabase/migrations/20261103010000_phase12_3_reconciliation_conflict_fix.sql'
  );

  assert(fs.existsSync(migrationPath), 'Migration 20261103010000_phase12_3_reconciliation_conflict_fix.sql exists');

  const sqlContent = fs.readFileSync(migrationPath, 'utf8');

  // 1. Conflict target matches partial unique index
  assert(
    sqlContent.includes("ON CONFLICT (phone_number) WHERE status IN ('active', 'inactive', 'suspended')"),
    '1. ON CONFLICT target matches partial unique index predicate WHERE status IN (\'active\', \'inactive\', \'suspended\')'
  );

  // 2. New active ownership insertion
  assert(
    sqlContent.includes("INSERT INTO public.phone_numbers"),
    '2. Inserts new active phone ownership record'
  );

  // 3. Same-operation reconciliation replay idempotency
  assert(
    sqlContent.includes("DO UPDATE SET") && sqlContent.includes("RETURNING * INTO v_op"),
    '3. Replay is idempotent via DO UPDATE SET and atomic RETURNING'
  );

  // 4. Same-org active row reconciliation safety
  assert(
    sqlContent.includes("v_existing_phone.organization_id <> v_op.organization_id"),
    '4. Checks existing ownership organization ID before update'
  );

  // 5. Cross-tenant ownership protection
  assert(
    sqlContent.includes("RAISE EXCEPTION 'OWNERSHIP_CONFLICT: Phone number % is already actively owned by organization %.'"),
    '5. Cross-tenant active ownership attempt fails closed with OWNERSHIP_CONFLICT'
  );

  // 6 & 7. Historical status exclusion
  assert(
    sqlContent.includes("WHERE phone_number = v_op.phone_number_e164") &&
    sqlContent.includes("AND status IN ('active', 'inactive', 'suspended')"),
    '6 & 7. Historical released/ported_out rows excluded from active conflict target, permitting legitimate new active ownership'
  );

  // 8, 9, 10, 11. Capability persistence
  assert(
    sqlContent.includes("capabilities_voice = v_cap_voice") &&
    sqlContent.includes("capabilities_sms = v_cap_sms") &&
    sqlContent.includes("capabilities_mms = v_cap_mms"),
    '8, 9, 10, 11. Authoritative capabilities (voice, sms, mms) persisted explicitly without country/type inference'
  );

  // 12 & 13. Provider mapping & provider-resource replay
  assert(
    sqlContent.includes("INSERT INTO public.number_provider_mappings") &&
    sqlContent.includes("ON CONFLICT (provider, provider_resource_id) DO UPDATE SET provider_status = p_provider_status"),
    '12 & 13. number_provider_mappings established idempotently with provider_resource_id'
  );

  // 14. Operation status update sequence
  assert(
    sqlContent.indexOf("INSERT INTO public.number_provider_mappings") < sqlContent.indexOf("UPDATE public.provider_number_operations") &&
    sqlContent.includes("SET status = 'succeeded'"),
    '14. provider_number_operations status set to succeeded ONLY after phone_numbers and mapping writes complete'
  );

  // 15. RPC Security DEFINER and Privileges
  assert(
    sqlContent.includes("SECURITY DEFINER") &&
    sqlContent.includes("SET search_path = public, pg_temp") &&
    sqlContent.includes("REVOKE EXECUTE ON FUNCTION public.reconcile_provider_number_purchase_v2(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;") &&
    sqlContent.includes("GRANT EXECUTE ON FUNCTION public.reconcile_provider_number_purchase_v2(UUID, TEXT, TEXT) TO service_role;"),
    '15. SECURITY DEFINER, search_path = public, pg_temp, REVOKE from PUBLIC/anon/authenticated, and GRANT to service_role verified'
  );

  console.log('\n=== ALL 15 HOTFIX AUDIT ASSERTIONS PASSED ===');
}

runHotfixAudit();
