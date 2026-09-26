import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { createAdminClient } from '@/lib/supabase/admin';
import { StripePaymentElementService } from '@/lib/billing/providers/stripe/stripePaymentElementService';

export async function POST(req: NextRequest) {
  try {
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'FORBIDDEN: Active organization profile required.' },
        { status: 403 }
      );
    }

    const userRole = (profile.role || '').toLowerCase();
    if (userRole !== 'owner' && userRole !== 'admin') {
      return NextResponse.json(
        { error: 'FORBIDDEN: Phone number checkout cancellation requires Owner or Admin role privileges.' },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { operationId, reason = 'Explicit customer cancellation' } = body;

    if (!operationId) {
      return NextResponse.json(
        { error: 'BAD_REQUEST: operationId is required for cancellation.' },
        { status: 400 }
      );
    }

    const organizationId = profile.organization_id;
    const adminSupabase = createAdminClient();

    const result = await StripePaymentElementService.cancelCheckoutSession(
      adminSupabase,
      organizationId,
      operationId,
      reason
    );

    if (!result.success) {
      const status = result.customerSafeStatus === 'Verifying payment status' ? 409 : 400;
      return NextResponse.json(
        {
          error: 'CANCELLATION_FAILED',
          customerSafeStatus: result.customerSafeStatus,
          message: result.message,
        },
        { status }
      );
    }

    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    console.error('[POST /api/billing/checkout/cancel] Error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to cancel checkout session.' },
      { status: 500 }
    );
  }
}
