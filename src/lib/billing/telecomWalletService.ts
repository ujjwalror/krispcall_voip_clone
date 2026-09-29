import { SupabaseClient } from '@supabase/supabase-js';
import {
  TelecomServiceType,
  TelecomDirection,
  TelecomWalletSummary,
} from './types';

export interface ReserveTelecomUsageParams {
  organizationId: string;
  internalUsageId: string;
  serviceType: TelecomServiceType;
  direction: TelecomDirection;
  amountReservedMinor: number;
  idempotencyKey: string;
  expiresInSeconds?: number;
  currency?: string;
  provider?: string;
  providerResourceId?: string | null;
  rateCardId?: string | null;
  rateSnapshot?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface ExtendTelecomUsageParams {
  organizationId: string;
  internalUsageId: string;
  additionalAmountReservedMinor: number;
  idempotencyKey: string;
  newExpiresInSeconds?: number;
}

export interface SettleTelecomUsageParams {
  organizationId: string;
  internalUsageId: string;
  actualRetailChargeMinor: number;
  description: string;
  idempotencyKey: string;
  providerWholesaleCostMinor?: number | null;
  providerResourceId?: string | null;
  metadata?: Record<string, any>;
}

export interface ReleaseTelecomUsageParams {
  organizationId: string;
  internalUsageId: string;
  reason?: string;
  idempotencyKey?: string;
}

export interface ReverseTelecomUsageParams {
  organizationId: string;
  internalUsageId: string;
  reversalAmountMinor: number;
  description: string;
  idempotencyKey: string;
}

export interface RateCalculationParams {
  retailRateMicro: number;
  durationSeconds: number;
  billingIncrementSeconds?: number;
  minChargeableUnits?: number;
}

export class TelecomWalletService {
  /**
   * High-precision telecom retail rating utility.
   * Converts sub-cent rate micro-units (where 1 cent = 10,000 micro-units, e.g. USD $0.0252/min = 25,200 micro-units)
   * into exact rounded minor units (cents).
   */
  static calculateRetailChargeMinor(params: RateCalculationParams): number {
    const {
      retailRateMicro,
      durationSeconds,
      billingIncrementSeconds = 60,
      minChargeableUnits = 1,
    } = params;

    if (!Number.isInteger(retailRateMicro) || retailRateMicro < 0) {
      throw new Error('TelecomWalletService: retailRateMicro must be a non-negative integer.');
    }
    if (!Number.isInteger(durationSeconds) || durationSeconds < 0) {
      throw new Error('TelecomWalletService: durationSeconds must be a non-negative integer.');
    }
    if (!Number.isInteger(billingIncrementSeconds) || billingIncrementSeconds <= 0) {
      throw new Error('TelecomWalletService: billingIncrementSeconds must be a positive integer.');
    }

    if (durationSeconds === 0) {
      return 0;
    }

    const calculatedUnits = Math.ceil(durationSeconds / billingIncrementSeconds);
    const billableUnits = Math.max(minChargeableUnits, calculatedUnits);

    const rawChargeMicro = billableUnits * retailRateMicro;
    // Round UP to next minor unit (cent) so platform never under-charges customer
    return Math.ceil(rawChargeMicro / 10000);
  }

  /**
   * Fetches the authoritative wallet summary (funded balance, active reservations, available balance).
   */
  static async getWalletSummary(
    supabase: SupabaseClient,
    organizationId: string
  ): Promise<TelecomWalletSummary> {
    if (!organizationId) {
      throw new Error('TelecomWalletService: organizationId is required.');
    }

    const { data, error } = await (supabase as any).rpc(
      'get_telecom_wallet_summary_atomic',
      { p_organization_id: organizationId }
    );

    if (error) {
      console.error('[TelecomWalletService] Error fetching wallet summary:', error.message);
      throw new Error(`TelecomWalletService error: ${error.message}`);
    }

    return {
      organizationId: data.organization_id,
      fundedBalanceMinor: Number(data.funded_balance_minor),
      activeReservationsMinor: Number(data.active_reservations_minor),
      availableBalanceMinor: Number(data.available_balance_minor),
      currency: data.currency,
    };
  }

