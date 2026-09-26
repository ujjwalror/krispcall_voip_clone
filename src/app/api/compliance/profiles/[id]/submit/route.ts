import 'server-only';
import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { ComplianceProfileService } from '@/lib/telephony/compliance/complianceProfileService';
import { TwilioPreflightService } from '@/lib/telephony/compliance/twilioPreflightService';
import { ProviderSubmissionOrchestrator } from '@/lib/telephony/compliance/providerSubmissionOrchestrator';
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

    // 2. Fetch User Profile & Server-Derived Organization Context
    const { data: userProfile, error: profileErr } = await supabase
      .from('profiles')
      .select('id, organization_id, role')
      .eq('id', user.id)
      .single();

    if (profileErr || !userProfile) {
      return NextResponse.json({ success: false, error: 'User profile or workspace not found.' }, { status: 403 });
    }

    const organizationId = userProfile.organization_id;
    const userRole = userProfile.role;

    // 3. Authorization: Owner or Admin role strictly required
    if (userRole !== 'owner' && userRole !== 'admin') {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED_ROLE: Provider compliance submission requires Owner or Admin workspace role access.' },
        { status: 403 }
      );
    }

    // 4. Fetch Compliance Profile & Verify Tenant Context
    const complianceProfile = await ComplianceProfileService.getProfileById(organizationId, complianceProfileId, userRole);
    if (!complianceProfile) {
      return NextResponse.json({ success: false, error: 'Compliance profile not found.' }, { status: 404 });
    }

    if (complianceProfile.organizationId !== organizationId) {
      return NextResponse.json({ success: false, error: 'FORBIDDEN: Cross-tenant profile access denied.' }, { status: 403 });
    }

    // 5. Preflight Evaluation Check
    const preflight = await TwilioPreflightService.runPreflight(organizationId, complianceProfileId, userRole);
    if (!preflight.ready) {
      return NextResponse.json(
        {
          success: false,
          error: 'PREFLIGHT_FAILED',
          message: 'Compliance profile preflight validation failed.',
          errors: preflight.errors,
          warnings: preflight.warnings,
        },
        { status: 422 }
      );
    }

    // 6. Check Provider Mutations Safety Gate
    const mutationsEnabled = process.env.TWILIO_COMPLIANCE_MUTATIONS_ENABLED === 'true';

    if (!mutationsEnabled) {
      // In Phase 11.3 (mutations disabled in production environment), return controlled safe response
      return NextResponse.json(
        {
          success: true,
          simulated: true,
          status: 'ready_for_submission',
          message: 'Compliance profile preflight passed. Live provider mutations are currently disabled in this environment.',
          preflight,
        },
        { status: 200 }
      );
    }

    // 7. Execute Live Orchestrated Provider Submission
    const adapter = new TwilioProviderComplianceAdapter();
    const result = await ProviderSubmissionOrchestrator.executeSubmissionPipeline(
      organizationId,
      complianceProfileId,
      userRole,
      adapter,
      user.id
    );

    // Update profile status in database to submitted
    const adminSupabase = createAdminClient() as any;
    await adminSupabase
      .from('organization_compliance_profiles')
      .update({ status: 'ready_for_submission' }) // Retain DB constraint safety
      .eq('id', complianceProfileId);

    return NextResponse.json(
      {
        success: true,
        simulated: false,
        bundleSid: result.bundleSid,
        status: result.bundleStatus,
        result,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error('[ComplianceSubmitAPI] Error during submission:', err);
    return NextResponse.json(
      {
        success: false,
        error: err.name || 'SUBMISSION_ERROR',
        message: err.message || 'An error occurred during compliance submission processing.',
      },
      { status: 500 }
    );
  }
}
