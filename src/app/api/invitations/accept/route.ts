import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/**
 * POST /api/invitations/accept
 * Invokes atomic database function public.accept_organization_invitation
 * to accept a pending invitation and join the organization.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();

    const {
      data: { user: currentUser },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !currentUser) {
      return NextResponse.json(
        { error: 'Unauthorized. Authenticated session required to accept invitation.' },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { token, fullName } = body;

    if (!token || typeof token !== 'string' || token.trim() === '') {
      return NextResponse.json({ error: 'Invitation token is required.' }, { status: 400 });
    }

    // Compute SHA-256 token hash server-side
    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');

    // Look up invitation to verify organization and seat limits
    const { data: inviteData } = await (supabase as any)
      .from('organization_invitations')
      .select('organization_id')
      .eq('token_hash', tokenHash)
      .eq('status', 'pending')
      .maybeSingle();

    if (inviteData?.organization_id) {
      const { SeatBillingService } = await import('@/lib/billing/seatBillingService');
      const { SubscriptionPolicyService } = await import('@/lib/billing/subscriptionPolicyService');

      const mayAddSeats = await SubscriptionPolicyService.mayIncreaseSeats(inviteData.organization_id, supabase);
      if (!mayAddSeats) {
        return NextResponse.json(
          { error: 'Forbidden. Joining workspace is restricted while subscription is in grace or suspended state.', code: 'subscription_restricted' },
          { status: 403 }
        );
      }

      const limitCheck = await SeatBillingService.canAddActiveUser(inviteData.organization_id, supabase);
      if (!limitCheck.allowed) {
        return NextResponse.json(
          { error: limitCheck.reason || 'Workspace active user limit exceeded.', code: 'seat_limit_exceeded' },
          { status: 403 }
        );
      }
    }

    // Invoke atomic database RPC function with server-generated token hash
    const { data: rpcResult, error: rpcErr } = await (supabase as any).rpc('accept_organization_invitation', {
      p_token_hash: tokenHash,
      p_full_name: fullName && typeof fullName === 'string' ? fullName.trim() : null,
    });

    if (rpcErr) {
      console.error('[Invitations Accept API] RPC Error:', rpcErr);
      const errMsg = rpcErr.message || 'Failed to accept invitation.';
      const isAuthMismatch = errMsg.includes('email');
      const isAlreadyMember = errMsg.includes('already belong');
      const isExpired = errMsg.includes('expired');

      const status = isAuthMismatch || isAlreadyMember || isExpired ? 400 : 500;
      return NextResponse.json({ error: errMsg }, { status });
    }

    const result = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (error: any) {
    console.error('[Invitations Accept API] Exception:', error.message || error);
    return NextResponse.json({ error: 'Internal server error accepting invitation.' }, { status: 500 });
  }
}
