import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';

/**
 * POST /api/invitations/create
 * Authenticated API route for Owners and Admins to invite team members.
 * Enforces atomic database-level serialization against organization_subscriptions row lock
 * to guarantee that concurrent invitation creations & acceptances never exceed seat capacity.
 */
export async function POST(request: Request) {
  try {
    // 1. Enforce active session authority
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user: currentUser, supabase } = sessionResult;

    // 2. Load requester's profile & verify active account
    const { data: requesterProfileData, error: profileErr } = await (supabase as any)
      .from('profiles')
      .select('organization_id, role, active, email')
      .eq('id', currentUser.id)
      .single();

    const requester = requesterProfileData as {
      organization_id?: string;
      role?: string;
      active?: boolean;
      email?: string;
    } | null;

    if (profileErr || !requester || !requester.organization_id || !requester.active) {
      return NextResponse.json({ error: 'Forbidden. Active profile required.' }, { status: 403 });
    }

    // 3. Verify requester authority
    if (!['owner', 'admin'].includes(requester.role || '')) {
      return NextResponse.json(
        { error: 'Forbidden. Invitation creation requires Owner or Admin role.' },
        { status: 403 }
      );
    }

    // 3b. Enforce subscription state policy server-side (blocked during grace and suspension)
    const { SubscriptionPolicyService } = await import('@/lib/billing/subscriptionPolicyService');
    const mayAddSeats = await SubscriptionPolicyService.mayIncreaseSeats(requester.organization_id, supabase);
    if (!mayAddSeats) {
      return NextResponse.json(
        { error: 'Forbidden. Adding seats is restricted while subscription is in grace or suspended state.', code: 'subscription_restricted' },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { email: rawEmail, role: requestedRole, intended_phone_number_id, intendedPhoneNumberId } = body;

    if (!rawEmail || typeof rawEmail !== 'string') {
      return NextResponse.json({ error: 'Email address is required.' }, { status: 400 });
    }

    const email = rawEmail.toLowerCase().trim();
    if (!email.includes('@') || email.length < 5) {
      return NextResponse.json({ error: 'Valid email address is required.' }, { status: 400 });
    }

    // 4. Validate requested role against requester's authority
    let targetRole = (requestedRole || 'agent').toLowerCase().trim();
    if (targetRole === 'owner') {
      return NextResponse.json({ error: 'Forbidden. Owner role cannot be invited.' }, { status: 403 });
    }

    if (requester.role === 'admin') {
      if (['owner', 'admin'].includes(targetRole)) {
        return NextResponse.json(
          { error: 'Forbidden. Admins can only invite Manager or Agent roles.' },
          { status: 403 }
        );
      }
    }

    if (!['admin', 'manager', 'agent'].includes(targetRole)) {
      targetRole = 'agent';
    }

    // 5. Reject self-invitation
    if (requester.email && requester.email.toLowerCase().trim() === email) {
      return NextResponse.json(
        { error: 'You cannot invite yourself to your own workspace.' },
        { status: 400 }
      );
    }

    const adminSupabase = createAdminClient();

    // Validate optional intended_phone_number_id
    const targetNumberId = intended_phone_number_id || intendedPhoneNumberId;
    let validatedIntendedNumberId: string | null = null;
    if (targetNumberId && typeof targetNumberId === 'string') {
      const { data: phoneNum } = await (adminSupabase as any)
        .from('phone_numbers')
        .select('id, organization_id, active, status')
        .eq('id', targetNumberId)
        .eq('organization_id', requester.organization_id)
        .maybeSingle();

      if (phoneNum && phoneNum.active !== false && phoneNum.status === 'active') {
        validatedIntendedNumberId = phoneNum.id;
      }
    }

    // 6. Generate cryptographically secure raw token server-side and hash with SHA-256
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // 7. Atomic Creation via Database RPC (with subscription row lock for concurrency protection)
    const { data: rpcInvite, error: rpcErr } = await (adminSupabase as any).rpc('create_organization_invitation', {
      p_organization_id: requester.organization_id,
      p_email: email,
      p_role: targetRole,
      p_invited_by_user_id: currentUser.id,
      p_token_hash: tokenHash,
      p_expires_at: expiresAt,
      p_intended_phone_number_id: validatedIntendedNumberId,
    });

    let newInvite = rpcInvite ? (Array.isArray(rpcInvite) ? rpcInvite[0] : rpcInvite) : null;

    if (rpcErr) {
      const errMsg = rpcErr.message || '';
      if (errMsg.includes('seat_limit_reached')) {
        const { SeatBillingService } = await import('@/lib/billing/seatBillingService');
        const metrics = await SeatBillingService.calculateSeats(requester.organization_id, adminSupabase);
        return NextResponse.json(
          {
            error: errMsg.replace(/^seat_limit_reached:\s*/, ''),
            code: 'seat_limit_exceeded',
            usedOrReservedSeats: metrics.usedOrReservedSeats,
            limit: metrics.maxActiveUsersLimit,
          },
          { status: 403 }
        );
      }
      if (errMsg.includes('already_member')) {
        return NextResponse.json(
          { error: `User "${email}" is already a member of this workspace.`, code: 'already_member' },
          { status: 400 }
        );
      }
      if (errMsg.includes('duplicate_invitation')) {
        return NextResponse.json(
          { error: `A pending invitation has already been sent to "${email}".`, code: 'duplicate_invitation' },
          { status: 400 }
        );
      }

      // Fallback for pre-migration environment compatibility
      console.warn('[Invitations API] RPC create_organization_invitation not available, falling back to app-level check:', rpcErr.message);

      const { SeatBillingService } = await import('@/lib/billing/seatBillingService');
      const seatCheck = await SeatBillingService.canAddActiveUser(requester.organization_id, supabase);
      if (!seatCheck.allowed) {
        return NextResponse.json(
          {
            error: seatCheck.reason || 'Workspace active user limit exceeded.',
            code: 'seat_limit_exceeded',
            activeMembers: seatCheck.activeMembers,
            usedOrReservedSeats: seatCheck.usedOrReservedSeats,
            limit: seatCheck.limit,
          },
          { status: 403 }
        );
      }

      const insertPayload: Record<string, any> = {
        organization_id: requester.organization_id,
        email,
        role: targetRole,
        invited_by_user_id: currentUser.id,
        token_hash: tokenHash,
        status: 'pending',
        expires_at: expiresAt,
      };
      if (validatedIntendedNumberId) {
        insertPayload.intended_phone_number_id = validatedIntendedNumberId;
      }

      const { data: fallbackInvite, error: insertErr } = await (adminSupabase as any)
        .from('organization_invitations')
        .insert(insertPayload)
        .select('id, organization_id, email, role, status, expires_at, created_at, intended_phone_number_id')
        .single();

      if (insertErr || !fallbackInvite) {
        console.error('[Invitations API] Insert error:', insertErr);
        return NextResponse.json({ error: 'Failed to create invitation record.' }, { status: 500 });
      }
      newInvite = fallbackInvite;
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const acceptanceUrl = `${baseUrl}/invite/accept?token=${rawToken}`;

    return NextResponse.json({
      success: true,
      invitation: newInvite,
      acceptanceUrl,
    });
  } catch (error: any) {
    console.error('[Invitations Create API] Exception:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
