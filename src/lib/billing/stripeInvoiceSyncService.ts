import Stripe from 'stripe';
import { SupabaseClient } from '@supabase/supabase-js';
import { getStripeClient } from './providers/stripe/stripeClient';

export interface InvoiceSyncOptions {
  providerInvoiceId: string;
  expectedOrganizationId?: string;
  expectedMode?: 'test' | 'live';
  stripeOverride?: Stripe;
  eventPayload?: Stripe.Event | Stripe.Invoice | null;
  providerAccountId?: string;
}

export type InvoiceSyncClassification =
  | 'INVOICE_SYNC_SUCCESSFUL'
  | 'STRIPE_RETRIEVAL_FAILED'
  | 'ORGANIZATION_NOT_FOUND'
  | 'PROVIDER_CUSTOMER_ORGANIZATION_MISMATCH'
  | 'PROVIDER_SUBSCRIPTION_MAPPING_NOT_FOUND'
  | 'PROVIDER_SUBSCRIPTION_ORGANIZATION_MISMATCH'
  | 'PROVIDER_INVOICE_ORGANIZATION_CONFLICT'
  | 'INVALID_CURRENCY'
  | 'INVALID_INVOICE_STATUS'
  | 'MISSING_HEADER_FINANCIAL_FIELD'
  | 'INVALID_HEADER_MONETARY_VALUE'
  | 'INVALID_INVOICE_PERIOD'
  | 'INVALID_TIMESTAMP_FORMAT'
  | 'INVALID_INVOICE_STATE_TRANSITION'
  | 'TERMINAL_INVOICE_MUTATION_PROHIBITED'
  | 'INVALID_INVOICE_STATE_REGRESSION'
  | 'FINALIZED_INVOICE_BASELINE_CONFLICT'
  | 'FINALIZED_INVOICE_LINE_CONFLICT'
  | 'BLANK_PROVIDER_LINE_ID'
  | 'DUPLICATE_PROVIDER_LINE_ID'
  | 'LINE_CURRENCY_MISMATCH'
  | 'INVALID_LINE_QUANTITY'
  | 'INVALID_LINE_PERIOD'
  | 'DELETED_DRAFT_INVOICE_HANDLED'
  | 'DATABASE_ERROR';

export interface InvoiceSyncResult {
  success: boolean;
  classification: InvoiceSyncClassification;
  organizationId?: string;
  providerInvoiceId: string;
  status?: string;
  invoiceId?: string;
  message?: string;
  error?: {
    code: string;
    message: string;
  };
}

