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

    // Server-authoritative profile resolution
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
        { error: 'FORBIDDEN: Phone number payment checkout requires Owner or Admin role privileges.' },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const {
      phoneNumber,
      countryCode,
      numberType = 'local',
      expectedPriceMinor,
      consentToSaveMethod = false,
      attemptToken = '',
      bundleSid = null,
    } = body;

    if (!phoneNumber || !countryCode) {
      return NextResponse.json(
        { error: 'BAD_REQUEST: phoneNumber and countryCode are required.' },
        { status: 400 }
      );
    }

    // Never trust browser-supplied organization_id! Use server-resolved profile.organization_id
    const organizationId = profile.organization_id;
    const userId = user.id;

    const adminSupabase = createAdminClient();
    const result = await StripePaymentElementService.createOrRecoverCheckoutSession(
      adminSupabase,
      {
        organizationId,
        userId,
        phoneNumber,
        countryCode,
        numberType,
        expectedPriceMinor,
        consentToSaveMethod,
        attemptToken,
        bundleSid,
      }
    );

    if (!result.success) {
      const status = result.error?.code === 'QUOTE_EXPIRED_PRICE_CHANGED' ? 409 : 400;
      return NextResponse.json(
        {
          error: result.error?.code || 'CHECKOUT_SESSION_FAILED',
          message: result.error?.message || 'Checkout session creation failed.',
          customerSafeStatus: result.customerSafeStatus,
        },
        { status }
      );
    }

    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    console.error('[POST /api/billing/checkout/session] Error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to create or recover checkout session.' },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
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
        { error: 'FORBIDDEN: Phone number payment checkout status requires Owner or Admin role privileges.' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(req.url);
    const operationId = searchParams.get('operationId') || undefined;
    const phoneNumber = searchParams.get('phoneNumber') || undefined;

    const organizationId = profile.organization_id;
    const adminSupabase = createAdminClient();

    const result = await StripePaymentElementService.getCheckoutSessionStatus(
      adminSupabase,
      organizationId,
      operationId,
      phoneNumber
    );

    if (!result.success) {
      return NextResponse.json(
        { error: result.error?.code || 'SESSION_NOT_FOUND', message: result.error?.message },
        { status: 404 }
      );
    }

    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    console.error('[GET /api/billing/checkout/session] Error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to retrieve checkout session status.' },
      { status: 500 }
    );
  }
}
