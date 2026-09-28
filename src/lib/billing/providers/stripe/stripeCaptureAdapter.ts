import Stripe from 'stripe';
import { getStripeClient } from './stripeClient';

/**
 * Phase 13.3.3.2C.1 — Stripe Capture Adapter
 * 
 * Minimal, production-grade wrapper for executing Stripe PaymentIntent capture POST requests.
 * 
 * DUAL FEATURE GATE INVARIANT:
 * Executable capture request is reachable ONLY WHEN BOTH:
 * 1. process.env.PHASE13_PAYMENT_ENABLED === 'true'
 * AND
 * 2. process.env.PHASE13_STRIPE_CAPTURE_ENABLED === 'true'
 * 
 * NO NODE_ENV INFERENCE.
 * 
 * SECURITY CONTRACT:
 * Receives ONLY server-authoritative inputs derived from canonical database records.
 * Does NOT accept browser inputs or make eligibility decisions itself.
 */

export interface CaptureDispatchParams {
  providerPaymentId: string;
  amountMinor: number;
  idempotencyKey: string;
  expectedMode: 'test' | 'live';
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

    const { providerPaymentId, amountMinor, idempotencyKey, expectedMode } = params;

    if (!providerPaymentId || !amountMinor || !idempotencyKey) {
      return {
        success: false,
        error: {
          code: 'MISSING_PARAMETERS',
          message: 'Server-authoritative providerPaymentId, amountMinor, and idempotencyKey are required.',
        },
      };
    }

    const stripe = getStripeClient();

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
