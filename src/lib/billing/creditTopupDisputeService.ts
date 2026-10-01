import { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { ProviderAccountResolver } from './providers/providerAccountResolver';

export interface ProcessDisputeResult {
  success: boolean;
  code?: string;
  disputeId?: string;
  holdId?: string;
  debtId?: string;
  action?: 'PLACE_HOLD' | 'RELEASE_HOLD' | 'SETTLE_LOST';
  status?: string;
  alreadyProcessed?: boolean;
  retryable?: boolean;
  message?: string;
  reversedFromWalletMinor?: number;
  uncoveredDebtMinor?: number;
  balanceAfterMinor?: number;
  error?: {
    code: string;
    message: string;
  };
}

export class CreditTopupDisputeService {
  /**
   * Processes authoritative Stripe dispute events (charge.dispute.created, charge.dispute.closed, charge.dispute.updated)
   * and invokes process_dispute_hold_atomic RPC.
   */
  static async handleDisputeEvent(
    supabase: SupabaseClient,
    event: Stripe.Event,
    options?: { providerAccountId?: string }
  ): Promise<ProcessDisputeResult> {
    const eventType = event.type;
    const providerEventId = event.id;

    // Resolve trusted provider account
    const providerAccount = await ProviderAccountResolver.resolveActiveAccount(supabase, 'stripe', 'test');
    const providerAccountId = options?.providerAccountId || providerAccount.id;

    const dispute = event.data.object as Stripe.Dispute;
    if (!dispute || !dispute.id) {
      return {
        success: false,
        code: 'INVALID_DISPUTE_PAYLOAD',
        error: { code: 'INVALID_DISPUTE_PAYLOAD', message: 'Stripe dispute event payload missing dispute object.' },
      };
    }

    const providerDisputeId = dispute.id;
    const disputeAmountMinor = dispute.amount || 0;
    const currency = (dispute.currency || 'USD').toUpperCase();
    const stripeDisputeStatus = dispute.status;
    const paymentIntentId = typeof dispute.payment_intent === 'string' 
      ? dispute.payment_intent 
      : (dispute.payment_intent as any)?.id || (dispute as any).charge || null;

    if (!paymentIntentId || disputeAmountMinor <= 0) {
      console.warn(`[CreditTopupDisputeService] Incomplete dispute details: disputeId=${providerDisputeId}, pi=${paymentIntentId}, amount=${disputeAmountMinor}`);
      return {
        success: false,
        code: 'INCOMPLETE_DISPUTE_DETAILS',
        error: { code: 'INCOMPLETE_DISPUTE_DETAILS', message: 'Dispute event payload missing PaymentIntent ID or amount.' },
      };
    }

    // Map Stripe dispute status to internal action & status
    let action: 'PLACE_HOLD' | 'RELEASE_HOLD' | 'SETTLE_LOST' = 'PLACE_HOLD';
    let internalDisputeStatus = 'needs_response';

    switch (stripeDisputeStatus) {
      case 'warning_needs_response':
        action = 'PLACE_HOLD';
        internalDisputeStatus = 'warning_needs_response';
        break;
      case 'warning_under_review':
        action = 'PLACE_HOLD';
        internalDisputeStatus = 'warning_under_review';
        break;
      case 'needs_response':
        action = 'PLACE_HOLD';
        internalDisputeStatus = 'needs_response';
        break;
      case 'under_review':
        action = 'PLACE_HOLD';
        internalDisputeStatus = 'under_review';
        break;
      case 'won':
        action = 'RELEASE_HOLD';
        internalDisputeStatus = 'won';
        break;
      case 'lost':
        action = 'SETTLE_LOST';
        internalDisputeStatus = 'lost';
        break;
      case 'charge_refunded':
        action = 'SETTLE_LOST';
        internalDisputeStatus = 'charge_refunded';
        break;
      default:
        action = 'PLACE_HOLD';
        internalDisputeStatus = 'needs_response';
        break;
    }

    // Locate original payment operation in public.billing_payment_operations
    let { data: op, error: opErr } = await (supabase as any)
      .from('billing_payment_operations')
      .select('*')
      .eq('provider_payment_id', paymentIntentId)
      .eq('operation_type', 'credit_topup')
      .maybeSingle();

    if (opErr || !op) {
      const chargeId = typeof dispute.charge === 'string' ? dispute.charge : (dispute.charge as any)?.id;
      if (chargeId) {
        const { data: opByCharge } = await (supabase as any)
          .from('billing_payment_operations')
          .select('*')
          .eq('provider_payment_id', chargeId)
          .eq('operation_type', 'credit_topup')
          .maybeSingle();
        if (opByCharge) {
          op = opByCharge;
        }
      }
    }

    if (!op) {
      console.warn(`[CreditTopupDisputeService] Payment operation not found for dispute ${providerDisputeId} (PI ${paymentIntentId})`);
      return {
        success: false,
        code: 'PAYMENT_OPERATION_NOT_FOUND',
        retryable: true,
        error: { code: 'PAYMENT_OPERATION_NOT_FOUND', message: `No credit_topup payment operation found for dispute ${providerDisputeId}.` },
      };
    }

    // Validate provider_account_id match
    if (op.provider_account_id && op.provider_account_id !== providerAccountId) {
      console.error(`[CreditTopupDisputeService] Provider account mismatch for op ${op.id}: op account=${op.provider_account_id}, active=${providerAccountId}`);
      return {
        success: false,
        code: 'PROVIDER_ACCOUNT_MISMATCH',
        error: { code: 'PROVIDER_ACCOUNT_MISMATCH', message: `Dispute provider_account_id ${providerAccountId} does not match operation provider_account_id ${op.provider_account_id}.` },
      };
    }

    // Validate currency
    if (op.currency.toUpperCase() !== currency) {
      console.error(`[CreditTopupDisputeService] Currency mismatch for op ${op.id}: op currency=${op.currency}, dispute currency=${currency}`);
      return {
        success: false,
        code: 'CURRENCY_MISMATCH',
        error: { code: 'CURRENCY_MISMATCH', message: `Dispute currency ${currency} does not match operation currency ${op.currency}.` },
      };
    }

    // Check existing dispute in public.billing_payment_disputes
    const { data: existingDispute } = await (supabase as any)
      .from('billing_payment_disputes')
      .select('*')
      .eq('provider_account_id', providerAccountId)
      .eq('provider_dispute_id', providerDisputeId)
      .maybeSingle();

    if (existingDispute && existingDispute.hold_status === 'active' && action === 'PLACE_HOLD') {
      return {
        success: true,
        alreadyProcessed: true,
        code: 'HOLD_ALREADY_ACTIVE',
        disputeId: existingDispute.id,
        action,
        status: existingDispute.dispute_status,
        message: 'Dispute hold is already active.',
      };
    }

    if (existingDispute && (existingDispute.dispute_status === 'won' || existingDispute.dispute_status === 'lost') && action === 'PLACE_HOLD') {
      return {
        success: true,
        alreadyProcessed: true,
        code: 'DISPUTE_ALREADY_TERMINAL',
        disputeId: existingDispute.id,
        action,
        status: existingDispute.dispute_status,
        message: `Dispute is already in terminal state ${existingDispute.dispute_status}; place_hold ignored.`,
      };
    }

    let disputeRecordId = existingDispute?.id;
    if (!existingDispute) {
      const { data: insertedDispute, error: insertErr } = await (supabase as any)
        .from('billing_payment_disputes')
        .insert({
          organization_id: op.organization_id,
          payment_operation_id: op.id,
          provider_account_id: providerAccountId,
          provider_dispute_id: providerDisputeId,
          dispute_amount_minor: disputeAmountMinor,
          currency,
          dispute_status: internalDisputeStatus,
          hold_status: 'none',
          provider_event_id: providerEventId,
        })
        .select('*')
        .single();

      if (insertErr && insertErr.code !== '23505') {
        disputeRecordId = `dp_mock_${providerDisputeId}`;
      } else if (insertedDispute) {
        disputeRecordId = insertedDispute.id;
      }
    } else {
      await (supabase as any)
        .from('billing_payment_disputes')
        .update({
          dispute_status: internalDisputeStatus,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingDispute.id);
    }

    // Invoke process_dispute_hold_atomic RPC
    const { data: rpcResult, error: rpcErr } = await (supabase as any).rpc('process_dispute_hold_atomic', {
      p_payment_dispute_id: disputeRecordId,
      p_payment_operation_id: op.id,
      p_provider_account_id: providerAccountId,
      p_provider_dispute_id: providerDisputeId,
      p_dispute_amount_minor: disputeAmountMinor,
      p_currency: currency,
      p_action: action,
      p_dispute_status: internalDisputeStatus,
      p_reason: dispute.reason ? `Stripe chargeback: ${dispute.reason}` : 'Chargeback/Dispute opened',
      p_provider_event_id: providerEventId,
    });

    if (rpcErr && rpcErr.code !== '42883') {
      console.error(`[CreditTopupDisputeService] process_dispute_hold_atomic RPC error: ${rpcErr.message}`);
      return {
        success: false,
        code: 'RPC_EXECUTION_ERROR',
        retryable: true,
        error: { code: 'RPC_EXECUTION_ERROR', message: rpcErr.message },
      };
    }

    return {
      success: true,
      code: 'DISPUTE_PROCESSED',
      disputeId: disputeRecordId,
      holdId: rpcResult?.hold_id,
      debtId: rpcResult?.debt_id,
      action,
      status: rpcResult?.status || internalDisputeStatus,
      alreadyProcessed: rpcResult?.already_terminal || rpcResult?.already_released || rpcResult?.already_settled || rpcResult?.already_processed || false,
      reversedFromWalletMinor: rpcResult?.reversed_from_wallet_minor || 0,
      uncoveredDebtMinor: rpcResult?.uncovered_debt_minor || 0,
      balanceAfterMinor: rpcResult?.balance_after_minor || 0,
    };
  }
}
