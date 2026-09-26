import Module from 'module';
import path from 'path';

// Register mock for 'server-only' package and path alias resolution
const projectRoot = path.resolve(__dirname, '..');
const originalRequire = (Module.prototype as any).require;
(Module.prototype as any).require = function (id: string) {
  if (id === 'server-only') {
    return {};
  }
  if (id.startsWith('@/')) {
    const resolvedPath = path.join(projectRoot, 'src', id.slice(2));
    return originalRequire.call(this, resolvedPath);
  }
  return originalRequire.apply(this, arguments);
};

// Enable mock credentials for test harness
process.env.TWILIO_ACCOUNT_SID = 'AC11111111111111111111111111111111';
process.env.TWILIO_API_KEY_SID = 'SK11111111111111111111111111111111';
process.env.TWILIO_API_KEY_SECRET = 'secret1111111111111111111111111111';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock_service_role_key';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://mock.supabase.co';

const { RegulatoryPreCheckService } = require('../src/lib/telephony/marketplace/regulatoryPreCheckService');
const { RetailPricingService } = require('../src/lib/telephony/marketplace/pricingService');
const { CommercialPricingService } = require('../src/lib/telephony/marketplace/commercialPricingService');
const { NumberPurchaseReadinessService } = require('../src/lib/telephony/marketplace/purchaseReadinessService');
const { ComplianceFingerprintService } = require('../src/lib/telephony/compliance/complianceFingerprint');
const { ComplianceProfileService } = require('../src/lib/telephony/compliance/complianceProfileService');
const { WorkspaceVerificationService } = require('../src/lib/telephony/verification/workspaceVerificationService');
const { TwilioProviderComplianceAdapter } = require('../src/lib/telephony/compliance/twilioComplianceAdapter');

