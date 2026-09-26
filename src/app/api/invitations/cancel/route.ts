import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';

/**
 * POST /api/invitations/cancel
 * Cancels a pending organization invitation.
 * Access: Owners and Admins.
 */
export async function POST(request: Request) {
  try {
    // 1. Enforce active session authority
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user: currentUser, supabase } = sessionResult;

    const { data: requesterProfileData, error: profileErr } = await (supabase as any)
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', currentUser.id)
      .single();

    const requester = requesterProfileData as {
      organization_id?: string;
      role?: string;
      active?: boolean;
    } | null;

    if (profileErr || !requester || !requester.organization_id || !requester.active) {
      return NextResponse.json({ error: 'Forbidden. Active profile required.' }, { status: 403 });
    }

    if (!['owner', 'admin'].includes(requester.role || '')) {
      return NextResponse.json(
        { error: 'Forbidden. Cancelling invitations requires Owner or Admin role.' },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { invitationId } = body;

    if (!invitationId || typeof invitationId !== 'string') {
      return NextResponse.json({ error: 'Invitation ID is required.' }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // Verify invitation belongs to requester's organization and is currently pending
    const { data: invite, error: fetchErr } = await (adminSupabase as any)
      .from('organization_invitations')
      .select('id, organization_id, status, role')
      .eq('id', invitationId)
      .eq('organization_id', requester.organization_id)
      .maybeSingle();

    if (fetchErr || !invite) {
      return NextResponse.json({ error: 'Invitation not found or access denied.' }, { status: 404 });
    }

    if (invite.status !== 'pending') {
      return NextResponse.json(
        { error: `Cannot cancel invitation with status "${invite.status}". Only pending invitations can be cancelled.` },
        { status: 400 }
      );
    }

    // Admins cannot cancel an invitation sent for Admin role unless requester is Owner
    if (requester.role === 'admin' && invite.role === 'admin') {
      return NextResponse.json(
        { error: 'Forbidden. Admins cannot cancel Admin-level invitations.' },
        { status: 403 }
      );
    }

    const nowIso = new Date().toISOString();
    const { error: updateErr } = await (adminSupabase as any)
      .from('organization_invitations')
      .update({
        status: 'cancelled',
        cancelled_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', invitationId);

    if (updateErr) {
      console.error('[Invitations Cancel API] Error:', updateErr);
      return NextResponse.json({ error: 'Failed to cancel invitation.' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: 'Invitation cancelled successfully.',
    });
  } catch (error: any) {
    console.error('[Invitations Cancel API] Exception:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
