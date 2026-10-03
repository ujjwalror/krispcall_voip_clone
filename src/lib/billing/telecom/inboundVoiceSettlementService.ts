import { SupabaseClient } from '@supabase/supabase-js';
import { TelecomWalletService } from '../telecomWalletService';
import { TelecomDomainService } from './telecomDomainService';
import { TelecomWholesaleService } from './telecomWholesaleService';
import { RateResolutionResult } from './types';

const MESSAGE_STATUS_PRECEDENCE: Record<string, number> = {
  initiated: 10,
  ringing: 20,
  'in-progress': 30,
  answered: 30,
  completed: 40,
  'no-answer': 40,
  busy: 40,
  canceled: 40,
  failed: 40,
};

export function shouldUpdateInboundCallStatus(currentStatus: string, newStatus: string): boolean {
  const currentRank = MESSAGE_STATUS_PRECEDENCE[currentStatus.toLowerCase()] || 0;
  const newRank = MESSAGE_STATUS_PRECEDENCE[newStatus.toLowerCase()] || 0;
  return newRank >= currentRank;
}

export interface InboundCallStatusCallbackParams {
  callSid: string;
  parentCallSid?: string;
  dialCallSid?: string;
  callStatus: string;
  dialCallStatus?: string;
  callDuration?: string | number;
  dialCallDuration?: string | number;
  sequenceNumber?: string | number;
  providerPrice?: string | number;
}

export interface InboundSettlementResult {
  settled: boolean;
  status: 'settled' | 'released_zero_charge' | 'manual_review_held' | 'ignored_out_of_order' | 'idempotent';
  settledAmountMinor: number;
  reconciliationStatus: 'reconciled' | 'manual_review' | 'pending';
}

