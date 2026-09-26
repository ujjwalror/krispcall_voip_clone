import { NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { TwilioInventoryProvider } from '@/lib/telephony/marketplace/inventoryProvider';

/**
 * GET /api/number-marketplace/countries
 * Returns list of available countries and supported number categories.
 * Access: Authenticated workspace members.
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
      .select('organization_id, active')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'Forbidden. Active organization profile required.' },
        { status: 403 }
      );
    }

    const provider = new TwilioInventoryProvider();
    const countries = await provider.getAvailableCountries();

    return NextResponse.json({
      success: true,
      countries,
    });
  } catch (error: any) {
    console.error('[GET /api/number-marketplace/countries] Exception:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error retrieving marketplace countries.' },
      { status: 500 }
    );
  }
}
