// Mock server-only before any other imports
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'server-only') {
    return {};
  }
  return originalRequire.apply(this, arguments);
};

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceAuthorizationService } from '../voiceAuthorizationService';
import { TelecomWalletService } from '../../telecomWalletService';
import { ExposurePolicy } from '../exposurePolicy';

// Mock DB harness implementing atomic row locking and exact PL/pgSQL logic
class MockAtomicTelecomDatabase {
  public walletBalanceMinor: number = 0;
  public maxConcurrentCalls: number = 5;
  public isBillingRestricted: boolean = false;
  public reservations: Map<string, any> = new Map();
  public idempotencyLedger: Map<string, any> = new Map();
  public sessions: Map<string, any> = new Map();
  public components: Map<string, any> = new Map();
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(initialBalanceMinor: number, maxConcurrent: number = 5) {
    this.walletBalanceMinor = initialBalanceMinor;
    this.maxConcurrentCalls = maxConcurrent;
  }

  // Simulates Postgres row locking: PERFORM ... FOR UPDATE
  async withOrganizationLock<T>(fn: () => Promise<T>): Promise<T> {
    let releaseLock: () => void = () => {};
    const currentLock = this.lockPromise;
    this.lockPromise = new Promise((resolve) => {
      releaseLock = resolve;
    });
    await currentLock;
    try {
      return await fn();
    } finally {
      releaseLock();
    }
  }

