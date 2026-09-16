import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptToken } from '@/lib/integrations/crm/crypto';
import { getCRMAdapter } from '@/lib/integrations/crm/registry';

export const dynamic = 'force-dynamic';

/**
 * POST /api/integrations/crm/zoho/disconnect
 * Admin-only endpoint to disconnect and revoke Zoho CRM integration for the organization.
 */
export async function POST() {
  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return NextResponse.json(
        { error: 'User profile not found.' },
        { status: 404 }
      );
    }

    if (profile.role !== 'admin') {
      return NextResponse.json(
        { error: 'Forbidden. Only organization Admins can disconnect CRM integrations.' },
        { status: 403 }
      );
    }

    const adminSupabase = createAdminClient();
    const { data: conn } = await (adminSupabase as any)
      .from('crm_connections')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .eq('provider', 'zoho')
      .single();

    if (conn && conn.encrypted_refresh_token) {
      try {
        const refreshToken = decryptToken(conn.encrypted_refresh_token);
        const zohoAdapter = getCRMAdapter('zoho');
        if (zohoAdapter.revokeToken) {
          await zohoAdapter.revokeToken({
            refreshToken,
            accountsDomain: conn.accounts_domain,
          });
        }
      } catch (err) {
        console.warn('[Zoho Disconnect API] Token revocation warning:', err);
      }
    }

    // Delete or set status to disconnected
    const { error: deleteError } = await (adminSupabase as any)
      .from('crm_connections')
      .delete()
      .eq('organization_id', profile.organization_id)
      .eq('provider', 'zoho');

    if (deleteError) {
      console.error('[Zoho Disconnect API] Error deleting connection:', deleteError);
      return NextResponse.json(
        { error: 'Failed to update CRM connection status.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Zoho CRM integration disconnected successfully.',
    });
  } catch (err: any) {
    console.error('[Zoho Disconnect API] Error during disconnect:', err);
    return NextResponse.json(
      { error: 'Internal server error disconnecting Zoho integration.' },
      { status: 500 }
    );
  }
}
