import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { generateVoiceAccessToken } from '@/lib/twilio/tokens';

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient();

    // 1. Verify Supabase session
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

    // 2. Fetch authenticated user profile
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('active, twilio_identity')
      .eq('id', user.id)
      .single();

    const profile = profileData as { active?: boolean; twilio_identity?: string | null } | null;

    if (profileError || !profile) {
      return NextResponse.json(
        { error: 'Forbidden. User profile not configured.' },
        { status: 403 }
      );
    }

    // 3. Verify active status
    if (!profile.active) {
      return NextResponse.json(
        { error: 'Forbidden. User account is currently inactive.' },
        { status: 403 }
      );
    }

    // 4. Verify Twilio identity exists
    if (!profile.twilio_identity || profile.twilio_identity.trim() === '') {
      return NextResponse.json(
        { error: 'Bad Request. Twilio identity not configured for this user.' },
        { status: 400 }
      );
    }

    // 5. Generate short-lived Twilio Access Token bound strictly to database profile identity
    const result = generateVoiceAccessToken(profile.twilio_identity);

    return NextResponse.json({
      token: result.token,
      identity: result.identity,
      expiresInSeconds: result.expiresInSeconds,
    });
  } catch (error: any) {
    console.error('Error generating Twilio Access Token:', error.message || error);
    return NextResponse.json(
      { error: 'Failed to generate voice access token. Check server configuration.' },
      { status: 500 }
    );
  }
}
