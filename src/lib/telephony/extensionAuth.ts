import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export interface ExtensionAuthResult {
  userId: string;
  organizationId: string;
  twilioIdentity: string;
}

/**
 * Resolves the explicit allowlist of authorized extension IDs and development origins.
 * Configured via process.env.ALLOWED_EXTENSION_IDS (comma-separated list of Extension IDs).
 */
export function getAllowedExtensionOrigins(): Set<string> {
  const allowed = new Set<string>();

  const envIds = process.env.ALLOWED_EXTENSION_IDS || process.env.NEXT_PUBLIC_ALLOWED_EXTENSION_IDS || '';
  if (envIds) {
    envIds.split(',').forEach((id) => {
      const trimmed = id.trim();
      if (trimmed) {
        allowed.add(`chrome-extension://${trimmed}`);
      }
    });
  }

  const devId = process.env.DEVELOPMENT_EXTENSION_ID;
  if (devId) {
    allowed.add(`chrome-extension://${devId.trim()}`);
  }

  return allowed;
}

/**
 * Handles CORS preflight and response headers for Chrome Extension API endpoints.
 * Enforces explicit Chrome Extension ID origin matching.
 */
export function getExtensionCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin') || '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };

  const allowedOrigins = getAllowedExtensionOrigins();

  if (origin && (allowedOrigins.has(origin) || (process.env.NODE_ENV !== 'production' && origin.startsWith('http://localhost:')))) {
    headers['Access-Control-Allow-Origin'] = origin;
  } else if (!origin && process.env.NODE_ENV !== 'production') {
    headers['Access-Control-Allow-Origin'] = '*';
  }

  return headers;
}

export function handleExtensionCorsOptions(request: Request): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: getExtensionCorsHeaders(request),
  });
}

/**
 * Verifies Supabase Bearer token for Chrome Extension requests.
 * Extracts user ID, organization ID, and twilio identity strictly from database.
 */
export async function authenticateExtensionRequest(
  request: Request
): Promise<{ auth?: ExtensionAuthResult; errorResponse?: NextResponse }> {
  const corsHeaders = getExtensionCorsHeaders(request);
  const authHeader = request.headers.get('authorization') || '';

  if (!authHeader.startsWith('Bearer ')) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Unauthorized. Bearer access token required.' },
        { status: 401, headers: corsHeaders }
      ),
    };
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Unauthorized. Invalid Bearer token string.' },
        { status: 401, headers: corsHeaders }
      ),
    };
  }

  const adminSupabase = createAdminClient();

  // Verify JWT token with Supabase Auth
  const { data: userData, error: userError } = await adminSupabase.auth.getUser(token);

  if (userError || !userData?.user) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Unauthorized. Expired or invalid extension access token.' },
        { status: 401, headers: corsHeaders }
      ),
    };
  }

  const userId = userData.user.id;

  // Fetch active user profile and organization ID from database
  const { data: profile, error: profileError } = await (adminSupabase as any)
    .from('profiles')
    .select('organization_id, active, twilio_identity')
    .eq('id', userId)
    .single();

  if (profileError || !profile || !profile.organization_id || !profile.active) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Forbidden. User profile inactive or organization unconfigured.' },
        { status: 403, headers: corsHeaders }
      ),
    };
  }

  return {
    auth: {
      userId: profile.id || userId,
      organizationId: profile.organization_id,
      twilioIdentity: profile.twilio_identity || '',
    },
  };
}
