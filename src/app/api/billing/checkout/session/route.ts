import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { StripePaymentElementService } from '@/lib/billing/providers/stripe/stripePaymentElementService';

async function getAuthenticatedUserAndRole(req: NextRequest) {
  const authHeader = req.headers.get('Authorization');
  let token = authHeader ? authHeader.replace('Bearer ', '') : null;

  // Fallback to cookie auth if Bearer token not provided in header
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

  if (!token) {
    const cookieHeader = req.headers.get('cookie') || '';
    const match = cookieHeader.match(/sb-access-token=([^;]+)/);
    if (match) {
      token = match[1];
    }
  }

  if (!token) {
    return { user: null, profile: null, status: 401, error: 'UNAUTHORIZED: Authentication required.' };
  }

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: { user }, error: userError } = await userClient.auth.getUser();

  if (userError || !user) {
    return { user: null, profile: null, status: 401, error: 'UNAUTHORIZED: Invalid session.' };
  }

  // Server-authoritative profile resolution
  const adminSupabase = createAdminClient();
  const { data: profile, error: profileError } = await (adminSupabase as any)
    .from('profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single();

  if (profileError || !profile || !profile.organization_id) {
    return { user, profile: null, status: 403, error: 'FORBIDDEN: Active organization membership required.' };
  }

  const role = (profile.role || '').toLowerCase();
  if (role !== 'owner' && role !== 'admin') {
    return { user, profile, status: 403, error: 'FORBIDDEN: Owner or Admin role required for payment checkout.' };
  }

  return { user, profile, status: 200, error: null };
}

export async function POST(req: NextRequest) {
  try {
    const authRes = await getAuthenticatedUserAndRole(req);
    if (authRes.error || !authRes.user || !authRes.profile) {
      return NextResponse.json({ error: authRes.error }, { status: authRes.status });
    }

    const body = await req.json().catch(() => ({}));
    const {
      phoneNumber,
      countryCode,
      numberType = 'local',
      expectedPriceMinor,
      consentToSaveMethod = false,
      attemptToken = '',
      bundleSid = null,
    } = body;

    if (!phoneNumber || !countryCode) {
      return NextResponse.json(
        { error: 'BAD_REQUEST: phoneNumber and countryCode are required.' },
        { status: 400 }
      );
    }

    // Never trust browser-supplied organization_id! Use server-resolved authRes.profile.organization_id
    const organizationId = authRes.profile.organization_id;
    const userId = authRes.user.id;

    const adminSupabase = createAdminClient();
    const result = await StripePaymentElementService.createOrRecoverCheckoutSession(
      adminSupabase,
      {
        organizationId,
        userId,
        phoneNumber,
        countryCode,
        numberType,
        expectedPriceMinor,
        consentToSaveMethod,
        attemptToken,
        bundleSid,
      }
    );

    if (!result.success) {
      const status = result.error?.code === 'QUOTE_EXPIRED_PRICE_CHANGED' ? 409 : 400;
      return NextResponse.json(
        {
          error: result.error?.code || 'CHECKOUT_SESSION_FAILED',
          message: result.error?.message || 'Checkout session creation failed.',
          customerSafeStatus: result.customerSafeStatus,
        },
        { status }
      );
    }

    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    console.error('[POST /api/billing/checkout/session] Error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to create or recover checkout session.' },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const authRes = await getAuthenticatedUserAndRole(req);
    if (authRes.error || !authRes.user || !authRes.profile) {
      return NextResponse.json({ error: authRes.error }, { status: authRes.status });
    }

    const { searchParams } = new URL(req.url);
    const operationId = searchParams.get('operationId') || undefined;
    const phoneNumber = searchParams.get('phoneNumber') || undefined;

    const organizationId = authRes.profile.organization_id;
    const adminSupabase = createAdminClient();

    const result = await StripePaymentElementService.getCheckoutSessionStatus(
      adminSupabase,
      organizationId,
      operationId,
      phoneNumber
    );

    if (!result.success) {
      return NextResponse.json(
        { error: result.error?.code || 'SESSION_NOT_FOUND', message: result.error?.message },
        { status: 404 }
      );
    }

    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    console.error('[GET /api/billing/checkout/session] Error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to retrieve checkout session status.' },
      { status: 500 }
    );
  }
}
