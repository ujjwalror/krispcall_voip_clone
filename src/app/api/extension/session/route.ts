import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getExtensionCorsHeaders, handleExtensionCorsOptions } from '@/lib/telephony/extensionAuth';

export async function OPTIONS(request: Request) {
  return handleExtensionCorsOptions(request);
}

export async function GET(request: Request) {
  const corsHeaders = getExtensionCorsHeaders(request);

  try {
    const supabase = await createServerSupabaseClient();
    
    // Validate authenticated user session from browser cookies
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json(
        { authenticated: false, error: 'No active web session found.' },
        { status: 401, headers: corsHeaders }
      );
    }

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session || !session.access_token) {
      return NextResponse.json(
        { authenticated: false, error: 'Session token invalid or expired.' },
        { status: 401, headers: corsHeaders }
      );
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, full_name, role, organization_id, active')
      .eq('id', user.id)
      .single();

    if (profile && (profile as any).active === false) {
      return NextResponse.json(
        { authenticated: false, error: 'Your account is inactive.' },
        { status: 403, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      {
        authenticated: true,
        token: session.access_token,
        user: {
          id: user.id,
          email: user.email,
          fullName: (profile as any)?.full_name || user.email,
          role: (profile as any)?.role || 'agent',
          organizationId: (profile as any)?.organization_id || null,
        },
      },
      { headers: corsHeaders }
    );
  } catch (error: any) {
    return NextResponse.json(
      { authenticated: false, error: error.message || 'Session verification failed.' },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function POST(request: Request) {
  const corsHeaders = getExtensionCorsHeaders(request);

  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || !body.email || !body.password) {
      return NextResponse.json(
        { authenticated: false, error: 'Email and password are required.' },
        { status: 400, headers: corsHeaders }
      );
    }

    const email = String(body.email).trim().toLowerCase();
    const password = String(body.password);

    if (!email || !password) {
      return NextResponse.json(
        { authenticated: false, error: 'Email and password cannot be blank.' },
        { status: 400, headers: corsHeaders }
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
    const anonKey =
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      'placeholder';

    // Standalone Supabase client for extension password authentication
    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
    });

    const { data: authData, error: authError } = await authClient.auth.signInWithPassword({
      email,
      password,
    });

    if (authError || !authData.session || !authData.user) {
      return NextResponse.json(
        { authenticated: false, error: 'Invalid email or password.' },
        { status: 401, headers: corsHeaders }
      );
    }

    const user = authData.user;
    const session = authData.session;

    // Fetch user profile securely using admin client to check organization & active status
    const adminSupabase = createAdminClient();
    const { data: profile, error: profileError } = await (adminSupabase as any)
      .from('profiles')
      .select('id, full_name, role, organization_id, active')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return NextResponse.json(
        { authenticated: false, error: 'User profile not configured.' },
        { status: 403, headers: corsHeaders }
      );
    }

    if (profile.active === false) {
      return NextResponse.json(
        { authenticated: false, error: 'Your account is inactive. Please contact your administrator.' },
        { status: 403, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      {
        authenticated: true,
        token: session.access_token,
        user: {
          id: user.id,
          email: user.email,
          fullName: profile.full_name || user.email,
          role: profile.role || 'agent',
          organizationId: profile.organization_id || null,
        },
      },
      { headers: corsHeaders }
    );
  } catch (err: any) {
    console.error('[VoIP Hub Extension Auth API Error]:', err?.message || err);
    return NextResponse.json(
      { authenticated: false, error: 'Authentication failed due to a server error.' },
      { status: 500, headers: corsHeaders }
    );
  }
}
