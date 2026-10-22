// Mock server-only before any server-only modules load
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'server-only') return {};
  return originalRequire.apply(this, arguments);
};

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import twilio from 'twilio';
import { VoiceAuthorizationService } from '../voiceAuthorizationService';
import { TelecomWalletService } from '../../telecomWalletService';

let generateOutboundDialTwiml: any;

/**
 * In-memory Mock Database for Atomic Telecom Wallet & Reservation Testing
 */
class MockAtomicTelecomDatabase {
  walletBalanceMinor: number;
  maxConcurrentCalls: number;
  reservations: Map<string, any> = new Map();
  idempotencyLedger: Map<string, any> = new Map();

  constructor(initialBalanceMinor: number = 1000, maxConcurrentCalls: number = 5) {
    this.walletBalanceMinor = initialBalanceMinor;
    this.maxConcurrentCalls = maxConcurrentCalls;
  }

  async recordReservationAtomic(params: any): Promise<any> {
    const { p_organization_id, p_internal_usage_id, p_service_type, p_amount_reserved_minor, p_idempotency_key } = params;

    if (p_idempotency_key && this.idempotencyLedger.has(p_idempotency_key)) {
      return { ...this.idempotencyLedger.get(p_idempotency_key).response_payload, is_duplicate: true };
    }

    let activeReservationsMinor = 0;
    for (const res of this.reservations.values()) {
      if (res.organization_id === p_organization_id && res.status === 'active') {
        activeReservationsMinor += res.amount_reserved_minor;
      }
    }

    const availableBalanceMinor = this.walletBalanceMinor - activeReservationsMinor;
    if (availableBalanceMinor < p_amount_reserved_minor) {
      throw new Error(`INSUFFICIENT_AVAILABLE_BALANCE: Available funded balance ${availableBalanceMinor} is insufficient for ${p_amount_reserved_minor}`);
    }

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

    if (p_idempotency_key) {
      this.idempotencyLedger.set(p_idempotency_key, {
        organization_id: p_organization_id,
        idempotency_key: p_idempotency_key,
        response_payload: respPayload,
      });
    }

    return respPayload;
  }

  async releaseReservationAtomic(params: any): Promise<any> {
    const { p_organization_id, p_internal_usage_id, p_idempotency_key } = params;
    if (p_idempotency_key && this.idempotencyLedger.has(p_idempotency_key)) {
      return { ...this.idempotencyLedger.get(p_idempotency_key).response_payload, is_duplicate: true };
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
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              in: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
              maybeSingle: async () => ({ data: null, error: null }),
            }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
        update: () => ({
          eq: () => ({
            eq: async () => ({ error: null }),
          }),
        }),
        insert: async () => ({ error: null }),
      }),
    };
  }
}

/**
 * Simulates the outbound webhook boundary check that guards TwiML <Dial> generation.
 */
async function simulateOutboundDispatchBoundary(authResult: {
  authorized: boolean;
  reservationId?: string;
  providerTimeLimit?: any;
  timeLimitSeconds?: any;
  isShadowMode?: boolean;
}): Promise<{ canDispatch: boolean; twiml?: string; reason?: string }> {
  const isEnforceMode = !authResult.isShadowMode;
  const isValidProviderLimit = VoiceAuthorizationService.isValidProviderTimeLimit(authResult.providerTimeLimit);
  const isReservationValid = !isEnforceMode || Boolean(authResult.reservationId);

  if (!isValidProviderLimit || !isReservationValid) {
    const failResp = new twilio.twiml.VoiceResponse();
    failResp.say(
      { voice: 'alice' },
      'We are unable to connect your call due to an authorization or credit reservation error. Please contact support.'
    );
    failResp.hangup();
    return {
      canDispatch: false,
      twiml: failResp.toString(),
      reason: !isValidProviderLimit ? 'INVALID_PROVIDER_TIME_LIMIT' : 'MISSING_RESERVATION_ID',
    };
  }

  // Consume ONLY authoritative providerTimeLimit
  const finalTimeLimitSeconds = authResult.providerTimeLimit as number;
  const twiml = generateOutboundDialTwiml({
    callerId: '+15551234567',
    destination: '+15559876543',
    providerTimeLimit: finalTimeLimitSeconds,
    dbCallId: 'sim_call_1',
  });

  return { canDispatch: true, twiml };
}

