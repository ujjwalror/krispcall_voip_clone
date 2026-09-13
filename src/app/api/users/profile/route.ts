import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/**
 * PATCH /api/users/profile
 * Allows any authenticated active user to update their own profile preferences
 * (timezone, time_format). Strictly scoped to the authenticated user's own ID.
 */
export async function PATCH(request: Request) {
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

    const body = await request.json().catch(() => ({}));
    const timezone = (body.timezone || 'UTC').trim();
    const timeFormat = (body.time_format || body.timeFormat || '12h').trim();

    // Validate timeFormat
    if (timeFormat !== '12h' && timeFormat !== '24h') {
      return NextResponse.json(
        { error: 'Invalid time format. Must be "12h" or "24h".' },
        { status: 400 }
      );
    }

    // Validate IANA timezone
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      return NextResponse.json(
        { error: 'Invalid IANA time zone identifier.' },
        { status: 400 }
      );
    }

    // Update public.profiles strictly scoped to auth.uid()
    const { data: updatedProfile, error: updateError } = await (supabase as any)
      .from('profiles')
      .update({
        timezone,
        time_format: timeFormat,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)
      .select()
      .single();

    if (updateError) {
      console.error('Error updating user profile preferences:', updateError);
      return NextResponse.json(
        { error: `Database error saving preferences: ${updateError.message || updateError.code}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      profile: updatedProfile,
      message: 'Preferences saved',
    });
  } catch (error: any) {
    console.error('Error in PATCH /api/users/profile:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error updating preferences.' },
      { status: 500 }
    );
  }
}
