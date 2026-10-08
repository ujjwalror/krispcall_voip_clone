import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { createAdminClient } from '@/lib/supabase/admin';
import { WorkspacePaymentProfileService } from '@/lib/billing/workspacePaymentProfileService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try {
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'FORBIDDEN', message: 'Active organization profile required.' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const adminSupabase = createAdminClient();
    const result = await WorkspacePaymentProfileService.getWorkspacePaymentProfile(
      adminSupabase,
      profile.organization_id
    );

    return NextResponse.json(result, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[GET /api/billing/workspace-payment-profile] Unexpected error:', err.message || err);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Unable to load workspace payment profile.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

export async function PATCH(req: NextRequest) {
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

    const userRole = (profile.role || '').toLowerCase();
    if (!['owner', 'admin'].includes(userRole)) {
      return NextResponse.json(
        { error: 'FORBIDDEN', message: 'Only Organization Owners and Admins can update payment profile settings.' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { scopes, paymentMethod } = body;

    const adminSupabase = createAdminClient();

    if (paymentMethod && typeof paymentMethod === 'object' && paymentMethod.id) {
      await WorkspacePaymentProfileService.saveDefaultWorkspacePaymentMethod(
        adminSupabase,
        profile.organization_id,
        {
          id: String(paymentMethod.id),
          brand: String(paymentMethod.brand || 'card'),
          last4: String(paymentMethod.last4 || '0000'),
        }
      );
    } else if (scopes && typeof scopes === 'object') {
      await WorkspacePaymentProfileService.updateAuthorizationScopes(
        adminSupabase,
        profile.organization_id,
        user.id,
        userRole,
        scopes
      );
    }

    const updatedProfile = await WorkspacePaymentProfileService.getWorkspacePaymentProfile(
      adminSupabase,
      profile.organization_id
    );

    return NextResponse.json(updatedProfile, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[PATCH /api/billing/workspace-payment-profile] Unexpected error:', err.message || err);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Unable to update payment profile settings.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