describe('Phase 22C-1A.1: Prepaid Voice Fail-Closed Boundary Hardening Test Matrix', () => {
  before(async () => {
    const route = await import('../../../../app/api/twilio/voice/outbound/route');
    generateOutboundDialTwiml = route.generateOutboundDialTwiml;
  });

  // TEST 1 — VALID AUTHORIZATION
  it('TEST 1 — VALID AUTHORIZATION: Reservation-derived providerTimeLimit = 300 -> <Dial timeLimit="300"> PASS', async () => {
    const authResult = {
      authorized: true,
      reservationId: 'res_test_1',
      providerTimeLimit: 300,
      timeLimitSeconds: 300,
      isShadowMode: false,
    };

    const dispatchResult = await simulateOutboundDispatchBoundary(authResult);
    assert.equal(dispatchResult.canDispatch, true, 'Valid providerTimeLimit must allow dispatch');
    assert.ok(dispatchResult.twiml?.includes('timeLimit="300"'), '<Dial> must contain timeLimit="300"');
    assert.ok(dispatchResult.twiml?.includes('<Dial'), 'Must generate <Dial> tag');
  });

  // TEST 2 — MISSING PROVIDER LIMIT
  it('TEST 2 — MISSING PROVIDER LIMIT: providerTimeLimit = undefined/null even if timeLimitSeconds = 3600 -> FAIL CLOSED', async () => {
    // 2a: undefined
    const authResultUndefined = {
      authorized: true,
      reservationId: 'res_test_2a',
      providerTimeLimit: undefined,
      timeLimitSeconds: 3600, // Legacy present but providerTimeLimit missing
      isShadowMode: false,
    };

    const resultUndefined = await simulateOutboundDispatchBoundary(authResultUndefined);
    assert.equal(resultUndefined.canDispatch, false, 'Undefined providerTimeLimit must FAIL CLOSED');
    assert.ok(!resultUndefined.twiml?.includes('<Dial'), 'No chargeable <Dial> may be generated');
    assert.ok(resultUndefined.twiml?.includes('<Hangup/>'), 'Must terminate with <Hangup/>');

    // 2b: null
    const authResultNull = {
      authorized: true,
      reservationId: 'res_test_2b',
      providerTimeLimit: null,
      timeLimitSeconds: 3600,
      isShadowMode: false,
    };

    const resultNull = await simulateOutboundDispatchBoundary(authResultNull);
    assert.equal(resultNull.canDispatch, false, 'Null providerTimeLimit must FAIL CLOSED');
    assert.ok(!resultNull.twiml?.includes('<Dial'), 'No chargeable <Dial> may be generated for null limit');
  });

  // TEST 3 — ZERO LIMIT
  it('TEST 3 — ZERO LIMIT: providerTimeLimit = 0 -> FAIL CLOSED', async () => {
    const authResult = {
      authorized: true,
      reservationId: 'res_test_3',
      providerTimeLimit: 0,
      timeLimitSeconds: 0,
      isShadowMode: false,
    };

    const result = await simulateOutboundDispatchBoundary(authResult);
    assert.equal(result.canDispatch, false, 'Zero providerTimeLimit must FAIL CLOSED');
    assert.ok(!result.twiml?.includes('<Dial'), 'No chargeable <Dial> may be generated for zero limit');
    assert.throws(
      () =>
        generateOutboundDialTwiml({
          callerId: '+15551234567',
          destination: '+15559876543',
          providerTimeLimit: 0,
          dbCallId: 'call_3',
        }),
      /Invalid providerTimeLimit/,
      'generateOutboundDialTwiml must throw for zero limit'
    );
  });

  // TEST 4 — NEGATIVE LIMIT
  it('TEST 4 — NEGATIVE LIMIT: providerTimeLimit = -1 -> FAIL CLOSED', async () => {
    const authResult = {
      authorized: true,
      reservationId: 'res_test_4',
      providerTimeLimit: -1,
      timeLimitSeconds: -1,
      isShadowMode: false,
    };

    const result = await simulateOutboundDispatchBoundary(authResult);
    assert.equal(result.canDispatch, false, 'Negative providerTimeLimit must FAIL CLOSED');
    assert.ok(!result.twiml?.includes('<Dial'), 'No chargeable <Dial> may be generated for negative limit');
    assert.throws(
      () =>
        generateOutboundDialTwiml({
          callerId: '+15551234567',
          destination: '+15559876543',
          providerTimeLimit: -1,
          dbCallId: 'call_4',
        }),
      /Invalid providerTimeLimit/,
      'generateOutboundDialTwiml must throw for negative limit'
    );
  });

  // TEST 5 — NON-FINITE LIMIT
  it('TEST 5 — NON-FINITE LIMIT: NaN and Infinity -> FAIL CLOSED', async () => {
    // 5a: NaN
    const authResultNaN = {
      authorized: true,
      reservationId: 'res_test_5a',
      providerTimeLimit: NaN,
      timeLimitSeconds: 300,
      isShadowMode: false,
    };
    const resultNaN = await simulateOutboundDispatchBoundary(authResultNaN);
    assert.equal(resultNaN.canDispatch, false, 'NaN providerTimeLimit must FAIL CLOSED');
    assert.ok(!resultNaN.twiml?.includes('<Dial'), 'No chargeable <Dial> generated for NaN');

    // 5b: Infinity
    const authResultInf = {
      authorized: true,
      reservationId: 'res_test_5b',
      providerTimeLimit: Infinity,
      timeLimitSeconds: 300,
      isShadowMode: false,
    };
    const resultInf = await simulateOutboundDispatchBoundary(authResultInf);
    assert.equal(resultInf.canDispatch, false, 'Infinity providerTimeLimit must FAIL CLOSED');
    assert.ok(!resultInf.twiml?.includes('<Dial'), 'No chargeable <Dial> generated for Infinity');

    // 5c: -Infinity
    const authResultNegInf = {
      authorized: true,
      reservationId: 'res_test_5c',
      providerTimeLimit: -Infinity,
      timeLimitSeconds: 300,
      isShadowMode: false,
    };
    const resultNegInf = await simulateOutboundDispatchBoundary(authResultNegInf);
    assert.equal(resultNegInf.canDispatch, false, '-Infinity providerTimeLimit must FAIL CLOSED');
  });

  // TEST 6 — LEGACY VALUE CANNOT OVERRIDE
  it('TEST 6 — LEGACY VALUE CANNOT OVERRIDE: providerTimeLimit = 300, legacy timeLimitSeconds = 3600 -> <Dial timeLimit="300">', async () => {
    const authResult = {
      authorized: true,
      reservationId: 'res_test_6',
      providerTimeLimit: 300,
      timeLimitSeconds: 3600, // Legacy larger duration
      isShadowMode: false,
    };

    const result = await simulateOutboundDispatchBoundary(authResult);
    assert.equal(result.canDispatch, true);
    assert.ok(result.twiml?.includes('timeLimit="300"'), '<Dial> must strictly use providerTimeLimit="300"');
    assert.ok(!result.twiml?.includes('3600'), '<Dial> MUST NOT use legacy timeLimitSeconds="3600"');
  });

  // TEST 7 — NO DEFAULT 300 FALLBACK
  it('TEST 7 — NO DEFAULT 300 FALLBACK: providerTimeLimit missing -> FAIL CLOSED (NOT 300)', async () => {
    const authResult = {
      authorized: true,
      reservationId: 'res_test_7',
      // providerTimeLimit is absent
      isShadowMode: false,
    };

    const result = await simulateOutboundDispatchBoundary(authResult);
    assert.equal(result.canDispatch, false, 'Missing providerTimeLimit must FAIL CLOSED');
    assert.ok(!result.twiml?.includes('<Dial'), 'Must NOT emit any <Dial>');
    assert.ok(!result.twiml?.includes('300'), 'Must NOT automatically default to 300');
  });

  // TEST 8 — COMPENSATION
  it('TEST 8 — COMPENSATION: Wallet reservation succeeds, then boundary validation fails -> Compensation executes idempotently', async () => {
    const db = new MockAtomicTelecomDatabase(1000);
    const client = db.createSupabaseClientMock();

    // 1. Commit wallet reservation
    const reserveRes = await TelecomWalletService.reserveUsage(client, {
      organizationId: 'org_test_8',
      internalUsageId: 'call:outbound:call_test_8',
      serviceType: 'voice_outbound',
      direction: 'outbound',
      amountReservedMinor: 50,
      idempotencyKey: 'reserve:test_8',
      expiresInSeconds: 1800,
      currency: 'USD',
      provider: 'twilio',
      rateCardId: 'rate_card_1',
    });

    assert.equal(reserveRes.success, true);
    assert.equal(db.reservations.get(reserveRes.reservationId)?.status, 'active');

    // 2. Pre-dispatch validation fails (simulated boundary error)
    const compensated = await VoiceAuthorizationService.compensatePreDispatchFailure(
      client,
      'org_test_8',
      'call:outbound:call_test_8',
      'call_test_8'
    );

    assert.equal(compensated, true, 'First compensation attempt must succeed');
    assert.equal(db.reservations.get(reserveRes.reservationId)?.status, 'released', 'Reservation status must be released');

    // 3. Second compensation attempt (idempotency check: no duplicate release or error)
    const secondCompensated = await VoiceAuthorizationService.compensatePreDispatchFailure(
      client,
      'org_test_8',
      'call:outbound:call_test_8',
      'call_test_8'
    );
    assert.equal(secondCompensated, true, 'Second compensation attempt must be idempotent');
    assert.equal(db.reservations.get(reserveRes.reservationId)?.status, 'released');
  });

  // TEST 9 — FINANCIAL BOUNDARY
  it('TEST 9 — FINANCIAL BOUNDARY: providerTimeLimit derives from committed reservation and is bounded into <Dial timeLimit>', () => {
    const rateCard = {
      retailRateMicro: 100_000, // $0.10 / min
      billingIncrementSeconds: 60,
      minChargeableUnits: 1,
      unitType: 'minute',
    };

    // 50 cents ($0.50) committed reservation hold
    const committedReservationMinor = 50;

    // A. calculateMaxFundedSecondsFromReservation strictly derives maximum billable seconds
    const maxFundedSeconds = VoiceAuthorizationService.calculateMaxFundedSecondsFromReservation(
      rateCard,
      committedReservationMinor
    );
    assert.equal(maxFundedSeconds, 300, '50 cents covers exactly 300 seconds (5 min) at $0.10/min');

    // B. Cost of maxFundedSeconds cannot exceed committedReservationMinor
    const costForFunded = TelecomWalletService.calculateRetailChargeMinor({
      retailRateMicro: rateCard.retailRateMicro,
      durationSeconds: maxFundedSeconds,
      billingIncrementSeconds: 60,
      minChargeableUnits: 1,
      unitType: 'minute',
    });
    assert.ok(costForFunded <= committedReservationMinor, `Cost (${costForFunded}) <= reserved (${committedReservationMinor})`);

    // C. providerTimeLimit passed directly to generateOutboundDialTwiml
    const twiml = generateOutboundDialTwiml({
      callerId: '+15551234567',
      destination: '+15559876543',
      providerTimeLimit: maxFundedSeconds,
      dbCallId: 'call_9',
    });

    assert.ok(twiml.includes('timeLimit="300"'), '<Dial> must strictly reflect funded reservation bound');

    // D. Confirm no downstream path can increase provider exposure:
    // If providerTimeLimit is clamped or reduced by risk policy (e.g. 180s):
    const clampedProviderLimit = Math.min(maxFundedSeconds, 180);
    const clampedTwiml = generateOutboundDialTwiml({
      callerId: '+15551234567',
      destination: '+15559876543',
      providerTimeLimit: clampedProviderLimit,
      dbCallId: 'call_9_clamped',
    });
    assert.ok(clampedTwiml.includes('timeLimit="180"'), 'Clamped provider limit is passed directly with no increase');
  });
});
