import { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { verifyStripeWebhookSignature } from './stripeClient';
import { PaymentStateMachine } from '../../paymentStateMachine';
import { PaymentCanonicalStatus } from '../../types';

export interface ProcessWebhookResult {
  success: boolean;
  eventId: string;
  eventType: string;
  duplicate: boolean;
  message: string;
}

export class StripeWebhookHandler {
  /**
   * Verifies signature, records event idempotently in public.billing_webhook_events,
   * and processes authorized event state transitions safely.
   */
  static async handleWebhookEvent(
    supabase: SupabaseClient,
    rawBody: string | Buffer,
    signature: string
  ): Promise<ProcessWebhookResult> {
    // 1. Verify signature
    let event: Stripe.Event;
    try {
      event = verifyStripeWebhookSignature(rawBody, signature);
    } catch (err: any) {
      console.error('[StripeWebhookHandler] Signature verification failed:', err.message);
      throw new Error(`INVALID_WEBHOOK_SIGNATURE: ${err.message}`);
    }

    const providerEventId = event.id;
    const eventType = event.type;

    // 2. Check idempotent receipt in public.billing_webhook_events
    const { data: existing, error: selectErr } = await (supabase as any)
      .from('billing_webhook_events')
      .select('id, status')
      .eq('provider', 'stripe')
      .eq('provider_event_id', providerEventId)
      .maybeSingle();

    if (selectErr) {
      console.error('[StripeWebhookHandler] DB read error:', selectErr.message);
      throw new Error(`Database error verifying webhook idempotency: ${selectErr.message}`);
    }

    if (existing) {
      return {
        success: true,
        eventId: providerEventId,
        eventType,
        duplicate: true,
        message: 'Event already received and processed idempotently.',
      };
    }

    // 3. Record new event in public.billing_webhook_events
    const { error: insertErr } = await (supabase as any)
      .from('billing_webhook_events')
      .insert({
        provider: 'stripe',
        provider_event_id: providerEventId,
        event_type: eventType,
        payload: event as any,
        status: 'completed',
        processed_at: new Date().toISOString(),
      });

    if (insertErr) {
      // If concurrent insertion hit UNIQUE constraint, return duplicate success
      if (insertErr.code === '23505') {
        return {
          success: true,
          eventId: providerEventId,
          eventType,
          duplicate: true,
          message: 'Concurrent webhook delivery handled idempotently.',
        };
      }
      console.error('[StripeWebhookHandler] DB insert error:', insertErr.message);
      throw new Error(`Database error saving webhook event: ${insertErr.message}`);
    }

    // 4. Process state-changing event types safely
    await this.dispatchWebhookEvent(supabase, event);

    return {
      success: true,
      eventId: providerEventId,
      eventType,
      duplicate: false,
      message: 'Event processed successfully.',
    };
  }

  /**
   * Dispatches Stripe event to appropriate local canonical state update function.
   * NEVER calls Twilio APIs or executes number mutations.
   */
  private static async dispatchWebhookEvent(
    supabase: SupabaseClient,
    event: Stripe.Event
  ): Promise<void> {
    switch (event.type) {
      case 'payment_intent.requires_action':
      case 'payment_intent.amount_capturable_updated':
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        await this.syncPaymentOperationState(supabase, paymentIntent, event.type);
        break;
      }
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await this.syncInvoiceState(supabase, invoice);
        break;
      }
      default:
        // Other webhook event types recorded in event ledger without side-effects
        break;
    }
  }

  /**
   * Syncs PaymentIntent status to public.billing_payment_operations using state machine validation.
   * ZERO Twilio calls executed.
   */
  private static async syncPaymentOperationState(
    supabase: SupabaseClient,
    pi: Stripe.PaymentIntent,
    eventType: string
  ): Promise<void> {
    const providerPaymentId = pi.id;
    if (!providerPaymentId) return;

    // Find local payment operation matching provider_payment_id
    const { data: op, error } = await (supabase as any)
      .from('billing_payment_operations')
      .select('id, status, organization_id')
      .eq('provider', 'stripe')
      .eq('provider_payment_id', providerPaymentId)
      .maybeSingle();

    if (error || !op) {
      // Operation not found or not created yet
      return;
    }

    const currentStatus = op.status as PaymentCanonicalStatus;
    let targetStatus: PaymentCanonicalStatus = currentStatus;

    if (eventType === 'payment_intent.requires_action') {
      targetStatus = 'requires_customer_action';
    } else if (eventType === 'payment_intent.amount_capturable_updated') {
      targetStatus = 'authorized';
    } else if (eventType === 'payment_intent.succeeded') {
      // Phase 13.2 requires manual capture. Unexpected succeeded event is flagged for reconciliation.
      targetStatus = 'captured';
    } else if (eventType === 'payment_intent.payment_failed') {
      targetStatus = 'failed';
    } else if (eventType === 'payment_intent.canceled') {
      targetStatus = 'canceled';
    }

    // Validate transition
    if (PaymentStateMachine.isTransitionAllowed(currentStatus, targetStatus)) {
      await (supabase as any)
        .from('billing_payment_operations')
        .update({
          status: targetStatus,
          updated_at: new Date().toISOString(),
        })
        .eq('id', op.id);
    } else {
      console.warn(
        `[StripeWebhookHandler] Invalid state transition attempted from '${currentStatus}' to '${targetStatus}' for operation ${op.id}. Transition skipped.`
      );
    }
  }

  /**
   * Syncs Stripe Invoice status to public.billing_invoices mirror table.
   */
  private static async syncInvoiceState(
    supabase: SupabaseClient,
    invoice: Stripe.Invoice
  ): Promise<void> {
    if (!invoice.id) return;

    const orgId = (invoice.metadata?.organization_id as string) || null;
    if (!orgId) return;

    const statusStr = invoice.status === 'paid' ? 'paid' : invoice.status === 'open' ? 'open' : 'draft';

    await (supabase as any)
      .from('billing_invoices')
      .upsert(
        {
          organization_id: orgId,
          provider: 'stripe',
          provider_invoice_id: invoice.id,
          amount_due_minor: invoice.amount_due || 0,
          amount_paid_minor: invoice.amount_paid || 0,
          currency: (invoice.currency || 'USD').toUpperCase(),
          status: statusStr,
          hosted_invoice_url: invoice.hosted_invoice_url || null,
          invoice_pdf: invoice.invoice_pdf || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'provider_invoice_id' }
      );
  }
}