  /**
   * Atomically places a pre-usage reservation hold on available funded balance.
   * Fails closed if available balance is insufficient.
   */
  static async reserveUsage(
    supabase: SupabaseClient,
    params: ReserveTelecomUsageParams
  ): Promise<{
    success: boolean;
    isDuplicate: boolean;
    reservationId: string;
    internalUsageId: string;
    amountReservedMinor: number;
    status: string;
    expiresAt?: string;
    fundedBalanceMinor: number;
    activeReservationsMinor: number;
    availableBalanceMinor: number;
  }> {
    const {
      organizationId,
      internalUsageId,
      serviceType,
      direction,
      amountReservedMinor,
      idempotencyKey,
      expiresInSeconds = 1800,
      currency = 'USD',
      provider = 'twilio',
      providerResourceId = null,
      rateCardId = null,
      rateSnapshot = {},
      metadata = {},
    } = params;

    if (!organizationId) {
      throw new Error('TelecomWalletService: organizationId is required.');
    }
    if (!internalUsageId || internalUsageId.trim().length === 0) {
      throw new Error('TelecomWalletService: internalUsageId is required.');
    }
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new Error('TelecomWalletService: idempotencyKey is required.');
    }
    if (!Number.isInteger(amountReservedMinor) || amountReservedMinor < 0) {
      throw new Error('TelecomWalletService: amountReservedMinor must be a non-negative integer.');
    }

    const { data, error } = await (supabase as any).rpc(
      'record_telecom_usage_reservation_atomic',
      {
        p_organization_id: organizationId,
        p_internal_usage_id: internalUsageId.trim(),
        p_service_type: serviceType,
        p_direction: direction,
        p_amount_reserved_minor: amountReservedMinor,
        p_idempotency_key: idempotencyKey.trim(),
        p_expires_in_seconds: expiresInSeconds,
        p_currency: currency,
        p_provider: provider,
        p_provider_resource_id: providerResourceId,
        p_rate_card_id: rateCardId,
        p_rate_snapshot: rateSnapshot,
        p_metadata: metadata,
      }
    );

    if (error) {
      console.error('[TelecomWalletService] Reservation RPC error:', error.message);
      if (error.message.includes('IDEMPOTENCY_CONFLICT')) {
        throw new Error(`IDEMPOTENCY_CONFLICT: Payload parameters conflict with original reservation.`);
      }
      if (error.message.includes('INSUFFICIENT_AVAILABLE_BALANCE')) {
        throw new Error(`INSUFFICIENT_AVAILABLE_BALANCE: Available funded balance is insufficient for reservation.`);
      }
      if (error.message.includes('ORGANIZATION_BILLING_RESTRICTED')) {
        throw new Error(`ORGANIZATION_BILLING_RESTRICTED: Organization is currently restricted from telecom usage.`);
      }
      if (error.message.includes('CURRENCY_MISMATCH')) {
        throw new Error(`CURRENCY_MISMATCH: Requested currency does not match wallet currency.`);
      }
      throw new Error(`TelecomWalletService reservation error: ${error.message}`);
    }

    return {
      success: data.success,
      isDuplicate: data.is_duplicate,
      reservationId: data.reservation_id,
      internalUsageId: data.internal_usage_id,
      amountReservedMinor: Number(data.amount_reserved_minor),
      status: data.status,
      expiresAt: data.expires_at,
      fundedBalanceMinor: Number(data.funded_balance_minor),
      activeReservationsMinor: Number(data.active_reservations_minor),
      availableBalanceMinor: Number(data.available_balance_minor),
    };
  }

  /**
   * Atomically extends an active usage reservation to increase protected exposure for long-running calls.
   */
  static async extendReservation(
    supabase: SupabaseClient,
    params: ExtendTelecomUsageParams
  ): Promise<{
    success: boolean;
    isDuplicate: boolean;
    reservationId: string;
    internalUsageId: string;
    amountReservedMinor: number;
    additionalReservedMinor?: number;
    fundedBalanceMinor: number;
    activeReservationsMinor: number;
    availableBalanceMinor: number;
  }> {
    const {
      organizationId,
      internalUsageId,
      additionalAmountReservedMinor,
      idempotencyKey,
      newExpiresInSeconds = 1800,
    } = params;

    if (!organizationId) {
      throw new Error('TelecomWalletService: organizationId is required.');
    }
    if (!internalUsageId || internalUsageId.trim().length === 0) {
      throw new Error('TelecomWalletService: internalUsageId is required.');
    }
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new Error('TelecomWalletService: idempotencyKey is required.');
    }
    if (!Number.isInteger(additionalAmountReservedMinor) || additionalAmountReservedMinor <= 0) {
      throw new Error('TelecomWalletService: additionalAmountReservedMinor must be a positive integer.');
    }

    const { data, error } = await (supabase as any).rpc(
      'extend_telecom_usage_reservation_atomic',
      {
        p_organization_id: organizationId,
        p_internal_usage_id: internalUsageId.trim(),
        p_additional_amount_reserved_minor: additionalAmountReservedMinor,
        p_idempotency_key: idempotencyKey.trim(),
        p_new_expires_in_seconds: newExpiresInSeconds,
      }
    );