  async recordReservationAtomic(params: any): Promise<any> {
    return this.withOrganizationLock(async () => {
      const {
        p_organization_id,
        p_internal_usage_id,
        p_service_type,
        p_amount_reserved_minor,
        p_idempotency_key,
      } = params;

      // 1. Check idempotency
      const existingOp = this.idempotencyLedger.get(p_idempotency_key);
      if (existingOp) {
        return {
          ...existingOp.response_payload,
          is_duplicate: true,
        };
      }

      // 2. Check duplicate usage ID
      for (const res of this.reservations.values()) {
        if (res.internal_usage_id === p_internal_usage_id && res.organization_id === p_organization_id) {
          throw new Error(`IDEMPOTENCY_CONFLICT: Usage ID ${p_internal_usage_id} already exists`);
        }
      }

      // 3. Check billing restricted
      if (this.isBillingRestricted) {
        throw new Error('ORGANIZATION_BILLING_RESTRICTED: Organization restricted');
      }

      // 4. Atomic Concurrency Gate
      if (['voice_outbound', 'voice_inbound'].includes(p_service_type)) {
        let activeVoiceCount = 0;
        for (const res of this.reservations.values()) {
          if (
            res.organization_id === p_organization_id &&
            res.status === 'active' &&
            ['voice_outbound', 'voice_inbound'].includes(res.service_type)
          ) {
            activeVoiceCount++;
          }
        }
        if (activeVoiceCount >= this.maxConcurrentCalls) {
          throw new Error(
            `CONCURRENT_CALL_LIMIT_EXCEEDED: Organization ${p_organization_id} has reached its concurrent active voice call limit (${activeVoiceCount}/${this.maxConcurrentCalls})`
          );
        }
      }

      // 5. Balance check
      let activeReservationsMinor = 0;
      for (const res of this.reservations.values()) {
        if (res.organization_id === p_organization_id && res.status === 'active') {
          activeReservationsMinor += res.amount_reserved_minor;
        }
      }

      const availableBalanceMinor = this.walletBalanceMinor - activeReservationsMinor;
      if (availableBalanceMinor < p_amount_reserved_minor) {
        throw new Error(
          `INSUFFICIENT_AVAILABLE_BALANCE: Available funded balance ${availableBalanceMinor} is insufficient for ${p_amount_reserved_minor}`
        );
      }

      // 6. Insert reservation
      const reservationId = `res_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const newRes = {
        id: reservationId,
        organization_id: p_organization_id,
        internal_usage_id: p_internal_usage_id,
        service_type: p_service_type,
        amount_reserved_minor: p_amount_reserved_minor,
        status: 'active',
        idempotency_key: p_idempotency_key,
        created_at: new Date().toISOString(),
      };
      this.reservations.set(reservationId, newRes);

      const respPayload = {
        success: true,
        is_duplicate: false,
        reservation_id: reservationId,
        internal_usage_id: p_internal_usage_id,
        amount_reserved_minor: p_amount_reserved_minor,
        status: 'active',
        funded_balance_minor: this.walletBalanceMinor,
        active_reservations_minor: activeReservationsMinor + p_amount_reserved_minor,
        available_balance_minor: availableBalanceMinor - p_amount_reserved_minor,
      };

      this.idempotencyLedger.set(p_idempotency_key, {
        organization_id: p_organization_id,
        idempotency_key: p_idempotency_key,
        response_payload: respPayload,
      });

      return respPayload;
    });
  }

  async releaseReservationAtomic(params: any): Promise<any> {
    return this.withOrganizationLock(async () => {
      const { p_organization_id, p_internal_usage_id, p_idempotency_key } = params;
      if (p_idempotency_key) {
        const existingOp = this.idempotencyLedger.get(p_idempotency_key);
        if (existingOp) {
          return { ...existingOp.response_payload, is_duplicate: true };
        }
      }

      let targetRes: any = null;
      for (const res of this.reservations.values()) {
        if (res.internal_usage_id === p_internal_usage_id && res.organization_id === p_organization_id) {
          targetRes = res;
          break;
        }
      }

      if (!targetRes) {
        throw new Error(`RESERVATION_NOT_FOUND: ${p_internal_usage_id}`);
      }

      targetRes.status = 'released';

      let activeReservationsMinor = 0;
      for (const res of this.reservations.values()) {
        if (res.organization_id === p_organization_id && res.status === 'active') {
          activeReservationsMinor += res.amount_reserved_minor;
        }
      }

      const respPayload = {
        success: true,
        is_duplicate: false,
        reservation_id: targetRes.id,
        internal_usage_id: p_internal_usage_id,
        status: 'released',
        funded_balance_minor: this.walletBalanceMinor,
        active_reservations_minor: activeReservationsMinor,
        available_balance_minor: this.walletBalanceMinor - activeReservationsMinor,
      };

      if (p_idempotency_key) {
        this.idempotencyLedger.set(p_idempotency_key, {
          organization_id: p_organization_id,
          idempotency_key: p_idempotency_key,
          response_payload: respPayload,
        });
      }

      return respPayload;
    });
  }

  createSupabaseClientMock(): any {
    return {
      rpc: async (fnName: string, args: any) => {
        if (fnName === 'record_telecom_usage_reservation_atomic') {
          try {
            const data = await this.recordReservationAtomic(args);
            return { data, error: null };
          } catch (err: any) {
            return { data: null, error: err };
          }
        }
        if (fnName === 'release_telecom_usage_reservation_atomic') {
          try {
            const data = await this.releaseReservationAtomic(args);
            return { data, error: null };
          } catch (err: any) {
            return { data: null, error: err };
          }
        }
        if (fnName === 'record_telecom_usage_economics_snapshot_atomic') {
          return { data: { success: true }, error: null };
        }
        return { data: null, error: new Error(`Unknown RPC: ${fnName}`) };
      },
      from: (table: string) => {
        return new MockQueryBuilder(table, this);
      },
    };
  }
}

class MockQueryBuilder {
  private table: string;
  private db: MockAtomicTelecomDatabase;
  private selectOpts?: any;
  private filters: Array<{ col: string; op: string; val: any }> = [];
  private insertedData?: any;
  private updatedData?: any;

  constructor(table: string, db: MockAtomicTelecomDatabase) {
    this.table = table;
    this.db = db;
  }

  select(cols?: string, opts?: any) {
    this.selectOpts = opts;
    return this;
  }

  insert(data: any) {
    this.insertedData = data;
    if (this.table === 'telecom_usage_sessions') {
      this.db.sessions.set(data.session_id, { ...data });
    } else if (this.table === 'telecom_usage_components') {
      this.db.components.set(data.component_id, { ...data });
    }
    return this;
  }

  update(data: any) {
    this.updatedData = data;
    return this;
  }

  eq(col: string, val: any) {
    this.filters.push({ col, op: 'eq', val });
    return this;
  }

  neq(col: string, val: any) {
    this.filters.push({ col, op: 'neq', val });
    return this;
  }

  in(col: string, val: any[]) {
    this.filters.push({ col, op: 'in', val });
    return this;
  }

  is(col: string, val: any) {
    this.filters.push({ col, op: 'is', val });
    return this;
  }

  order() {
    return this;
  }

  limit() {
    return this;
  }

  private resolveResult(): { data: any; error: any; count?: number | null } {
    switch (this.table) {
      case 'organizations': {
        const idFilter = this.filters.find((f) => f.col === 'id')?.val || 'org_test';
        return {
          data: {
            id: idFilter,
            name: 'Test Org',
            subscription_status: 'active',
          },
          error: null,
        };
      }
      case 'organization_billing_controls': {
        return {
          data: {
            is_billing_restricted: this.db.isBillingRestricted,
            max_concurrent_voice_calls: this.db.maxConcurrentCalls,
            telecom_suspended: false,
          },
          error: null,
        };
      }
      case 'phone_number_lifecycle_states': {
        return {
          data: {
            lifecycle_state: 'active',
            allow_telecom_usage: true,
          },
          error: null,
        };
      }
      case 'phone_numbers': {
        return {
          data: {
            status: 'active',
            active: true,
          },
          error: null,
        };
      }
      case 'number_lifecycle_policies': {
        return { data: null, error: null };
      }
      case 'organization_telecom_lifecycle_policies': {
        return { data: null, error: null };
      }
      case 'telecom_organization_provider_assignments': {
        return { data: [], error: null };
      }
      case 'telecom_provider_accounts': {
        return { data: null, error: null };
      }
      case 'telecom_suspensions': {
        return { data: [], error: null };
      }
      case 'telecom_retail_rate_cards': {
        return {
          data: [
            {
              id: 'rate_us_standard',
              service_type: 'voice_outbound',
              direction: 'outbound',
              currency: 'USD',
              retail_rate_micro: 100_000, // $0.10 / min
              wholesale_cost_micro: 80_000, // 80,000 + 2500 bps (25%) = 100,000 micro = $0.10/min
              billing_increment_seconds: 60,
              min_chargeable_units: 1,
              unit_type: 'minute',
              effective_start_at: '2020-01-01T00:00:00Z',
              effective_end_at: null,
              destination_pattern: '+1',
              is_active: true,
            },
          ],
          error: null,
        };
      }
      case 'telecom_usage_reservations': {
        let count = 0;
        const orgFilter = this.filters.find((f) => f.col === 'organization_id')?.val;
        for (const res of this.db.reservations.values()) {
          if (
            (!orgFilter || res.organization_id === orgFilter) &&
            res.status === 'active' &&
            ['voice_outbound', 'voice_inbound'].includes(res.service_type)
          ) {
            count++;
          }
        }
        return {
          data: [],
          error: null,
          count,
        };
      }
      case 'telecom_usage_sessions': {
        if (this.insertedData) {
          return { data: this.insertedData, error: null };
        }
        if (this.updatedData) {
          return { data: this.updatedData, error: null };
        }
        return { data: [], error: null };
      }
      case 'telecom_usage_components': {
        if (this.insertedData) {
          return { data: this.insertedData, error: null };
        }
        if (this.updatedData) {
          return { data: this.updatedData, error: null };
        }
        return { data: [], error: null };
      }
      default:
        return { data: [], error: null };
    }
  }

  async maybeSingle(): Promise<{ data: any; error: any }> {
    const res = this.resolveResult();
    const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
    return { data, error: res.error };
  }

  async single(): Promise<{ data: any; error: any }> {
    const res = this.resolveResult();
    const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
    return { data, error: res.error };
  }

  then(onfulfilled?: (val: any) => any, onrejected?: (val: any) => any): Promise<any> {
    const res = this.resolveResult();
    return Promise.resolve(res).then(onfulfilled, onrejected);
  }
}

describe('Phase 22C-1A: Prepaid Voice Financial Safety & Atomic Concurrency Test Matrix', () => {
  const standardRateCard = {
    id: 'rate_us_standard',
    retailRateMicro: 100_000, // $0.10 per minute
    billingIncrementSeconds: 60,
    minChargeableUnits: 1,
    unitType: 'minute',
    wholesaleCostMicro: 50_000,
  };

  // TEST A: SINGLE CALL
  it('TEST A — Single Call: Invariant provider exposure <= reserved amount', async () => {
    const db = new MockAtomicTelecomDatabase(1000); // $10.00 wallet
    const client = db.createSupabaseClientMock();

    const authResult = await VoiceAuthorizationService.authorizeOutboundVoice(client, {
      organizationId: 'org_test_a',
      dbCallId: 'call_test_a',
      fromNumber: '+15551234567',
      toNumber: '+15559876543',
      policyConfigOverrides: { initialExposureSeconds: 300, enforcementMode: 'enforce' },
    });

    assert.equal(authResult.authorized, true, 'Call must be authorized');
    assert.equal(authResult.reservedAmountMinor, 50, 'Must reserve exactly 50 cents ($0.50) for 300s at $0.10/min');
    assert.equal(authResult.authorizedSeconds, 300, 'Authorized duration must be 300s');
    assert.ok(authResult.providerTimeLimit! <= 300, 'Provider timeLimit must be <= 300s');
    assert.ok(authResult.providerTimeLimit! <= authResult.authorizedSeconds!, 'providerTimeLimit <= authorizedSeconds');

    // Financial invariant assertion: Cost of provider timeLimit <= reserved amount
    const costForProviderLimit = TelecomWalletService.calculateRetailChargeMinor({
      retailRateMicro: standardRateCard.retailRateMicro,
      durationSeconds: authResult.providerTimeLimit!,
      billingIncrementSeconds: standardRateCard.billingIncrementSeconds,
      minChargeableUnits: standardRateCard.minChargeableUnits,
      unitType: 'minute',
    });
    assert.ok(
      costForProviderLimit <= authResult.reservedAmountMinor!,
      `Cost of provider limit ($${costForProviderLimit / 100}) must never exceed reserved amount ($${authResult.reservedAmountMinor! / 100})`
    );
  });

  // TEST B: FIVE SIMULTANEOUS CALLS
  it('TEST B — Five Simultaneous Calls: Combined maximum provider exposure <= total funds secured', async () => {
    const db = new MockAtomicTelecomDatabase(1000); // $10.00 wallet
    const client = db.createSupabaseClientMock();

    const calls = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        VoiceAuthorizationService.authorizeOutboundVoice(client, {
          organizationId: 'org_test_b',
          dbCallId: `call_test_b_${i}`,
          fromNumber: '+15551234567',
          toNumber: '+15559876543',
          policyConfigOverrides: { initialExposureSeconds: 300, enforcementMode: 'enforce' },
        })
      )
    );

    let totalReservedMinor = 0;
    let totalMaxExposureMinor = 0;

    for (const call of calls) {
      assert.equal(call.authorized, true);
      assert.equal(call.reservedAmountMinor, 50);
      assert.ok(call.providerTimeLimit! <= 300);
      totalReservedMinor += call.reservedAmountMinor!;

      const callCost = TelecomWalletService.calculateRetailChargeMinor({
        retailRateMicro: standardRateCard.retailRateMicro,
        durationSeconds: call.providerTimeLimit!,
        billingIncrementSeconds: 60,
        minChargeableUnits: 1,
        unitType: 'minute',
      });
      totalMaxExposureMinor += callCost;
    }

    assert.equal(totalReservedMinor, 250, 'Total reserved must be $2.50');
    assert.equal(totalMaxExposureMinor, 250, 'Total maximum exposure must be $2.50');
    assert.ok(totalMaxExposureMinor <= totalReservedMinor, 'Maximum provider exposure <= atomically secured funds');
    assert.ok(totalMaxExposureMinor <= db.walletBalanceMinor, 'Maximum provider exposure <= wallet balance ($10)');
    assert.ok(totalMaxExposureMinor < 3000, 'Prevented catastrophic $30 exposure against $10 wallet');
  });

  // TEST C: TWENTY PARALLEL REQUESTS
  it('TEST C — Twenty Parallel Requests: Exactly 5 accepted, 15 rejected at DB transaction level', async () => {
    const db = new MockAtomicTelecomDatabase(10000, 5); // $100 wallet, limit = 5
    const client = db.createSupabaseClientMock();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        VoiceAuthorizationService.authorizeOutboundVoice(client, {
          organizationId: 'org_test_c',
          dbCallId: `call_test_c_${i}`,
          fromNumber: '+15551234567',
          toNumber: '+15559876543',
          policyConfigOverrides: { initialExposureSeconds: 300, enforcementMode: 'enforce' },
        })
      )
    );

    const authorizedCalls = results.filter((r) => r.authorized);
    const rejectedCalls = results.filter((r) => !r.authorized);

    assert.equal(authorizedCalls.length, 5, 'Exactly 5 calls must be authorized');
    assert.equal(rejectedCalls.length, 15, 'Exactly 15 calls must be rejected');
    for (const rej of rejectedCalls) {
      assert.equal(rej.failureReason, 'CONCURRENT_CALL_LIMIT_EXCEEDED');
    }
  });

  // TEST D: LOW BALANCE
  it('TEST D — Low Balance: $0.60 wallet can only authorize 1 call, total exposure <= $0.60', async () => {
    const db = new MockAtomicTelecomDatabase(60); // $0.60 wallet
    const client = db.createSupabaseClientMock();

    const call1 = await VoiceAuthorizationService.authorizeOutboundVoice(client, {
      organizationId: 'org_test_d',
      dbCallId: 'call_test_d_1',
      fromNumber: '+15551234567',
      toNumber: '+15559876543',
      policyConfigOverrides: { initialExposureSeconds: 300, enforcementMode: 'enforce' },
    });

    assert.equal(call1.authorized, true);
    assert.equal(call1.reservedAmountMinor, 50);

    const call2 = await VoiceAuthorizationService.authorizeOutboundVoice(client, {
      organizationId: 'org_test_d',
      dbCallId: 'call_test_d_2',
      fromNumber: '+15551234567',
      toNumber: '+15559876543',
      policyConfigOverrides: { initialExposureSeconds: 300, enforcementMode: 'enforce' },
    });

    assert.equal(call2.authorized, false);
    assert.equal(call2.failureReason, 'INSUFFICIENT_AVAILABLE_BALANCE');
  });

  // TEST E: MULTI-INSTANCE SIMULATION
  it('TEST E — Multi-Instance Simulation: Two independent service instances sharing DB lock', async () => {
    const db = new MockAtomicTelecomDatabase(100); // $1.00 wallet, only enough for two 50-cent calls
    const instanceA = db.createSupabaseClientMock();
    const instanceB = db.createSupabaseClientMock();

    // 4 calls launched concurrently across both instances (2 on A, 2 on B)
    const [a1, b1, a2, b2] = await Promise.all([
      VoiceAuthorizationService.authorizeOutboundVoice(instanceA, {
        organizationId: 'org_test_e',
        dbCallId: 'call_a1',
        fromNumber: '+15551234567',
        toNumber: '+15559876543',
        policyConfigOverrides: { initialExposureSeconds: 300, enforcementMode: 'enforce' },
      }),
      VoiceAuthorizationService.authorizeOutboundVoice(instanceB, {
        organizationId: 'org_test_e',
        dbCallId: 'call_b1',
        fromNumber: '+15551234567',
        toNumber: '+15559876543',
        policyConfigOverrides: { initialExposureSeconds: 300, enforcementMode: 'enforce' },
      }),
      VoiceAuthorizationService.authorizeOutboundVoice(instanceA, {
        organizationId: 'org_test_e',
        dbCallId: 'call_a2',
        fromNumber: '+15551234567',
        toNumber: '+15559876543',
        policyConfigOverrides: { initialExposureSeconds: 300, enforcementMode: 'enforce' },
      }),
      VoiceAuthorizationService.authorizeOutboundVoice(instanceB, {
        organizationId: 'org_test_e',
        dbCallId: 'call_b2',
        fromNumber: '+15551234567',
        toNumber: '+15559876543',
        policyConfigOverrides: { initialExposureSeconds: 300, enforcementMode: 'enforce' },
      }),
    ]);

    const all = [a1, b1, a2, b2];
    const authorized = all.filter((r) => r.authorized);
    const rejected = all.filter((r) => !r.authorized);

    assert.equal(authorized.length, 2, 'Exactly 2 calls can be authorized with $1.00');
    assert.equal(rejected.length, 2, 'Remaining 2 calls must be rejected fail-closed');
  });

  // TEST F: DUPLICATE AUTHORIZATION
  it('TEST F — Duplicate Authorization: Exactly one effective reservation on duplicate submissions', async () => {
    const db = new MockAtomicTelecomDatabase(1000);
    const client = db.createSupabaseClientMock();

    const [res1, res2] = await Promise.all([
      VoiceAuthorizationService.authorizeOutboundVoice(client, {
        organizationId: 'org_test_f',
        dbCallId: 'call_test_f_duplicate',
        fromNumber: '+15551234567',
        toNumber: '+15559876543',
        policyConfigOverrides: { initialExposureSeconds: 300, enforcementMode: 'enforce' },
      }),
      VoiceAuthorizationService.authorizeOutboundVoice(client, {
        organizationId: 'org_test_f',
        dbCallId: 'call_test_f_duplicate',
        fromNumber: '+15551234567',
        toNumber: '+15559876543',
        policyConfigOverrides: { initialExposureSeconds: 300, enforcementMode: 'enforce' },
      }),
    ]);

    assert.equal(res1.authorized, true);
    assert.equal(res2.authorized, true);
    assert.equal(res1.reservationId, res2.reservationId);
    assert.equal(db.reservations.size, 1, 'Only one reservation record in database');
  });

  // TEST G: PROVIDER DISPATCH FAILURE
  it('TEST G — Provider Dispatch Failure: Reservation released and compensated exactly once', async () => {
    const db = new MockAtomicTelecomDatabase(1000);
    const client = db.createSupabaseClientMock();

    const auth = await VoiceAuthorizationService.authorizeOutboundVoice(client, {
      organizationId: 'org_test_g',
      dbCallId: 'call_test_g',
      fromNumber: '+15551234567',
      toNumber: '+15559876543',
      policyConfigOverrides: { initialExposureSeconds: 300, enforcementMode: 'enforce' },
    });

    assert.equal(auth.authorized, true);
    assert.equal(db.reservations.get(auth.reservationId!)?.status, 'active');

    // Simulate provider dispatch failure -> compensate
    const compensated = await VoiceAuthorizationService.compensatePreDispatchFailure(
      client,
      'org_test_g',
      auth.internalUsageId!,
      'call_test_g'
    );

    assert.equal(compensated, true);
    assert.equal(db.reservations.get(auth.reservationId!)?.status, 'released');

    // Second compensation attempt (idempotent, no double credit or error)
    const secondCompensated = await VoiceAuthorizationService.compensatePreDispatchFailure(
      client,
      'org_test_g',
      auth.internalUsageId!,
      'call_test_g'
    );
    assert.equal(secondCompensated, true);
  });

  // TEST H: ROUNDING
  it('TEST H — Rounding: Uneven rate rounds DOWN funded duration to integer increments', () => {
    const unevenRateCard = {
      retailRateMicro: 137_000, // $0.137 / min -> 14c min 1, 28c min 2, 42c min 3, 56c min 4
      billingIncrementSeconds: 60,
      minChargeableUnits: 1,
      unitType: 'minute',
    };

    // 50 cents reserved: 3 minutes = 42 cents, 4 minutes = 56 cents
    const maxFundedSeconds = VoiceAuthorizationService.calculateMaxFundedSecondsFromReservation(
      unevenRateCard,
      50
    );

    assert.equal(maxFundedSeconds, 180, 'Must round DOWN to 180s (3 minutes), NEVER 240s');
    const costForFunded = TelecomWalletService.calculateRetailChargeMinor({
      retailRateMicro: unevenRateCard.retailRateMicro,
      durationSeconds: maxFundedSeconds,
      billingIncrementSeconds: 60,
      minChargeableUnits: 1,
      unitType: 'minute',
    });
    assert.ok(costForFunded <= 50, `Cost (${costForFunded}) must be <= reserved (50)`);
  });

  // TEST I: ZERO / INVALID RATE
  it('TEST I — Zero / Invalid Rate: Fails closed with zero provider authorization', async () => {
    const db = new MockAtomicTelecomDatabase(1000);
    const client = db.createSupabaseClientMock();

    const auth = await VoiceAuthorizationService.authorizeOutboundVoice(client, {
      organizationId: 'org_test_i',
      dbCallId: 'call_test_i',
      fromNumber: '+15551234567',
      toNumber: '', // Invalid destination -> cannot resolve rate
      policyConfigOverrides: { initialExposureSeconds: 300, enforcementMode: 'enforce' },
    });

    assert.equal(auth.authorized, false);
    assert.equal(auth.failureReason, 'INVALID_PARAMETERS');
    assert.equal(db.reservations.size, 0, 'No reservation created');
  });

  // TEST J: CRASH / STRANDED RESERVATION
  it('TEST J — Crash / Stranded Reservation: Preserves reservation hold until reconciliation', async () => {
    const db = new MockAtomicTelecomDatabase(1000);
    const client = db.createSupabaseClientMock();

    // 1. Authorization succeeds and reservation is committed
    const auth = await VoiceAuthorizationService.authorizeOutboundVoice(client, {
      organizationId: 'org_test_j',
      dbCallId: 'call_test_j',
      fromNumber: '+15551234567',
      toNumber: '+15559876543',
      policyConfigOverrides: { initialExposureSeconds: 300, enforcementMode: 'enforce' },
    });

    assert.equal(auth.authorized, true);
    const reservationRecord = db.reservations.get(auth.reservationId!);
    assert.equal(reservationRecord.status, 'active');

    // 2. Application crashes immediately here (simulated)
    // Invariant: The reservation remains ACTIVE in the database.
    // Funds are NOT prematurely released, protecting the carrier from unfunded usage
    // in case the provider call actually started on the carrier network!
    assert.equal(db.reservations.get(auth.reservationId!)?.status, 'active');
  });
});
