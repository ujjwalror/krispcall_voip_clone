import { SupabaseClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import { TelecomWalletService } from '../telecomWalletService';
import { TelecomRatingService } from './telecomRatingService';

export interface ProcessChildStatusCallbackParams {
  organizationId: string;
  dbCallId: string;
  callSid: string;
  parentCallSid?: string | null;
  callStatus: string;
  callDurationStr?: string | null;
  payload?: Record<string, any>;
  twilioClientOverride?: any; // For unit/integration test mocking
}

export interface ValidatedRateSnapshot {
  retailRateMicro: number;
  billingIncrementSeconds: number;
  minChargeableUnits: number;
  unitType: string;
  currency: string;
}

export interface VoiceSettlementResult {
  success: boolean;
  settled: boolean;
  released: boolean;
  isDuplicate: boolean;
  retailChargeMinor: number;
  durationSeconds: number;
  reservationId?: string;
  ledgerId?: string | null;
  reconciliationRequired: boolean;
  reason: string;
}

export class VoiceSettlementService {
  /**
   * Structurally validates the immutable rate_snapshot JSONB object stored during B.2B authorization.
   * Defect 4 Fix: If both rateMicro and retailRateMicro are present and differ, FAILS CLOSED.
   */
  public static validateRateSnapshot(snapshot: any, reservationCurrency: string = 'USD'): ValidatedRateSnapshot | null {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return null;
    }

    const hasRateMicro = typeof snapshot.rateMicro === 'number' && Number.isInteger(snapshot.rateMicro) && snapshot.rateMicro >= 0;
    const hasRetailRateMicro = typeof snapshot.retailRateMicro === 'number' && Number.isInteger(snapshot.retailRateMicro) && snapshot.retailRateMicro >= 0;

    if (!hasRateMicro && !hasRetailRateMicro) {
      return null;
    }

    // Contradiction check: If both fields exist, they MUST be identical
    if (hasRateMicro && hasRetailRateMicro && snapshot.rateMicro !== snapshot.retailRateMicro) {
      console.error('[VoiceSettlementService] Contradiction in rate snapshot: rateMicro !== retailRateMicro', {
        rateMicro: snapshot.rateMicro,
        retailRateMicro: snapshot.retailRateMicro,
      });
      return null;
    }

    const rateMicro = hasRetailRateMicro ? snapshot.retailRateMicro : snapshot.rateMicro;

    const increment = snapshot.billingIncrementSeconds ?? 60;
    if (typeof increment !== 'number' || !Number.isInteger(increment) || increment <= 0) {
      return null;
    }

    const minUnits = snapshot.minChargeableUnits ?? 1;
    if (typeof minUnits !== 'number' || !Number.isInteger(minUnits) || minUnits < 0) {
      return null;
    }

    const unitType = snapshot.unitType ?? 'minute';
    if (typeof unitType !== 'string' || !['minute', 'message', 'event'].includes(unitType)) {
      return null;
    }

    const currency = (snapshot.currency || reservationCurrency || 'USD').toUpperCase();
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      return null;
    }

    if (reservationCurrency && currency !== reservationCurrency.toUpperCase()) {
      return null; // Currency mismatch
    }

    return {
      retailRateMicro: rateMicro,
      billingIncrementSeconds: increment,
      minChargeableUnits: minUnits,
      unitType,
      currency,
    };
  }

  /**
   * Shared Canonical Rating Helper.
   * Reuses TelecomWalletService.calculateRetailChargeMinor to guarantee 100% rating equivalence
   * between authorization exposure calculation and final retail settlement.
   * Defect 1 & Defect 3 Fix: Model A integer-safe per-minute rating with BigInt intermediate precision.
   */
  public static calculateSettlementChargeMinor(
    snapshot: ValidatedRateSnapshot,
    durationSeconds: number
  ): number {
    return TelecomWalletService.calculateRetailChargeMinor({
      retailRateMicro: snapshot.retailRateMicro,
      durationSeconds,
      billingIncrementSeconds: snapshot.billingIncrementSeconds,
      minChargeableUnits: snapshot.minChargeableUnits,
      unitType: snapshot.unitType,
    });
  }

  /**
   * Process incoming signed terminal callback for outbound PSTN calls.
   * Performs atomic child CallSid identity linkage, followed by authoritative settlement or zero-charge release.
   */
  public static async processChildStatusCallback(
    client: SupabaseClient,
    params: ProcessChildStatusCallbackParams
  ): Promise<VoiceSettlementResult> {
    const {
      organizationId,
      dbCallId,
      callSid,
      parentCallSid = null,
      callStatus,
      callDurationStr,
      payload = {},
      twilioClientOverride,
    } = params;

    if (!organizationId || !dbCallId || !callSid) {
      return {
        success: false,
        settled: false,
        released: false,
        isDuplicate: false,
        retailChargeMinor: 0,
        durationSeconds: 0,
        reconciliationRequired: true,
        reason: 'INVALID_INPUT_PARAMETERS',
      };
    }

    const internalUsageId = `call:outbound:${dbCallId}`;
    const componentId = `comp:pstn_outbound:${dbCallId}`;
    const sessionId = dbCallId;
    const normalizedStatus = (callStatus || '').toLowerCase().trim();

    // 1. DEFECT 2 FIX: ATOMIC DATABASE-LEVEL CHILD PROVIDER RESOURCES LINKAGE
    const { data: linkRes, error: linkErr } = await (client as any).rpc(
      'link_telecom_child_provider_resource_atomic',
      {
        p_organization_id: organizationId,
        p_session_id: sessionId,
        p_component_id: componentId,
        p_child_provider_resource_id: callSid,
        p_parent_provider_resource_id: parentCallSid || null,
      }
    );

    if (linkErr) {
      const errMsg = linkErr.message || '';
      console.error('[VoiceSettlementService] Atomic child CallSid linkage failed:', errMsg);

      if (errMsg.includes('CHILD_CALLSID_MISMATCH')) {
        await this.markManualReview(client, organizationId, dbCallId, 'CHILD_CALLSID_MISMATCH');
        return {
          success: false,
          settled: false,
          released: false,
          isDuplicate: false,
          retailChargeMinor: 0,
          durationSeconds: 0,
          reconciliationRequired: true,
          reason: 'CHILD_CALLSID_MISMATCH',
        };
      }

      if (errMsg.includes('PARENT_CALLSID_MISMATCH')) {
        await this.markManualReview(client, organizationId, dbCallId, 'PARENT_CALLSID_MISMATCH');
        return {
          success: false,
          settled: false,
          released: false,
          isDuplicate: false,
          retailChargeMinor: 0,
          durationSeconds: 0,
          reconciliationRequired: true,
          reason: 'PARENT_CALLSID_MISMATCH',
        };
      }

      await this.markManualReview(client, organizationId, dbCallId, `IDENTITY_LINKAGE_FAILED_${errMsg}`);
      return {
        success: false,
        settled: false,
        released: false,
        isDuplicate: false,
        retailChargeMinor: 0,
        durationSeconds: 0,
        reconciliationRequired: true,
        reason: 'IDENTITY_LINKAGE_FAILED',
      };
    }

    // 2. Fetch reservation strictly by (organization_id, internal_usage_id)
    const { data: reservation, error: resErr } = await client
      .from('telecom_usage_reservations')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('internal_usage_id', internalUsageId)
      .maybeSingle();

    if (resErr) {
      console.error('[VoiceSettlementService] Database error querying reservation:', resErr.message);
      return {
        success: false,
        settled: false,
        released: false,
        isDuplicate: false,
        retailChargeMinor: 0,
        durationSeconds: 0,
        reconciliationRequired: true,
        reason: 'RESERVATION_QUERY_ERROR',
      };
    }

    // 3. Handle calls with NO active reservation (e.g. shadow_log / disabled mode calls)
    if (!reservation) {
      console.log(`[VoiceSettlementService] No reservation found for ${internalUsageId}. Historical call ran outside enforce mode.`);
      return {
        success: true,
        settled: false,
        released: false,
        isDuplicate: false,
        retailChargeMinor: 0,
        durationSeconds: 0,
        reconciliationRequired: false,
        reason: 'NO_RESERVATION_EXISTS',
      };
    }

    // 4. Handle reservation status idempotency
    if (reservation.status === 'settled') {
      console.log(`[VoiceSettlementService] Reservation ${reservation.id} is already settled.`);
      return {
        success: true,
        settled: true,
        released: false,
        isDuplicate: true,
        retailChargeMinor: Number(reservation.actual_customer_charge_minor || 0),
        durationSeconds: Number(payload.CallDuration || callDurationStr || 0),
        reservationId: reservation.id,
        ledgerId: reservation.settlement_ledger_id,
        reconciliationRequired: false,
        reason: 'ALREADY_SETTLED',
      };
    }

    if (reservation.status === 'released' || reservation.status === 'expired') {
      console.log(`[VoiceSettlementService] Reservation ${reservation.id} is already ${reservation.status}.`);
      return {
        success: true,
        settled: false,
        released: true,
        isDuplicate: true,
        retailChargeMinor: 0,
        durationSeconds: 0,
        reservationId: reservation.id,
        reconciliationRequired: false,
        reason: `ALREADY_${reservation.status.toUpperCase()}`,
      };
    }

    if (reservation.status !== 'active') {
      return {
        success: false,
        settled: false,
        released: false,
        isDuplicate: false,
        retailChargeMinor: 0,
        durationSeconds: 0,
        reconciliationRequired: true,
        reason: `UNEXPECTED_RESERVATION_STATUS_${reservation.status.toUpperCase()}`,
      };
    }

    // 5. Classify Call Status & Duration
    const zeroChargeOutcomes = ['busy', 'failed', 'no-answer', 'canceled'];
    const isZeroChargeOutcome = zeroChargeOutcomes.includes(normalizedStatus);

    let parsedDuration: number | null = null;
    if (callDurationStr !== undefined && callDurationStr !== null && callDurationStr.trim() !== '') {
      const p = parseInt(callDurationStr.trim(), 10);
      if (!Number.isNaN(p) && p >= 0) {
        parsedDuration = p;
      }
    }

    // A. Authoritative Zero-Charge Outcome (busy, failed, no-answer, canceled, or completed with 0s duration)
    if (isZeroChargeOutcome || (normalizedStatus === 'completed' && parsedDuration === 0)) {
      console.log(`[VoiceSettlementService] Releasing reservation with zero charge for ${internalUsageId} (status: ${normalizedStatus}, duration: ${parsedDuration ?? 0}s)`);

      const releaseRes = await TelecomWalletService.releaseUsage(client, {
        organizationId,
        internalUsageId,
        reason: `call_terminal_${normalizedStatus}`,
        idempotencyKey: `release:outbound:${dbCallId}`,
      });

      // Update PSTN component and session records
      await this.updateDomainRecords(client, {
        organizationId,
        dbCallId,
        callSid,
        parentCallSid,
        durationSeconds: 0,
        retailChargeMinor: 0,
        sessionStatus: 'completed',
        reconciliationStatus: 'reconciled',
      });

      return {
        success: releaseRes.success,
        settled: false,
        released: true,
        isDuplicate: releaseRes.isDuplicate,
        retailChargeMinor: 0,
        durationSeconds: 0,
        reservationId: reservation.id,
        reconciliationRequired: false,
        reason: `ZERO_CHARGE_RELEASE_${normalizedStatus.toUpperCase()}`,
      };
    }

    // B. Completed Outcome with Missing / Malformed Duration -> Conditional READ-ONLY Provider Fetch
    if (normalizedStatus === 'completed' && parsedDuration === null) {
      console.warn(`[VoiceSettlementService] Terminal completed status callback missing duration for ${internalUsageId}. Attempting conditional read-only provider fetch.`);

      const fetchedDuration = await this.fetchProviderCallDuration(callSid, twilioClientOverride);

      if (fetchedDuration === null) {
        console.error(`[VoiceSettlementService] Read-only provider fetch failed or returned non-terminal duration for ${callSid}. Flagging manual review.`);
        await this.markManualReview(client, organizationId, dbCallId, 'MISSING_AUTHORITATIVE_DURATION');
        return {
          success: false,
          settled: false,
          released: false,
          isDuplicate: false,
          retailChargeMinor: 0,
          durationSeconds: 0,
          reconciliationRequired: true,
          reason: 'MISSING_AUTHORITATIVE_DURATION',
        };
      }

      parsedDuration = fetchedDuration;
    }

    // C. Completed Outcome with Positive Duration (> 0) -> Authoritative Settlement
    if (normalizedStatus === 'completed' && parsedDuration !== null && parsedDuration > 0) {
      const rateSnapshot = this.validateRateSnapshot(reservation.rate_snapshot, reservation.currency);

      if (!rateSnapshot) {
        console.error(`[VoiceSettlementService] Rate snapshot invalid, contradictory, or missing for reservation ${reservation.id}. Flagging manual review.`);
        await this.markManualReview(client, organizationId, dbCallId, 'INVALID_RATE_SNAPSHOT');
        return {
          success: false,
          settled: false,
          released: false,
          isDuplicate: false,
          retailChargeMinor: 0,
          durationSeconds: parsedDuration,
          reconciliationRequired: true,
          reason: 'INVALID_RATE_SNAPSHOT',
        };
      }

      const actualRetailChargeMinor = this.calculateSettlementChargeMinor(rateSnapshot, parsedDuration);

      console.log(`[VoiceSettlementService] Settling usage for ${internalUsageId}: duration=${parsedDuration}s, rateMicro=${rateSnapshot.retailRateMicro}, charge=${actualRetailChargeMinor} cents`);

      const settleRes = await TelecomWalletService.settleUsage(client, {
        organizationId,
        internalUsageId,
        actualRetailChargeMinor,
        description: `Outbound PSTN call (${parsedDuration}s)`,
        idempotencyKey: `settle:outbound:${dbCallId}`,
        providerResourceId: callSid,
        metadata: {
          duration_seconds: parsedDuration,
          call_sid: callSid,
          parent_call_sid: parentCallSid,
        },
      });

      // Update PSTN component and session records
      await this.updateDomainRecords(client, {
        organizationId,
        dbCallId,
        callSid,
        parentCallSid,
        durationSeconds: parsedDuration,
        retailChargeMinor: actualRetailChargeMinor,
        sessionStatus: 'completed',
        reconciliationStatus: 'reconciled',
      });

      return {
        success: settleRes.success,
        settled: true,
        released: false,
        isDuplicate: settleRes.isDuplicate,
        retailChargeMinor: actualRetailChargeMinor,
        durationSeconds: parsedDuration,
        reservationId: reservation.id,
        ledgerId: settleRes.settlementLedgerId,
        reconciliationRequired: false,
        reason: 'SETTLED_SUCCESSFULLY',
      };
    }

    // D. Non-terminal status (initiated, ringing, in-progress) -> preserve active reservation
    if (['initiated', 'ringing', 'in-progress'].includes(normalizedStatus)) {
      return {
        success: true,
        settled: false,
        released: false,
        isDuplicate: false,
        retailChargeMinor: 0,
        durationSeconds: 0,
        reconciliationRequired: false,
        reason: `NON_TERMINAL_STATUS_${normalizedStatus.toUpperCase()}`,
      };
    }

    // E. Ambiguous / Unknown Status -> Flag Manual Review, retain reservation hold
    console.error(`[VoiceSettlementService] Unrecognized call status "${normalizedStatus}" for ${internalUsageId}. Flagging manual review.`);
    await this.markManualReview(client, organizationId, dbCallId, `UNKNOWN_CALL_STATUS_${normalizedStatus}`);
    return {
      success: false,
      settled: false,
      released: false,
      isDuplicate: false,
      retailChargeMinor: 0,
      durationSeconds: 0,
      reconciliationRequired: true,
      reason: `UNKNOWN_CALL_STATUS_${normalizedStatus.toUpperCase()}`,
    };
  }

  /**
   * Helper: Performs a safe, bounded READ-ONLY provider fetch to retrieve call duration.
   */
  private static async fetchProviderCallDuration(
    callSid: string,
    clientOverride?: any
  ): Promise<number | null> {
    try {
      if (clientOverride) {
        const res = await clientOverride.calls(callSid).fetch();
        const d = parseInt(res.duration || '0', 10);
        return !Number.isNaN(d) ? d : null;
      }

      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;

      if (!accountSid || !authToken) {
        console.warn('[VoiceSettlementService] Twilio credentials missing for provider fetch.');
        return null;
      }

      const client = twilio(accountSid, authToken);
      const callRes = await client.calls(callSid).fetch();

      if (callRes && callRes.duration) {
        const dur = parseInt(callRes.duration, 10);
        return !Number.isNaN(dur) ? dur : null;
      }

      return null;
    } catch (err: any) {
      console.error('[VoiceSettlementService] Exception during read-only provider fetch:', err.message || err);
      return null;
    }
  }

  /**
   * Helper: Updates durable domain records (telecom_usage_components & telecom_usage_sessions).
   */
  private static async updateDomainRecords(
    client: SupabaseClient,
    params: {
      organizationId: string;
      dbCallId: string;
      callSid: string;
      parentCallSid?: string | null;
      durationSeconds: number;
      retailChargeMinor: number;
      sessionStatus: string;
      reconciliationStatus: string;
    }
  ): Promise<void> {
    const {
      organizationId,
      dbCallId,
      callSid,
      parentCallSid,
      durationSeconds,
      retailChargeMinor,
      sessionStatus,
      reconciliationStatus,
    } = params;

    const componentId = `comp:pstn_outbound:${dbCallId}`;
    const sessionId = dbCallId;
    const nowIso = new Date().toISOString();

    try {
      // Update component record
      await client
        .from('telecom_usage_components')
        .update({
          child_provider_resource_id: callSid,
          parent_provider_resource_id: parentCallSid || null,
          duration_seconds: durationSeconds,
          retail_charge_minor: retailChargeMinor,
          reconciliation_status: reconciliationStatus,
          updated_at: nowIso,
        })
        .eq('organization_id', organizationId)
        .eq('component_id', componentId);

      // Update session record
      await client
        .from('telecom_usage_sessions')
        .update({
          status: sessionStatus,
          total_retail_charge_minor: retailChargeMinor,
          reconciliation_status: reconciliationStatus,
          updated_at: nowIso,
        })
        .eq('organization_id', organizationId)
        .eq('session_id', sessionId);
    } catch (err: any) {
      console.warn('[VoiceSettlementService] Non-fatal error updating domain records:', err.message || err);
    }
  }

  /**
   * Helper: Marks session reconciliation_status = 'manual_review' when ambiguity occurs.
   */
  private static async markManualReview(
    client: SupabaseClient,
    organizationId: string,
    dbCallId: string,
    reason: string
  ): Promise<void> {
    try {
      const sessionId = dbCallId;
      await client
        .from('telecom_usage_sessions')
        .update({
          reconciliation_status: 'manual_review',
          metadata: { manual_review_reason: reason },
          updated_at: new Date().toISOString(),
        })
        .eq('organization_id', organizationId)
        .eq('session_id', sessionId);
    } catch (err: any) {
      console.error('[VoiceSettlementService] Error marking manual review:', err);
    }
  }
}
