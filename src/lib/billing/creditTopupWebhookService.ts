import { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

export interface CreditTopupWebhookResult {
  success: boolean;
  code: string;
  message: string;
  alreadyFunded?: boolean;
  paymentOperationId?: string;
  ledgerEntryId?: string;
  fundedAmountMinor?: number;
  currency?: string;
}

export class CreditTopupWebhookService {
  /**
   * Server-authoritatively validates a payment_intent.succeeded event for credit_topup
   * and executes exact-once credit funding via the frozen public.fund_credit_topup_from_payment_atomic RPC.
   * NO DIRECT LEDGER MUTATIONS ALLOWED.
   */
  static async processPaymentIntentSucceeded(
    supabase: SupabaseClient,
    event: Stripe.Event
  ): Promise<CreditTopupWebhookResult> {
    const pi = event.data.object as Stripe.PaymentIntent;
    const providerEventId = event.id;

    // 1. Required Metadata Cross-Check (NO FUNDING BY PROVIDER_PAYMENT_ID ALONE IF METADATA IS MISSING)
    const metadata = pi.metadata || {};
    const operationType = metadata.operation_type;
    const paymentOperationId = metadata.payment_operation_id;

    if (operationType !== 'credit_topup') {
      return {
        success: false,
        code: 'INVALID_OPERATION_TYPE',
        message: `Event operation_type '${operationType}' is not credit_topup.`,
      };
    }

    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!paymentOperationId || typeof paymentOperationId !== 'string' || !uuidRegex.test(paymentOperationId.trim())) {
      console.warn(`[CreditTopupWebhookService] Missing or malformed payment_operation_id metadata for PI ${pi.id}`);
      return {
        success: false,
        code: 'MISSING_PAYMENT_OPERATION_ID',
        message: 'Required payment_operation_id UUID metadata is missing or malformed.',
      };
    }

    const cleanOpId = paymentOperationId.trim();

    // 2. Load Local Payment Operation Identified by Metadata UUID
    const { data: op, error: opErr } = await (supabase as any)
      .from('billing_payment_operations')
      .select('*')
      .eq('id', cleanOpId)
      .maybeSingle();

    if (opErr) {
      console.error('[CreditTopupWebhookService] DB error loading payment operation:', opErr.message);
      throw new Error(`TRANSIENT_DB_ERROR: ${opErr.message}`);
    }

    if (!op) {
      console.warn(`[CreditTopupWebhookService] Payment operation ${cleanOpId} not found for PI ${pi.id}`);
      return {
        success: false,
        code: 'PAYMENT_OPERATION_NOT_FOUND',
        message: `Payment operation ${cleanOpId} not found.`,
      };
    }

    // 3. Exact Operation Property Cross-Checks
    if (op.operation_type !== 'credit_topup') {
      return {
        success: false,
        code: 'OPERATION_TYPE_MISMATCH',
        message: `Local operation type '${op.operation_type}' is not credit_topup.`,
      };
    }

    if (op.provider !== 'stripe') {
      return {
        success: false,
        code: 'PROVIDER_MISMATCH',
        message: `Local operation provider '${op.provider}' is not stripe.`,
      };
    }

    if (op.provider_payment_id !== pi.id) {
      console.warn(`[CreditTopupWebhookService] Provider payment ID mismatch for op ${op.id}: expected ${op.provider_payment_id}, got ${pi.id}`);
      return {
        success: false,
        code: 'PROVIDER_PAYMENT_ID_MISMATCH',
        message: `Provider payment ID mismatch. Operation bound to '${op.provider_payment_id}', received '${pi.id}'.`,
      };
    }

    if (metadata.organization_id && metadata.organization_id !== op.organization_id) {
      console.warn(`[CreditTopupWebhookService] Metadata org ID mismatch: metadata=${metadata.organization_id}, op=${op.organization_id}`);
      return {
        success: false,
        code: 'ORGANIZATION_MISMATCH',
        message: 'Metadata organization_id does not match payment operation organization_id.',
      };
    }

    // 4. Validate Authoritative Succeeded Received Amount (NO PRODUCTION FALLBACK TO INTENDED AMOUNT)
    const amountReceived = pi.amount_received;
    if (typeof amountReceived !== 'number' || !Number.isSafeInteger(amountReceived) || amountReceived <= 0) {
      console.warn(`[CreditTopupWebhookService] Invalid amount_received in PI ${pi.id}: ${amountReceived}`);
      return {
        success: false,
        code: 'INVALID_AMOUNT_RECEIVED',
        message: 'Stripe PaymentIntent amount_received is missing, zero, or invalid.',
      };
    }

    if (amountReceived !== Number(op.amount_minor)) {
      console.warn(`[CreditTopupWebhookService] Amount mismatch for op ${op.id}: received ${amountReceived}, expected ${op.amount_minor}`);
      return {
        success: false,
        code: 'AMOUNT_MISMATCH',
        message: `Succeeded amount ${amountReceived} does not match operation amount ${op.amount_minor}.`,
      };
    }

    // Intended PI amount cross-check (if present)
    if (typeof pi.amount === 'number' && pi.amount > 0 && pi.amount !== Number(op.amount_minor)) {
      console.warn(`[CreditTopupWebhookService] Intended PI amount mismatch for op ${op.id}: PI amount=${pi.amount}, op amount=${op.amount_minor}`);
      return {
        success: false,
        code: 'INTENDED_AMOUNT_MISMATCH',
        message: `PaymentIntent intended amount ${pi.amount} does not match operation amount ${op.amount_minor}.`,
      };
    }

    // 5. Currency Normalization & Exact Match (NO FX ALLOWED)
    const normalizedCurrency = (pi.currency || '').trim().toUpperCase();
    if (!normalizedCurrency || normalizedCurrency !== op.currency.toUpperCase()) {
      console.warn(`[CreditTopupWebhookService] Currency mismatch for op ${op.id}: received ${normalizedCurrency}, expected ${op.currency}`);
      return {
        success: false,
        code: 'CURRENCY_MISMATCH',
        message: `Succeeded currency ${normalizedCurrency} does not match operation currency ${op.currency}.`,
      };
    }

    // 6. Stripe Customer Exact Cross-Check
    if (typeof pi.customer === 'string' && pi.customer.trim().length > 0) {
      const stripeCustomerId = pi.customer.trim();
      const { data: customerRow } = await (supabase as any)
        .from('billing_provider_customers')
        .select('provider_customer_id')
        .eq('organization_id', op.organization_id)
        .eq('provider', 'stripe')
        .maybeSingle();

      if (customerRow?.provider_customer_id && customerRow.provider_customer_id !== stripeCustomerId) {
        console.warn(`[CreditTopupWebhookService] Customer mismatch for org ${op.organization_id}: bound ${customerRow.provider_customer_id}, PI customer ${stripeCustomerId}`);
        return {
          success: false,
          code: 'CUSTOMER_MISMATCH',
          message: 'Stripe Customer ID mismatch for organization.',
        };
      }
    }

    // 7. Livemode / Environment Safety Check
    const isProduction = process.env.NODE_ENV === 'production' && process.env.STRIPE_EXPECTED_MODE !== 'test';
    if (pi.livemode !== isProduction) {
      console.warn(`[CreditTopupWebhookService] Livemode mismatch for PI ${pi.id}: PI livemode=${pi.livemode}, expected production=${isProduction}`);
      return {
        success: false,
        code: 'LIVEMODE_MISMATCH',
        message: `PaymentIntent livemode (${pi.livemode}) does not match server environment.`,
      };
    }

    // 8. Invoke Frozen C.4B Atomic Funding RPC (Service-Role Admin Client)
    const { data: rpcResult, error: rpcErr } = await (supabase as any).rpc(
      'fund_credit_topup_from_payment_atomic',
      {
        p_payment_operation_id: op.id,
        p_provider_payment_id: pi.id,
        p_succeeded_amount_minor: amountReceived,
        p_succeeded_currency: normalizedCurrency,
        p_provider_event_id: providerEventId,
      }
    );

    if (rpcErr) {
      console.error('[CreditTopupWebhookService] RPC fund_credit_topup_from_payment_atomic error:', rpcErr.message);
      if (
        rpcErr.message?.includes('AMOUNT_MISMATCH') ||
        rpcErr.message?.includes('CURRENCY_MISMATCH') ||
        rpcErr.message?.includes('INVALID_OPERATION_TYPE') ||
        rpcErr.message?.includes('CANNOT_FUND_TERMINAL_PAYMENT') ||
        rpcErr.message?.includes('INVALID_PAYMENT_STATUS')
      ) {
        return {
          success: false,
          code: 'RPC_VALIDATION_FAILURE',
          message: rpcErr.message,
        };
      }
      throw new Error(`TRANSIENT_RPC_ERROR: ${rpcErr.message}`);
    }

    if (!rpcResult || !rpcResult.success) {
      return {
        success: false,
        code: 'RPC_EXECUTION_FAILED',
        message: rpcResult?.error?.message || 'Atomic funding RPC returned unsuccessful result.',
      };
    }

    return {
      success: true,
      code: rpcResult.already_funded ? 'ALREADY_FUNDED' : 'NEWLY_FUNDED',
      message: rpcResult.already_funded
        ? 'Payment operation already funded idempotently.'
        : 'Credit top-up funded successfully.',
      alreadyFunded: rpcResult.already_funded,
      paymentOperationId: rpcResult.payment_operation_id,
      ledgerEntryId: rpcResult.ledger_entry_id,
      fundedAmountMinor: Number(rpcResult.funded_amount_minor),
      currency: rpcResult.currency,
    };
  }
}
