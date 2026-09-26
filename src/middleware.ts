import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
  const supabasePublishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    'placeholder-publishable-key';

  const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({
          request,
        });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  // Refresh user session if necessary
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  // Exclude Twilio server webhooks, extension API endpoints, and public invitation verification/acceptance routes from browser authentication redirects
  if (
    pathname.startsWith('/api/twilio/voice/') ||
    pathname.startsWith('/api/twilio/status') ||
    pathname.startsWith('/api/twilio/recording') ||
    pathname.startsWith('/api/extension') ||
    pathname.startsWith('/api/invitations/verify') ||
    pathname.startsWith('/api/invitations/accept')
  ) {
    return NextResponse.next();
  }

  // Public auth routes (unauthenticated landing)
  const isAuthRoute =
    pathname === '/login' ||
    pathname === '/signup' ||
    pathname === '/forgot-password' ||
    pathname === '/reset-password';
  const isPublicRoute =
    isAuthRoute ||
    pathname.startsWith('/auth/callback') ||
    pathname.startsWith('/invite/accept');

  // 1. Unauthenticated users trying to access protected routes -> redirect to /login
  if (!user && !isPublicRoute && pathname !== '/') {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // 2. Authenticated users visiting auth routes -> check profile and redirect
  if (user && isAuthRoute) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', user.id)
      .maybeSingle();

    const url = request.nextUrl.clone();
    url.pathname = profile ? '/dashboard' : '/onboarding';
    return NextResponse.redirect(url);
  }

  // 3. Authenticated users onboarding check for protected web app routes (excluding API and public assets)
  if (user && !isPublicRoute && !pathname.startsWith('/api') && !pathname.startsWith('/_next')) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile) {
      if (pathname !== '/onboarding' && !pathname.startsWith('/invite/accept')) {
        const url = request.nextUrl.clone();
        url.pathname = '/onboarding';
        return NextResponse.redirect(url);
      }
    } else {
      if (pathname === '/onboarding') {
        const url = request.nextUrl.clone();
        url.pathname = '/dashboard';
        return NextResponse.redirect(url);
      }

      if (!profile.active) {
        const url = request.nextUrl.clone();
        url.pathname = '/login';
        url.searchParams.set('error', 'inactive');
        return NextResponse.redirect(url);
      }

      if (pathname.startsWith('/admin') && !['owner', 'admin'].includes(profile.role)) {
        const url = request.nextUrl.clone();
        url.pathname = '/dashboard';
        return NextResponse.redirect(url);
      }
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public assets
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
