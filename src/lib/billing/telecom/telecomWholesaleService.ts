import { SupabaseClient } from '@supabase/supabase-js';
import {
  RecordWholesaleSnapshotParams,
  RecordCostObservationParams,
  TelecomUsageEconomicsSummary,
} from './wholesaleTypes';
import { normalizeTwilioProviderPrice } from './monetaryParser';

export class TelecomWholesaleService {
  /**
   * Atomically records the initial confidential wholesale economics snapshot for a usage reservation.
   * Executed strictly via service_role. Failure to record snapshot does not throw if non-fatal.
   */
  public static async recordWholesaleSnapshot(
    client: SupabaseClient,
    params: RecordWholesaleSnapshotParams
  ): Promise<{
    success: boolean;
    isDuplicate: boolean;
    economicsId?: string;
    error?: string;
  }> {
    const {
      organizationId,
      reservationId,
      internalUsageId,
      providerAccountId = null,
      providerKey = 'twilio',
      serviceType,
      direction,
      currency = 'USD',
      estimatedWholesaleRateMicro,
      estimatedWholesaleCostMinor,
      metadata = {},
    } = params;

    if (!organizationId || !reservationId || !internalUsageId) {
      return { success: false, isDuplicate: false, error: 'MISSING_REQUIRED_PARAMETERS' };
    }

    try {
      const { data, error } = await (client as any).rpc(
        'record_telecom_usage_economics_snapshot_atomic',
        {
          p_organization_id: organizationId,
          p_reservation_id: reservationId,
          p_internal_usage_id: internalUsageId.trim(),
          p_provider_account_id: providerAccountId,
          p_provider_key: providerKey.trim(),
          p_service_type: serviceType,
          p_direction: direction,
          p_currency: currency,
          p_estimated_wholesale_rate_micro: estimatedWholesaleRateMicro,
          p_estimated_wholesale_cost_minor: estimatedWholesaleCostMinor,
          p_metadata: metadata,
        }
      );

      if (error) {
        console.error('[TelecomWholesaleService] Error recording wholesale snapshot:', error.message);
        return { success: false, isDuplicate: false, error: error.message };
      }

      return {
        success: data.success,
        isDuplicate: data.is_duplicate,
        economicsId: data.economics_id,
      };
    } catch (err: any) {
      console.error('[TelecomWholesaleService] Exception in recordWholesaleSnapshot:', err.message || err);
      return { success: false, isDuplicate: false, error: err.message || 'UNKNOWN_EXCEPTION' };
    }
  }

  /**
   * Idempotently records an append-only provider cost observation and updates net wholesale economics summary.
   */
  public static async recordCostObservation(
    client: SupabaseClient,
    params: RecordCostObservationParams
  ): Promise<{
    success: boolean;
    isDuplicate: boolean;
    observationId?: string;
    economicsId?: string;
    costStatus?: string;
    netCostMinor?: number;
    error?: string;
  }> {
    const {
      organizationId,
      internalUsageId,
      sourceAuthority,
      economicEffect,
      costSource,
      providerCostMicro,
      rawSign,
      rawProviderPriceText = null,
      fingerprint = null,
      settlementLedgerId = null,
      retailChargeMinor = null,
      rawPayload = {},
    } = params;

    if (!organizationId || !internalUsageId) {
      return { success: false, isDuplicate: false, error: 'MISSING_REQUIRED_PARAMETERS' };
    }

    try {
      const costMicroBigInt = BigInt(providerCostMicro.toString());

      const { data, error } = await (client as any).rpc(
        'record_provider_cost_observation_atomic',
        {
          p_organization_id: organizationId,
          p_internal_usage_id: internalUsageId.trim(),
          p_source_authority: sourceAuthority,
          p_economic_effect: economicEffect,
          p_cost_source: costSource,
          p_provider_cost_micro: costMicroBigInt.toString(),
          p_raw_sign: rawSign,
          p_raw_provider_price_text: rawProviderPriceText,
          p_fingerprint: fingerprint,
          p_settlement_ledger_id: settlementLedgerId,
          p_retail_charge_minor: retailChargeMinor,
          p_raw_payload: rawPayload,
        }
      );

      if (error) {
        console.error('[TelecomWholesaleService] Error recording cost observation:', error.message);
        return { success: false, isDuplicate: false, error: error.message };
      }

      return {
        success: data.success,
        isDuplicate: data.is_duplicate,
        observationId: data.observation_id,
        economicsId: data.economics_id,
        costStatus: data.cost_status,
        netCostMinor: data.net_actual_provider_cost_minor ? Number(data.net_actual_provider_cost_minor) : 0,
      };
    } catch (err: any) {
      console.error('[TelecomWholesaleService] Exception in recordCostObservation:', err.message || err);
      return { success: false, isDuplicate: false, error: err.message || 'UNKNOWN_EXCEPTION' };
    }
  }

