import { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { verifyStripeWebhookSignature } from './stripeClient';
import { PaymentStateMachine } from '../../paymentStateMachine';
import { PaymentCanonicalStatus } from '../../types';
import { CommercialCaptureReconciliationService } from '../../commercialCaptureReconciliationService';
import { CommercialSubscriptionSyncService, SubscriptionSyncResult } from '../../commercialSubscriptionSyncService';
import { StripeInvoiceSyncService, InvoiceSyncResult } from '../../stripeInvoiceSyncService';
import { CreditTopupWebhookService } from '../../creditTopupWebhookService';

export interface ProcessWebhookResult {
  success: boolean;
  eventId: string;
  eventType: string;
  duplicate: boolean;
  message: string;
  syncResult?: SubscriptionSyncResult | InvoiceSyncResult;
}

export class StripeWebhookHandler {
  /**
   * Verifies signature, records event idempotently in public.billing_webhook_events,
   * and processes authorized event state transitions safely.
   */
  static async handleWebhookEvent(
    supabase: SupabaseClient,
    rawBody: string | Buffer,
    signature: string,
    options?: { stripeOverride?: Stripe; skipSignatureVerification?: boolean }
  ): Promise<ProcessWebhookResult> {
    // 1. Verify signature
    let event: Stripe.Event;
    if (options?.skipSignatureVerification) {
      event = typeof rawBody === 'string' ? JSON.parse(rawBody) : JSON.parse(rawBody.toString());
    } else {
      try {
        event = verifyStripeWebhookSignature(rawBody, signature);
      } catch (err: any) {
        console.error('[StripeWebhookHandler] Signature verification failed:', err.message);
        throw new Error(`INVALID_WEBHOOK_SIGNATURE: ${err.message}`);
      }
    }

    const providerEventId = event.id;
    const eventType = event.type;
    const isSubscriptionEvent = eventType.startsWith('customer.subscription.');
    const isInvoiceEvent = eventType.startsWith('invoice.');

    // 2. Claim / Record Webhook Event safely
    const nowIso = new Date().toISOString();
    const staleThresholdMs = 5 * 60 * 1000; // 5 minutes conservative stale threshold

    // Try RPC claim_stripe_webhook_event_for_processing first
    const { data: claimResult, error: rpcErr } = await (supabase as any)
      .rpc('claim_stripe_webhook_event_for_processing', {
        p_provider_event_id: providerEventId,
        p_stale_threshold_seconds: 300,
      });

    if (!rpcErr && claimResult) {
      if (claimResult.claimed) {
        // Exclusive claim obtained for existing pending/failed/stale event
      } else if (claimResult.reason === 'not_found') {
        // Brand new event: Insert initial record in public.billing_webhook_events
        const initialStatus = (isSubscriptionEvent || isInvoiceEvent) ? 'processing' : 'completed';
        const { error: insertErr } = await (supabase as any)
          .from('billing_webhook_events')
          .insert({
            provider: 'stripe',
            provider_event_id: providerEventId,
            event_type: eventType,
            payload: event as any,
            status: initialStatus,
            processing_started_at: (isSubscriptionEvent || isInvoiceEvent) ? nowIso : null,
            processed_at: (isSubscriptionEvent || isInvoiceEvent) ? null : nowIso,
          });

        if (insertErr) {
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

        if (!isSubscriptionEvent && !isInvoiceEvent) {
          return {
            success: true,
            eventId: providerEventId,
            eventType,
            duplicate: false,
            message: 'Event recorded successfully.',
          };
        }
      } else {
        return {
          success: true,
          eventId: providerEventId,
          eventType,
          duplicate: true,
          message: claimResult.reason === 'completed'
            ? 'Event already received and processed idempotently.'
            : 'Event delivery currently processing in parallel.',
        };
      }
    } else {
      // Fallback for mock DB / client query if RPC not present in schema
      const { data: existing, error: selectErr } = await (supabase as any)
        .from('billing_webhook_events')
        .select('id, status, attempt_count, processing_started_at')
        .eq('provider', 'stripe')
        .eq('provider_event_id', providerEventId)
        .maybeSingle();

      if (selectErr) {
        console.error('[StripeWebhookHandler] DB read error:', selectErr.message);
        throw new Error(`Database error verifying webhook idempotency: ${selectErr.message}`);
      }

      if (existing) {
        if (existing.status === 'completed') {
          return {
            success: true,
            eventId: providerEventId,
            eventType,
            duplicate: true,
            message: 'Event already received and processed idempotently.',
          };
        }

        let reclaimQuery = (supabase as any)
          .from('billing_webhook_events')
          .update({
            status: 'processing',
            processing_started_at: nowIso,
            attempt_count: (existing.attempt_count || 0) + 1,
          })
          .eq('id', existing.id);

        if (existing.status === 'pending') {
          reclaimQuery = reclaimQuery.eq('status', 'pending');
        } else if (existing.status === 'failed') {
          reclaimQuery = reclaimQuery.eq('status', 'failed');
        } else if (existing.status === 'processing') {
          const startedTime = new Date(existing.processing_started_at).getTime();
          const isStale = Date.now() - startedTime >= staleThresholdMs;

          if (!isStale) {
            return {
              success: true,
              eventId: providerEventId,
              eventType,
              duplicate: true,
              message: 'Event delivery currently processing in parallel.',
            };
          }
          reclaimQuery = reclaimQuery.eq('status', 'processing').eq('processing_started_at', existing.processing_started_at);
        }

        const { data: reclaimed, error: reclaimErr } = await reclaimQuery.select('id').maybeSingle();

        if (reclaimErr || !reclaimed) {
          return {
            success: true,
            eventId: providerEventId,
            eventType,
            duplicate: true,
            message: 'Event delivery currently processing in parallel.',
          };
        }
      } else {
        // Record new event in public.billing_webhook_events
        const initialStatus = (isSubscriptionEvent || isInvoiceEvent) ? 'processing' : 'completed';

        const { error: insertErr } = await (supabase as any)
          .from('billing_webhook_events')
          .insert({
            provider: 'stripe',
            provider_event_id: providerEventId,
            event_type: eventType,
            payload: event as any,
            status: initialStatus,
            processing_started_at: (isSubscriptionEvent || isInvoiceEvent) ? nowIso : null,
            processed_at: (isSubscriptionEvent || isInvoiceEvent) ? null : nowIso,
          });

        if (insertErr) {
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
      }
    }

    // 4. Process state-changing event types safely
    const syncRes = await this.dispatchWebhookEvent(supabase, event, options?.stripeOverride);

    const isGateDisabled = (syncRes as any)?.classification === 'FEATURE_GATE_DISABLED';

    return {
      success: true,
      eventId: providerEventId,
      eventType,
      duplicate: false,
      message: isGateDisabled
        ? 'Webhook received and durably recorded as pending (subscription sync gate disabled).'
        : 'Event processed successfully.',
      syncResult: syncRes || undefined,
    };
  }

  /**
   * Dispatches Stripe event to appropriate local canonical state update function.
   * NEVER calls Twilio APIs or executes number mutations.
   */
  private static async dispatchWebhookEvent(
    supabase: SupabaseClient,
    event: Stripe.Event,
    stripeOverride?: Stripe
  ): Promise<SubscriptionSyncResult | InvoiceSyncResult | null> {
    const providerEventId = event.id;
    const nowIso = new Date().toISOString();

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const subId = sub.id;

        const syncResult = await CommercialSubscriptionSyncService.reconcileSubscriptionFromProvider(
          supabase,
          {
            providerSubscriptionId: subId,
            eventPayload: event,
            stripeOverride,
          }
        );

        if (syncResult.classification === 'FEATURE_GATE_DISABLED') {
          await (supabase as any)
            .from('billing_webhook_events')
            .update({
              status: 'pending',
              processing_started_at: null,
              last_error: 'SUBSCRIPTION_SYNC_DISABLED',
            })
            .eq('provider', 'stripe')
            .eq('provider_event_id', providerEventId);
        } else if (syncResult.success) {
          await (supabase as any)
            .from('billing_webhook_events')
            .update({
              status: 'completed',
              processed_at: nowIso,
              last_error: null,
            })
            .eq('provider', 'stripe')
            .eq('provider_event_id', providerEventId);
        } else {
          await (supabase as any)
            .from('billing_webhook_events')
            .update({
              status: 'failed',
              last_error: syncResult.error?.message || syncResult.message || `Subscription sync failed with classification: ${syncResult.classification}`,
            })
            .eq('provider', 'stripe')
            .eq('provider_event_id', providerEventId);
        }

        return syncResult;
      }
      case 'invoice.created':
      case 'invoice.finalized':
      case 'invoice.updated':
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.voided':
      case 'invoice.marked_uncollectible':
      case 'invoice.deleted': {
        const invoice = event.data.object as Stripe.Invoice;
        const invoiceId = invoice.id;

        const syncResult = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(
          supabase,
          {
            providerInvoiceId: invoiceId,
            eventPayload: event,
            stripeOverride,
          }
        );

        if (syncResult.success) {
          await (supabase as any)
            .from('billing_webhook_events')
            .update({
              status: 'completed',
              processed_at: nowIso,
              last_error: null,
            })
            .eq('provider', 'stripe')
            .eq('provider_event_id', providerEventId);
        } else {
          await (supabase as any)
            .from('billing_webhook_events')
            .update({
              status: 'failed',
              last_error: syncResult.error?.message || syncResult.message || `Invoice sync failed with classification: ${syncResult.classification}`,
            })
            .eq('provider', 'stripe')
            .eq('provider_event_id', providerEventId);
        }

        return syncResult;
      }
      case 'payment_intent.requires_action':
      case 'payment_intent.amount_capturable_updated':
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const opType = paymentIntent.metadata?.operation_type;

        if (event.type === 'payment_intent.succeeded' && opType === 'credit_topup') {
          const topupRes = await CreditTopupWebhookService.processPaymentIntentSucceeded(supabase, event);
          if (topupRes.success) {
            await (supabase as any)
              .from('billing_webhook_events')
              .update({
                status: 'completed',
                processed_at: nowIso,
                last_error: null,
              })
              .eq('provider', 'stripe')
              .eq('provider_event_id', providerEventId);
          } else {
            await (supabase as any)
              .from('billing_webhook_events')
              .update({
                status: 'completed',
                processed_at: nowIso,
                last_error: `CREDIT_TOPUP_FUNDING_REJECTED: [${topupRes.code}] ${topupRes.message}`,
              })
              .eq('provider', 'stripe')
              .eq('provider_event_id', providerEventId);
          }
          return null;
        }

        await this.syncPaymentOperationState(supabase, paymentIntent, event.type);
        return null;
      }
      default:
        return null;
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
      return;
    }

    const currentStatus = op.status as PaymentCanonicalStatus;
    let targetStatus: PaymentCanonicalStatus = currentStatus;

    if (eventType === 'payment_intent.succeeded') {
      const stripeMode = (process.env.STRIPE_EXPECTED_MODE || (pi.livemode ? 'live' : 'test')) as 'test' | 'live';
      const reconResult = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(
        supabase,
        {
          providerPaymentId,
          expectedMode: stripeMode,
        }
      );

      if (!reconResult.success && reconResult.classification === 'DISPATCH_NOT_CLAIMED_RECONCILIATION_REQUIRED') {
        console.warn(`[StripeWebhookHandler] payment_intent.succeeded received for ${providerPaymentId} without durable dispatch claim lock. Canonical capture skipped.`);
      }
      return;
    } else if (eventType === 'payment_intent.requires_action') {
      targetStatus = 'requires_customer_action';
    } else if (eventType === 'payment_intent.amount_capturable_updated') {
      targetStatus = 'authorized';
    } else if (eventType === 'payment_intent.payment_failed') {
      targetStatus = 'failed';
    } else if (eventType === 'payment_intent.canceled') {
      targetStatus = 'canceled';
    }

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
}
