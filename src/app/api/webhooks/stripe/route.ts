import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { StripeWebhookHandler } from '@/lib/billing/providers/stripe/stripeWebhookHandler';

/**
 * POST /api/webhooks/stripe
 * Production Stripe Webhook Receiver Endpoint.
 * Authenticated strictly via Stripe cryptographic signature header (stripe-signature).
 * Never accepts unverified JSON or browser credentials.
 */
export async function POST(request: Request) {
  try {
    const signature = request.headers.get('stripe-signature');
    if (!signature) {
      return NextResponse.json(
        { error: 'Bad Request. Missing stripe-signature header.' },
        { status: 400 }
      );
    }

    const rawBody = await request.text();
    if (!rawBody || rawBody.trim().length === 0) {
      return NextResponse.json(
        { error: 'Bad Request. Empty request payload.' },
        { status: 400 }
      );
    }

    const supabaseAdmin = createAdminClient();

    const result = await StripeWebhookHandler.handleWebhookEvent(
      supabaseAdmin,
      rawBody,
      signature
    );

    return NextResponse.json({
      received: true,
      eventId: result.eventId,
      eventType: result.eventType,
      duplicate: result.duplicate,
      message: result.message,
    });
  } catch (error: any) {
    console.error('[POST /api/webhooks/stripe] Exception processing webhook:', error.message || error);
    const status = error.message?.includes('INVALID_WEBHOOK_SIGNATURE') ? 400 : 500;
    return NextResponse.json(
      { error: error.message || 'Error processing webhook event.' },
      { status }
    );
  }
}