export class InboundVoiceSettlementService {
  /**
   * Processes terminal inbound voice status callback.
   * Settles retail usage against authorization rate snapshot, bounded by reserved exposure.
   * Enforces zero-charge release ONLY when provider zero cost is authoritatively established.
   */
  public static async processInboundCallStatusCallback(
    client: SupabaseClient,
    params: InboundCallStatusCallbackParams
  ): Promise<InboundSettlementResult> {
    const {
      callSid,
      parentCallSid,
      dialCallSid,
      callStatus,
      dialCallStatus,
      callDuration,
      dialCallDuration,
      sequenceNumber,
      providerPrice,
    } = params;

    const cleanCallSid = (callSid || '').trim();
    if (!cleanCallSid) {
      throw new Error('InboundVoiceSettlementService: Missing CallSid');
    }

    const normStatus = (callStatus || '').toLowerCase();
    const isTerminal = ['completed', 'no-answer', 'busy', 'canceled', 'failed'].includes(normStatus);

    // 1. Locate reservation record
    const internalUsageId = `inbound_call_${cleanCallSid}`;
    const { data: reservation, error: resErr } = await client
      .from('telecom_usage_reservations')
      .select('*')
      .eq('internal_usage_id', internalUsageId)
      .maybeSingle();

    if (resErr) {
      throw new Error(`InboundVoiceSettlementService: DB error fetching reservation: ${resErr.message}`);
    }

    if (!reservation) {
      return {
        settled: false,
        status: 'manual_review_held',
        settledAmountMinor: 0,
        reconciliationStatus: 'manual_review',
      };
    }

    if (reservation.status === 'released' || reservation.status === 'settled') {
      return {
        settled: true,
        status: 'idempotent',
        settledAmountMinor: Number(reservation.amount_settled_minor || 0),
        reconciliationStatus: 'reconciled',
      };
    }

    const organizationId = reservation.organization_id;
    const reservedAmountMinor = Number(reservation.amount_reserved_minor || 0);
    const rateSnapshot: RateResolutionResult = reservation.metadata?.rateSnapshot || reservation.rate_snapshot;

    // 2. Link child DialCallSid atomically if present
    if (dialCallSid && dialCallSid.trim()) {
      const cleanDialSid = dialCallSid.trim();
      const componentId = `comp_inbound_pstn_${cleanCallSid}`;
      const sessionId = `sess_inbound_${cleanCallSid}`;

      try {
        const { data: linkRes, error: linkErr } = await client.rpc('link_telecom_child_provider_resource_atomic', {
          p_organization_id: organizationId,
          p_session_id: sessionId,
          p_component_id: componentId,
          p_child_provider_resource_id: cleanDialSid,
        });

        if (linkErr) {
          if (linkErr.message.includes('CHILD_PROVIDER_RESOURCE_MISMATCH')) {
            throw new Error(`CALL_SID_MISMATCH: Conflicting child DialCallSid ${cleanDialSid} for component ${componentId}`);
          }
        }
      } catch (linkCatch: any) {
        if (linkCatch.message.includes('CALL_SID_MISMATCH')) {
          throw linkCatch;
        }
        console.warn('[InboundVoiceSettlementService] Non-fatal child link notice:', linkCatch.message || linkCatch);
      }
    }

    if (!isTerminal) {
      return {
        settled: false,
        status: 'manual_review_held',
        settledAmountMinor: 0,
        reconciliationStatus: 'pending',
      };
    }

    // 3. Determine authoritative duration
    let durationSec = 0;
    if (dialCallDuration !== undefined && dialCallDuration !== '' && dialCallDuration !== null) {
      durationSec = parseInt(String(dialCallDuration), 10) || 0;
    } else if (callDuration !== undefined && callDuration !== '' && callDuration !== null) {
      durationSec = parseInt(String(callDuration), 10) || 0;
    }

    // 4. Case A: Terminal call with positive connected duration
    if (durationSec > 0 && rateSnapshot) {
      const retailRateMicro = rateSnapshot.retailRateMicro || 0;
      const billingIncrementSeconds = rateSnapshot.billingIncrementSeconds || 60;
      const minChargeableUnits = rateSnapshot.minChargeableUnits || 1;

      const calculatedChargeMinor = TelecomWalletService.calculateRetailChargeMinor({
        retailRateMicro,
        durationSeconds: durationSec,
        unitType: rateSnapshot.unitType || 'minute',
        billingIncrementSeconds,
        minChargeableUnits,
      });

      // CAP INVARIANT: settlement amount MUST NOT exceed reserved exposure
      const isOverage = calculatedChargeMinor > reservedAmountMinor;
      const settlementChargeMinor = isOverage ? reservedAmountMinor : calculatedChargeMinor;
      const reconciliationStatus = isOverage ? 'manual_review' : 'reconciled';

      const idempotencyKey = `idemp_inbound_settle_${cleanCallSid}`;

      await TelecomWalletService.settleUsage(client, {
        organizationId,
        internalUsageId,
        actualRetailChargeMinor: settlementChargeMinor,
        description: `Inbound call settlement (${durationSec}s)`,
        idempotencyKey,
        metadata: {
          callSid: cleanCallSid,
          durationSeconds: durationSec,
          calculatedChargeMinor,
          reservedAmountMinor,
          isOverage,
        },
      });

      if (isOverage) {
        await client
          .from('telecom_usage_sessions')
          .update({ reconciliation_status: 'manual_review' })
          .eq('session_id', `sess_inbound_${cleanCallSid}`);
      }

      // Record confidential provider cost observation if price evidence exists
      const rawPriceText = providerPrice !== undefined && providerPrice !== null ? String(providerPrice) : null;
      if (rawPriceText) {
        await TelecomWholesaleService.recordTwilioCallbackCostObservation(client, {
          organizationId,
          internalUsageId,
          rawPriceText,
          costSource: 'twilio_inbound_voice_callback',
          resourceId: cleanCallSid,
          settlementLedgerId: null,
          retailChargeMinor: settlementChargeMinor,
        });
      }

      return {
        settled: true,
        status: 'settled',
        settledAmountMinor: settlementChargeMinor,
        reconciliationStatus,
      };
    }

    // 5. Case B: Zero duration or non-connected call outcome (busy, no-answer, canceled, failed)
    const hasZeroProviderPrice = providerPrice === '0.00' || providerPrice === 0 || providerPrice === '0';

    if (hasZeroProviderPrice) {
      await TelecomWalletService.releaseUsage(client, {
        organizationId,
        internalUsageId,
        reason: `inbound_call_${normStatus}_zero_provider_price`,
        idempotencyKey: `idemp_inbound_release_${cleanCallSid}`,
      });

      return {
        settled: true,
        status: 'released_zero_charge',
        settledAmountMinor: 0,
        reconciliationStatus: 'reconciled',
      };
    }

    // 6. Case C: Financial truth unavailable (missing provider price / missing lookup)
    await client
      .from('telecom_usage_reservations')
      .update({
        metadata: {
          ...reservation.metadata,
          reconciliation_reason: 'FINANCIAL_TRUTH_UNESTABLISHED',
          callStatus: normStatus,
        },
      })
      .eq('internal_usage_id', internalUsageId);

    return {
      settled: false,
      status: 'manual_review_held',
      settledAmountMinor: 0,
      reconciliationStatus: 'manual_review',
    };
  }
}