  /**
   * Helper utility: Parses raw Twilio provider price and records cost observation in one step.
   */
  public static async recordTwilioCallbackCostObservation(
    client: SupabaseClient,
    params: {
      organizationId: string;
      internalUsageId: string;
      rawPriceText?: string | null;
      costSource: string;
      resourceId?: string;
      settlementLedgerId?: string | null;
      retailChargeMinor?: number | null;
      rawPayload?: Record<string, any>;
    }
  ): Promise<{ success: boolean; recorded: boolean; reason?: string }> {
    const {
      organizationId,
      internalUsageId,
      rawPriceText,
      costSource,
      resourceId,
      settlementLedgerId,
      retailChargeMinor,
      rawPayload,
    } = params;

    if (!rawPriceText) {
      return { success: true, recorded: false, reason: 'NO_PRICE_EVIDENCE' };
    }

    const norm = normalizeTwilioProviderPrice(rawPriceText, 'preliminary_callback', resourceId);
    if (!norm || !norm.success) {
      return { success: false, recorded: false, reason: 'UNPARSEABLE_PRICE_TEXT' };
    }

    const res = await this.recordCostObservation(client, {
      organizationId,
      internalUsageId,
      sourceAuthority: norm.sourceAuthority,
      economicEffect: norm.economicEffect,
      costSource,
      providerCostMicro: norm.providerCostMicroBig,
      rawSign: norm.rawSign,
      rawProviderPriceText: norm.rawPriceText,
      fingerprint: norm.fingerprint,
      settlementLedgerId,
      retailChargeMinor,
      rawPayload,
    });

    return {
      success: res.success,
      recorded: res.success,
      reason: res.isDuplicate ? 'DUPLICATE_OBSERVATION_IGNORED' : 'OBSERVATION_RECORDED',
    };
  }

  /**
   * Confidential Service-Role Helper: Retrieves wholesale economics record for internal finance/admin.
   * NEVER expose this method or its return type to client-facing REST APIs or public DTOs.
   */
  public static async getConfidentialEconomics(
    client: SupabaseClient,
    organizationId: string,
    internalUsageId: string
  ): Promise<TelecomUsageEconomicsSummary | null> {
    const { data, error } = await client
      .from('telecom_usage_economics')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('internal_usage_id', internalUsageId)
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    return {
      id: data.id,
      organizationId: data.organization_id,
      reservationId: data.reservation_id,
      internalUsageId: data.internal_usage_id,
      providerAccountId: data.provider_account_id,
      settlementLedgerId: data.settlement_ledger_id,
      providerKey: data.provider_key,
      serviceType: data.service_type,
      direction: data.direction,
      currency: data.currency,
      estimatedWholesaleRateMicro: Number(data.estimated_wholesale_rate_micro || 0),
      estimatedWholesaleCostMinor: Number(data.estimated_wholesale_cost_minor || 0),
      retailChargeMinor: data.retail_charge_minor !== null ? Number(data.retail_charge_minor) : null,
      netActualProviderCostMicro: data.net_actual_provider_cost_micro !== null ? Number(data.net_actual_provider_cost_micro) : null,
      netActualProviderCostMinor: data.net_actual_provider_cost_minor !== null ? Number(data.net_actual_provider_cost_minor) : null,
      costStatus: data.cost_status,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }
}
