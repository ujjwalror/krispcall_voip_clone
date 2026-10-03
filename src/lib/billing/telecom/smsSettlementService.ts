import { SupabaseClient } from '@supabase/supabase-js';
import { TelecomWalletService } from '../telecomWalletService';
import { TelecomWholesaleService } from './telecomWholesaleService';

export interface ProcessMessageStatusCallbackParams {
  organizationId: string;
  clientSendId: string;
  messageSid: string;
  status: string;
  providerSegments?: number | null;
  providerPrice?: string | number | null;
  errorCode?: string | null;
  payload?: Record<string, any>;
}

export interface ValidatedSmsRateSnapshot {
  retailRateMicro: number;
  unitType: string;
  currency: string;
}

export interface SmsSettlementResult {
  success: boolean;
  settled: boolean;
  released: boolean;
  isDuplicate: boolean;
  retailChargeMinor: number;
  providerSegments: number;
  reservationId?: string;
  ledgerId?: string | null;
  reconciliationRequired: boolean;
  reason: string;
}

export class SmsSettlementService {
  /**
   * Validates rate snapshot JSONB stored during pre-send authorization.
   */
  public static validateRateSnapshot(snapshot: any, reservationCurrency: string = 'USD'): ValidatedSmsRateSnapshot | null {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return null;
    }

    const rateMicro = snapshot.retailRateMicro ?? snapshot.rateMicro;
    if (typeof rateMicro !== 'number' || !Number.isInteger(rateMicro) || rateMicro < 0) {
      return null;
    }

