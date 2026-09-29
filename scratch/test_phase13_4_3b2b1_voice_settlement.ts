import { VoiceSettlementService, ValidatedRateSnapshot } from '../src/lib/billing/telecom/voiceSettlementService';
import { TelecomWalletService } from '../src/lib/billing/telecomWalletService';
import { ExposurePolicy } from '../src/lib/billing/telecom/exposurePolicy';
import { TelecomRatingService } from '../src/lib/billing/telecom/telecomRatingService';

let totalTests = 0;
let passedTests = 0;

function assert(condition: boolean, description: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ ${description}`);
  } else {
    console.error(`  ✕ FAIL: ${description}`);
    throw new Error(`Assertion failed: ${description}`);
  }
}

async function runB2B1ExpandedTestPlan() {
  console.log('================================================================');
  console.log('PHASE 13.4.3B.2B.1 — EXPANDED FINANCIAL & IDENTITY DEFECT TEST SUITE');
  console.log('================================================================\n');

  // --- PART 1: CANONICAL RATING EQUIVALENCE MATRIX (DEFECT 1 & DEFECT 3 FIX) ---
  console.log('SECTION 1: Canonical Authorization vs Settlement Rating Equivalence Matrix');

  const rateMicro = 25200; // $0.0252 per increment

  // Matrix A: increment = 60s, min = 1
  const cardA = {
    id: 'c-a', rateCode: 'A', serviceType: 'voice_outbound', direction: 'outbound',
    destinationPattern: '+1', destinationName: 'US', retailRateMicro: rateMicro,
    unitType: 'minute', billingIncrementSeconds: 60, minChargeableUnits: 1, currency: 'USD',
    isActive: true, effectiveStartAt: new Date().toISOString(),
  } as any;

  for (const d of [1, 60, 61]) {
    const authExposure = TelecomRatingService.calculateEstimatedExposureMinor(cardA, d);
    const snapA: ValidatedRateSnapshot = { retailRateMicro: rateMicro, billingIncrementSeconds: 60, minChargeableUnits: 1, unitType: 'minute', currency: 'USD' };
    const settleCharge = VoiceSettlementService.calculateSettlementChargeMinor(snapA, d);
    assert(authExposure === settleCharge, `Matrix A (inc=60s, d=${d}s): Auth (${authExposure}¢) == Settlement (${settleCharge}¢)`);
  }

  // Matrix B: increment = 6s, min = 1
  const cardB = { ...cardA, billingIncrementSeconds: 6 };
  for (const d of [1, 6, 7, 10, 60]) {
    const authExposure = TelecomRatingService.calculateEstimatedExposureMinor(cardB, d);
    const snapB: ValidatedRateSnapshot = { retailRateMicro: rateMicro, billingIncrementSeconds: 6, minChargeableUnits: 1, unitType: 'minute', currency: 'USD' };
    const settleCharge = VoiceSettlementService.calculateSettlementChargeMinor(snapB, d);
    assert(authExposure === settleCharge, `Matrix B (inc=6s, d=${d}s): Auth (${authExposure}¢) == Settlement (${settleCharge}¢)`);
  }

  // Matrix C: increment = 30s, min = 2
  const cardC = { ...cardA, billingIncrementSeconds: 30, minChargeableUnits: 2 };
  for (const d of [1, 30, 31, 60, 61]) {
    const authExposure = TelecomRatingService.calculateEstimatedExposureMinor(cardC, d);
    const snapC: ValidatedRateSnapshot = { retailRateMicro: rateMicro, billingIncrementSeconds: 30, minChargeableUnits: 2, unitType: 'minute', currency: 'USD' };
    const settleCharge = VoiceSettlementService.calculateSettlementChargeMinor(snapC, d);
    assert(authExposure === settleCharge, `Matrix C (inc=30s, min=2, d=${d}s): Auth (${authExposure}¢) == Settlement (${settleCharge}¢)`);
  }

  // Non-divisible integer rateMicro case: rateMicro = 25,201 per min, increment = 6
  console.log('\nSECTION 2: Pure Integer Arithmetic & Non-Divisible Micro-Units');
  const snapNonDivisible: ValidatedRateSnapshot = { retailRateMicro: 25201, billingIncrementSeconds: 6, minChargeableUnits: 1, unitType: 'minute', currency: 'USD' };
  // 60s duration (1 min): 25,201 micro -> ceil(25201 / 10000) = 3 cents ($0.03)
  const chargeNonDivisible = VoiceSettlementService.calculateSettlementChargeMinor(snapNonDivisible, 60);
  assert(chargeNonDivisible === 3, 'Non-divisible rateMicro (25,201 micro/min) calculates strictly to 3 cents with zero float loss');


  // --- PART 2: RATE SNAPSHOT CONTRADICTION TESTS (DEFECT 4 FIX) ---
  console.log('\nSECTION 3: Rate Snapshot Contradiction & Edge Case Validation');

  // RateMicro only
  const sOnlyRateMicro = VoiceSettlementService.validateRateSnapshot({ rateMicro: 25200 }, 'USD');
  assert(sOnlyRateMicro !== null && sOnlyRateMicro.retailRateMicro === 25200, 'Snapshot with rateMicro only is accepted');

  // RetailRateMicro only
  const sOnlyRetailRateMicro = VoiceSettlementService.validateRateSnapshot({ retailRateMicro: 25200 }, 'USD');
  assert(sOnlyRetailRateMicro !== null && sOnlyRetailRateMicro.retailRateMicro === 25200, 'Snapshot with retailRateMicro only is accepted');

  // Both equal
  const sBothEqual = VoiceSettlementService.validateRateSnapshot({ rateMicro: 25200, retailRateMicro: 25200 }, 'USD');
  assert(sBothEqual !== null && sBothEqual.retailRateMicro === 25200, 'Snapshot with rateMicro === retailRateMicro is accepted');

  // Both DIFFERENT -> FAIL CLOSED!
  const sBothDifferent = VoiceSettlementService.validateRateSnapshot({ rateMicro: 25200, retailRateMicro: 30000 }, 'USD');
  assert(sBothDifferent === null, 'Snapshot with CONTRADICTORY rateMicro !== retailRateMicro FAILS CLOSED (returns null)');

  // Missing / Wrong Currency
  assert(VoiceSettlementService.validateRateSnapshot({ retailRateMicro: 25200, currency: 'EUR' }, 'USD') === null, 'Currency mismatch fails validation');

  // Invalid increment
  assert(VoiceSettlementService.validateRateSnapshot({ retailRateMicro: 25200, billingIncrementSeconds: 0 }, 'USD') === null, 'Zero increment fails validation');
  assert(VoiceSettlementService.validateRateSnapshot({ retailRateMicro: 25200, billingIncrementSeconds: -6 }, 'USD') === null, 'Negative increment fails validation');

  // Invalid unitType
  assert(VoiceSettlementService.validateRateSnapshot({ retailRateMicro: 25200, unitType: 'invalid' }, 'USD') === null, 'Invalid unitType fails validation');


  // --- PART 3: CHILD & PARENT CALLSID IDENTITY TESTS (DEFECT 2 FIX) ---
  console.log('\nSECTION 4: Child & Parent CallSid Write-Once Identity Validation');

  const createMockIdentityDb = (initialComponent: any = null, initialReservation: any = null) => {
    const dbState = {
      component: initialComponent,
      reservation: initialReservation,
      settled: false,
      released: false,
      manualReviewMarked: false,
    };

    const client: any = {
      from: (table: string) => {
        if (table === 'telecom_usage_reservations') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: dbState.reservation, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === 'telecom_usage_components') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: dbState.component, error: null }),
                }),
              }),
            }),
            update: (payload: any) => ({
              eq: () => ({
                eq: async () => {
                  if (payload.child_provider_resource_id) {
                    if (!dbState.component) dbState.component = {};
                    dbState.component.child_provider_resource_id = payload.child_provider_resource_id;
                  }
                  if (payload.parent_provider_resource_id) {
                    if (!dbState.component) dbState.component = {};
                    dbState.component.parent_provider_resource_id = payload.parent_provider_resource_id;
                  }
                  return { data: null, error: null };
                },
              }),
            }),
          };
        }
        if (table === 'telecom_usage_sessions') {
          return {
            update: (payload: any) => ({
              eq: () => ({
                eq: async () => {
                  if (payload.reconciliation_status === 'manual_review') {
                    dbState.manualReviewMarked = true;
                  }
                  return { data: null, error: null };
                },
              }),
            }),
          };
        }
        return {};
      },
      rpc: async (rpcName: string, args: any) => {
        if (rpcName === 'link_telecom_child_provider_resource_atomic') {
          const comp = dbState.component;
          if (!comp) {
            return { data: null, error: { message: 'COMPONENT_NOT_FOUND' } };
          }
          if (comp.child_provider_resource_id && comp.child_provider_resource_id !== args.p_child_provider_resource_id) {
            return { data: null, error: { message: 'CHILD_CALLSID_MISMATCH' } };
          }
          if (comp.parent_provider_resource_id && args.p_parent_provider_resource_id && comp.parent_provider_resource_id !== args.p_parent_provider_resource_id) {
            return { data: null, error: { message: 'PARENT_CALLSID_MISMATCH' } };
          }
          let outcome = 'idempotent_match';
          if (!comp.child_provider_resource_id) {
            comp.child_provider_resource_id = args.p_child_provider_resource_id;
            outcome = 'linked';
          }
          if (!comp.parent_provider_resource_id && args.p_parent_provider_resource_id) {
            comp.parent_provider_resource_id = args.p_parent_provider_resource_id;
          }
          return { data: { outcome, child_provider_resource_id: comp.child_provider_resource_id }, error: null };
        }
        if (rpcName === 'settle_telecom_usage_reservation_atomic') {
          dbState.settled = true;
          return { data: { success: true, is_duplicate: false, settlement_ledger_id: 'l-1' }, error: null };
        }
        if (rpcName === 'release_telecom_usage_reservation_atomic') {
          dbState.released = true;
          return { data: { success: true, is_duplicate: false }, error: null };
        }
        return { data: null, error: null };
      },
    };

    return { client, dbState };
  };

  const stdRes = { id: 'res-id', organization_id: 'org-1', internal_usage_id: 'call:outbound:c1', status: 'active', currency: 'USD', rate_snapshot: { retailRateMicro: 25200, billingIncrementSeconds: 60, minChargeableUnits: 1, unitType: 'minute', currency: 'USD' } };

  // 1. Unlinked child + valid callback => links ONCE
  const dbUnlinked = createMockIdentityDb({ component_id: 'comp:pstn_outbound:c1', child_provider_resource_id: null }, stdRes);
  const resLink = await VoiceSettlementService.processChildStatusCallback(dbUnlinked.client, {
    organizationId: 'org-1', dbCallId: 'c1', callSid: 'CA_CHILD_100', callStatus: 'completed', callDurationStr: '60',
  });
  assert(resLink.success && resLink.settled, '1. Unlinked child CallSid links cleanly and settles');
  assert(dbUnlinked.dbState.component.child_provider_resource_id === 'CA_CHILD_100', '1b. child_provider_resource_id written to component');

  // 2. Linked same child => allowed (Idempotent duplicate)
  const dbLinkedSame = createMockIdentityDb({ component_id: 'comp:pstn_outbound:c1', child_provider_resource_id: 'CA_CHILD_100' }, stdRes);
  const resSame = await VoiceSettlementService.processChildStatusCallback(dbLinkedSame.client, {
    organizationId: 'org-1', dbCallId: 'c1', callSid: 'CA_CHILD_100', callStatus: 'completed', callDurationStr: '60',
  });
  assert(resSame.success && resSame.settled, '2. Callback with matching linked child CallSid is ALLOWED');

  // 3. Linked DIFFERENT child => FAIL CLOSED!
  const dbLinkedDiff = createMockIdentityDb({ component_id: 'comp:pstn_outbound:c1', child_provider_resource_id: 'CA_CHILD_100' }, stdRes);
  const resDiff = await VoiceSettlementService.processChildStatusCallback(dbLinkedDiff.client, {
    organizationId: 'org-1', dbCallId: 'c1', callSid: 'CA_ATTACKER_999', callStatus: 'completed', callDurationStr: '60',
  });
  assert(!resDiff.success && resDiff.reconciliationRequired && resDiff.reason === 'CHILD_CALLSID_MISMATCH', '3. Callback with CONFLICTING child CallSid FAILS CLOSED with CHILD_CALLSID_MISMATCH');
  assert(!dbLinkedDiff.dbState.settled, '4. Mismatched child CallSid produces ZERO debit');

  // 5 & 6. Wrong child + busy/0s => reservation NOT released!
  const dbBusyDiff = createMockIdentityDb({ component_id: 'comp:pstn_outbound:c1', child_provider_resource_id: 'CA_CHILD_100' }, stdRes);
  const resBusyDiff = await VoiceSettlementService.processChildStatusCallback(dbBusyDiff.client, {
    organizationId: 'org-1', dbCallId: 'c1', callSid: 'CA_ATTACKER_999', callStatus: 'busy',
  });
  assert(!resBusyDiff.success && !dbBusyDiff.dbState.released, '5. Mismatched child CallSid + busy DOES NOT release reservation');

  const db0sDiff = createMockIdentityDb({ component_id: 'comp:pstn_outbound:c1', child_provider_resource_id: 'CA_CHILD_100' }, stdRes);
  const res0sDiff = await VoiceSettlementService.processChildStatusCallback(db0sDiff.client, {
    organizationId: 'org-1', dbCallId: 'c1', callSid: 'CA_ATTACKER_999', callStatus: 'completed', callDurationStr: '0',
  });
  assert(!res0sDiff.success && !db0sDiff.dbState.released, '6. Mismatched child CallSid + 0s completed DOES NOT release reservation');

  // 7. Correct child + WRONG parent => FAIL CLOSED!
  const dbParentDiff = createMockIdentityDb({ component_id: 'comp:pstn_outbound:c1', child_provider_resource_id: 'CA_CHILD_100', parent_provider_resource_id: 'CA_PARENT_REAL' }, stdRes);
  const resParentDiff = await VoiceSettlementService.processChildStatusCallback(dbParentDiff.client, {
    organizationId: 'org-1', dbCallId: 'c1', callSid: 'CA_CHILD_100', parentCallSid: 'CA_PARENT_FAKE', callStatus: 'completed', callDurationStr: '60',
  });
  assert(!resParentDiff.success && resParentDiff.reason === 'PARENT_CALLSID_MISMATCH', '7. Conflicting parent CallSid FAILS CLOSED with PARENT_CALLSID_MISMATCH');

  // 8. Correct child + CORRECT parent => ALLOWED
  const dbParentSame = createMockIdentityDb({ component_id: 'comp:pstn_outbound:c1', child_provider_resource_id: 'CA_CHILD_100', parent_provider_resource_id: 'CA_PARENT_REAL' }, stdRes);
  const resParentSame = await VoiceSettlementService.processChildStatusCallback(dbParentSame.client, {
    organizationId: 'org-1', dbCallId: 'c1', callSid: 'CA_CHILD_100', parentCallSid: 'CA_PARENT_REAL', callStatus: 'completed', callDurationStr: '60',
  });
  assert(resParentSame.success && resParentSame.settled, '8. Matching parent CallSid + matching child CallSid is ALLOWED');


  console.log('\n================================================================');
  console.log(`EXPANDED B.2B.1 TEST SUITE PASSED: ${passedTests} / ${totalTests} assertions verified clean.`);
  console.log('================================================================\n');
}

runB2B1ExpandedTestPlan().catch((err) => {
  console.error('[Expanded B.2B.1 Test Suite Failed]:', err);
  process.exit(1);
});
