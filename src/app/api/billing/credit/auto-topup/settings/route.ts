import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { createAdminClient } from '@/lib/supabase/admin';
import { CreditAutoTopupService } from '@/lib/billing/creditAutoTopupService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET: Read customer Auto Top-Up settings.
 * Allowed for Owner, Admin, Manager, Agent.
 */
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
        { error: 'FORBIDDEN: Active organization profile required.', code: 'forbidden' },
        { status: 403 }
      );
    }

    const adminSupabase = createAdminClient();
    const result = await CreditAutoTopupService.getAutoTopupSettings(adminSupabase, profile.organization_id);

    return NextResponse.json(
      {
        success: true,
        settings: result.settings,
        userRole: profile.role,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: any) {
    console.error('[GET /api/billing/credit/auto-topup/settings] Error:', error.message || error);
    return NextResponse.json(
      { error: 'SETTINGS_UNAVAILABLE', message: 'Failed to retrieve Auto Top-Up settings.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

/**
 * POST: Complete SetupIntent & Enable/Update Auto Top-Up settings.
 * Owner / Admin ONLY.
 */
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
        { error: 'FORBIDDEN: Active organization profile required.', code: 'forbidden' },
        { status: 403 }
      );
    }

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
    const { attemptToken, setupIntentId } = body;

    if (!attemptToken || typeof attemptToken !== 'string' || !setupIntentId || typeof setupIntentId !== 'string') {
      return NextResponse.json(
        { error: 'INVALID_ARGUMENTS', message: 'attemptToken and setupIntentId strings are required.' },
        { status: 400 }
      );
    }

    const adminSupabase = createAdminClient();
    const result = await CreditAutoTopupService.completeAutoTopupEnrolment(
      adminSupabase,
      profile.organization_id,
      user.id,
      userRole,
      {
        attemptToken: attemptToken.trim(),
        setupIntentId: setupIntentId.trim(),
      }
    );

    if (!result.success) {
      const statusCode = result.code === 'FORBIDDEN' ? 403 : result.code?.includes('INVALID') ? 400 : 422;
      return NextResponse.json(
        { error: result.code || 'ENROLMENT_FAILED', message: result.message },
        { status: statusCode, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json(
      {
        success: true,
        settings: result.settings,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: any) {
    console.error('[POST /api/billing/credit/auto-topup/settings] Error:', error.message || error);
    return NextResponse.json(
      { error: 'ENROLMENT_UNAVAILABLE', message: 'Failed to complete Auto Top-Up enrolment.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

/**
 * DELETE: Disable Auto Top-Up.
 * Owner / Admin ONLY.
 */
export async function DELETE(req: NextRequest) {
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
        { error: 'FORBIDDEN: Active organization profile required.', code: 'forbidden' },
        { status: 403 }
      );
    }

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

    const adminSupabase = createAdminClient();
    const result = await CreditAutoTopupService.disableAutoTopup(
      adminSupabase,
      profile.organization_id,
      user.id,
      userRole,
      'customer_disabled'
    );

    if (!result.success) {
      return NextResponse.json(
        { error: result.code || 'DISABLE_FAILED', message: result.message },
        { status: 500, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json(
      { success: true, message: 'Auto Top-Up has been disabled.' },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error: any) {
    console.error('[DELETE /api/billing/credit/auto-topup/settings] Error:', error.message || error);
    return NextResponse.json(
      { error: 'DISABLE_UNAVAILABLE', message: 'Failed to disable Auto Top-Up.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
