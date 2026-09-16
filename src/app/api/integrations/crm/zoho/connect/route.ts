import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createOAuthState } from '@/lib/integrations/crm/crypto';
import { getCRMAdapter } from '@/lib/integrations/crm/registry';

export const dynamic = 'force-dynamic';

/**
 * GET /api/integrations/crm/zoho/connect
 * Initiates the Zoho CRM OAuth 2.0 flow.
 * Admin-only authorization required.
 */
export async function GET(request: Request) {
  const settingsUrl = new URL('/settings?tab=integrations', request.url);

  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      settingsUrl.searchParams.set('error', 'Unauthorized. Authenticated session required.');
      return NextResponse.redirect(settingsUrl);
    }

    // Verify user role is 'admin'
    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      settingsUrl.searchParams.set('error', 'User profile not found.');
      return NextResponse.redirect(settingsUrl);
    }

    if (profile.role !== 'admin') {
      settingsUrl.searchParams.set('error', 'Forbidden. Only organization Admins can manage CRM integrations.');
      return NextResponse.redirect(settingsUrl);
    }

    // Check environment configuration
    if (!process.env.ZOHO_CLIENT_ID || !process.env.ZOHO_CLIENT_SECRET) {
      settingsUrl.searchParams.set('error', 'Zoho CRM connection has not been configured for this environment.');
      return NextResponse.redirect(settingsUrl);
    }

    // Determine redirect URI (supports both localhost:3000 and production HTTPS)
    let redirectUri = process.env.ZOHO_REDIRECT_URI;
    if (!redirectUri) {
      const url = new URL(request.url);
      redirectUri = `${url.protocol}//${url.host}/api/integrations/crm/zoho/callback`;
    }

    // Create cryptographically signed state
    const state = createOAuthState({
      userId: user.id,
      organizationId: profile.organization_id,
      provider: 'zoho',
    });

    const zohoAdapter = getCRMAdapter('zoho');
    const authUrl = zohoAdapter.getAuthorizationUrl({ state, redirectUri });

    // Store state in HTTP-only cookie for CSRF validation
    const cookieStore = await cookies();
    cookieStore.set('crm_oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 900, // 15 minutes
    });

    return NextResponse.redirect(authUrl);
  } catch (err: any) {
    console.error('[Zoho Connect API] Error initiating OAuth flow:', err);
    settingsUrl.searchParams.set('error', err.message || 'Zoho CRM connection has not been configured for this environment.');
    return NextResponse.redirect(settingsUrl);
  }
}
