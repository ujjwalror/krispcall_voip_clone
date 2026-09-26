import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * GET /api/invitations/verify?token=...
 * Public API route to verify an invitation token before signup/login.
 * Returns non-sensitive invitation details (organization name, invited email, role).
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const rawToken = searchParams.get('token');

    if (!rawToken || typeof rawToken !== 'string' || rawToken.trim() === '') {
      return NextResponse.json({ error: 'Invitation token parameter required.' }, { status: 400 });
    }

    const tokenHash = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
    const adminSupabase = createAdminClient();

    const { data: invite, error: fetchErr } = await (adminSupabase as any)
      .from('organization_invitations')
      .select(`
        id,
        organization_id,
        email,
        role,
        status,
        expires_at,
        organizations:organization_id(name, slug, status)
      `)
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (fetchErr) {
      console.error('[Invitations Verify API] DB error:', fetchErr);
      return NextResponse.json({ error: 'Database error verifying invitation token.' }, { status: 500 });
    }

    if (!invite) {
      return NextResponse.json({ error: 'Invalid or unrecognized invitation token.' }, { status: 404 });
    }

    if (invite.status !== 'pending') {
      return NextResponse.json(
        { error: `This invitation is no longer active (status: ${invite.status}).` },
        { status: 400 }
      );
    }

    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      return NextResponse.json(
        { error: 'This invitation link has expired. Please request a new invitation.' },
        { status: 400 }
      );
    }

    const org = invite.organizations as { name?: string; slug?: string; status?: string } | null;
    if (org?.status !== 'active') {
      return NextResponse.json(
        { error: 'The workspace organization associated with this invitation is inactive.' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      invitation: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        organizationName: org?.name || 'Workspace',
        organizationSlug: org?.slug || 'workspace',
      },
    });
  } catch (error: any) {
    console.error('[Invitations Verify API] Exception:', error.message || error);
    return NextResponse.json({ error: 'Internal server error verifying invitation.' }, { status: 500 });
  }
}
