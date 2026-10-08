import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { createAdminClient } from '@/lib/supabase/admin';
import { UnifiedRecurringBillingService } from '@/lib/billing/unifiedRecurringBillingService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try {
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'FORBIDDEN', message: 'Active organization profile required.' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const adminSupabase = createAdminClient();
    const invoiceCalculation = await UnifiedRecurringBillingService.calculateConsolidatedRecurringInvoice(
      adminSupabase,
      profile.organization_id
    );

    return NextResponse.json(
      {
        success: true,
        calculation: invoiceCalculation,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: any) {
    console.error('[GET /api/billing/recurring-service-invoice] Error:', err.message || err);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Unable to calculate recurring service invoice.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