    if (error) {
      console.error('[TelecomWalletService] Extension RPC error:', error.message);
      if (error.message.includes('CANNOT_EXTEND_INACTIVE_RESERVATION')) {
        throw new Error(`CANNOT_EXTEND_INACTIVE_RESERVATION: Cannot extend an inactive reservation.`);
      }
      if (error.message.includes('INSUFFICIENT_AVAILABLE_BALANCE')) {
        throw new Error(`INSUFFICIENT_AVAILABLE_BALANCE: Available balance cannot cover reservation extension.`);
      }
      throw new Error(`TelecomWalletService extension error: ${error.message}`);
    }

    return {
      success: data.success,
      isDuplicate: data.is_duplicate,
      reservationId: data.reservation_id,
      internalUsageId: data.internal_usage_id,
      amountReservedMinor: Number(data.amount_reserved_minor),
      additionalReservedMinor: data.additional_reserved_minor !== undefined ? Number(data.additional_reserved_minor) : 0,
      fundedBalanceMinor: Number(data.funded_balance_minor),
      activeReservationsMinor: Number(data.active_reservations_minor),
      availableBalanceMinor: Number(data.available_balance_minor),
    };
  }

  /**
   * Atomically settles a usage reservation by deducting the exact retail charge from billing_credit_ledger
   * and releasing the reservation hold, while preserving funds protected for OTHER active usage.
   */
  static async settleUsage(
    supabase: SupabaseClient,
    params: SettleTelecomUsageParams
  ): Promise<{
    success: boolean;
    isDuplicate: boolean;
    reservationId: string;
    internalUsageId: string;
    status: string;
    actualCustomerChargeMinor: number;
    actualProviderCostMinor: number | null;
    actualGrossMarginMinor: number | null;
    settlementLedgerId: string | null;
    fundedBalanceMinor: number;
    activeReservationsMinor: number;
    availableBalanceMinor: number;
  }> {
    const {
      organizationId,
      internalUsageId,
      actualRetailChargeMinor,
      description,
      idempotencyKey,
      providerWholesaleCostMinor = null,
      providerResourceId = null,
      metadata = {},
    } = params;

    if (!organizationId) {
      throw new Error('TelecomWalletService: organizationId is required.');
    }
    if (!internalUsageId || internalUsageId.trim().length === 0) {
      throw new Error('TelecomWalletService: internalUsageId is required.');
    }
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new Error('TelecomWalletService: idempotencyKey is required.');
    }
    if (!Number.isInteger(actualRetailChargeMinor) || actualRetailChargeMinor < 0) {
      throw new Error('TelecomWalletService: actualRetailChargeMinor must be a non-negative integer.');
    }

    const { data, error } = await (supabase as any).rpc(
      'settle_telecom_usage_reservation_atomic',
      {
        p_organization_id: organizationId,
        p_internal_usage_id: internalUsageId.trim(),
        p_actual_retail_charge_minor: actualRetailChargeMinor,
        p_description: description.trim(),
        p_idempotency_key: idempotencyKey.trim(),
        p_provider_wholesale_cost_minor: providerWholesaleCostMinor,
        p_provider_resource_id: providerResourceId,
        p_metadata: metadata,
      }
    );

    if (error) {
      console.error('[TelecomWalletService] Settlement RPC error:', error.message);
      if (error.message.includes('RESERVATION_NOT_FOUND')) {
        throw new Error(`RESERVATION_NOT_FOUND: Normal settlement requires an existing active reservation.`);
      }
      if (error.message.includes('CANNOT_SETTLE_INACTIVE_RESERVATION')) {
        throw new Error(`CANNOT_SETTLE_INACTIVE_RESERVATION: Cannot settle an inactive reservation.`);
      }
      if (error.message.includes('SETTLEMENT_EXCEEDS_UNRESERVED_FUNDED_BALANCE')) {
        throw new Error(`SETTLEMENT_EXCEEDS_UNRESERVED_FUNDED_BALANCE: Charge exceeds funded balance available after protecting other active reservations.`);
      }
      if (error.message.includes('IDEMPOTENCY_CONFLICT')) {
        throw new Error(`IDEMPOTENCY_CONFLICT: Settlement charge conflicts with original settlement.`);
      }
      throw new Error(`TelecomWalletService settlement error: ${error.message}`);
    }

    return {
      success: data.success,
      isDuplicate: data.is_duplicate,
      reservationId: data.reservation_id,
      internalUsageId: data.internal_usage_id,
      status: data.status,
      actualCustomerChargeMinor: Number(data.actual_customer_charge_minor),
      actualProviderCostMinor: data.actual_provider_cost_minor !== null ? Number(data.actual_provider_cost_minor) : null,
      actualGrossMarginMinor: data.actual_gross_margin_minor !== null ? Number(data.actual_gross_margin_minor) : null,
      settlementLedgerId: data.settlement_ledger_id,
      fundedBalanceMinor: Number(data.funded_balance_minor),
      activeReservationsMinor: Number(data.active_reservations_minor),
      availableBalanceMinor: Number(data.available_balance_minor),
    };
  }

  /**
   * Atomically releases/cancels a reservation hold without generating any fake wallet movements.
   */
  static async releaseUsage(
    supabase: SupabaseClient,
    params: ReleaseTelecomUsageParams
  ): Promise<{
    success: boolean;
    isDuplicate: boolean;
    reservationId: string;
    internalUsageId: string;
    status: string;
    fundedBalanceMinor: number;
    activeReservationsMinor: number;
    availableBalanceMinor: number;
  }> {
    const { organizationId, internalUsageId, reason = 'cancelled_by_user', idempotencyKey } = params;

    if (!organizationId) {
      throw new Error('TelecomWalletService: organizationId is required.');
    }
    if (!internalUsageId || internalUsageId.trim().length === 0) {
      throw new Error('TelecomWalletService: internalUsageId is required.');
    }

    const { data, error } = await (supabase as any).rpc(
      'release_telecom_usage_reservation_atomic',
      {
        p_organization_id: organizationId,
        p_internal_usage_id: internalUsageId.trim(),
        p_reason: reason,
        p_idempotency_key: idempotencyKey ? idempotencyKey.trim() : null,
      }
    );

    if (error) {
      console.error('[TelecomWalletService] Release RPC error:', error.message);
      if (error.message.includes('CANNOT_RELEASE_SETTLED_RESERVATION')) {
        throw new Error(`CANNOT_RELEASE_SETTLED_RESERVATION: Cannot release a settled reservation.`);
      }
      throw new Error(`TelecomWalletService release error: ${error.message}`);
    }

    return {
      success: data.success,
      isDuplicate: data.is_duplicate,
      reservationId: data.reservation_id,
      internalUsageId: data.internal_usage_id,
      status: data.status,
      fundedBalanceMinor: Number(data.funded_balance_minor),
      activeReservationsMinor: Number(data.active_reservations_minor),
      availableBalanceMinor: Number(data.available_balance_minor),
    };
  }

  /**
   * Records a genuine, bounded telecom usage reversal / refund entry in billing_credit_ledger.
   * Strictly bounded by original settled customer charge.
   */
  static async reverseUsage(
    supabase: SupabaseClient,
    params: ReverseTelecomUsageParams
  ): Promise<{
    success: boolean;
    isDuplicate: boolean;
    ledgerEntryId: string;
    internalUsageId: string;
    reversalAmountMinor: number;
    fundedBalanceMinor: number;
    availableBalanceMinor: number;
  }> {
    const {
      organizationId,
      internalUsageId,
      reversalAmountMinor,
      description,
      idempotencyKey,
    } = params;

    if (!organizationId) {
      throw new Error('TelecomWalletService: organizationId is required.');
    }
    if (!internalUsageId || internalUsageId.trim().length === 0) {
      throw new Error('TelecomWalletService: internalUsageId is required.');
    }
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new Error('TelecomWalletService: idempotencyKey is required.');
    }
    if (!Number.isInteger(reversalAmountMinor) || reversalAmountMinor <= 0) {
      throw new Error('TelecomWalletService: reversalAmountMinor must be a positive integer.');
    }

    const { data, error } = await (supabase as any).rpc(
      'record_telecom_usage_reversal_atomic',
      {
        p_organization_id: organizationId,
        p_internal_usage_id: internalUsageId.trim(),
        p_reversal_amount_minor: reversalAmountMinor,
        p_description: description.trim(),
        p_idempotency_key: idempotencyKey.trim(),
      }
    );

    if (error) {
      console.error('[TelecomWalletService] Reversal RPC error:', error.message);
      if (error.message.includes('SETTLED_RESERVATION_NOT_FOUND')) {
        throw new Error(`SETTLED_RESERVATION_NOT_FOUND: Reversal requires an existing settled reservation.`);
      }
      if (error.message.includes('REVERSAL_EXCEEDS_SETTLED_CHARGE')) {
        throw new Error(`REVERSAL_EXCEEDS_SETTLED_CHARGE: Reversal amount exceeds remaining reversible amount.`);
      }
      if (error.message.includes('IDEMPOTENCY_CONFLICT')) {
        throw new Error(`IDEMPOTENCY_CONFLICT: Reversal amount conflicts with original reversal.`);
      }
      throw new Error(`TelecomWalletService reversal error: ${error.message}`);
    }

    return {
      success: data.success,
      isDuplicate: data.is_duplicate,
      ledgerEntryId: data.ledger_entry_id,
      internalUsageId: data.internal_usage_id,
      reversalAmountMinor: Number(data.reversal_amount_minor),
      fundedBalanceMinor: Number(data.funded_balance_minor),
      availableBalanceMinor: Number(data.available_balance_minor),
    };
  }
}
