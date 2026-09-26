import { NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { WorkspaceVerificationService } from '@/lib/telephony/verification/workspaceVerificationService';
import { isMockVerificationEnabled } from '@/lib/telephony/verification/vendorProvider';
import { WorkspaceVerificationType } from '@/lib/telephony/verification/types';

/**
 * GET /api/workspace-verification
 * Retrieves customer-safe workspace verification status for the authenticated user's organization.
 * Tenant organization and user role are resolved strictly server-side from session.
 */
export async function GET() {
  try {
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user: currentUser, supabase } = sessionResult;

    const { data: profile, error: profileErr } = await (supabase as any)
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', currentUser.id)
      .single();

    if (profileErr || !profile || !profile.organization_id || !profile.active) {
      return NextResponse.json({ error: 'Forbidden. Active organization profile required.' }, { status: 403 });
    }

    const customerStatus = await WorkspaceVerificationService.getCustomerStatus(
      profile.organization_id,
      profile.role || 'agent'
    );

    return NextResponse.json({
      success: true,
      data: customerStatus,
      mock_enabled: isMockVerificationEnabled(),
    });
  } catch (err: any) {
    console.error('[API workspace-verification GET] Exception:', err.message || err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/workspace-verification
 * Handles customer workspace verification actions.
 * Never accepts browser-supplied organization_id.
 * Direct payload requesting status = 'verified' without valid server vendor/mock processing fails closed.
 */
export async function POST(request: Request) {
  try {
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user: currentUser, supabase } = sessionResult;

    const { data: profile, error: profileErr } = await (supabase as any)
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', currentUser.id)
      .single();

    if (profileErr || !profile || !profile.organization_id || !profile.active) {
      return NextResponse.json({ error: 'Forbidden. Active organization profile required.' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const action = body.action || 'start';
    const verificationType: WorkspaceVerificationType = body.verification_type === 'individual' ? 'individual' : 'business';

    // Anti-Fraud Safeguard: Direct client attempt to force 'verified' status without server validation is rejected
    if (body.status === 'verified' && action !== 'mock_complete') {
      return NextResponse.json(
        { error: 'Forbidden. Verification state can only be granted by trusted server provider evaluation.' },
        { status: 403 }
      );
    }

    if (action === 'start') {
      const result = await WorkspaceVerificationService.startVerificationSession(
        profile.organization_id,
        verificationType,
        profile.role || 'agent'
      );

      const customerStatus = await WorkspaceVerificationService.getCustomerStatus(
        profile.organization_id,
        profile.role || 'agent'
      );

      return NextResponse.json({
        success: true,
        data: customerStatus,
        redirect_url: result.redirect_url,
      });
    }

    if (action === 'mock_complete') {
      if (!isMockVerificationEnabled()) {
        return NextResponse.json(
          { error: 'Forbidden. Mock verification is disabled in current environment.' },
          { status: 403 }
        );
      }

      const targetStatus = body.target_status || 'verified';
      if (!['verified', 'rejected', 'action_required'].includes(targetStatus)) {
        return NextResponse.json({ error: 'Invalid target status for mock completion.' }, { status: 400 });
      }

      await WorkspaceVerificationService.applyMockCompletion(
        profile.organization_id,
        profile.role || 'agent',
        targetStatus
      );

      const customerStatus = await WorkspaceVerificationService.getCustomerStatus(
        profile.organization_id,
        profile.role || 'agent'
      );

      return NextResponse.json({
        success: true,
        data: customerStatus,
      });
    }

    return NextResponse.json({ error: 'Invalid action requested.' }, { status: 400 });
  } catch (err: any) {
    console.error('[API workspace-verification POST] Exception:', err.message || err);
    const statusCode = err.message?.startsWith('UNAUTHORIZED_ROLE') ? 403 : 500;
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: statusCode });
  }
}
