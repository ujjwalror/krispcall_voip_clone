import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';

/**
 * POST /api/invitations/create
 * Authenticated API route for Owners and Admins to invite team members.
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

    const body = await request.json().catch(() => ({}));
    const { email: rawEmail, role: requestedRole } = body;

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

    // 6. Reject if email is already an active member of this organization
    const { data: existingMember } = await (adminSupabase as any)
      .from('profiles')
      .select('id')
      .eq('organization_id', requester.organization_id)
      .eq('email', email)
      .maybeSingle();

    if (existingMember) {
      return NextResponse.json(
        { error: `User "${email}" is already a member of this workspace.` },
        { status: 400 }
      );
    }

    // 7. Reject if duplicate pending invitation exists for this organization
    const { data: existingPendingInvite } = await (adminSupabase as any)
      .from('organization_invitations')
      .select('id')
      .eq('organization_id', requester.organization_id)
      .eq('email', email)
      .eq('status', 'pending')
      .maybeSingle();

    if (existingPendingInvite) {
      return NextResponse.json(
        { error: `A pending invitation has already been sent to "${email}".` },
        { status: 400 }
      );
    }

    // 8. Generate cryptographically secure raw token server-side and hash with SHA-256
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // 9. Store invitation in database
    const { data: newInvite, error: insertErr } = await (adminSupabase as any)
      .from('organization_invitations')
      .insert({
        organization_id: requester.organization_id,
        email,
        role: targetRole,
        invited_by_user_id: currentUser.id,
        token_hash: tokenHash,
        status: 'pending',
        expires_at: expiresAt,
      })
      .select('id, organization_id, email, role, status, expires_at, created_at')
      .single();

    if (insertErr || !newInvite) {
      console.error('[Invitations API] Insert error:', insertErr);
      return NextResponse.json({ error: 'Failed to create invitation record.' }, { status: 500 });
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
