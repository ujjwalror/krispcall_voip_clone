import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { createAdminClient } from '@/lib/supabase/admin';
import { CreditTopupService } from '@/lib/billing/creditTopupService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest) {
  try {
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    // Server-authoritative organization & role resolution
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'FORBIDDEN: Active organization profile required.', code: 'forbidden' },
        { status: 403 }
      );
    }

    // Role Authorization: Owner & Admin ONLY
    const allowedRoles = ['owner', 'admin'];
    if (!allowedRoles.includes((profile.role || '').toLowerCase())) {
      return NextResponse.json(
        {
          error: 'FORBIDDEN: Only organization Owners and Admins are authorized to initiate credit top-ups.',
          code: 'forbidden',
        },
        { status: 403 }
      );
    }

    // Enforce subscription state policy server-side (blocked during grace and suspension)
    const { SubscriptionPolicyService } = await import('@/lib/billing/subscriptionPolicyService');
    const mayFund = await SubscriptionPolicyService.mayFundWallet(profile.organization_id, supabase);
    if (!mayFund) {
      return NextResponse.json(
        { error: 'FORBIDDEN: Manual Telecom Credit top-up is restricted while subscription is in grace or suspended state.', code: 'subscription_restricted' },
        { status: 403 }
      );
    }

    // Parse Request Body
    const body = await req.json().catch(() => ({}));
    const { attemptToken, amountMinor } = body;

    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!attemptToken || typeof attemptToken !== 'string' || !uuidRegex.test(attemptToken.trim())) {
      return NextResponse.json(
        { error: 'INVALID_ATTEMPT_TOKEN', message: 'attemptToken UUID string is required.' },
        { status: 400 }
      );
    }

    if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      return NextResponse.json(
        { error: 'INVALID_AMOUNT', message: 'amountMinor must be a positive integer in minor units (cents).' },
        { status: 400 }
      );
    }

    const adminSupabase = createAdminClient();

    const result = await CreditTopupService.createOrRecoverCheckoutSession(adminSupabase, {
      organizationId: profile.organization_id,
      userId: user.id,
      attemptToken: attemptToken.trim(),
      amountMinor,
    });

    if (!result.success || result.error) {
      const statusCode =
        result.error?.code === 'ATTEMPT_PARAMETER_MISMATCH' || result.error?.code === 'PROVIDER_BINDING_CONFLICT'
          ? 409
          : result.error?.code === 'INVALID_AMOUNT' || result.error?.code === 'INVALID_ATTEMPT_TOKEN'
          ? 400
          : result.error?.code === 'CURRENCY_UNAVAILABLE' || result.error?.code === 'WALLET_UNAVAILABLE'
          ? 422
          : 500;

      return NextResponse.json(
        {
          error: result.error?.code || 'CHECKOUT_FAILED',
          message: result.error?.message || 'Credit checkout session failed.',
        },
        {
          status: statusCode,
          headers: {
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          },
        }
      );
    }

    return NextResponse.json(
      {
        success: true,
        paymentOperationId: result.paymentOperationId,
        clientSecret: result.clientSecret,
        amountMinor: result.amountMinor,
        formattedAmount: result.formattedAmount,
        currency: result.currency,
        paymentStatus: result.paymentStatus,
        fundingStatus: result.fundingStatus,
        reusedAttempt: result.reusedAttempt,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      }
    );
  } catch (error: any) {
    console.error('[POST /api/billing/credit/checkout] Unexpected error:', error.message || error);
    return NextResponse.json(
      {
        error: 'CHECKOUT_UNAVAILABLE',
        message: 'Credit checkout service is temporarily unavailable.',
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
