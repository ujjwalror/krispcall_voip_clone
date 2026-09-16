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
    const rawTimezone = body.timezone;
    const rawTimeFormat = body.time_format || body.timeFormat;
    const rawRingtoneVol = body.ringtone_volume ?? body.ringtoneVolume;
    const rawRingtoneName = body.ringtone_name ?? body.ringtoneName;

    const updatePayload: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    // Validate timeFormat if provided
    if (rawTimeFormat !== undefined && rawTimeFormat !== null) {
      const timeFormat = String(rawTimeFormat).trim();
      if (timeFormat !== '12h' && timeFormat !== '24h') {
        return NextResponse.json(
          { error: 'Invalid time format. Must be "12h" or "24h".' },
          { status: 400 }
        );
      }
      updatePayload.time_format = timeFormat;
    }

    if (rawTimezone !== undefined) {
      if (rawTimezone && typeof rawTimezone === 'string' && rawTimezone.trim() !== '' && rawTimezone.trim() !== 'AUTO') {
        let tz = rawTimezone.trim();
        if (tz === 'Asia/Calcutta') {
          tz = 'Asia/Kolkata';
        }
        try {
          Intl.DateTimeFormat(undefined, { timeZone: tz });
          updatePayload.timezone = tz;
        } catch {
          return NextResponse.json(
            { error: 'Invalid IANA time zone identifier.' },
            { status: 400 }
          );
        }
      } else {
        updatePayload.timezone = null;
      }
    }

    // Validate ringtone_volume if provided
    if (rawRingtoneVol !== undefined && rawRingtoneVol !== null) {
      const volNum = parseInt(String(rawRingtoneVol), 10);
      if (isNaN(volNum) || volNum < 0 || volNum > 100) {
        return NextResponse.json(
          { error: 'Invalid ringtone volume. Must be an integer between 0 and 100.' },
          { status: 400 }
        );
      }
      updatePayload.ringtone_volume = volNum;
    }

    // Validate ringtone_name if provided
    if (rawRingtoneName !== undefined && rawRingtoneName !== null) {
      const validKeys = ['classic', 'soft', 'digital', 'pulse', 'minimal'];
      const keyStr = String(rawRingtoneName).trim().toLowerCase();
      if (!validKeys.includes(keyStr)) {
        return NextResponse.json(
          { error: 'Invalid ringtone key.' },
          { status: 400 }
        );
      }
      updatePayload.ringtone_name = keyStr;
    }

    // Update public.profiles strictly scoped to auth.uid()
    const { data: updatedProfile, error: updateError } = await (supabase as any)
      .from('profiles')
      .update(updatePayload)
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
