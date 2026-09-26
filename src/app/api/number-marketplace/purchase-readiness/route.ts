import { NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import {
  NumberPurchaseReadinessService,
  PurchaseReadinessCandidate,
} from '@/lib/telephony/marketplace/purchaseReadinessService';

/**
 * POST /api/number-marketplace/purchase-readiness
 * Authoritative server-side purchase readiness and compliance gate endpoint.
 * Strictly derives organization identity from authenticated server session.
 * Revalidates exact inventory availability, retail pricing, commercial safety, number entitlement limits, and regulatory requirements.
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

    const body = await request.json();
    const candidate: PurchaseReadinessCandidate = body.candidate || body;

    if (!candidate || !candidate.phoneNumber || !candidate.countryCode || !candidate.numberType) {
      return NextResponse.json(
        { error: 'Bad Request. Missing candidate number parameters (phoneNumber, countryCode, numberType).' },
        { status: 400 }
      );
    }

    const readinessResult = await NumberPurchaseReadinessService.evaluateReadiness(
      profile.organization_id,
      candidate
    );

    return NextResponse.json({
      success: true,
      readiness: readinessResult,
    });
  } catch (error: any) {
    console.error('[POST /api/number-marketplace/purchase-readiness] Exception:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error evaluating purchase readiness.' },
      { status: 500 }
    );
  }
}
