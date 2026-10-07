import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { createAdminClient } from '@/lib/supabase/admin';
import { NumberRenewalPaymentIdentityService, OLD_MARKETPLACE_PI_ID } from '@/lib/telephony/marketplace/numberRenewalPaymentIdentityService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
        { error: 'FORBIDDEN', message: 'Active organization profile required.' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const userRole = (profile.role || '').toLowerCase();
    if (!['owner', 'admin'].includes(userRole)) {
      return NextResponse.json(
        { error: 'FORBIDDEN', message: 'Only Organization Owners and Admins can setup renewal payment methods.' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const body = await req.json().catch(() => ({}));
    let { attemptToken, phoneNumberId, billableResourceId, paymentIntentId } = body;

    // STRICT REJECTION: Old marketplace PaymentIntent cannot be passed or reused
    if (paymentIntentId === OLD_MARKETPLACE_PI_ID) {
      return NextResponse.json(
        { error: 'PROHIBITED_PI_REUSE', message: 'Historical marketplace PaymentIntent cannot be reused for renewal setup.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!attemptToken || typeof attemptToken !== 'string' || !uuidRegex.test(attemptToken.trim())) {
      attemptToken = crypto.randomUUID();
    }

    const adminSupabase = createAdminClient();
    const result = await NumberRenewalPaymentIdentityService.createRenewalSetupIntent(
      adminSupabase,
      {
        organizationId: profile.organization_id,
        userId: user.id,
        userRole,
        attemptToken: attemptToken.trim(),
        phoneNumberId: typeof phoneNumberId === 'string' ? phoneNumberId : undefined,
        billableResourceId: typeof billableResourceId === 'string' ? billableResourceId : undefined,
      }
    );

    if (!result.success) {
      const status = result.code === 'FORBIDDEN' ? 403 : result.code?.includes('INVALID') ? 400 : 500;
      return NextResponse.json(
        { error: result.code || 'SETUP_FAILED', message: result.message },
        { status, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json(result, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[POST /api/billing/numbers/renewal-setup-intent] Unexpected error:', err.message || err);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Renewal setup intent service unavailable.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

export async function PUT(req: NextRequest) {
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
        { error: 'FORBIDDEN', message: 'Active organization profile required.' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { attemptToken, setupIntentId, consentAccepted } = body;

    if (!consentAccepted) {
      return NextResponse.json(
        { error: 'CONSENT_REQUIRED', message: 'Explicit customer consent is required to authorize recurring number-rental charges.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const adminSupabase = createAdminClient();
    const result = await NumberRenewalPaymentIdentityService.completeRenewalSetupIntent(
      adminSupabase,
      {
        organizationId: profile.organization_id,
        userId: user.id,
        attemptToken: String(attemptToken || ''),
        setupIntentId: String(setupIntentId || ''),
        consentAccepted: true,
        consentScope: 'PHONE_NUMBER_RENTAL_RENEWAL',
      }
    );

    if (!result.success) {
      const status = result.code?.includes('INVALID') || result.code === 'CONSENT_REQUIRED' ? 400 : 500;
      return NextResponse.json(
        { error: result.code || 'COMPLETION_FAILED', message: result.message },
        { status, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json(result, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[PUT /api/billing/numbers/renewal-setup-intent] Unexpected error:', err.message || err);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Renewal setup completion service unavailable.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
