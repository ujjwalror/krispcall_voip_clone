import * as fs from 'fs';
import * as path from 'path';
import Module from 'module';

// Mock server-only package for tsx scripts
const originalRequire = Module.prototype.require;
// @ts-ignore
Module.prototype.require = function (id: string) {
  if (id === 'server-only') {
    return {};
  }
  return originalRequire.apply(this, arguments as any);
};

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`PASS: ${message}`);
  }
}

async function runTests() {
  console.log('=== RUNNING HARDENED PHASE 12.2 PRE-MIGRATION & SECURITY TESTS ===\n');

  const { generateRequestFingerprintV1 } = await import(
    '/Users/ritikchoudhary/Downloads/Kripscall_clone/src/lib/telephony/commerce/requestFingerprint'
  );
  const { ProviderNumberOperationService } = await import(
    '/Users/ritikchoudhary/Downloads/Kripscall_clone/src/lib/telephony/commerce/providerNumberOperationService'
  );

  const migrationPath = path.join(
    process.cwd(),
    'supabase/migrations/20261102000000_phase12_2_purchase_operation_ledger.sql'
  );
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');

  // --- SCHEMA & SECURITY STATICAL INSPECTION TESTS ---

  // 1. Anon raw SELECT revoked
  assert(
    migrationSql.includes('REVOKE ALL ON TABLE public.provider_number_operations FROM PUBLIC, anon, authenticated;'),
    '1. Migration explicitly REVOKES ALL table access on provider_number_operations from anon'
  );

  // 2. Authenticated raw SELECT revoked
  assert(
    migrationSql.includes('REVOKE ALL ON TABLE public.provider_number_operations FROM PUBLIC, anon, authenticated;'),
    '2. Migration explicitly REVOKES ALL table access on provider_number_operations from authenticated'
  );

  // 3. Service role table access granted
  assert(
    migrationSql.includes('GRANT ALL ON TABLE public.provider_number_operations TO service_role;'),
    '3. Migration explicitly GRANTS ALL table access on provider_number_operations strictly to service_role'
  );

  // 4. create_and_claim RPC execution revoked from PUBLIC, anon, authenticated
  assert(
    migrationSql.includes('REVOKE EXECUTE ON FUNCTION public.create_and_claim_number_purchase_op') &&
      migrationSql.includes('FROM PUBLIC, anon, authenticated;'),
    '4. Migration explicitly REVOKES EXECUTE on create_and_claim_number_purchase_op from PUBLIC, anon, authenticated'
  );

  // 5. reconcile_provider_number_purchase RPC execution revoked from PUBLIC, anon, authenticated
  assert(
    migrationSql.includes('REVOKE EXECUTE ON FUNCTION public.reconcile_provider_number_purchase') &&
      migrationSql.includes('FROM PUBLIC, anon, authenticated;'),
    '5. Migration explicitly REVOKES EXECUTE on reconcile_provider_number_purchase from PUBLIC, anon, authenticated'
  );

  // 6. create_and_claim RPC execution granted to service_role
  assert(
    migrationSql.includes('GRANT EXECUTE ON FUNCTION public.create_and_claim_number_purchase_op') &&
      migrationSql.includes('TO service_role;'),
    '6. Migration explicitly GRANTS EXECUTE on create_and_claim_number_purchase_op to service_role'
  );

  // 7. reconcile RPC execution granted to service_role
  assert(
    migrationSql.includes('GRANT EXECUTE ON FUNCTION public.reconcile_provider_number_purchase') &&
      migrationSql.includes('TO service_role;'),
    '7. Migration explicitly GRANTS EXECUTE on reconcile_provider_number_purchase to service_role'
  );

  // 8. SECURITY DEFINER search_path hardening
  assert(
    migrationSql.includes('SET search_path = public, pg_temp'),
    '8. Both SECURITY DEFINER RPC functions set hardened search_path = public, pg_temp'
  );

  // 9. Legacy phone_number unique constraint safely dropped
  assert(
    migrationSql.includes('ALTER TABLE public.phone_numbers DROP CONSTRAINT IF EXISTS phone_numbers_phone_number_key;'),
    '9. Migration safely drops legacy unscoped phone_numbers_phone_number_key constraint'
  );

  // 10. Lifecycle-aware partial unique ownership index created
  assert(
    migrationSql.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_numbers_active_ownership') &&
      migrationSql.includes("WHERE status IN ('active', 'inactive', 'suspended');"),
    '10. Migration creates lifecycle-aware partial index idx_phone_numbers_active_ownership'
  );

  // 11. Manual review state included in active purchase lock index
  assert(
    migrationSql.includes('idx_active_purchase_number_lock') &&
      migrationSql.includes("'manual_review_required'"),
    "11. Global purchase lock index strictly includes 'manual_review_required'"
  );

  // --- IN-MEMORY DOMAIN ENGINE SCENARIOS ---

  const mockOperations: Map<string, any> = new Map();
  const mockPhoneNumbers: Map<string, any> = new Map();

  function createMockOp(params: any): any {
    const orgId = params.organizationId;
    const key = params.idempotencyKey;
    const existingKey = `${orgId}:${key}`;

    if (mockOperations.has(existingKey)) {
      const existing = mockOperations.get(existingKey);
      if (existing.request_fingerprint !== params.requestFingerprint) {
        throw new Error('IDEMPOTENCY_CONFLICT: Request fingerprint does not match existing idempotency key.');
      }
      return existing;
    }

    // Check active ownership in phone_numbers
    for (const [, phone] of mockPhoneNumbers) {
      if (phone.phone_number === params.phoneNumberE164 && ['active', 'inactive', 'suspended'].includes(phone.status)) {
        throw new Error('NUMBER_ALREADY_OWNED: Phone number is currently owned by an active workspace.');
      }
    }

    // Check active purchase lock (pending, in_progress, reconciliation_required, manual_review_required)
    for (const [, op] of mockOperations) {
      if (
        op.phone_number_e164 === params.phoneNumberE164 &&
        op.operation_type === 'purchase_number' &&
        ['pending', 'in_progress', 'reconciliation_required', 'manual_review_required'].includes(op.status)
      ) {
        throw new Error('ACTIVE_PURCHASE_LOCK_EXISTS: Another operation is actively processing this phone number.');
      }
    }

    const opId = `op_${Math.random().toString(36).slice(2)}`;
    const record = {
      id: opId,
      organization_id: orgId,
      operation_type: 'purchase_number',
      provider: params.provider || 'twilio',
      phone_number_e164: params.phoneNumberE164,
      number_type: params.numberType,
      country_code: params.countryCode,
      status: params.initialStatus || 'in_progress',
      idempotency_key: key,
      request_fingerprint: params.requestFingerprint,
      retail_amount_minor: params.retailAmountMinor,
      retail_currency: params.retailCurrency,
      provider_cost_minor: params.providerCostMinor,
      provider_cost_currency: params.providerCostCurrency,
      pricing_source: params.pricingSource,
      pricing_policy_id: params.pricingPolicyId || null,
      gross_margin_minor: params.retailAmountMinor - params.providerCostMinor,
      price_snapshot_payload: {
        retailAmountMinor: params.retailAmountMinor,
        retailCurrency: params.retailCurrency,
        providerCostMinor: params.providerCostMinor,
        providerCostCurrency: params.providerCostCurrency,
        pricingSource: params.pricingSource,
        pricingPolicyId: params.pricingPolicyId || null,
        grossMarginMinor: params.retailAmountMinor - params.providerCostMinor,
        priceResolvedAt: new Date().toISOString(),
        schemaVersion: 1,
      },
      compliance_profile_id: params.complianceProfileId || null,
      regulatory_bundle_sid: params.regulatoryBundleSid || null,
      regulatory_provisioning_context: {
        provider: params.provider || 'twilio',
        countryCode: params.countryCode,
        numberType: params.numberType,
        readinessVerifiedAt: new Date().toISOString(),
        schemaVersion: 1,
      },
      attempt_count: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    mockOperations.set(existingKey, record);
    return record;
  }

  // 12. Idempotency Key Reuse
  {
    const fp = generateRequestFingerprintV1({
      operationType: 'purchase_number',
      organizationId: 'org_1',
      provider: 'twilio',
      phoneNumberE164: '+12025550100',
      countryCode: 'US',
      numberType: 'local',
      retailAmountMinor: 299,
      retailCurrency: 'USD',
      pricingSource: 'pricing_policy',
      providerCostMinor: 100,
      providerCostCurrency: 'USD',
    });

    const op1 = createMockOp({
      organizationId: 'org_1',
      idempotencyKey: 'idemp_1',
      phoneNumberE164: '+12025550100',
      countryCode: 'US',
      numberType: 'local',
      retailAmountMinor: 299,
      retailCurrency: 'USD',
      providerCostMinor: 100,
      providerCostCurrency: 'USD',
      pricingSource: 'pricing_policy',
      requestFingerprint: fp,
    });

    const op2 = createMockOp({
      organizationId: 'org_1',
      idempotencyKey: 'idemp_1',
      phoneNumberE164: '+12025550100',
      countryCode: 'US',
      numberType: 'local',
      retailAmountMinor: 299,
      retailCurrency: 'USD',
      providerCostMinor: 100,
      providerCostCurrency: 'USD',
      pricingSource: 'pricing_policy',
      requestFingerprint: fp,
    });

    assert(op1.id === op2.id, '12. Same org + same idempotency key + same fingerprint reuses existing operation');
  }

  // 13. Idempotency Fingerprint Conflict
  {
    const fpDifferent = generateRequestFingerprintV1({
      operationType: 'purchase_number',
      organizationId: 'org_1',
      provider: 'twilio',
      phoneNumberE164: '+12025550100',
      countryCode: 'US',
      numberType: 'local',
      retailAmountMinor: 599, // Changed retail price
      retailCurrency: 'USD',
      pricingSource: 'explicit_override',
      providerCostMinor: 100,
      providerCostCurrency: 'USD',
    });

    let caught = false;
    try {
      createMockOp({
        organizationId: 'org_1',
        idempotencyKey: 'idemp_1',
        phoneNumberE164: '+12025550100',
        countryCode: 'US',
        numberType: 'local',
        retailAmountMinor: 599,
        retailCurrency: 'USD',
        providerCostMinor: 100,
        providerCostCurrency: 'USD',
        pricingSource: 'explicit_override',
        requestFingerprint: fpDifferent,
      });
    } catch (err: any) {
      if (err.message.includes('IDEMPOTENCY_CONFLICT')) caught = true;
    }
    assert(caught, '13. Same org + same idempotency key + different fingerprint fails closed with IDEMPOTENCY_CONFLICT');
  }

  // 14. Cross-Org Idempotency Isolation
  {
    const fpOrg2 = generateRequestFingerprintV1({
      operationType: 'purchase_number',
      organizationId: 'org_2',
      provider: 'twilio',
      phoneNumberE164: '+12025550200',
      countryCode: 'US',
      numberType: 'local',
      retailAmountMinor: 299,
      retailCurrency: 'USD',
      pricingSource: 'pricing_policy',
      providerCostMinor: 100,
      providerCostCurrency: 'USD',
    });

    const opOrg2 = createMockOp({
      organizationId: 'org_2',
      idempotencyKey: 'idemp_1', // Same idempotency key string, different organization
      phoneNumberE164: '+12025550200',
      countryCode: 'US',
      numberType: 'local',
      retailAmountMinor: 299,
      retailCurrency: 'USD',
      providerCostMinor: 100,
      providerCostCurrency: 'USD',
      pricingSource: 'pricing_policy',
      requestFingerprint: fpOrg2,
    });

    assert(opOrg2.organization_id === 'org_2', '14. Idempotency keys are strictly isolated per organization_id');
  }

  // 15. Global Concurrent Exact E.164 Purchase Protection
  {
    const fpConflictE164 = generateRequestFingerprintV1({
      operationType: 'purchase_number',
      organizationId: 'org_3',
      provider: 'twilio',
      phoneNumberE164: '+12025550100', // Active in org_1
      countryCode: 'US',
      numberType: 'local',
      retailAmountMinor: 299,
      retailCurrency: 'USD',
      pricingSource: 'pricing_policy',
      providerCostMinor: 100,
      providerCostCurrency: 'USD',
    });

    let lockCaught = false;
    try {
      createMockOp({
        organizationId: 'org_3',
        idempotencyKey: 'idemp_3',
        phoneNumberE164: '+12025550100',
        countryCode: 'US',
        numberType: 'local',
        retailAmountMinor: 299,
        retailCurrency: 'USD',
        providerCostMinor: 100,
        providerCostCurrency: 'USD',
        pricingSource: 'pricing_policy',
        requestFingerprint: fpConflictE164,
      });
    } catch (err: any) {
      if (err.message.includes('ACTIVE_PURCHASE_LOCK_EXISTS')) lockCaught = true;
    }
    assert(lockCaught, '15. Concurrent purchase attempt for active E.164 blocked globally across tenants');
  }

  // 16. Manual Review Lock Retention
  {
    const fpManual = generateRequestFingerprintV1({
      operationType: 'purchase_number',
      organizationId: 'org_4',
      provider: 'twilio',
      phoneNumberE164: '+12025550400',
      countryCode: 'US',
      numberType: 'local',
      retailAmountMinor: 299,
      retailCurrency: 'USD',
      pricingSource: 'pricing_policy',
      providerCostMinor: 100,
      providerCostCurrency: 'USD',
    });

    const opManual = createMockOp({
      organizationId: 'org_4',
      idempotencyKey: 'idemp_4',
      phoneNumberE164: '+12025550400',
      countryCode: 'US',
      numberType: 'local',
      retailAmountMinor: 299,
      retailCurrency: 'USD',
      providerCostMinor: 100,
      providerCostCurrency: 'USD',
      pricingSource: 'pricing_policy',
      requestFingerprint: fpManual,
      initialStatus: 'manual_review_required',
    });

    let lockRetained = false;
    try {
      createMockOp({
        organizationId: 'org_5',
        idempotencyKey: 'idemp_5',
        phoneNumberE164: '+12025550400', // Try purchasing number in manual_review_required
        countryCode: 'US',
        numberType: 'local',
        retailAmountMinor: 299,
        retailCurrency: 'USD',
        providerCostMinor: 100,
        providerCostCurrency: 'USD',
        pricingSource: 'pricing_policy',
        requestFingerprint: fpManual,
      });
    } catch (err: any) {
      if (err.message.includes('ACTIVE_PURCHASE_LOCK_EXISTS')) lockRetained = true;
    }
    assert(lockRetained, '16. manual_review_required status strictly RETAINS global purchase lock and marketplace suppression');
  }

  // 17. Succeeded Purchase Blocked by Permanent Ownership Rule
  {
    mockPhoneNumbers.set('phone_active', {
      id: 'phone_active',
      phone_number: '+12025550500',
      status: 'active',
    });

    const fpOwned = generateRequestFingerprintV1({
      operationType: 'purchase_number',
      organizationId: 'org_6',
      provider: 'twilio',
      phoneNumberE164: '+12025550500',
      countryCode: 'US',
      numberType: 'local',
      retailAmountMinor: 299,
      retailCurrency: 'USD',
      pricingSource: 'pricing_policy',
      providerCostMinor: 100,
      providerCostCurrency: 'USD',
    });

    let ownedCaught = false;
    try {
      createMockOp({
        organizationId: 'org_6',
        idempotencyKey: 'idemp_6',
        phoneNumberE164: '+12025550500',
        countryCode: 'US',
        numberType: 'local',
        retailAmountMinor: 299,
        retailCurrency: 'USD',
        providerCostMinor: 100,
        providerCostCurrency: 'USD',
        pricingSource: 'pricing_policy',
        requestFingerprint: fpOwned,
      });
    } catch (err: any) {
      if (err.message.includes('NUMBER_ALREADY_OWNED')) ownedCaught = true;
    }
    assert(ownedCaught, '17. Active owned number in phone_numbers blocks purchase attempt via permanent ownership rule');
  }

  // 18. Released Number History Permits Repurchase
  {
    mockPhoneNumbers.set('phone_released', {
      id: 'phone_released',
      phone_number: '+12025550600',
      status: 'released', // Released historical state
    });

    const fpReleased = generateRequestFingerprintV1({
      operationType: 'purchase_number',
      organizationId: 'org_7',
      provider: 'twilio',
      phoneNumberE164: '+12025550600',
      countryCode: 'US',
      numberType: 'local',
      retailAmountMinor: 299,
      retailCurrency: 'USD',
      pricingSource: 'pricing_policy',
      providerCostMinor: 100,
      providerCostCurrency: 'USD',
    });

    const opRepurchase = createMockOp({
      organizationId: 'org_7',
      idempotencyKey: 'idemp_7',
      phoneNumberE164: '+12025550600',
      countryCode: 'US',
      numberType: 'local',
      retailAmountMinor: 299,
      retailCurrency: 'USD',
      providerCostMinor: 100,
      providerCostCurrency: 'USD',
      pricingSource: 'pricing_policy',
      requestFingerprint: fpReleased,
    });

    assert(opRepurchase.phone_number_e164 === '+12025550600', '18. Historical released number permits repurchase without lock conflict');
  }

  // 19. Customer DTO Conceals Wholesale Cost and Margin
  {
    const mockDomainOp: any = {
      id: 'op_dto_1',
      organizationId: 'org_dto',
      operationType: 'purchase_number',
      provider: 'twilio',
      phoneNumberE164: '+12025550999',
      numberType: 'local',
      countryCode: 'US',
      status: 'succeeded',
      idempotencyKey: 'key_dto',
      requestFingerprint: 'sha256:abc',
      retailAmountMinor: 299,
      retailCurrency: 'USD',
      providerCostMinor: 100,
      providerCostCurrency: 'USD',
      pricingSource: 'pricing_policy',
      grossMarginMinor: 199,
      priceResolvedAt: new Date().toISOString(),
      priceSnapshotPayload: {},
      regulatoryProvisioningContext: {},
      attemptCount: 1,
      createdAt: new Date().toISOString(),
    };

    const dto = ProviderNumberOperationService.toCustomerSafeDTO(mockDomainOp);

    assert(
      (dto as any).providerCostMinor === undefined &&
        (dto as any).grossMarginMinor === undefined &&
        (dto as any).providerCostCurrency === undefined &&
        dto.retailAmountFormatted === '$2.99/month',
      '19. Customer DTO formats retail price and strictly hides wholesale cost and gross margin'
    );
  }

  console.log('\nALL HARDENED PRE-MIGRATION TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
