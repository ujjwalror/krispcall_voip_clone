import { NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { ComplianceProfileService } from '@/lib/telephony/compliance/complianceProfileService';

/**
 * GET /api/compliance/profiles/[id]
 * Retrieves single compliance profile details, snapshot requirements, and field values.
 * Restricted strictly to 'owner' and 'admin' workspace roles.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    const { data: profile } = await supabase
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'Forbidden. Active organization profile required.' },
        { status: 403 }
      );
    }

    if (profile.role !== 'owner' && profile.role !== 'admin') {
      return NextResponse.json(
        { error: 'Forbidden. Compliance profiles require owner or admin role access.' },
        { status: 403 }
      );
    }

    const { id: profileId } = await params;
    if (!profileId) {
      return NextResponse.json(
        { error: 'Bad Request. Missing profile ID parameter.' },
        { status: 400 }
      );
    }

    const compProfile = await ComplianceProfileService.getProfileById(
      profile.organization_id,
      profileId,
      profile.role
    );

    if (!compProfile) {
      return NextResponse.json(
        { error: 'Not Found. Compliance profile not found for organization.' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      profile: compProfile,
    });
  } catch (error: any) {
    console.error('[GET /api/compliance/profiles/[id]] Exception:', error.message || error);
    return NextResponse.json(
      { error: error.message || 'Internal server error retrieving compliance profile.' },
      { status: error.message?.includes('UNAUTHORIZED_ROLE') ? 403 : 500 }
    );
  }
}

/**
 * PATCH /api/compliance/profiles/[id]
 * Updates customer dynamic field values for a compliance profile.
 * Performs strict field whitelisting against captured requirement snapshot schema.
 * Client mutation of status, providerStatus, or approval states is strictly prohibited.
 * Restricted strictly to 'owner' and 'admin' workspace roles.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    const { data: profile } = await supabase
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'Forbidden. Active organization profile required.' },
        { status: 403 }
      );
    }

    if (profile.role !== 'owner' && profile.role !== 'admin') {
      return NextResponse.json(
        { error: 'Forbidden. Compliance profiles require owner or admin role access.' },
        { status: 403 }
      );
    }

    const { id: profileId } = await params;
    if (!profileId) {
      return NextResponse.json(
        { error: 'Bad Request. Missing profile ID parameter.' },
        { status: 400 }
      );
    }

    const body = await request.json();

    // Security Check: Prohibit client tampering with internal or provider status fields
    if ('status' in body || 'providerStatus' in body || 'approved' in body || 'verified' in body) {
      return NextResponse.json(
        { error: 'Bad Request. Direct mutation of compliance status or approval fields is prohibited.' },
        { status: 400 }
      );
    }

    const fieldValues = body.fieldValues || [];
    if (!Array.isArray(fieldValues)) {
      return NextResponse.json(
        { error: 'Bad Request. fieldValues must be an array of key-value objects.' },
        { status: 400 }
      );
    }

    const updatedProfile = await ComplianceProfileService.updateFieldValues(
      profile.organization_id,
      profileId,
      profile.role,
      { fieldValues }
    );

    return NextResponse.json({
      success: true,
      profile: updatedProfile,
    });
  } catch (error: any) {
    console.error('[PATCH /api/compliance/profiles/[id]] Exception:', error.message || error);
    return NextResponse.json(
      { error: error.message || 'Internal server error updating compliance profile.' },
      { status: error.message?.includes('UNALLOWED_KEY') || error.message?.includes('UNAUTHORIZED_ROLE') ? 400 : 500 }
    );
  }
}