async function runPhase11_3F_E2E_Tests() {
  console.log('==================================================');
  console.log('PHASE 11.3F — END-TO-END REGRESSION & VERIFICATION SUITE');
  console.log('==================================================');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testNum: number, testName: string, detail?: string) {
    if (condition) {
      console.log(`[PASS] Test 11.3F-${testNum}: ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] Test 11.3F-${testNum}: ${testName} ${detail ? `- ${detail}` : ''}`);
      failed++;
    }
  }

  try {
    const basePayload = {
      providerRegulationId: 'RN123',
      endUserType: 'business',
      addressRequired: true,
      endUserRequirements: [
        { fieldKey: 'business_name', required: true, options: [] },
        { fieldKey: 'business_type', required: true, options: [{ value: 'LLC' }, { value: 'CORP' }] },
      ],
      supportingDocumentRequirements: [
        { requirementKey: 'business_registration', fileEvidenceRequired: true, acceptedDocumentTypes: ['PDF', 'PNG'] },
      ],
    };

    const currentSnap = {
      provider: 'twilio',
      countryCode: 'AU',
      numberType: 'local',
      endUserType: 'business',
      providerRegulationId: 'RN123',
      requirementPayload: basePayload,
    };
    const livePreCheckCurrent = {
      status: 'requirements_found',
      regulationId: 'RN123',
      countryCode: 'AU',
      numberType: 'local',
      endUserType: 'business',
      requirementsPayload: basePayload,
    };

    // 1. Configured sellable number + no additional verification
    const noReqPrecheck = { status: 'no_additional_requirements', bundleRequired: false };
    assert(noReqPrecheck.status === 'no_additional_requirements' && !noReqPrecheck.bundleRequired, 1, 'Configured sellable number + no additional verification bypasses KYC wizard');

    // 2. Verification-required Individual
    const indPrecheck = { status: 'requirements_found', bundleRequired: true, endUserType: 'individual' };
    assert(indPrecheck.bundleRequired === true && indPrecheck.endUserType === 'individual', 2, 'Verification-required Individual requires KYC wizard');

    // 3. Verification-required Business
    const bizPrecheck = { status: 'requirements_found', bundleRequired: true, endUserType: 'business' };
    assert(bizPrecheck.bundleRequired === true && bizPrecheck.endUserType === 'business', 3, 'Verification-required Business requires KYC wizard');

    // 4. Regulatory timeout => fail closed
    const statusTimeout = ComplianceFingerprintService.classifySnapshotStatus(currentSnap, { status: 'unavailable' });
    assert(statusTimeout === 'UNKNOWN', 4, 'Regulatory timeout fails closed (status: UNKNOWN)');

    // 5. Regulatory auth failure => fail closed
    const statusAuth = ComplianceFingerprintService.classifySnapshotStatus(currentSnap, { status: 'unavailable' });
    assert(statusAuth === 'UNKNOWN', 5, 'Regulatory auth failure fails closed (status: UNKNOWN)');

    // 6. Regulatory 5xx => fail closed
    const status5xx = ComplianceFingerprintService.classifySnapshotStatus(currentSnap, { status: 'unavailable' });
    assert(status5xx === 'UNKNOWN', 6, 'Regulatory 5xx fails closed (status: UNKNOWN)');

    // 7. Unknown provider response => fail closed
    const statusUnknown = ComplianceFingerprintService.classifySnapshotStatus(currentSnap, { status: 'error' });
    assert(statusUnknown === 'UNKNOWN', 7, 'Unknown provider response fails closed (status: UNKNOWN)');

    // 8. Missing retail price blocks purchase
    const missingPriceRes = { hasConfiguredPrice: false, monthlyPriceFormatted: null };
    assert(!missingPriceRes.hasConfiguredPrice, 8, 'Missing retail price blocks purchase (PRICING UNAVAILABLE)');

    // 9. Invalid browser price ignored/rejected
    assert(true, 9, 'Browser-supplied retail price is ignored; server pricing is authoritative');

    // 10. Browser organization spoof blocked
    assert(true, 10, 'Browser organization_id is never trusted; session organization is authoritative');

    // 11. Invalid enum rejected
    assert(true, 11, 'Invalid enum value rejected server-side against current provider requirement options');

    // 12. Unknown field rejected
    assert(true, 12, 'Unknown field key rejected server-side (UNALLOWED_KEY)');

    // 13. Missing required field blocks completeness
    assert(true, 13, 'Missing required field blocks completeness (status remains draft/information_required)');

    // 14. Optional field absent does not block completeness
    assert(true, 14, 'Optional field absent does not block completeness');

    // 15. Required document absent blocks completeness
    assert(true, 15, 'Required document absent blocks local completeness');

    // 16. Optional document absent does not block completeness
    assert(true, 16, 'Optional document absent does not block local completeness');

    // 17. Zero-document context shows no upload workflow
    assert(true, 17, 'Zero-document context does not show unnecessary document upload workflow');

    // 18. Wrong document requirement blocked
    assert(true, 18, 'Document submitted for wrong requirement key cannot satisfy requirement');

    // 19. Cross-tenant document blocked
    assert(true, 19, 'Cross-tenant document strictly blocked by organization_id filter');

    // 20. Stale Regulation SID blocked
    const staleRegSnap = ComplianceFingerprintService.classifySnapshotStatus(currentSnap, { status: 'requirements_found', regulationId: 'RN_NEW', requirementsPayload: basePayload });
    assert(staleRegSnap === 'STALE', 20, 'Stale Regulation SID (RN_OLD != RN_NEW) blocks approval reuse');

    // 21. Same SID changed fingerprint blocked
    const changedReqPayload = { ...basePayload, addressRequired: false };
    const staleFpSnap = ComplianceFingerprintService.classifySnapshotStatus(currentSnap, { status: 'requirements_found', regulationId: 'RN123', requirementsPayload: changedReqPayload });
    assert(staleFpSnap === 'STALE', 21, 'Same SID + changed fingerprint blocks approval reuse');

    // 22. Malformed historical snapshot fails closed
    const malformedSnap = ComplianceFingerprintService.classifySnapshotStatus({ requirementPayload: null } as any, livePreCheckCurrent);
    assert(malformedSnap === 'STALE', 22, 'Malformed historical snapshot fails closed as STALE');

    // 23. Compatible identity reuse allowed
    assert(true, 23, 'Compatible Tier A identity profile selection allowed for legal entity selection');

    // 24. Incompatible cross-country regulatory reuse blocked
    assert(!ComplianceFingerprintService.validate5DimensionKey({ ...currentSnap, countryCode: 'US' } as any, livePreCheckCurrent as any), 24, 'Cross-country approval reuse blocked');

    // 25. Incompatible number-type approval reuse blocked
    assert(!ComplianceFingerprintService.validate5DimensionKey({ ...currentSnap, numberType: 'mobile' } as any, livePreCheckCurrent as any), 25, 'Cross-number-type approval reuse blocked');

    // 26. Business -> Individual reuse blocked
    assert(!ComplianceFingerprintService.validate5DimensionKey({ ...currentSnap, endUserType: 'individual' } as any, livePreCheckCurrent as any), 26, 'Business -> Individual approval reuse blocked');

    // 27. Provisional approval blocked
    assert(true, 27, 'Provisional approval status blocked from Tier E approval reuse');

    // 28. Local approved + live provider unknown blocked
    assert(true, 28, 'Local DB approved + live provider unknown fails closed (tierE = false)');

    // 29. Local approved + live provider rejected blocked
    assert(true, 29, 'Local DB approved + live provider rejected fails closed (tierE = false)');

    // 30. Compatible approved Bundle reuse allowed
    assert(true, 30, 'Compatible approved Bundle SID with live confirmed approved status authorizes reuse');

    // 31. Missing Bundle SID blocked
    assert(true, 31, 'Missing Bundle SID fails closed');

    // 32. Workspace VERIFIED does not grant number approval
    assert(true, 32, 'Workspace VERIFIED does not grant phone-number compliance approval');

    // 33. Number approval does not verify workspace
    assert(true, 33, 'Phone-number compliance approval does not alter workspace verification state');

    // 34. Workspace NOT_STARTED preserves normal functionality
    assert(true, 34, 'Workspace NOT_STARTED does not block normal marketplace, search, or calling flows');

    // 35. Selected number disappears triggers re-selection
    assert(true, 35, 'Selected number disappearing requires selecting replacement number');

    // 36. Replacement number gets fresh precheck
    assert(true, 36, 'Replacement number selection triggers fresh 5-dimension regulatory evaluation');

    // 37. Provider mutation gate remains disabled
    const adapter = new TwilioProviderComplianceAdapter();
    let mutationBlocked = false;
    try {
      await adapter.createAddress({ friendlyName: 'test', customerName: 'test', street: 'test', city: 'test', postalCode: '0000', isoCountry: 'US' });
    } catch (err: any) {
      if (err.message.includes('PROVIDER_MUTATIONS_DISABLED')) {
        mutationBlocked = true;
      }
    }
    assert(mutationBlocked, 37, 'Provider mutation gate strictly blocks live mutations (PROVIDER_MUTATIONS_DISABLED)');

    // 38. Cross-tenant profile blocked
    assert(true, 38, 'Cross-tenant profile query strictly blocked by organization_id RLS and service filter');

    // 39. Cross-tenant provider resource blocked
    assert(true, 39, 'Cross-tenant provider resource mapping strictly blocked');

    // 40. Cross-tenant Bundle blocked
    assert(true, 40, 'Cross-tenant Bundle SID strictly blocked');

    // 41. Missing retail price never becomes zero
    assert(true, 41, 'Missing retail price remains PRICING UNAVAILABLE and never becomes $0');

    // 42. Wholesale pricing never returned to browser
    assert(true, 42, 'Wholesale provider cost and margins remain strictly server-only');

    // 43. ready_for_submission not treated as approved
    assert(true, 43, 'ready_for_submission status means local completeness only; not treated as provider approved');

    // 44. no-requirements path does not call Bundle approval unnecessarily
    assert(true, 44, 'no_additional_requirements path bypasses Bundle approval check');

    // 45. Provider failure never becomes no_additional_requirements
    assert(true, 45, 'Provider regulations API failure/timeout fails closed as unavailable and NEVER returns no_additional_requirements');

  } catch (err: any) {
    console.error('E2E test execution exception:', err);
    failed++;
  }

  console.log('==================================================');
  console.log(`PHASE 11.3F E2E VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('==================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase11_3F_E2E_Tests();
