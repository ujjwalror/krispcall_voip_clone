import { NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';

export async function GET() {
  try {
    // 1. Enforce active session authority
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    // 2. Fetch authenticated user profile
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('active, twilio_identity, organization_id')
      .eq('id', user.id)
      .single();

    const profile = profileData as { active?: boolean; twilio_identity?: string | null; organization_id?: string } | null;

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

    // 5. Generate short-lived Twilio Access Token bound strictly to database profile identity and organization account context
    const { generateVoiceAccessTokenAsync } = await import('@/lib/twilio/tokens');
    const result = await generateVoiceAccessTokenAsync(profile.twilio_identity, 3600, {
      organizationId: profile.organization_id,
    });

    return NextResponse.json({
      token: result.token,
      identity: result.identity,
      expiresInSeconds: result.expiresInSeconds,
    });
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    console.error('Error generating Twilio Access Token:', err.message || err);
    const statusCode =
      err.code === 'CUSTOMER_SUBACCOUNT_WEBRTC_UNSUPPORTED' ||
      err.code === 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED' ||
      err.code === 'PROVIDER_ASSIGNMENT_REQUIRED'
        ? 403
        : 500;
    return NextResponse.json(
      { error: err.message || 'Failed to generate voice access token. Check server configuration.' },
      { status: statusCode }
    );
  }
}