export class StripeInvoiceSyncService {
  /**
   * Authoritative Provider Invoice Synchronization Service.
   * Reconciles Stripe Invoice state into internal DB tables safely.
   */
  static async reconcileInvoiceFromProvider(
    supabase: SupabaseClient,
    options: InvoiceSyncOptions
  ): Promise<InvoiceSyncResult> {
    const { providerInvoiceId, expectedOrganizationId, stripeOverride, eventPayload } = options;

    if (!providerInvoiceId || providerInvoiceId.trim().length === 0) {
      return {
        success: false,
        classification: 'DATABASE_ERROR',
        providerInvoiceId: '',
        message: 'Invalid provider invoice ID',
        error: { code: 'INVALID_PROVIDER_INVOICE_ID', message: 'Invoice ID cannot be blank' },
      };
    }

    // 1. Authoritative Invoice Object Retrieval
    let stripeInvoice: Stripe.Invoice;
    if (eventPayload && 'id' in eventPayload && (eventPayload as any).object === 'invoice' && eventPayload.id === providerInvoiceId) {
      stripeInvoice = eventPayload as Stripe.Invoice;
    } else {
      try {
        let stripe: Stripe;
        if (stripeOverride) {
          stripe = stripeOverride;
        } else if (options?.providerAccountId) {
          const { StripeClientFactory } = await import('./providers/stripe/stripeClientFactory');
          stripe = await StripeClientFactory.getClientForAccount(supabase, options.providerAccountId, { environment: options?.expectedMode || 'test' });
        } else {
          stripe = getStripeClient();
        }
        stripeInvoice = await stripe.invoices.retrieve(providerInvoiceId, {
          expand: ['lines.data'],
        });
      } catch (err: any) {
        console.error('[StripeInvoiceSyncService] Stripe retrieve failed for invoice:', providerInvoiceId, err.message);
        return {
          success: false,
          classification: 'STRIPE_RETRIEVAL_FAILED',
          providerInvoiceId,
          message: `Stripe invoice retrieval failed: ${err.message}`,
          error: { code: 'STRIPE_RETRIEVAL_FAILED', message: err.message },
        };
      }
    }

    // Handle invoice deletion (retained-audit approach)
    if ((stripeInvoice as any).deleted) {
      return {
        success: true,
        classification: 'DELETED_DRAFT_INVOICE_HANDLED',
        providerInvoiceId,
        message: 'Draft invoice deletion event recorded without modifying finalized history.',
      };
    }

    const customerId =
      typeof stripeInvoice.customer === 'string'
        ? stripeInvoice.customer
        : stripeInvoice.customer?.id;

    if (!customerId) {
      return {
        success: false,
        classification: 'PROVIDER_CUSTOMER_ORGANIZATION_MISMATCH',
        providerInvoiceId,
        message: 'Stripe invoice missing customer ID.',
        error: { code: 'MISSING_CUSTOMER_ID', message: 'Invoice has no customer ID' },
      };
    }

    // 2. Resolve Tenant Organization from Customer Mapping
    const { data: customerMapping, error: custErr } = await (supabase as any)
      .from('billing_provider_customers')
      .select('organization_id')
      .eq('provider', 'stripe')
      .eq('provider_customer_id', customerId)
      .single();

    if (custErr || !customerMapping?.organization_id) {
      return {
        success: false,
        classification: 'PROVIDER_CUSTOMER_ORGANIZATION_MISMATCH',
        providerInvoiceId,
        message: `No organization mapping found for Stripe customer ${customerId}`,
        error: {
          code: 'PROVIDER_CUSTOMER_ORGANIZATION_MISMATCH',
          message: `Stripe customer ${customerId} is not mapped to any organization`,
        },
      };
    }

    const organizationId = customerMapping.organization_id;

    if (expectedOrganizationId && organizationId !== expectedOrganizationId) {
      return {
        success: false,
        classification: 'PROVIDER_CUSTOMER_ORGANIZATION_MISMATCH',
        providerInvoiceId,
        organizationId,
        message: `Customer belongs to org ${organizationId} but expected org ${expectedOrganizationId}`,
        error: {
          code: 'PROVIDER_CUSTOMER_ORGANIZATION_MISMATCH',
          message: `Customer mismatch: ${organizationId} vs ${expectedOrganizationId}`,
        },
      };
    }

    // 3. Prepare RPC Payload
    const rawSub = (stripeInvoice as any).subscription || (stripeInvoice as any).parent?.subscription_details?.subscription;
    const subscriptionId = typeof rawSub === 'string' ? rawSub : rawSub?.id || null;

    const payload = {
      id: stripeInvoice.id,
      customer: customerId,
      subscription: subscriptionId,
      status: stripeInvoice.status,
      currency: stripeInvoice.currency,
      subtotal: stripeInvoice.subtotal,
      discount_minor: (stripeInvoice.total_discount_amounts || []).reduce((acc, d) => acc + d.amount, 0),
      tax_minor: (stripeInvoice.total_taxes || []).reduce((acc, t) => acc + t.amount, 0),
      amount_due: stripeInvoice.amount_due,
      amount_paid: stripeInvoice.amount_paid,
      amount_remaining: stripeInvoice.amount_remaining,
      hosted_invoice_url: stripeInvoice.hosted_invoice_url || null,
      invoice_pdf: stripeInvoice.invoice_pdf || null,
      created: stripeInvoice.created,
      status_transitions: stripeInvoice.status_transitions
        ? {
            finalized_at: stripeInvoice.status_transitions.finalized_at || null,
            paid_at: stripeInvoice.status_transitions.paid_at || null,
            voided_at: stripeInvoice.status_transitions.voided_at || null,
            marked_uncollectible_at: stripeInvoice.status_transitions.marked_uncollectible_at || null,
          }
        : null,
      period_start: stripeInvoice.period_start,
      period_end: stripeInvoice.period_end,
      billing_reason: stripeInvoice.billing_reason || null,
      collection_method: stripeInvoice.collection_method || null,
      lines: {
        data: (stripeInvoice.lines?.data || []).map((line) => ({
          id: line.id,
          description: line.description || '',
          quantity: line.quantity,
          quantity_decimal: line.quantity_decimal || null,
          amount: line.amount,
          subtotal: line.subtotal,
          currency: line.currency,
          period: line.period ? { start: line.period.start, end: line.period.end } : null,
          pricing: line.pricing ? { unit_amount_decimal: line.pricing.unit_amount_decimal || null } : null,
        })),
      },
    };

    // 4. Call Atomic Reconciliation RPC
    const { data: rpcResult, error: rpcErr } = await (supabase as any).rpc(
      'reconcile_stripe_invoice_atomic',
      {
        p_organization_id: organizationId,
        p_payload: payload,
      }
    );

    if (rpcErr) {
      const errMsg = rpcErr.message || '';
      let classification: InvoiceSyncClassification = 'DATABASE_ERROR';

      if (errMsg.includes('ORGANIZATION_NOT_FOUND')) {
        classification = 'ORGANIZATION_NOT_FOUND';
      } else if (errMsg.includes('PROVIDER_CUSTOMER_ORGANIZATION_MISMATCH')) {
        classification = 'PROVIDER_CUSTOMER_ORGANIZATION_MISMATCH';
      } else if (errMsg.includes('PROVIDER_SUBSCRIPTION_MAPPING_NOT_FOUND')) {
        classification = 'PROVIDER_SUBSCRIPTION_MAPPING_NOT_FOUND';
      } else if (errMsg.includes('PROVIDER_SUBSCRIPTION_ORGANIZATION_MISMATCH')) {
        classification = 'PROVIDER_SUBSCRIPTION_ORGANIZATION_MISMATCH';
      } else if (errMsg.includes('PROVIDER_INVOICE_ORGANIZATION_CONFLICT')) {
        classification = 'PROVIDER_INVOICE_ORGANIZATION_CONFLICT';
      } else if (errMsg.includes('INVALID_CURRENCY')) {
        classification = 'INVALID_CURRENCY';
      } else if (errMsg.includes('INVALID_INVOICE_STATUS')) {
        classification = 'INVALID_INVOICE_STATUS';
      } else if (errMsg.includes('MISSING_HEADER_FINANCIAL_FIELD')) {
        classification = 'MISSING_HEADER_FINANCIAL_FIELD';
      } else if (errMsg.includes('INVALID_HEADER_MONETARY_VALUE')) {
        classification = 'INVALID_HEADER_MONETARY_VALUE';
      } else if (errMsg.includes('INVALID_INVOICE_PERIOD')) {
        classification = 'INVALID_INVOICE_PERIOD';
      } else if (errMsg.includes('INVALID_TIMESTAMP_FORMAT')) {
        classification = 'INVALID_TIMESTAMP_FORMAT';
      } else if (errMsg.includes('INVALID_INVOICE_STATE_TRANSITION')) {
        classification = 'INVALID_INVOICE_STATE_TRANSITION';
      } else if (errMsg.includes('TERMINAL_INVOICE_MUTATION_PROHIBITED')) {
        classification = 'TERMINAL_INVOICE_MUTATION_PROHIBITED';
      } else if (errMsg.includes('INVALID_INVOICE_STATE_REGRESSION')) {
        classification = 'INVALID_INVOICE_STATE_REGRESSION';
      } else if (errMsg.includes('FINALIZED_INVOICE_BASELINE_CONFLICT')) {
        classification = 'FINALIZED_INVOICE_BASELINE_CONFLICT';
      } else if (errMsg.includes('FINALIZED_INVOICE_LINE_CONFLICT')) {
        classification = 'FINALIZED_INVOICE_LINE_CONFLICT';
      } else if (errMsg.includes('BLANK_PROVIDER_LINE_ID')) {
        classification = 'BLANK_PROVIDER_LINE_ID';
      } else if (errMsg.includes('DUPLICATE_PROVIDER_LINE_ID')) {
        classification = 'DUPLICATE_PROVIDER_LINE_ID';
      } else if (errMsg.includes('LINE_CURRENCY_MISMATCH')) {
        classification = 'LINE_CURRENCY_MISMATCH';
      } else if (errMsg.includes('INVALID_LINE_QUANTITY')) {
        classification = 'INVALID_LINE_QUANTITY';
      } else if (errMsg.includes('INVALID_LINE_PERIOD')) {
        classification = 'INVALID_LINE_PERIOD';
      }

      console.error('[StripeInvoiceSyncService] RPC reconciliation error:', errMsg);
      return {
        success: false,
        classification,
        organizationId,
        providerInvoiceId,
        message: `Invoice reconciliation failed: ${errMsg}`,
        error: { code: classification, message: errMsg },
      };
    }

    return {
      success: true,
      classification: 'INVOICE_SYNC_SUCCESSFUL',
      organizationId,
      providerInvoiceId,
      status: rpcResult.status,
      invoiceId: rpcResult.invoice_id,
      message: 'Stripe invoice reconciled successfully.',
    };
  }
}
