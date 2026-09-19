import { NextResponse } from 'next/server';
import {
  authenticateExtensionRequest,
  getExtensionCorsHeaders,
  handleExtensionCorsOptions,
} from '@/lib/telephony/extensionAuth';
import { generateVoiceAccessToken } from '@/lib/twilio/tokens';

export async function OPTIONS(request: Request) {
  return handleExtensionCorsOptions(request);
}

export async function GET(request: Request) {
  const corsHeaders = getExtensionCorsHeaders(request);

  try {
    const { auth, errorResponse } = await authenticateExtensionRequest(request);
    if (errorResponse) return errorResponse;
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401, headers: corsHeaders });
    }

    if (!auth.twilioIdentity || auth.twilioIdentity.trim() === '') {
      return NextResponse.json(
        { error: 'Bad Request. Twilio identity not configured for this user profile.' },
        { status: 400, headers: corsHeaders }
      );
    }

    const result = generateVoiceAccessToken(auth.twilioIdentity);

    return NextResponse.json(
      {
        token: result.token,
        identity: result.identity,
        expiresInSeconds: result.expiresInSeconds,
      },
      { headers: corsHeaders }
    );
  } catch (error: any) {
    console.error('Error generating extension voice token:', error.message || error);
    return NextResponse.json(
      { error: 'Failed to generate voice access token.' },
      { status: 500, headers: corsHeaders }
    );
  }
}
