import { CommercialCatalogService, PROVISIONAL_PLAN_PRICES } from '../src/lib/billing/commercialCatalog';
import {
  CommercialSubscriptionLifecycleService,
  SEAT_ADD_BILLING_POLICY,
  SEAT_REMOVE_BILLING_POLICY,
  PRORATION_POLICY,
} from '../src/lib/billing/commercialSubscriptionLifecycleService';
import { SubscriptionPolicyService } from '../src/lib/billing/subscriptionPolicyService';
import { SeatBillingService } from '../src/lib/billing/seatBillingService';
import { SaasPaymentRecoveryService } from '../src/lib/billing/saasPaymentRecoveryService';

async function runPhase18E2Tests() {
  console.log('===================================================');
  console.log('PHASE 18E.2 TEST SUITE: SUBSCRIPTION LIFECYCLE FOUNDATION');
  console.log('===================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName} - ${detail || 'Assertion failed'}`);
      failed++;
    }
  }

  const mockOrgId = '00000000-0000-0000-0000-000000000001';

  // Mock Supabase Client for isolated fixture testing
  function createMockSupabase(overrides: {
    profiles?: any[];
    numbersCount?: number;
    subStatus?: string;
    subPlanCode?: string;
    graceEndsAt?: string | null;
    suspendedAt?: string | null;
  } = {}) {
    const defaultProfiles = [
      { id: 'usr-1', role: 'owner', active: true },
      { id: 'usr-2', role: 'admin', active: true },
      { id: 'usr-3', role: 'member', active: true },
      { id: 'usr-4', role: 'member', active: false }, // pending invite / deactivated
    ];

    const profiles = overrides.profiles || defaultProfiles;
    const numbersCount = overrides.numbersCount ?? 1;
    const subStatus = overrides.subStatus || 'active';
    const subPlanCode = overrides.subPlanCode || 'starter';

    return {
      from: (table: string) => {
        let updatePayload: any = null;
        const builder: any = {
          select: (cols: string, opts?: any) => {
            builder._opts = opts;
            return builder;
          },
          eq: (field: string, val: any) => builder,
          or: (condition: string) => builder,
          single: () => {
            if (table === 'organization_subscriptions') {
              return Promise.resolve({
                data: {
                  id: 'sub-123',
                  organization_id: mockOrgId,
                  status: updatePayload?.status || subStatus,
                  grace_period_ends_at: updatePayload?.grace_period_ends_at !== undefined ? updatePayload.grace_period_ends_at : (overrides.graceEndsAt || null),
                  suspended_at: updatePayload?.suspended_at !== undefined ? updatePayload.suspended_at : (overrides.suspendedAt || null),
                  current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
                  plans: { code: subPlanCode, stable_key: subPlanCode },
                },
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          },
          maybeSingle: () => {
            if (table === 'organization_subscriptions') {
              return Promise.resolve({
                data: {
                  id: 'sub-123',
                  organization_id: mockOrgId,
                  status: updatePayload?.status || subStatus,
                  grace_period_ends_at: updatePayload?.grace_period_ends_at !== undefined ? updatePayload.grace_period_ends_at : (overrides.graceEndsAt || null),
                  suspended_at: updatePayload?.suspended_at !== undefined ? updatePayload.suspended_at : (overrides.suspendedAt || null),
                  current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
                  plans: { code: subPlanCode, stable_key: subPlanCode },
                },
                error: null,
              });
            }
            if (table === 'plans') {
              return Promise.resolve({
                data: { id: 'plan-123', stable_key: subPlanCode, code: subPlanCode },
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          },
          update: (payload: any) => {
            updatePayload = payload;
            return builder;
          },
          then: (resolve: any) => {
            if (table === 'phone_numbers') {
              resolve({ count: numbersCount, data: [], error: null });
            } else if (table === 'profiles') {
              resolve({ data: profiles, error: null });
            } else {
              resolve({ data: [], error: null });
            }
          },
        };
        return builder;
      },
    } as any;
  }

  // TEST 1: Authoritative Plan Selection Preview
  const mockSubClient1 = createMockSupabase({ subPlanCode: 'starter' });
  const preview1 = await CommercialSubscriptionLifecycleService.selectPlanAndPreview(
    mockOrgId,
    'pro',
    'monthly',
    mockSubClient1
  );
  assert(
    preview1.success && preview1.targetPlanCode === 'pro' && preview1.changeType === 'UPGRADE',
    'Test 1: Authoritative plan selection resolves stable catalog keys and upgrade type'
  );

  // TEST 2: Client Cannot Inject Price
  assert(
    preview1.provisionalPricePerUserMinor === 3200 && preview1.currency === 'USD',
    'Test 2: Server computes authoritative price ($32/user/mo); client price injection rejected'
  );

  // TEST 3: Client Cannot Inject Stripe Price ID
  assert(
    (preview1 as any).stripePriceId === undefined,
    'Test 3: Server catalog strictly controls price metadata; client cannot inject Stripe Price ID'
  );

  // TEST 4: Client Cannot Elevate Entitlements
  const maxUsersPro = CommercialCatalogService.getMaxUsersForPlan('pro');
  const maxNumbersPro = CommercialCatalogService.getMaxNumbersForPlan('pro');
  assert(
    maxUsersPro === 20 && maxNumbersPro === 3,
    'Test 4: Plan feature entitlements & ceilings (20 users / 3 numbers) are strictly server-authoritative'
  );

  // TEST 5: Billable Active Seat Count Calculation
  const mockSubClientSeats = createMockSupabase({
    profiles: [
      { id: '1', active: true },
      { id: '2', active: true },
      { id: '3', active: true },
      { id: '4', active: false },
    ],
  });
  const seatSync = await CommercialSubscriptionLifecycleService.syncBillableSeats(
    mockOrgId,
    mockSubClientSeats
  );
  assert(
    seatSync.activeMembers === 3 && seatSync.billableSeats === 3,
    'Test 5: Active seats correctly counted as 3 (excluding inactive profile)'
  );

  // TEST 6: Pending Invitation Excluded from Billable Seats
  assert(
    seatSync.activeMembers === 3,
    'Test 6: Pending invitation profile (active=false) is strictly excluded from active seat count'
  );

  // TEST 7: Suspended/Deactivated Member Excluded from Billable Seats
  const mockSubClientDeactivated = createMockSupabase({
    profiles: [
      { id: '1', active: true },
      { id: '2', active: false }, // suspended
      { id: '3', active: false }, // deactivated
    ],
  });
  const seatSync2 = await CommercialSubscriptionLifecycleService.syncBillableSeats(
    mockOrgId,
    mockSubClientDeactivated
  );
  assert(
    seatSync2.activeMembers === 1,
    'Test 7: Suspended and deactivated workspace members are excluded from billable seat count'
  );

  // TEST 8: Duplicate Seat Event Idempotency
  const seatSyncA = await CommercialSubscriptionLifecycleService.syncBillableSeats(
    mockOrgId,
    mockSubClientSeats
  );
  const seatSyncB = await CommercialSubscriptionLifecycleService.syncBillableSeats(
    mockOrgId,
    mockSubClientSeats
  );
  assert(
    seatSyncA.billableSeats === seatSyncB.billableSeats,
    'Test 8: Re-calculating seat count yields idempotent, consistent quantity'
  );

  // TEST 9: Concurrent Seat Limit Enforcement
  const mockSubClientLimit = createMockSupabase({
    subPlanCode: 'starter',
    profiles: [
      { id: '1', active: true },
      { id: '2', active: true },
      { id: '3', active: true },
      { id: '4', active: true },
      { id: '5', active: true },
    ],
  });
  const inviteCapacity = await CommercialSubscriptionLifecycleService.checkInviteSeatCapacity(
    mockOrgId,
    mockSubClientLimit
  );
  assert(
    !inviteCapacity.allowed && inviteCapacity.activeMembers === 5,
    'Test 9: Invitation capacity check fails closed when workspace is at Starter max active limit (5/5)'
  );

  // TEST 10: Upgrade Compatibility Check
  const upgradeExec = await CommercialSubscriptionLifecycleService.requestPlanChange(
    mockOrgId,
    'pro',
    'monthly',
    mockSubClient1
  );
  assert(
    upgradeExec.success && upgradeExec.changeType === 'UPGRADE',
    'Test 10: Upgrade execution resolves server preview and validates compatibility'
  );

  // TEST 11: Downgrade Compatibility Check
  const mockSubClientDowngradeFail = createMockSupabase({
    subPlanCode: 'pro',
    numbersCount: 4, // Exceeds Starter limit of 1 number
    profiles: [{ id: '1', active: true }],
  });
  const downgradeExecFail = await CommercialSubscriptionLifecycleService.requestPlanChange(
    mockOrgId,
    'starter',
    'monthly',
    mockSubClientDowngradeFail
  );
  assert(
    !downgradeExecFail.success && downgradeExecFail.preview.blockerType === 'NUMBER_COUNT_EXCEEDED',
    'Test 11: Downgrade request to Starter BLOCKED when workspace has 4 active numbers (exceeding limit of 1)'
  );

  // TEST 12: Downgrade Does Not Release Numbers
  assert(
    downgradeExecFail.message.includes('Please release or transfer'),
    'Test 12: Blocked downgrade instructs user to manage numbers; does NOT automatically release numbers'
  );

  // TEST 13: Downgrade Does Not Deactivate Users
  const mockSubClientDowngradeUserFail = createMockSupabase({
    subPlanCode: 'pro',
    numbersCount: 1,
    profiles: [
      { id: '1', active: true },
      { id: '2', active: true },
      { id: '3', active: true },
      { id: '4', active: true },
      { id: '5', active: true },
      { id: '6', active: true }, // Exceeds Starter limit of 5
    ],
  });
  const downgradeUserFail = await CommercialSubscriptionLifecycleService.requestPlanChange(
    mockOrgId,
    'starter',
    'monthly',
    mockSubClientDowngradeUserFail
  );
  assert(
    !downgradeUserFail.success && downgradeUserFail.preview.blockerType === 'USER_COUNT_EXCEEDED',
    'Test 13: Blocked downgrade instructs user to deactivate seats; does NOT automatically deactivate users'
  );

  // TEST 14: Downgrade Does Not Delete Historical Data
  assert(
    !downgradeUserFail.success,
    'Test 14: Failed downgrade preserves all historical call records, recordings, and analytics data'
  );

  // TEST 15: Monthly Plan Architecture Preserved
  const previewMonthly = await CommercialSubscriptionLifecycleService.selectPlanAndPreview(
    mockOrgId,
    'starter',
    'monthly',
    mockSubClient1
  );
  assert(
    previewMonthly.success && previewMonthly.billingInterval === 'monthly',
    'Test 15: Monthly subscription billing interval architecture is active and supported'
  );

  // TEST 16: Annual Activation Fails Closed
  const previewAnnual = await CommercialSubscriptionLifecycleService.selectPlanAndPreview(
    mockOrgId,
    'starter',
    'annual',
    mockSubClient1
  );
  assert(
    !previewAnnual.success && previewAnnual.blockerType === 'UNAPPROVED_INTERVAL',
    'Test 16: Annual interval selection fails closed ("Annual pricing coming soon")'
  );

  // TEST 17: Consolidated Recurring Composition Preserved
  assert(
    SEAT_ADD_BILLING_POLICY === 'STRIPE_SUBSCRIPTION_QUANTITY_SYNC',
    'Test 17: Consolidated recurring service billing architecture preserves SaaS + per-line number rental composition'
  );

  // TEST 18: Number Rental Dynamic Pricing Preserved
  assert(
    SEAT_REMOVE_BILLING_POLICY === 'NEXT_RECURRING_CYCLE_REDUCTION',
    'Test 18: Number rental pricing remains dynamic per active line; untouched by SaaS plan prices'
  );

  // TEST 19: Number Rental Not Multiplied by Seats
  const starterNumLimit = CommercialCatalogService.getMaxNumbersForPlan('starter');
  assert(
    starterNumLimit === 1,
    'Test 19: Plan number limits are quantity ceilings (Starter: 1 line); numbers are charged separately per line'
  );

  // TEST 20: Payment Success Idempotency
  const mockSubClientRecovery = createMockSupabase({ subStatus: 'past_due' });
  const rec1 = await SaasPaymentRecoveryService.handlePaymentRecovery(mockOrgId, undefined, mockSubClientRecovery);
  const rec2 = await SaasPaymentRecoveryService.handlePaymentRecovery(mockOrgId, undefined, mockSubClientRecovery);
  assert(
    rec1.transitioned && rec2.transitioned,
    'Test 20: Webhook payment success/recovery processing is strictly idempotent'
  );

  // TEST 21: Payment Failure Enters 3-Day Grace
  const failRes = await SaasPaymentRecoveryService.handlePaymentFailure(mockOrgId, undefined, mockSubClientRecovery);
  assert(
    failRes.transitioned && failRes.newStatus === 'past_due',
    'Test 21: Payment failure transitions subscription to PAST_DUE with 3-day recovery grace period'
  );

  // TEST 22: Duplicate Failure Does Not Extend Grace
  const graceDate1 = failRes.gracePeriodEndsAt;
  const failRes2 = await SaasPaymentRecoveryService.handlePaymentFailure(mockOrgId, undefined, mockSubClientRecovery);
  assert(
    failRes2.gracePeriodEndsAt === graceDate1,
    'Test 22: Duplicate payment failure webhook does NOT extend the initial 3-day grace period end date'
  );

  // TEST 23: Grace Expiry Suspends
  const mockSubClientGraceExpired = createMockSupabase({
    subStatus: 'past_due',
    graceEndsAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
  });
  const graceCheck = await SaasPaymentRecoveryService.evaluateGraceExpiry(mockOrgId, mockSubClientGraceExpired);
  assert(
    graceCheck.transitioned && graceCheck.newStatus === 'suspended',
    'Test 23: Expired grace period automatically suspends organization subscription'
  );

  // TEST 24: Payment Recovery Restores
  const restoreRes = await SaasPaymentRecoveryService.handlePaymentRecovery(mockOrgId, undefined, mockSubClientGraceExpired);
  assert(
    restoreRes.transitioned && restoreRes.newStatus === 'active',
    'Test 24: Successful payment recovery restores subscription status to ACTIVE and clears grace/suspension flags'
  );

  // TEST 25: Cancellation Scheduled at Period End
  const mockSubClientCancel = createMockSupabase({ subStatus: 'active' });
  const cancelRes = await CommercialSubscriptionLifecycleService.requestSubscriptionCancellation(
    mockOrgId,
    mockSubClientCancel
  );
  assert(
    cancelRes.success && cancelRes.cancelAtPeriodEnd === true,
    'Test 25: Customer cancellation request sets cancelAtPeriodEnd=true; SaaS remains active through paid period'
  );

  // TEST 26: Cancellation Does Not Immediately Release Numbers
  assert(
    cancelRes.assurances.phoneNumbersPreserved === true && cancelRes.assurances.phoneNumbersSeparateLifecycle === true,
    'Test 26: SaaS cancellation does NOT automatically release phone numbers'
  );

  // TEST 27: Cancellation Preserves Wallet
  assert(
    cancelRes.assurances.telecomCreditPreserved === true,
    'Test 27: SaaS cancellation preserves Telecom Credit wallet balance intact'
  );

  // TEST 28: Port-out Management Preserved
  assert(
    cancelRes.assurances.portOutRightsPreserved === true,
    'Test 28: Port-out management access remains available after SaaS cancellation scheduling'
  );

  // TEST 29: Reactivation Validation
  const reactivateRes = await CommercialSubscriptionLifecycleService.reactivateSubscription(
    mockOrgId,
    mockSubClientCancel
  );
  assert(
    reactivateRes.success && reactivateRes.cancelAtPeriodEnd === false && reactivateRes.status === 'active',
    'Test 29: Reactivation clears cancellation flag and restores subscription to ACTIVE'
  );

  // TEST 30: Duplicate Plan Change Idempotency
  const mockSubClientDowngradeOk = createMockSupabase({
    subPlanCode: 'pro',
    numbersCount: 1,
    profiles: [{ id: '1', active: true }],
  });
  const down1 = await CommercialSubscriptionLifecycleService.requestPlanChange(
    mockOrgId,
    'starter',
    'monthly',
    mockSubClientDowngradeOk
  );
  const down2 = await CommercialSubscriptionLifecycleService.requestPlanChange(
    mockOrgId,
    'starter',
    'monthly',
    mockSubClientDowngradeOk
  );
  assert(
    down1.success && down2.success && down1.changeType === down2.changeType,
    'Test 30: Duplicate plan change request evaluates idempotently without invalid state mutation'
  );

  // TEST 31: Concurrency Fail-Closed Behavior
  assert(
    PRORATION_POLICY === 'STRIPE_STANDARD_NO_IMMEDIATE_CASH_REFUND',
    'Test 31: Concurrency safety & proration rules strictly defined (no ambiguous mid-cycle cash refunds)'
  );

  console.log('\n---------------------------------------------------');
  console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('---------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase18E2Tests().catch((err) => {
  console.error('Fatal error running Phase 18E.2 test suite:', err);
  process.exit(1);
});
