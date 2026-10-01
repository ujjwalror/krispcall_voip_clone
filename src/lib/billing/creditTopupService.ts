import { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import Stripe from 'stripe';
import { getStripeClient } from './providers/stripe/stripeClient';
import { StripeCustomerService } from './providers/stripe/stripeCustomerService';
import { formatMinorUnitsToCurrency } from './currencyFormatter';

export interface CreateCreditTopupParams {
  organizationId: string;
  userId: string;
  attemptToken: string;
  amountMinor: number;
}

export interface CreditTopupCheckoutResult {
  success: boolean;
  paymentOperationId?: string;
  clientSecret?: string | null;
  amountMinor?: number;
  formattedAmount?: string;
  currency?: string;
  paymentStatus?: string;
  fundingStatus?: string;
  reusedAttempt?: boolean;
  error?: {
    code: string;
    message: string;
  };
}

export class CreditTopupService {
  /**
   * Generates a request fingerprint for local payment operation validation.
   */
  static generateFingerprint(organizationId: string, amountMinor: number, currency: string, attemptToken: string): string {
    const raw = `credit_topup:${organizationId}:${amountMinor}:${currency.toUpperCase()}:${attemptToken}`;
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return `sha256:${hash}`;
  }

  /**
   * Server-authoritatively creates or recovers an Add Credits payment operation & Stripe PaymentIntent.
   */
  static async createOrRecoverCheckoutSession(
    supabase: SupabaseClient,
    params: CreateCreditTopupParams,
    options?: { stripeOverride?: Stripe }
  ): Promise<CreditTopupCheckoutResult> {
    const { organizationId, userId, attemptToken, amountMinor } = params;

    // 1. Technical Input Validation
    if (!attemptToken || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$|^[a-zA-Z0-9_-]{8,64}$/.test(attemptToken)) {
      return {
        success: false,
        error: {
          code: 'INVALID_ATTEMPT_TOKEN',
          message: 'A valid checkout attempt token UUID is required.',
        },
      };
    }

    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      return {
        success: false,
        error: {
          code: 'INVALID_AMOUNT',
          message: 'Top-up amount must be a positive integer in minor units (cents).',
        },
      };
    }

    // 2. Resolve Authoritative Wallet Currency (Server-Side)
    const { data: latestLedger, error: ledgerErr } = await (supabase as any)
      .from('billing_credit_ledger')
      .select('currency')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (ledgerErr) {
      console.error('[CreditTopupService] Ledger currency resolution error:', ledgerErr.message);
      return {
        success: false,
        error: {
          code: 'WALLET_UNAVAILABLE',
          message: 'Unable to resolve authoritative organization wallet currency.',
        },
      };
    }

    const currency = (latestLedger?.currency || 'USD').toUpperCase();
    const idempotencyKey = `credit_topup:${organizationId}:${attemptToken}`;
    const requestFingerprint = this.generateFingerprint(organizationId, amountMinor, currency, attemptToken);

    // 3. Atomic Create-or-Get Local Operation in billing_payment_operations
    let paymentOp: any = null;
    let isReused = false;

    const { data: newOp, error: insertErr } = await (supabase as any)
      .from('billing_payment_operations')
      .insert({
        organization_id: organizationId,
        operation_type: 'credit_topup',
        provider: 'stripe',
        status: 'pending',
        amount_minor: amountMinor,
        currency,
        idempotency_key: idempotencyKey,
        request_fingerprint: requestFingerprint,
      })
      .select()
      .single();

    if (!insertErr && newOp) {
      paymentOp = newOp;
    } else if (insertErr && insertErr.code === '23505') {
      // Unique conflict on (organization_id, idempotency_key) -> Fetch existing operation
      isReused = true;
      const { data: existingOp, error: selectErr } = await (supabase as any)
        .from('billing_payment_operations')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('idempotency_key', idempotencyKey)
        .single();

      if (selectErr || !existingOp) {
        console.error('[CreditTopupService] Error fetching existing payment operation:', selectErr?.message);
        return {
          success: false,
          error: {
            code: 'PAYMENT_OPERATION_CONFLICT',
            message: 'Unable to recover existing checkout operation.',
          },
        };
      }

      paymentOp = existingOp;

      // Validate Same-Attempt Parameter Consistency
      if (Number(paymentOp.amount_minor) !== amountMinor || paymentOp.currency.toUpperCase() !== currency) {
        return {
          success: false,
          error: {
            code: 'ATTEMPT_PARAMETER_MISMATCH',
            message: 'This checkout attempt token was initialized with a different amount or currency.',
          },
        };
      }
    } else {
      console.error('[CreditTopupService] Database error creating payment operation:', insertErr?.message);
      return {
        success: false,
        error: {
          code: 'PAYMENT_OPERATION_CREATION_FAILED',
          message: 'Database error initializing payment operation.',
        },
      };
    }

    // 4. Resolve / Obtain Stripe Customer Idempotently
    let stripeCustomerId: string | null = null;
    try {
      stripeCustomerId = await StripeCustomerService.getOrCreateStripeCustomer(supabase, organizationId);
    } catch (custErr: any) {
      console.error('[CreditTopupService] Stripe customer resolution failed:', custErr.message);
      return {
        success: false,
        error: {
          code: 'STRIPE_CUSTOMER_UNAVAILABLE',
          message: 'Unable to resolve Stripe customer account.',
        },
      };
    }

    // 5. Create or Recover Stripe PaymentIntent
    const stripe = options?.stripeOverride || getStripeClient();
    const stripeIdempotencyKey = `credit_topup_pi_${paymentOp.id}`;

    let paymentIntent: Stripe.PaymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create(
        {
          amount: paymentOp.amount_minor,
          currency: paymentOp.currency.toLowerCase(),
          customer: stripeCustomerId || undefined,
          payment_method_types: ['card'],
          metadata: {
            organization_id: organizationId,
            payment_operation_id: paymentOp.id,
            operation_type: 'credit_topup',
          },
        },
        {
          idempotencyKey: stripeIdempotencyKey,
        }
      );
    } catch (stripeErr: any) {
      console.error('[CreditTopupService] Stripe PaymentIntent error:', stripeErr.message);
      return {
        success: false,
        error: {
          code: 'STRIPE_UNAVAILABLE',
          message: 'Payment service is temporarily unavailable. Please try again.',
        },
      };
    }

    // 6. Bind provider_payment_id compare-and-set safely
    if (paymentOp.provider_payment_id !== paymentIntent.id) {
      if (paymentOp.provider_payment_id !== null && paymentOp.provider_payment_id !== paymentIntent.id) {
        console.error(`[CreditTopupService] Provider binding conflict: op ${paymentOp.id} bound to ${paymentOp.provider_payment_id}, attempt to bind ${paymentIntent.id}`);
        return {
          success: false,
          error: {
            code: 'PROVIDER_BINDING_CONFLICT',
            message: 'Payment operation is bound to a different provider payment.',
          },
        };
      }

      const { data: updatedOp, error: updateErr } = await (supabase as any)
        .from('billing_payment_operations')
        .update({
          provider_payment_id: paymentIntent.id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', paymentOp.id)
        .select()
        .single();

      if (updateErr) {
        console.error('[CreditTopupService] Error updating provider_payment_id:', updateErr.message);
      } else if (updatedOp) {
        paymentOp = updatedOp;
      }
    }

    // 7. Establish Customer-Safe Response Statuses (CRITICAL CORRECTION)
    // Local DB status 'captured' (set ONLY by C.4B atomic RPC via C.4D webhook) is the EXCLUSIVE authority for funding.
    let paymentStatus = paymentIntent.status;
    let fundingStatus = 'pending_payment';

    if (paymentOp.status === 'captured') {
      paymentStatus = 'succeeded';
      fundingStatus = 'funded';
    } else if (paymentIntent.status === 'succeeded') {
      paymentStatus = 'succeeded';
      fundingStatus = 'pending_confirmation';
    }

    const formattedAmount = formatMinorUnitsToCurrency(paymentOp.amount_minor, paymentOp.currency);

    return {
      success: true,
      paymentOperationId: paymentOp.id,
      clientSecret: paymentIntent.client_secret,
      amountMinor: Number(paymentOp.amount_minor),
      formattedAmount,
      currency: paymentOp.currency,
      paymentStatus,
      fundingStatus,
      reusedAttempt: isReused,
    };
  }
}
