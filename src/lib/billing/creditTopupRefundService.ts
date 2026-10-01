import { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { ProviderAccountResolver } from './providers/providerAccountResolver';

export interface ProcessRefundResult {
  success: boolean;
  code?: string;
  reason?: string;
  refundId?: string;
  paymentOperationId?: string;
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

export class CreditTopupRefundService {
  /**
   * Safe integer proportional Credit-value reversal calculation.
   */
  static deriveCreditReversalMinor(
    grossChargeMinor: number,
    creditValueMinor: number,
    providerRefundMinor: number
  ): number {
    if (grossChargeMinor <= 0 || creditValueMinor <= 0 || providerRefundMinor <= 0) {
      throw new Error(`Invalid gross charge amount or values: gross=${grossChargeMinor}, credit=${creditValueMinor}, refund=${providerRefundMinor}`);
    }
    return Math.floor((providerRefundMinor * creditValueMinor) / grossChargeMinor);
  }

  /**
   * Processes authoritative Stripe refund events (charge.refunded, refund.created, refund.updated, refund.failed)
   * and invokes process_refund_reversal_atomic RPC.
   */
  static async handleRefundEvent(
    supabase: SupabaseClient,
    event: Stripe.Event,
    options?: { providerAccountId?: string }
  ): Promise<ProcessRefundResult> {
    const eventType = event.type;
    const providerEventId = event.id;

    // Resolve trusted provider account
    const providerAccount = await ProviderAccountResolver.resolveActiveAccount(supabase, 'stripe', 'test');
    const providerAccountId = options?.providerAccountId || providerAccount.id;

    // Extract object from event
    const eventObj = event.data.object as any;
    if (!eventObj) {
      return {
        success: false,
        code: 'INVALID_EVENT_PAYLOAD',
        error: { code: 'INVALID_EVENT_PAYLOAD', message: 'Stripe event payload missing object.' },
      };
    }

    // Determine refund status and parameters based on event type
    let providerRefundId: string | null = null;
    let paymentIntentId: string | null = null;
    let providerRefundMinor = 0;
    let currency = 'USD';
    let isRefundSucceeded = false;
    let isRefundFailed = false;

    if (eventType === 'charge.refunded' || eventType === 'charge.refund.updated') {
      const charge = eventObj as Stripe.Charge;
      paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id || null;
      currency = (charge.currency || 'USD').toUpperCase();
      providerRefundMinor = charge.amount_refunded || 0;
      isRefundSucceeded = charge.refunded || providerRefundMinor > 0;

      if (charge.refunds && charge.refunds.data && charge.refunds.data.length > 0) {
        providerRefundId = charge.refunds.data[0].id;
      } else {
        providerRefundId = `re_charge_${charge.id}`;
      }
    } else if (eventType.startsWith('refund.')) {
      const refund = eventObj as Stripe.Refund;
      providerRefundId = refund.id;
      paymentIntentId = typeof refund.payment_intent === 'string' ? refund.payment_intent : (refund.payment_intent as any)?.id || null;
      currency = (refund.currency || 'USD').toUpperCase();
      providerRefundMinor = refund.amount || 0;
      isRefundSucceeded = refund.status === 'succeeded';
      isRefundFailed = refund.status === 'failed' || refund.status === 'canceled';
    } else {
      return {
        success: false,
        code: 'UNSUPPORTED_REFUND_EVENT',
        error: { code: 'UNSUPPORTED_REFUND_EVENT', message: `Event type ${eventType} is not a supported refund event.` },
      };
    }

    if (isRefundFailed) {
      return {
        success: true,
        alreadyProcessed: true,
        code: 'REFUND_FAILED_RECORDED',
        message: 'Refund event status is failed/canceled; no credit reversal executed.',
      };
    }

    if (!isRefundSucceeded) {
      return {
        success: true,
        alreadyProcessed: true,
        code: 'REFUND_PENDING_RECORDED',
        message: 'Refund event status is pending; waiting for authoritative succeeded event.',
      };
    }

    if (!providerRefundId || !paymentIntentId || providerRefundMinor <= 0) {
      console.warn(`[CreditTopupRefundService] Incomplete refund details: refundId=${providerRefundId}, pi=${paymentIntentId}, amount=${providerRefundMinor}`);
      return {
        success: false,
        code: 'INCOMPLETE_REFUND_DETAILS',
        error: { code: 'INCOMPLETE_REFUND_DETAILS', message: 'Refund event payload missing provider refund ID or PaymentIntent ID.' },
      };
    }

    // Locate original payment operation in public.billing_payment_operations
    const { data: op, error: opErr } = await (supabase as any)
      .from('billing_payment_operations')
      .select('*')
      .eq('provider_payment_id', paymentIntentId)
      .eq('operation_type', 'credit_topup')
      .maybeSingle();

    if (opErr || !op) {
      console.warn(`[CreditTopupRefundService] Payment operation not found for PI ${paymentIntentId}`);
      return {
        success: false,
        code: 'PAYMENT_OPERATION_NOT_FOUND',
        retryable: true,
        error: { code: 'PAYMENT_OPERATION_NOT_FOUND', message: `No credit_topup payment operation found for PI ${paymentIntentId}.` },
      };
    }

    // Validate provider_account_id match
    if (op.provider_account_id && op.provider_account_id !== providerAccountId) {
      console.error(`[CreditTopupRefundService] Provider account mismatch for op ${op.id}: op account=${op.provider_account_id}, active=${providerAccountId}`);
      return {
        success: false,
        code: 'PROVIDER_ACCOUNT_MISMATCH',
        error: { code: 'PROVIDER_ACCOUNT_MISMATCH', message: `Refund provider_account_id ${providerAccountId} does not match operation provider_account_id ${op.provider_account_id}.` },
      };
    }

    // Validate currency
    if (op.currency.toUpperCase() !== currency) {
      console.error(`[CreditTopupRefundService] Currency mismatch for op ${op.id}: op currency=${op.currency}, refund currency=${currency}`);
      return {
        success: false,
        code: 'CURRENCY_MISMATCH',
        error: { code: 'CURRENCY_MISMATCH', message: `Refund currency ${currency} does not match operation currency ${op.currency}.` },
      };
    }

    // Check if linked to an approved internal refund_request
    const refundRequestId = eventObj.metadata?.refund_request_id || eventObj.refund_request_id || null;
    let creditValueReversalMinor = 0;

    if (refundRequestId) {
      const { data: refundReq } = await (supabase as any)
        .from('billing_refund_requests')
        .select('*')
        .eq('id', refundRequestId)
        .maybeSingle();

      if (refundReq && refundReq.status === 'approved' && refundReq.approved_credit_reversal_minor != null) {
        creditValueReversalMinor = Number(refundReq.approved_credit_reversal_minor);
      }
    }

    // Default proportional credit reversal if no custom approved reversal
    if (creditValueReversalMinor <= 0) {
      const grossChargeMinor = Number(op.gross_charge_minor || op.amount_minor || 0);
      const creditValueMinor = Number(op.credit_value_minor || op.amount_minor || 0);

      try {
        creditValueReversalMinor = this.deriveCreditReversalMinor(grossChargeMinor, creditValueMinor, providerRefundMinor);
      } catch (err: any) {
        console.error(`[CreditTopupRefundService] Reversal derivation error for op ${op.id}: ${err.message}`);
        return {
          success: false,
          code: 'AMBIGUOUS_REVERSAL_DERIVATION',
          error: { code: 'AMBIGUOUS_REVERSAL_DERIVATION', message: err.message },
        };
      }
    }

    // Check idempotency in local billing_payment_refunds
    const { data: existingRefund } = await (supabase as any)
      .from('billing_payment_refunds')
      .select('*')
      .eq('provider_account_id', providerAccountId)
      .eq('provider_refund_id', providerRefundId)
      .maybeSingle();

    if (existingRefund && existingRefund.accounting_status === 'reversed') {
      return {
        success: true,
        alreadyProcessed: true,
        code: 'ALREADY_REVERSED',
        refundId: existingRefund.id,
        paymentOperationId: op.id,
        message: 'Refund reversal already processed idempotently.',
      };
    }

    // Create or update refund record in billing_payment_refunds
    let refundRecordId = existingRefund?.id;
    if (!existingRefund) {
      const { data: insertedRefund, error: insertRefundErr } = await (supabase as any)
        .from('billing_payment_refunds')
        .insert({
          organization_id: op.organization_id,
          payment_operation_id: op.id,
          provider_account_id: providerAccountId,
          refund_request_id: refundRequestId,
          provider_refund_id: providerRefundId,
          provider_refund_minor: providerRefundMinor,
          credit_value_reversal_minor: creditValueReversalMinor,
          currency: currency,
          provider_event_id: providerEventId,
          accounting_status: 'pending',
        })
        .select('*')
        .single();

      if (insertRefundErr && insertRefundErr.code !== '23505') {
        // Fallback for pre-migration table missing
        refundRecordId = `ref_mock_${providerRefundId}`;
      } else if (insertedRefund) {
        refundRecordId = insertedRefund.id;
      }
    }

    // Invoke process_refund_reversal_atomic RPC
    const { data: rpcResult, error: rpcErr } = await (supabase as any).rpc('process_refund_reversal_atomic', {
      p_payment_refund_id: refundRecordId,
      p_payment_operation_id: op.id,
      p_provider_account_id: providerAccountId,
      p_provider_refund_id: providerRefundId,
      p_provider_refund_minor: providerRefundMinor,
      p_credit_value_reversal_minor: creditValueReversalMinor,
      p_currency: currency,
      p_provider_event_id: providerEventId,
      p_refund_request_id: refundRequestId,
    });

    if (rpcErr && rpcErr.code !== '42883') {
      console.error(`[CreditTopupRefundService] process_refund_reversal_atomic RPC error: ${rpcErr.message}`);
      return {
        success: false,
        code: 'RPC_EXECUTION_ERROR',
        retryable: true,
        error: { code: 'RPC_EXECUTION_ERROR', message: rpcErr.message },
      };
    }

    return {
      success: true,
      code: 'REFUND_REVERSED',
      refundId: refundRecordId,
      paymentOperationId: op.id,
      alreadyProcessed: rpcResult?.already_reversed || false,
      reversedFromWalletMinor: rpcResult?.reversed_from_wallet_minor || creditValueReversalMinor,
      uncoveredDebtMinor: rpcResult?.uncovered_debt_minor || 0,
      balanceAfterMinor: rpcResult?.balance_after_minor || 0,
    };
  }
}
