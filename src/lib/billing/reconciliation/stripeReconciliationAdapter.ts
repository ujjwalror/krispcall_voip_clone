import Stripe from 'stripe';
import { SupabaseClient } from '@supabase/supabase-js';
import { getStripeClient } from '../providers/stripe/stripeClient';
import { StripeClientFactory } from '../providers/stripe/stripeClientFactory';
import { ProviderAccountResolver } from '../providers/providerAccountResolver';
import {
  StripePaymentIntentSnapshot,
  StripeRefundSnapshot,
  StripeRefundSnapshotPage,
  StripeDisputeSnapshot,
} from './reconciliationTypes';

/**
 * Strict Read-Only Payment Provider Reconciliation Adapter.
 *
 * CRITICAL SECURITY CONTRACT:
 * Exposes ONLY read-only data retrieval methods for financial reconciliation.
 * NO mutation operations (create, confirm, capture, cancel, refund, update) are exposed.
 */
export interface IStripeReconciliationAdapter {
  getPaymentIntentState(params: {
    supabase: SupabaseClient;
    providerAccountId: string;
    environment: 'test' | 'live';
    paymentIntentId: string;
  }): Promise<StripePaymentIntentSnapshot | null>;

  listRefundStates(params: {
    supabase: SupabaseClient;
    providerAccountId: string;
    environment: 'test' | 'live';
    paymentIntentId?: string;
    limit?: number;
    startingAfter?: string;
  }): Promise<StripeRefundSnapshotPage>;

  getDisputeState(params: {
    supabase: SupabaseClient;
    providerAccountId: string;
    environment: 'test' | 'live';
    disputeId: string;
  }): Promise<StripeDisputeSnapshot | null>;
}

export class StripeReconciliationAdapter implements IStripeReconciliationAdapter {
  /**
   * Retrieves authoritative read-only snapshot of a Stripe PaymentIntent.
   * Resolves provider account credentials and strips all sensitive client secrets / PANs.
   */
  async getPaymentIntentState(params: {
    supabase: SupabaseClient;
    providerAccountId: string;
    environment: 'test' | 'live';
    paymentIntentId: string;
  }): Promise<StripePaymentIntentSnapshot | null> {
    const { supabase, providerAccountId, environment, paymentIntentId } = params;

    if (!paymentIntentId || !paymentIntentId.trim()) {
      throw new Error('STRIPE_RECON_ADAPTER_ERROR: paymentIntentId is required.');
    }

    let stripe: Stripe;
    try {
      stripe = await StripeClientFactory.getClientForAccount(supabase, providerAccountId, { environment });
    } catch (err: any) {
      if (err.message?.includes('PROVIDER_CREDENTIALS_UNAVAILABLE')) {
        throw err;
      }
      console.warn(`[StripeReconciliationAdapter] Provider account ${providerAccountId} resolution warning:`, err.message);
      throw new Error(`PROVIDER_CREDENTIALS_UNAVAILABLE: Unable to resolve provider account ${providerAccountId} credentials.`);
    }

    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId.trim());

