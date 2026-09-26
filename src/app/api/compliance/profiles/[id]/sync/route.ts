import 'server-only';
import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { ComplianceProfileService } from '@/lib/telephony/compliance/complianceProfileService';
import { ProviderResourceMappingService } from '@/lib/telephony/compliance/providerResourceMappingService';
import { TwilioProviderComplianceAdapter } from '@/lib/telephony/compliance/twilioComplianceAdapter';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: complianceProfileId } = await context.params;
    if (!complianceProfileId) {
      return NextResponse.json({ success: false, error: 'Compliance profile ID is required.' }, { status: 400 });
    }

    // 1. Authentication
    const supabase = (await createServerSupabaseClient()) as any;
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ success: false, error: 'Authentication required.' }, { status: 401 });
    }

    // 2. User Profile & Role check
    const { data: userProfile, error: profileErr } = await supabase
      .from('profiles')
      .select('id, organization_id, role')
      .eq('id', user.id)
      .single();

    if (profileErr || !userProfile) {
      return NextResponse.json({ success: false, error: 'User profile not found.' }, { status: 403 });
    }

    const organizationId = userProfile.organization_id;
    const userRole = userProfile.role;

    if (userRole !== 'owner' && userRole !== 'admin') {
      return NextResponse.json({ success: false, error: 'UNAUTHORIZED_ROLE: Requires Owner or Admin role access.' }, { status: 403 });
    }

    // 3. Fetch profile & mappings
    const profile = await ComplianceProfileService.getProfileById(organizationId, complianceProfileId, userRole);
    if (!profile) {
      return NextResponse.json({ success: false, error: 'Compliance profile not found.' }, { status: 404 });
    }

    const adminSupabase = createAdminClient() as any;
    const mappings = await ProviderResourceMappingService.getMappingsForProfile(
      organizationId,
      complianceProfileId,
      adminSupabase
    );

    const bundleMapping = mappings.find((m) => m.resourceType === 'bundle');
    if (!bundleMapping) {
      return NextResponse.json({
        success: true,
        synced: false,
        status: profile.status,
        message: 'No provider bundle mapping exists for this profile.',
      });
    }

    // 4. Perform Read-Only Provider Status Fetch
    const adapter = new TwilioProviderComplianceAdapter();
    const providerStatusRes = await adapter.getResourceStatus('bundle', bundleMapping.providerResourceId);

    // 5. Update Mapping Status
    await ProviderResourceMappingService.recordMapping(
      organizationId,
      complianceProfileId,
      'bundle',
      bundleMapping.providerResourceId,
      {
        countryCode: bundleMapping.countryCode,
        numberType: bundleMapping.numberType,
        endUserType: bundleMapping.endUserType,
        providerRegulationId: bundleMapping.providerRegulationId,
      },
      bundleMapping.sourceEntityId,
      providerStatusRes.status,
      providerStatusRes.details || {},
      adminSupabase
    );

    return NextResponse.json({
      success: true,
      synced: true,
      bundleSid: bundleMapping.providerResourceId,
      providerStatus: providerStatusRes.status,
      details: providerStatusRes.details,
    });
  } catch (err: any) {
    console.error('[ComplianceSyncAPI] Error syncing status:', err);
    return NextResponse.json(
      { success: false, error: err.name || 'SYNC_ERROR', message: err.message || 'Status sync failed.' },
      { status: 500 }
    );
  }
}
