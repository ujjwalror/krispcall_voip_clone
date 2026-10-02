import Stripe from 'stripe';
import { SupabaseClient } from '@supabase/supabase-js';
import { getStripeClient } from './stripeClient';
import { StripeClientFactory } from './stripeClientFactory';

export interface CaptureDispatchParams {
  providerPaymentId: string;
  amountMinor: number;
  idempotencyKey: string;
  expectedMode: 'test' | 'live';
  supabase?: SupabaseClient;
  providerAccountId?: string;
}

export interface CaptureDispatchResult {
  success: boolean;
  status?: string;
  paymentIntent?: Stripe.PaymentIntent;
  error?: {
    code: string;
    message: string;
  };
}

export type CaptureDispatchFunction = (params: CaptureDispatchParams) => Promise<CaptureDispatchResult>;

export class StripeCaptureAdapter {
  /**
   * Returns true ONLY IF both PHASE13_PAYMENT_ENABLED and PHASE13_STRIPE_CAPTURE_ENABLED are explicitly 'true'.
   */
  static isCaptureExecutionAllowed(): boolean {
    return (
      process.env.PHASE13_PAYMENT_ENABLED === 'true' &&
      process.env.PHASE13_STRIPE_CAPTURE_ENABLED === 'true'
    );
  }

  /**
   * Executes authoritative Stripe PaymentIntent capture POST request.
   * Hard-gated: Returns GATE_DISABLED error if dual feature gates are not explicitly enabled.
   */
  static async capturePaymentIntent(params: CaptureDispatchParams): Promise<CaptureDispatchResult> {
    if (!this.isCaptureExecutionAllowed()) {
      return {
        success: false,
        error: {
          code: 'GATE_DISABLED',
          message: 'Real Stripe PaymentIntent capture execution is disabled by feature gates.',
        },
      };
    }

    const { providerPaymentId, amountMinor, idempotencyKey, expectedMode, supabase, providerAccountId } = params;

    if (!providerPaymentId || !amountMinor || !idempotencyKey) {
      return {
        success: false,
        error: {
          code: 'MISSING_PARAMETERS',
          message: 'Server-authoritative providerPaymentId, amountMinor, and idempotencyKey are required.',
        },
      };
    }

    let stripe: Stripe;
    if (supabase && providerAccountId) {
      stripe = await StripeClientFactory.getClientForAccount(supabase, providerAccountId, { environment: expectedMode });
    } else if (supabase && providerPaymentId) {
      const { data: op } = await (supabase as any)
        .from('billing_payment_operations')
        .select('provider_account_id')
        .eq('provider_payment_id', providerPaymentId)
        .maybeSingle();

      if (op?.provider_account_id) {
        stripe = await StripeClientFactory.getClientForAccount(supabase, op.provider_account_id, { environment: expectedMode });
      } else {
        stripe = getStripeClient();
      }
    } else {
      stripe = getStripeClient();
    }

    try {
      const paymentIntent = await stripe.paymentIntents.capture(
        providerPaymentId,
        {
          amount_to_capture: amountMinor,
        },
        {
          idempotencyKey,
        }
      );

      // Verify mode match on returned object
      const isLive = expectedMode === 'live';
      if (paymentIntent.livemode !== isLive) {
        return {
          success: false,
          status: paymentIntent.status,
          paymentIntent,
          error: {
            code: 'MODE_MISMATCH',
            message: `Captured PaymentIntent livemode (${paymentIntent.livemode}) does not match expected mode (${isLive}).`,
          },
        };
      }

      return {
        success: paymentIntent.status === 'succeeded',
        status: paymentIntent.status,
        paymentIntent,
      };
    } catch (err: any) {
      console.error('[StripeCaptureAdapter] Stripe paymentIntents.capture call threw error:', err.code || err.message || err);
      return {
        success: false,
        error: {
          code: err.code || 'STRIPE_CAPTURE_FAILED',
          message: err.message || 'PaymentIntent capture POST request failed.',
        },
      };
    }
  }
}
