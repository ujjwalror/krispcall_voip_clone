import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * GET /api/invitations/list
 * Returns pending and historical invitations for the authenticated user's organization.
 * Access: Owners and Admins only.
 */
export async function GET() {
  try {
    const supabase = await createServerSupabaseClient();

    const {
      data: { user: currentUser },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !currentUser) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

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
        { error: 'Forbidden. Viewing invitations requires Owner or Admin role.' },
        { status: 403 }
      );
    }

    const adminSupabase = createAdminClient();

    const { data: invitations, error: fetchErr } = await (adminSupabase as any)
      .from('organization_invitations')
      .select(`
        id,
        organization_id,
        email,
        role,
        status,
        expires_at,
        accepted_at,
        cancelled_at,
        created_at,
        invited_by_user_id,
        invited_by:profiles!invited_by_user_id(full_name, email)
      `)
      .eq('organization_id', requester.organization_id)
      .order('created_at', { ascending: false });

    if (fetchErr) {
      console.error('[Invitations List API] Error:', fetchErr);
      return NextResponse.json({ error: 'Failed to retrieve workspace invitations.' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      invitations: invitations || [],
    });
  } catch (error: any) {
    console.error('[Invitations List API] Exception:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
