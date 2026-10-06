import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PreRenewalPolicyService } from '@/lib/telephony/renewal/preRenewalPolicyService';
import { PolicySimulationEngine, SimulationInput } from '@/lib/telephony/renewal/policySimulationEngine';

export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    const userRole = (profile as any)?.role || 'agent';

    if (!PreRenewalPolicyService.isPlatformAdmin(userRole, user.id)) {
      return NextResponse.json(
        { error: 'Forbidden: Global policy simulation and preview require PLATFORM_ADMIN authorization.' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const {
      phoneNumberE164 = '+18005550199',
      cycleAnchorAt = new Date().toISOString(),
      customerFundedThroughAt = new Date(Date.now() + 86400 * 1000).toISOString(),
      providerNextExposureAt = null,
      customPolicy = null,
      autopayEnabled = true,
      paymentOutcomes = [],
      hasActivePortOut = false,
      reconciliationBlocked = false,
      providerCycleStatus = 'verified',
      asOfDate = null,
    } = body || {};

    const activePolicy = customPolicy
      ? { ...(await PreRenewalPolicyService.getActivePolicy()), ...customPolicy }
      : await PreRenewalPolicyService.getActivePolicy();

    // Validate custom policy if provided
    if (customPolicy) {
      const val = PreRenewalPolicyService.validatePolicy(customPolicy);
      if (!val.valid) {
        return NextResponse.json(
          { error: `INVALID_POLICY_CONFIGURATION: ${val.errors.join(' ')}` },
          { status: 400 }
        );
      }
    }

    const simInput: SimulationInput = {
      phoneNumberE164,
      cycleAnchorAt,
      customerFundedThroughAt,
      providerNextExposureAt,
      policy: activePolicy,
      autopayEnabled,
      paymentOutcomes,
      hasActivePortOut,
      reconciliationBlocked,
      providerCycleStatus,
      asOfDate: asOfDate || undefined,
    };

    const simulation = PolicySimulationEngine.simulateTimeline(simInput);

    return NextResponse.json({
      success: true,
      simulation,
    });
  } catch (err: any) {
    console.error('[API /admin/renewal-policy/simulate] POST Exception:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
