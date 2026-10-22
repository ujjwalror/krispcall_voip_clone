import { NextResponse } from 'next/server';
import {
  authenticateExtensionRequest,
  getExtensionCorsHeaders,
  handleExtensionCorsOptions,
} from '@/lib/telephony/extensionAuth';

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

    const { generateVoiceAccessTokenAsync } = await import('@/lib/twilio/tokens');
    const result = await generateVoiceAccessTokenAsync(auth.twilioIdentity, 3600, {
      organizationId: auth.organizationId,
    });

    return NextResponse.json(
      {
        token: result.token,
        identity: result.identity,
        expiresInSeconds: result.expiresInSeconds,
      },
      { headers: corsHeaders }
    );
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    console.error('Error generating extension voice token:', err.message || err);
    const statusCode =
      err.code === 'CUSTOMER_SUBACCOUNT_WEBRTC_UNSUPPORTED' ||
      err.code === 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED'
        ? 403
        : 500;
    return NextResponse.json(
      { error: err.message || 'Failed to generate voice access token.' },
      { status: statusCode, headers: corsHeaders }
    );
  }
}
