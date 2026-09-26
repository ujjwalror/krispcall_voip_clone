import { NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { MarketplaceCartService, CartItemCandidate } from '@/lib/telephony/marketplace/cartService';
import { normalizeNumberType } from '@/lib/telephony/marketplace/utils';

/**
 * POST /api/number-marketplace/cart
 * Validates a candidate phone number for temporary cart addition.
 * Resolves authoritative server retail price, checks workspace capacity, and evaluates pre-check requirements.
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
    const rawCandidate: CartItemCandidate = body.candidate || body;

    if (!rawCandidate || !rawCandidate.phoneNumber || !rawCandidate.countryCode) {
      return NextResponse.json(
        { error: 'Bad Request. Missing required candidate number parameters.' },
        { status: 400 }
      );
    }

    const normalizedCandidate: CartItemCandidate = {
      ...rawCandidate,
      countryCode: (rawCandidate.countryCode || 'US').toUpperCase().trim(),
      numberType: (normalizeNumberType(rawCandidate.numberType) as any) || 'local',
      endUserType: rawCandidate.endUserType === 'individual' ? 'individual' : 'business',
    };

    const validation = await MarketplaceCartService.validateCartItem(
      profile.organization_id,
      normalizedCandidate
    );

    return NextResponse.json({
      success: true,
      validation,
    });
  } catch (error: any) {
    console.error('[POST /api/number-marketplace/cart] Exception:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error processing cart candidate validation.' },
      { status: 500 }
    );
  }
}
