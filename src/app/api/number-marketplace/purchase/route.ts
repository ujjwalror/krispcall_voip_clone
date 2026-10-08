import { NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { ProvisioningEngine } from '@/lib/telephony/commerce/provisioningEngine';
import { CreatePurchaseOperationParams } from '@/lib/telephony/commerce/providerNumberOperationService';

/**
 * POST /api/number-marketplace/purchase
 * Authoritative server-side purchase execution API entry point.
 * Strictly derives organization identity from authenticated server session.
 * Requires Owner or Admin authorization.
 * Never accepts browser-supplied organization_id or customer-supplied capacity limits / provider credentials.
 */
export async function POST(request: Request) {
  try {
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    // 1. Fetch user profile and verify active organization membership & role
    const { data: profile } = await supabase
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'Forbidden. Active organization profile required.' },
        { status: 403 }
      );
    }

    // Role gate: Only Owner or Admin can execute number purchases
    const userRole = (profile.role || '').toLowerCase();
    if (userRole !== 'owner' && userRole !== 'admin') {
      return NextResponse.json(
        { error: 'Forbidden. Phone number purchasing requires Owner or Admin role privileges.' },
        { status: 403 }
      );
    }

    // Enforce subscription state policy server-side (blocked during grace and suspension)
    const { SubscriptionPolicyService } = await import('@/lib/billing/subscriptionPolicyService');
    const mayPurchase = await SubscriptionPolicyService.mayPurchaseNumber(profile.organization_id, supabase);
    if (!mayPurchase) {
      return NextResponse.json(
        { error: 'Forbidden. Purchasing numbers is restricted while subscription is in grace or suspended state.', code: 'subscription_restricted' },
        { status: 403 }
      );
    }

    // 2. Resolve Server-Authoritative Line Entitlement Capacity Limit from Organizations / Phase 5 Entitlement Engine
    const { data: orgData, error: orgErr } = await supabase
      .from('organizations')
      .select('max_phone_numbers')
      .eq('id', profile.organization_id)
      .single();

    if (orgErr || !orgData) {
      return NextResponse.json(
        { error: 'Forbidden. Failed to resolve organization entitlement subscription limit.' },
        { status: 403 }
      );
    }

    const maxCapacityLimit = orgData.max_phone_numbers ?? 50;
    if (maxCapacityLimit <= 0) {
      return NextResponse.json(
        { error: 'Forbidden. Organization number capacity limit is zero. Purchases disabled.' },
        { status: 403 }
      );
    }

    // SERVER-AUTHORITATIVE PRE-PHASE-13 PAYMENT BOUNDARY GATE
    // Real automated payment authorization & Stripe checkout integration is Phase 13.
    // In Phase 12.4 runtime, purchases without verified payment authorization are blocked server-side.
    // NO client-supplied request headers, cookies, body fields, or query params can bypass this check.
    const paymentEnabled = process.env.PHASE13_PAYMENT_ENABLED === 'true';

    if (!paymentEnabled) {
      return NextResponse.json(
        {
          error: 'Payment authorization required. Full billing checkout and automated payment processing will be enabled in Phase 13.',
          code: 'PAYMENT_AUTHORIZATION_REQUIRED',
        },
        { status: 402 }
      );
    }

    const body = await request.json();

    // 3. Input Validation
    const phoneNumberE164 = (body.phoneNumberE164 || body.phoneNumber || '').trim();
    const countryCode = (body.countryCode || '').trim().toUpperCase();
    const numberType = (body.numberType || '').trim().toLowerCase();
    const idempotencyKey = (body.idempotencyKey || '').trim();

    if (!phoneNumberE164 || !/^\+[1-9]\d{1,14}$/.test(phoneNumberE164)) {
      return NextResponse.json(
        { error: 'Bad Request. Valid E.164 phone number is required.' },
        { status: 400 }
      );
    }

    if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) {
      return NextResponse.json(
        { error: 'Bad Request. Valid 2-letter ISO country code is required.' },
        { status: 400 }
      );
    }

    if (!['local', 'mobile', 'toll_free'].includes(numberType)) {
      return NextResponse.json(
        { error: 'Bad Request. Valid numberType (local, mobile, toll_free) is required.' },
        { status: 400 }
      );
    }

    if (!idempotencyKey || idempotencyKey.length < 8) {
      return NextResponse.json(
        { error: 'Bad Request. Valid idempotencyKey (min 8 characters) is required.' },
        { status: 400 }
      );
    }

    // 4. Construct purchase operation params
    // maxCapacityLimit is derived STRICTLY from server-authoritative Phase 5 entitlement model
    const params: CreatePurchaseOperationParams = {
      organizationId: profile.organization_id, // Derived strictly from server session
      maxCapacityLimit, // Server-authoritative line capacity limit
      idempotencyKey,
      phoneNumberE164,
      countryCode,
      numberType: numberType as 'local' | 'mobile' | 'toll_free',
      retailAmountMinor: Number(body.retailAmountMinor || 0),
      retailCurrency: (body.retailCurrency || 'USD').toUpperCase(),
      providerCostMinor: Number(body.providerCostMinor || 0),
      providerCostCurrency: (body.providerCostCurrency || 'USD').toUpperCase(),
      pricingSource: 'pricing_policy',
      complianceProfileId: body.complianceProfileId || null,
      endUserType: body.endUserType || null,
      regulatoryBundleSid: body.regulatoryBundleSid || null,
    };

    // 5. Execute Live Purchase Workflow through Provisioning Engine
    const resultDTO = await ProvisioningEngine.executeLivePurchaseWorkflow(params);

    return NextResponse.json({
      success: true,
      operation: resultDTO,
    });
  } catch (error: any) {
    console.error('[POST /api/number-marketplace/purchase] Exception:', error.message || error);
    return NextResponse.json(
      { error: error.message || 'An error occurred processing the purchase request.' },
      { status: 500 }
    );
  }
}