      return {
        providerPaymentId: pi.id,
        providerAccountId,
        environment,
        status: pi.status,
        amountMinor: pi.amount,
        amountReceivedMinor: pi.amount_received || 0,
        currency: (pi.currency || 'usd').toUpperCase(),
        customerId: typeof pi.customer === 'string' ? pi.customer : pi.customer?.id || null,
        metadata: (pi.metadata as Record<string, string>) || {},
        createdAt: new Date(pi.created * 1000).toISOString(),
      };
    } catch (err: any) {
      if (err.statusCode === 404 || err.code === 'resource_missing') {
        return null; // Conclusively absent on provider
      }
      if (err.statusCode === 429 || err.type === 'StripeRateLimitError') {
        throw new Error(`PROVIDER_STATE_UNKNOWN: Stripe API rate limit exceeded (HTTP 429).`);
      }
      if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.type === 'StripeConnectionError') {
        throw new Error(`PROVIDER_STATE_UNKNOWN: Network timeout contacting Stripe API.`);
      }
      throw new Error(`PROVIDER_STATE_UNKNOWN: Stripe query error: ${err.message}`);
    }
  }

  /**
   * Lists authoritative read-only refund snapshots from Stripe.
   */
  async listRefundStates(params: {
    supabase: SupabaseClient;
    providerAccountId: string;
    environment: 'test' | 'live';
    paymentIntentId?: string;
    limit?: number;
    startingAfter?: string;
  }): Promise<StripeRefundSnapshotPage> {
    const { supabase, providerAccountId, environment, paymentIntentId, limit = 100, startingAfter } = params;

    let stripe: Stripe;
    try {
      stripe = await StripeClientFactory.getClientForAccount(supabase, providerAccountId, { environment });
    } catch (err: any) {
      if (err.message?.includes('PROVIDER_CREDENTIALS_UNAVAILABLE')) {
        throw err;
      }
      throw new Error(`PROVIDER_CREDENTIALS_UNAVAILABLE: Unable to resolve provider account ${providerAccountId} credentials.`);
    }

    const queryParams: Stripe.RefundListParams = {
      limit: Math.min(100, Math.max(1, limit)),
    };

    if (paymentIntentId && paymentIntentId.trim()) {
      queryParams.payment_intent = paymentIntentId.trim();
    }
    if (startingAfter && startingAfter.trim()) {
      queryParams.starting_after = startingAfter.trim();
    }

    try {
      const res = await stripe.refunds.list(queryParams);

      const refunds: StripeRefundSnapshot[] = res.data.map((ref) => ({
        providerRefundId: ref.id,
        providerPaymentId: typeof ref.payment_intent === 'string' ? ref.payment_intent : ref.payment_intent?.id || '',
        providerAccountId,
        environment,
        amountMinor: ref.amount,
        currency: (ref.currency || 'usd').toUpperCase(),
        status: ref.status || 'succeeded',
        reason: ref.reason || null,
        createdAt: new Date(ref.created * 1000).toISOString(),
      }));

      return {
        refunds,
        hasMore: res.has_more,
        nextStartingAfter: res.data.length > 0 ? res.data[res.data.length - 1].id : undefined,
      };
    } catch (err: any) {
      if (err.statusCode === 429 || err.type === 'StripeRateLimitError') {
        throw new Error(`PROVIDER_STATE_UNKNOWN: Stripe API rate limit exceeded (HTTP 429).`);
      }
      if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.type === 'StripeConnectionError') {
        throw new Error(`PROVIDER_STATE_UNKNOWN: Network timeout contacting Stripe API.`);
      }
      throw new Error(`PROVIDER_STATE_UNKNOWN: Stripe refund query error: ${err.message}`);
    }
  }

  /**
   * Retrieves authoritative read-only snapshot of a Stripe Dispute.
   */
  async getDisputeState(params: {
    supabase: SupabaseClient;
    providerAccountId: string;
    environment: 'test' | 'live';
    disputeId: string;
  }): Promise<StripeDisputeSnapshot | null> {
    const { supabase, providerAccountId, environment, disputeId } = params;

    if (!disputeId || !disputeId.trim()) {
      throw new Error('STRIPE_RECON_ADAPTER_ERROR: disputeId is required.');
    }

    let stripe: Stripe;
    try {
      stripe = await StripeClientFactory.getClientForAccount(supabase, providerAccountId, { environment });
    } catch (err: any) {
      if (err.message?.includes('PROVIDER_CREDENTIALS_UNAVAILABLE')) {
        throw err;
      }
      throw new Error(`PROVIDER_CREDENTIALS_UNAVAILABLE: Unable to resolve provider account ${providerAccountId} credentials.`);
    }

    try {
      const dispute = await stripe.disputes.retrieve(disputeId.trim());

      return {
        providerDisputeId: dispute.id,
        providerPaymentId: typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id || '',
        providerAccountId,
        environment,
        amountMinor: dispute.amount,
        currency: (dispute.currency || 'usd').toUpperCase(),
        status: dispute.status,
        reason: dispute.reason || null,
        createdAt: new Date(dispute.created * 1000).toISOString(),
      };
    } catch (err: any) {
      if (err.statusCode === 404 || err.code === 'resource_missing') {
        return null;
      }
      if (err.statusCode === 429 || err.type === 'StripeRateLimitError') {
        throw new Error(`PROVIDER_STATE_UNKNOWN: Stripe API rate limit exceeded (HTTP 429).`);
      }
      if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.type === 'StripeConnectionError') {
        throw new Error(`PROVIDER_STATE_UNKNOWN: Network timeout contacting Stripe API.`);
      }
      throw new Error(`PROVIDER_STATE_UNKNOWN: Stripe dispute query error: ${err.message}`);
    }
  }
}
