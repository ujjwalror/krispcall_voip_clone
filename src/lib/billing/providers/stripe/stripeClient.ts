import Stripe from 'stripe';

let stripeInstance: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (stripeInstance) {
    return stripeInstance;
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey || secretKey.trim().length === 0) {
    throw new Error(
      'STRIPE_CONFIGURATION_ERROR: STRIPE_SECRET_KEY environment variable is not configured.'
    );
  }

  stripeInstance = new Stripe(secretKey, {
    apiVersion: '2025-02-24.acacia' as any,
    appInfo: {
      name: 'Kripscall Voip SaaS Platform',
      version: '1.0.0',
    },
  });

  return stripeInstance;
}

export function verifyStripeWebhookSignature(
  rawBody: string | Buffer,
  signature: string
): Stripe.Event {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret || webhookSecret.trim().length === 0) {
    throw new Error(
      'STRIPE_CONFIGURATION_ERROR: STRIPE_WEBHOOK_SECRET environment variable is not configured.'
    );
  }

  const stripe = getStripeClient();
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}
