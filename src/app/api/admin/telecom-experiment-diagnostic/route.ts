import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getExperimentKeyVersion } from '@/lib/telephony/experimentCrypto';

/**
 * TEMPORARY DIAGNOSTIC ENDPOINT — PHASE 13.4.3B.2E
 * Server-authoritative HMAC key version verification.
 * Strictly requires authenticated Owner or Admin role session.
 * Returns ONLY the 8-character non-secret key version.
 */
export async function GET() {
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

    // Role-based privilege authorization against profiles table
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    const profile = profileData as { organization_id?: string; role?: string } | null;

    if (profileError || !profile) {
      return NextResponse.json(
        { error: 'Forbidden. Active user profile not found.' },
        { status: 403 }
      );
    }

    const userRole = (profile.role || '').toLowerCase();
    if (!['owner', 'admin'].includes(userRole)) {
      return NextResponse.json(
        { error: 'Forbidden. Diagnostic access requires Owner or Admin role.' },
        { status: 403 }
      );
    }

    // Return non-secret diagnostic version
    const experimentKeyVersion = getExperimentKeyVersion();

    return NextResponse.json({
      experimentKeyVersion,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Failed to retrieve experiment key version diagnostic.' },
      { status: 500 }
    );
  }
}
