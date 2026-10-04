import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { VoluntaryReleaseService } from '@/lib/telephony/lifecycle/voluntaryReleaseService';

/**
 * GET /api/phone-numbers/[id]/release
 * Evaluate eligibility for voluntary phone number release.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: phoneNumberId } = await params;
    if (!phoneNumberId) {
      return NextResponse.json({ error: 'Missing phone_number_id parameter' }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Resolve user's active organization and role from profile
    const { data: profileData } = await supabase
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    const profile = profileData as any;

    if (!profile || !profile.organization_id) {
      return NextResponse.json({ error: 'Organization context not found' }, { status: 403 });
    }

    const service = new VoluntaryReleaseService({ dbClient: supabase });
    const eligibility = await service.checkReleaseEligibility(
      profile.organization_id,
      phoneNumberId,
      profile.role || 'member'
    );

    return NextResponse.json({
      eligible: eligibility.eligible,
      blockers: eligibility.blockers,
      phoneNumberId: eligibility.phoneNumberId,
      phoneNumberE164: eligibility.phoneNumberE164,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Failed to check release eligibility' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/phone-numbers/[id]/release
 * Submit customer-initiated voluntary number release.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: phoneNumberId } = await params;
    if (!phoneNumberId) {
      return NextResponse.json({ error: 'Missing phone_number_id parameter' }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profileData } = await supabase
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    const profile = profileData as any;

    if (!profile || !profile.organization_id) {
      return NextResponse.json({ error: 'Organization context not found' }, { status: 403 });
    }

    // Parse customer request body
    const body = await req.json().catch(() => ({}));
    const { confirm_phone_number, idempotency_key } = body;

    if (!confirm_phone_number) {
      return NextResponse.json(
        { error: 'confirm_phone_number is required for voluntary release' },
        { status: 400 }
      );
    }

    const service = new VoluntaryReleaseService({ dbClient: supabase });
    const dto = await service.requestVoluntaryRelease({
      organizationId: profile.organization_id,
      userId: user.id,
      userRole: profile.role || 'member',
      phoneNumberId,
      confirmPhoneNumber: confirm_phone_number,
      idempotencyKey: idempotency_key,
    });

    return NextResponse.json(dto, { status: 200 });
  } catch (err: any) {
    const errorMessage = err?.message || 'Voluntary release failed';
    const statusCode = errorMessage.includes('ROLE_NOT_AUTHORIZED')
      ? 403
      : errorMessage.includes('TYPED_CONFIRMATION_MISMATCH')
      ? 400
      : errorMessage.includes('RELEASE_ELIGIBILITY_FAILED')
      ? 409
      : 500;

    return NextResponse.json({ error: errorMessage }, { status: statusCode });
  }
}