    const unitType = snapshot.unitType ?? 'message';
    if (typeof unitType !== 'string' || !['message', 'event'].includes(unitType)) {
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
      unitType,
      currency,
    };
  }

  /**
   * Process terminal SMS/MMS status callback.
   * Performs atomic MessageSid identity linkage, followed by authoritative settlement or zero-charge release.
   */
  public static async processMessageStatusCallback(
    client: SupabaseClient,
    params: ProcessMessageStatusCallbackParams
  ): Promise<SmsSettlementResult> {
    const {
      organizationId,
      clientSendId,
      messageSid,
      status,
      providerSegments = null,
      providerPrice = null,
      errorCode = null,
      payload = {},
    } = params;

    if (!organizationId || !clientSendId || !messageSid) {
      return {
        success: false,
        settled: false,
        released: false,
        isDuplicate: false,
        retailChargeMinor: 0,
        providerSegments: 0,
        reconciliationRequired: true,
        reason: 'INVALID_INPUT_PARAMETERS',
      };
    }

    const internalUsageId = `msg:outbound:${clientSendId}`;
    const componentId = `comp:msg:${clientSendId}`;
    const sessionId = clientSendId;
    const normalizedStatus = (status || '').toLowerCase().trim();

    // 1. ATOMIC DATABASE-LEVEL PROVIDER MESSAGESID LINKAGE
    const { data: linkRes, error: linkErr } = await (client as any).rpc(
      'link_telecom_message_provider_resource_atomic',
      {
        p_organization_id: organizationId,
        p_session_id: sessionId,
        p_component_id: componentId,
        p_provider_message_sid: messageSid,
      }
    );

    if (linkErr) {
      const errMsg = linkErr.message || '';
      console.error('[SmsSettlementService] Atomic MessageSid linkage failed:', errMsg);

      if (errMsg.includes('MESSAGE_SID_MISMATCH')) {
        await this.markManualReview(client, organizationId, sessionId, 'MESSAGE_SID_MISMATCH');
        return {
          success: false,
          settled: false,
          released: false,
          isDuplicate: false,
          retailChargeMinor: 0,
          providerSegments: 0,
          reconciliationRequired: true,
          reason: 'MESSAGE_SID_MISMATCH',
        };
      }

      await this.markManualReview(client, organizationId, sessionId, `IDENTITY_LINKAGE_FAILED_${errMsg}`);
      return {
        success: false,
        settled: false,
        released: false,
        isDuplicate: false,
        retailChargeMinor: 0,
        providerSegments: 0,
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
      console.error('[SmsSettlementService] Database error querying reservation:', resErr.message);
      return {
        success: false,
        settled: false,
        released: false,
        isDuplicate: false,
        retailChargeMinor: 0,
        providerSegments: 0,
        reconciliationRequired: true,
        reason: 'RESERVATION_QUERY_ERROR',
      };
    }

    // Handle calls with NO active reservation (historical / shadow mode)
    if (!reservation) {
      console.log(`[SmsSettlementService] No reservation found for ${internalUsageId}. Message ran outside enforce mode.`);
      return {
        success: true,
        settled: false,
        released: false,
        isDuplicate: false,
        retailChargeMinor: 0,
        providerSegments: 0,
        reconciliationRequired: false,
        reason: 'NO_RESERVATION_EXISTS',
      };
    }

    // 3. Handle reservation idempotency
    if (reservation.status === 'settled') {
      return {
        success: true,
        settled: true,
        released: false,
        isDuplicate: true,
        retailChargeMinor: Number(reservation.actual_customer_charge_minor || 0),
        providerSegments: Number(payload.num_segments || providerSegments || 1),
        reservationId: reservation.id,
        ledgerId: reservation.settlement_ledger_id,
        reconciliationRequired: false,
        reason: 'ALREADY_SETTLED',
      };
    }

    if (reservation.status === 'released' || reservation.status === 'expired') {
      return {
        success: true,
        settled: false,
        released: true,
        isDuplicate: true,
        retailChargeMinor: 0,
        providerSegments: 0,
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
        providerSegments: 0,
        reconciliationRequired: true,
        reason: `UNEXPECTED_RESERVATION_STATUS_${reservation.status.toUpperCase()}`,
      };
    }

    // 4. Classify Status & Segment Count
    const actualSegments = Math.max(1, providerSegments ?? payload.num_segments ?? reservation.duration_seconds ?? 1);

    // CASE C: Authoritative Zero-Cost Evidence (providerPrice explicitly "0.00" or 0)
    // BLOCKER 1 FIX: Error codes alone (30007, 30008, 21614) MUST NEVER authorize zero-charge release after MessageSid exists.
    const hasZeroProviderPrice = providerPrice !== null && (providerPrice === '0.00' || providerPrice === 0 || String(providerPrice).trim() === '0');

    if ((normalizedStatus === 'failed' || normalizedStatus === 'undelivered') && hasZeroProviderPrice) {
      console.log(`[SmsSettlementService] Releasing reservation with zero charge for ${internalUsageId} (status: ${normalizedStatus}, providerPrice: 0.00)`);

      const releaseRes = await TelecomWalletService.releaseUsage(client, {
        organizationId,
        internalUsageId,
        reason: `message_terminal_${normalizedStatus}_zero_provider_price`,
        idempotencyKey: `release:sms:${clientSendId}`,
      });

      return {
        success: releaseRes.success,
        settled: false,
        released: true,
        isDuplicate: releaseRes.isDuplicate,
        retailChargeMinor: 0,
        providerSegments: actualSegments,
        reservationId: reservation.id,
        reconciliationRequired: false,
        reason: `ZERO_CHARGE_RELEASE_${normalizedStatus.toUpperCase()}`,
      };
    }

    // CASE D: Authoritative Settlement for Delivered / Sent / Chargeable Failed messages
    if (['delivered', 'sent', 'undelivered', 'failed'].includes(normalizedStatus)) {
      const rateSnapshot = this.validateRateSnapshot(reservation.rate_snapshot, reservation.currency);

      if (!rateSnapshot) {
        console.error(`[SmsSettlementService] Rate snapshot invalid or missing for reservation ${reservation.id}. Flagging manual review.`);
        await this.markManualReview(client, organizationId, sessionId, 'INVALID_RATE_SNAPSHOT');
        return {
          success: false,
          settled: false,
          released: false,
          isDuplicate: false,
          retailChargeMinor: 0,
          providerSegments: actualSegments,
          reconciliationRequired: true,
          reason: 'INVALID_RATE_SNAPSHOT',
        };
      }

      // Calculate calculated charge
      const calculatedChargeMinor = TelecomWalletService.calculateRetailChargeMinor({
        retailRateMicro: rateSnapshot.retailRateMicro,
        durationSeconds: actualSegments,
        unitType: rateSnapshot.unitType,
      });

      // OVER-SEGMENT EXPOSURE PROTECTION (INVARIANT RULE: Settlement <= Reserved)
      let actualRetailChargeMinor = calculatedChargeMinor;
      let reconciliationRequired = false;
      let settleReason = 'SETTLED_SUCCESSFULLY';

      if (calculatedChargeMinor > reservation.amount_reserved_minor) {
        console.warn(`[SmsSettlementService] Over-segment usage detected for ${internalUsageId}: calculated ${calculatedChargeMinor}¢ > reserved ${reservation.amount_reserved_minor}¢. Capping customer debit at reserved amount.`);
        actualRetailChargeMinor = reservation.amount_reserved_minor;
        reconciliationRequired = true;
        settleReason = 'SETTLED_WITH_OVERSEGMENT_CAP';

        await this.markManualReview(client, organizationId, sessionId, `OVERSEGMENT_DISCREPANCY_CALCULATED_${calculatedChargeMinor}_RESERVED_${reservation.amount_reserved_minor}`);
      }

      console.log(`[SmsSettlementService] Settling usage for ${internalUsageId}: segments=${actualSegments}, rateMicro=${rateSnapshot.retailRateMicro}, charge=${actualRetailChargeMinor}¢`);

      const settleRes = await TelecomWalletService.settleUsage(client, {
        organizationId,
        internalUsageId,
        actualRetailChargeMinor,
        description: `Outbound message (${actualSegments} segment${actualSegments > 1 ? 's' : ''})`,
        idempotencyKey: `settle:sms:${clientSendId}`,
        providerResourceId: messageSid,
        metadata: {
          segments: actualSegments,
          message_sid: messageSid,
          calculated_charge_minor: calculatedChargeMinor,
          capped_charge_minor: actualRetailChargeMinor,
          error_code: errorCode || null,
        },
      });

      // Record confidential provider cost observation if price evidence exists
      const rawPriceText = providerPrice !== null && providerPrice !== undefined ? String(providerPrice) : payload?.Price || payload?.price || null;
      if (rawPriceText) {
        await TelecomWholesaleService.recordTwilioCallbackCostObservation(client, {
          organizationId,
          internalUsageId,
          rawPriceText,
          costSource: 'twilio_sms_callback',
          resourceId: messageSid,
          settlementLedgerId: settleRes.settlementLedgerId,
          retailChargeMinor: actualRetailChargeMinor,
          rawPayload: payload,
        });
      }

      return {
        success: settleRes.success,
        settled: true,
        released: false,
        isDuplicate: settleRes.isDuplicate,
        retailChargeMinor: actualRetailChargeMinor,
        providerSegments: actualSegments,
        reservationId: reservation.id,
        ledgerId: settleRes.settlementLedgerId,
        reconciliationRequired,
        reason: settleReason,
      };
    }

    // CASE E: Non-terminal status (queued, sending) -> preserve active reservation
    return {
      success: true,
      settled: false,
      released: false,
      isDuplicate: false,
      retailChargeMinor: 0,
      providerSegments: 0,
      reconciliationRequired: false,
      reason: `NON_TERMINAL_STATUS_${normalizedStatus.toUpperCase()}`,
    };
  }

  private static async markManualReview(
    client: SupabaseClient,
    organizationId: string,
    sessionId: string,
    reason: string
  ): Promise<void> {
    try {
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
      console.error('[SmsSettlementService] Error marking manual review:', err);
    }
  }
}
