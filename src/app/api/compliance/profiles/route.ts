import { NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { ComplianceProfileService } from '@/lib/telephony/compliance/complianceProfileService';

/**
 * GET /api/compliance/profiles
 * Lists tenant compliance profiles for the authenticated organization.
 * Restricted strictly to 'owner' and 'admin' workspace roles.
 */
export async function GET() {
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

    const profiles = await ComplianceProfileService.getOrganizationProfiles(
      profile.organization_id,
      profile.role
    );

    return NextResponse.json({
      success: true,
      profiles,
    });
  } catch (error: any) {
    console.error('[GET /api/compliance/profiles] Exception:', error.message || error);
    return NextResponse.json(
      { error: error.message || 'Internal server error listing compliance profiles.' },
      { status: error.message?.includes('UNAUTHORIZED_ROLE') ? 403 : 500 }
    );
  }
}

/**
 * POST /api/compliance/profiles
 * Creates a new draft compliance profile for a target country, end-user type, and number type.
 * Server revalidates parameters and queries RegulatoryPreCheckService for requirement snapshot.
 * Restricted strictly to 'owner' and 'admin' workspace roles.
 */
export async function POST(request: Request) {
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

    const body = await request.json();
    const { countryCode, numberType, endUserType, legalName, givenName, familyName } = body;

    if (!countryCode || !numberType || !legalName) {
      return NextResponse.json(
        { error: 'Bad Request. Missing required fields (countryCode, numberType, legalName).' },
        { status: 400 }
      );
    }

    const newProfile = await ComplianceProfileService.createDraftProfile(
      profile.organization_id,
      user.id,
      profile.role,
      {
        countryCode,
        numberType,
        endUserType: endUserType === 'individual' ? 'individual' : 'business',
        legalName,
        givenName,
        familyName,
      }
    );

    return NextResponse.json({
      success: true,
      profile: newProfile,
    });
  } catch (error: any) {
    console.error('[POST /api/compliance/profiles] Exception:', error.message || error);
    return NextResponse.json(
      { error: error.message || 'Internal server error creating compliance profile.' },
      { status: error.message?.includes('UNAUTHORIZED_ROLE') ? 403 : 400 }
    );
  }
}
