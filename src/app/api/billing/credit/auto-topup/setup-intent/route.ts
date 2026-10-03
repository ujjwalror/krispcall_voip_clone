import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { createAdminClient } from '@/lib/supabase/admin';
import { CreditAutoTopupService } from '@/lib/billing/creditAutoTopupService';

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
    const userRole = (profile.role || '').toLowerCase();
    if (!['owner', 'admin'].includes(userRole)) {
      return NextResponse.json(
        {
          error: 'FORBIDDEN: Only Organization Owners and Admins are authorized to configure Auto Top-Up.',
          code: 'forbidden',
        },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    let { attemptToken, thresholdMajor, rechargeAmountMajor, currency } = body;

    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!attemptToken || typeof attemptToken !== 'string' || !uuidRegex.test(attemptToken.trim())) {
      attemptToken = crypto.randomUUID();
    }

    const adminSupabase = createAdminClient();
    const result = await CreditAutoTopupService.createOrRecoverSetupIntent(
      adminSupabase,
      profile.organization_id,
      user.id,
      userRole,
      {
        attemptToken: attemptToken.trim(),
        thresholdMajor: thresholdMajor ? Number(thresholdMajor) : undefined,
        rechargeAmountMajor: rechargeAmountMajor ? Number(rechargeAmountMajor) : undefined,
        currency,
      }
    );

    if (!result.success) {
      const statusCode = result.code === 'FORBIDDEN' ? 403 : result.code?.includes('INVALID') ? 400 : 500;
      return NextResponse.json(
        { error: result.code || 'SETUP_INTENT_FAILED', message: result.message },
        { status: statusCode, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json(
      {
        success: true,
        attemptToken: result.attemptToken,
        clientSecret: result.clientSecret,
        setupIntentId: result.setupIntentId,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: any) {
    console.error('[POST /api/billing/credit/auto-topup/setup-intent] Unexpected error:', error.message || error);
    return NextResponse.json(
      { error: 'SERVICE_UNAVAILABLE', message: 'Auto Top-Up setup service is temporarily unavailable.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
