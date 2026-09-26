import { createServerSupabaseClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const next = requestUrl.searchParams.get('next');

  if (code) {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error && data?.user) {
      // Query profiles table to determine tenant membership state
      const { data: profileData } = await supabase
        .from('profiles')
        .select('id, active')
        .eq('id', data.user.id)
        .maybeSingle();

      const profile = profileData as { id: string; active?: boolean } | null;

      // 1. If next parameter is an invitation acceptance route (/invite/accept?token=...), redirect there directly
      if (next && next.startsWith('/invite/accept')) {
        return NextResponse.redirect(new URL(next, requestUrl.origin));
      }

      if (profile) {
        if (profile.active === false) {
          return NextResponse.redirect(new URL('/login?error=inactive', requestUrl.origin));
        }

        // Existing customer profile exists -> enter dashboard
        const targetPath =
          next && next.startsWith('/') && !next.startsWith('/login') && !next.startsWith('/signup')
            ? next
            : '/dashboard';
        return NextResponse.redirect(new URL(targetPath, requestUrl.origin));
      } else {
        // Authenticated user has NO profile -> redirect to onboarding to create organization
        return NextResponse.redirect(new URL('/onboarding', requestUrl.origin));
      }
    }
  }

  // Return user to login if code exchange fails or code is missing
  return NextResponse.redirect(new URL('/login?error=auth_callback_failed', requestUrl.origin));
}

