import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { createAdminClient } from '@/lib/supabase/admin';
import { TelecomWalletService } from '@/lib/billing/telecomWalletService';
import { formatMinorUnitsToCurrency } from '@/lib/billing/currencyFormatter';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try {
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    // Server-authoritative organization & role resolution
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'FORBIDDEN: Active organization profile required.', code: 'forbidden' },
        { status: 403 }
      );
    }

    // SERVER-AUTHORITATIVE TENANT ISOLATION:
    // Ignore any browser-supplied organization_id parameter! Use profile.organization_id exclusively.
    const organizationId = profile.organization_id;
    const adminSupabase = createAdminClient();

    const summary = await TelecomWalletService.getWalletSummary(adminSupabase, organizationId);

    const availableCreditsMinor = summary.availableBalanceMinor || 0;
    const currency = summary.currency || 'USD';
    const formattedBalance = formatMinorUnitsToCurrency(availableCreditsMinor, currency);

    // CUSTOMER-SAFE RESPONSE CONTRACT:
    // Strictly omit internal reservation hold totals, wholesale costs, provider SIDs, and ledger details!
    return NextResponse.json(
      {
        success: true,
        availableCreditsMinor,
        formattedBalance,
        currency,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      }
    );
  } catch (error: any) {
    console.error('[GET /api/billing/credit/summary] Error fetching wallet summary:', error.message || error);
    return NextResponse.json(
      {
        error: 'WALLET_SUMMARY_UNAVAILABLE',
        message: 'Credits balance temporarily unavailable.',
      },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      }
    );
  }
}
