import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { StripePaymentElementService } from '@/lib/billing/providers/stripe/stripePaymentElementService';

async function getAuthenticatedUserAndRole(req: NextRequest) {
  const authHeader = req.headers.get('Authorization');
  let token = authHeader ? authHeader.replace('Bearer ', '') : null;

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

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: { user }, error: userError } = await userClient.auth.getUser();

  if (userError || !user) {
    return { user: null, profile: null, status: 401, error: 'UNAUTHORIZED: Invalid session.' };
  }

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
    return { user, profile, status: 403, error: 'FORBIDDEN: Owner or Admin role required for cancellation.' };
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
    const { operationId, reason = 'Explicit customer cancellation' } = body;

    if (!operationId) {
      return NextResponse.json(
        { error: 'BAD_REQUEST: operationId is required for cancellation.' },
        { status: 400 }
      );
    }

    const organizationId = authRes.profile.organization_id;
    const adminSupabase = createAdminClient();

    const result = await StripePaymentElementService.cancelCheckoutSession(
      adminSupabase,
      organizationId,
      operationId,
      reason
    );

    if (!result.success) {
      const status = result.customerSafeStatus === 'Verifying payment status' ? 409 : 400;
      return NextResponse.json(
        {
          error: 'CANCELLATION_FAILED',
          customerSafeStatus: result.customerSafeStatus,
          message: result.message,
        },
        { status }
      );
    }

    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    console.error('[POST /api/billing/checkout/cancel] Error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to cancel checkout session.' },
      { status: 500 }
    );
  }
}
