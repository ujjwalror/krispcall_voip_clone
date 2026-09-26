import { NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { TwilioPreflightService } from '@/lib/telephony/compliance/twilioPreflightService';

/**
 * POST /api/compliance/preflight
 * Runs read-only provider submission preflight check for a tenant compliance profile.
 * Restricted strictly to 'owner' and 'admin' workspace roles.
 * Ignores browser-supplied organization_id and derives organization server-side.
 * DOES NOT execute any provider mutations.
 */
export async function POST(req: Request) {
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
        { error: 'Forbidden. Compliance preflight requires owner or admin role access.' },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { complianceProfileId } = body;

    if (!complianceProfileId || typeof complianceProfileId !== 'string') {
      return NextResponse.json(
        { error: 'Bad Request. Valid complianceProfileId is required.' },
        { status: 400 }
      );
    }

    const preflight = await TwilioPreflightService.runPreflight(
      profile.organization_id,
      complianceProfileId,
      profile.role,
      supabase
    );

    return NextResponse.json({
      success: true,
      preflight,
    });
  } catch (error: any) {
    console.error('[POST /api/compliance/preflight] Exception:', error.message || error);
    return NextResponse.json(
      { error: error.message || 'Internal server error executing provider preflight.' },
      { status: error.message?.includes('UNAUTHORIZED_ROLE') || error.message?.includes('FORBIDDEN') ? 403 : 500 }
    );
  }
}
