import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ paymentOperationId: string }> }
) {
  try {
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    // Server-authoritative organization & profile resolution
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'FORBIDDEN: Active organization profile required.', code: 'forbidden' },
        { status: 403 }
      );
    }

    const { paymentOperationId } = await params;

    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!paymentOperationId || typeof paymentOperationId !== 'string' || !uuidRegex.test(paymentOperationId.trim())) {
      return NextResponse.json(
        { error: 'INVALID_PAYMENT_OPERATION_ID', message: 'paymentOperationId must be a valid UUID v4.' },
        { status: 400 }
      );
    }

    const cleanOpId = paymentOperationId.trim();
    const adminSupabase = createAdminClient();

    // Query operation securely filtered by server-derived organization_id
    const { data: op, error: opError } = await (adminSupabase as any)
      .from('billing_payment_operations')
      .select('id, organization_id, operation_type, status, amount_minor, currency')
      .eq('id', cleanOpId)
      .maybeSingle();

    if (opError || !op) {
      return NextResponse.json(
        { error: 'OPERATION_NOT_FOUND', message: 'Payment operation not found.' },
        { status: 404 }
      );
    }

    // STRICT CROSS-TENANT ISOLATION: Operation must belong to authenticated user's organization!
    if (op.organization_id !== profile.organization_id) {
      return NextResponse.json(
        { error: 'OPERATION_NOT_FOUND', message: 'Payment operation not found.' },
        { status: 404 }
      );
    }

    // STRICT OPERATION-TYPE ISOLATION: Operation must be credit_topup!
    if (op.operation_type !== 'credit_topup') {
      return NextResponse.json(
        { error: 'OPERATION_NOT_FOUND', message: 'Payment operation not found.' },
        { status: 404 }
      );
    }

    // Durable exact-once funding condition: status === 'captured' or 'completed'
    const isFunded = op.status === 'captured' || op.status === 'completed';

    // CUSTOMER-SAFE RESPONSE CONTRACT:
    // Strictly omit provider_payment_id, Stripe PaymentIntent ID, provider_account_id, and internal keys!
    return NextResponse.json(
      {
        success: true,
        paymentOperationId: op.id,
        status: op.status,
        funded: isFunded,
        amountMinor: Number(op.amount_minor),
        currency: op.currency,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      }
    );
  } catch (error: any) {
    console.error('[GET /api/billing/credit/checkout/[paymentOperationId]/status] Error:', error.message || error);
    return NextResponse.json(
      {
        error: 'OPERATION_STATUS_UNAVAILABLE',
        message: 'Payment operation status is temporarily unavailable.',
      },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      }
    );
  }
}
