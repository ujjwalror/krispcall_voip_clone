import { NextResponse } from 'next/server';
import { User, SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { extractSessionIdFromToken } from '@/lib/auth/session';

export type RequireActiveSessionResult =
  | {
      success: true;
      user: User;
      sessionId: string;
      supabase: SupabaseClient;
    }
  | {
      success: false;
      errorResponse: NextResponse;
    };

/**
 * Server-only helper to enforce single active session authority for protected API routes.
 * 1. Authenticates request via server Supabase getUser()
 * 2. Extracts JWT session_id claim
 * 3. Queries public.user_active_sessions under user's RLS context
 * 4. Fails closed if session is displaced, unregistered, invalid, or missing
 */
export async function requireActiveSession(
  customHeaders?: Record<string, string>
): Promise<RequireActiveSessionResult> {
  try {
    const supabase = await createServerSupabaseClient();

    // 1. Authenticate user with server Supabase client (getUser is the auth authority)
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return {
        success: false,
        errorResponse: NextResponse.json(
          { error: 'Unauthorized. Authenticated session required.', code: 'unauthorized' },
          { status: 401, headers: customHeaders }
        ),
      };
    }

    // 2. Retrieve session access token to read JWT claims for the current request
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const sessionId = session?.access_token
      ? extractSessionIdFromToken(session.access_token)
      : null;

    if (!sessionId) {
      return {
        success: false,
        errorResponse: NextResponse.json(
          { error: 'Invalid authenticated session claims.', code: 'session_invalid' },
          { status: 401, headers: customHeaders }
        ),
      };
    }

    // 3. Query public.user_active_sessions (RLS auth.uid() = user_id applies)
    const { data: activeSessionData, error: dbError } = await (supabase as any)
      .from('user_active_sessions')
      .select('active_session_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (dbError) {
      console.error('[requireActiveSession] Database error querying active session:', dbError);
      return {
        success: false,
        errorResponse: NextResponse.json(
          { error: 'Failed to verify session authority.', code: 'session_verification_failed' },
          { status: 500, headers: customHeaders }
        ),
      };
    }

    if (!activeSessionData) {
      return {
        success: false,
        errorResponse: NextResponse.json(
          { error: 'Active session not registered.', code: 'session_not_registered' },
          { status: 401, headers: customHeaders }
        ),
      };
    }

    // 4. Compare current JWT session_id against authoritative active_session_id
    if (activeSessionData.active_session_id !== sessionId) {
      return {
        success: false,
        errorResponse: NextResponse.json(
          { error: 'Session displaced by another active login.', code: 'session_displaced' },
          { status: 401, headers: customHeaders }
        ),
      };
    }

    return {
      success: true,
      user,
      sessionId,
      supabase,
    };
  } catch (err: any) {
    console.error('[requireActiveSession] Unexpected exception:', err.message || err);
    return {
      success: false,
      errorResponse: NextResponse.json(
        { error: 'Internal server error verifying session.', code: 'session_verification_failed' },
        { status: 500, headers: customHeaders }
      ),
    };
  }
}
