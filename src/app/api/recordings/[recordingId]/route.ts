import { NextResponse } from 'next/server';
import { ProviderAccountResolver } from '@/lib/telecom/provider/providerAccountResolver';
import { TwilioRecordingAdapter } from '@/lib/telecom/provider/adapters/recordingAdapter';
import { ProviderResourceManager } from '@/lib/telecom/provider/providerResourceManager';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * DELETE /api/recordings/[recordingId]
 * Permanently deletes a call recording from both the telephony provider (Twilio)
 * and public.recordings database table.
 * 
 * Strict Admin-Only Authorization & Organization Scoping Enforced.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ recordingId: string }> }
) {
  try {
    const { recordingId } = await params;
    const supabase = await createServerSupabaseClient();

    // 1. Authenticate user session
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    // 2. Fetch authenticated user profile
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', user.id)
      .single();

    const profile = profileData as { organization_id?: string; role?: string; active?: boolean } | null;

    if (profileError || !profile || !profile.active || !profile.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden. User account is inactive or unconfigured.' },
        { status: 403 }
      );
    }

    // 3. Strict Admin/Owner-Only Role Authorization Check
    if (!['owner', 'admin'].includes(profile.role || '')) {
      return NextResponse.json(
        { error: 'Forbidden. Owner or Admin privileges required to delete call recordings.' },
        { status: 403 }
      );
    }

    // 3b. Enforce recordings entitlement
    const { requireEntitlement } = await import('@/lib/entitlements/server');
    const entitlementRes = await requireEntitlement('recordings');
    if (!entitlementRes.success) {
      return entitlementRes.errorResponse;
    }

    // 4. Fetch target recording record strictly scoped to authenticated organization
    const adminSupabase = createAdminClient();
    const { data: recordingRecord, error: fetchError } = await (adminSupabase as any)
      .from('recordings')
      .select('id, organization_id, twilio_recording_sid, call_id')
      .eq('id', recordingId)
      .eq('organization_id', profile.organization_id)
      .maybeSingle();

    if (fetchError || !recordingRecord) {
      return NextResponse.json(
        { error: 'Recording not found or already deleted.' },
        { status: 404 }
      );
    }

    // 6. Delete actual recording from Telephony Provider via Provider Abstraction
    const twilioSid = recordingRecord.twilio_recording_sid;
    if (twilioSid) {
      // Resolve provider context for this organization and RECORDING service
      const providerResolution = await ProviderAccountResolver.resolveAccount({
        organizationId: profile.organization_id,
        service: 'RECORDING',
      }, adminSupabase);

      if (!providerResolution.success || !providerResolution.context) {
        return NextResponse.json(
          { error: providerResolution.errorMessage || 'Unable to resolve provider account context for recording deletion.' },
          { status: 500 }
        );
      }

      if (providerResolution.context.isSharedParent || providerResolution.context.accountType === 'SHARED_PARENT') {
        return NextResponse.json(
          { error: 'Forbidden. Customer organizations cannot delete parent Twilio recording resources.' },
          { status: 403 }
        );
      }

      // Verify remote resource tenant ownership
      const isOwner = await ProviderResourceManager.assertResourceOwnership(
        profile.organization_id,
        'RECORDING',
        twilioSid,
        adminSupabase
      );
      if (!isOwner) {
        return NextResponse.json(
          { error: 'Forbidden. Cross-tenant or unmapped provider resource identifier.' },
          { status: 403 }
        );
      }

      try {
        const recordingAdapter = new TwilioRecordingAdapter();
        const delRes = await recordingAdapter.deleteRecording(twilioSid, providerResolution.context);
        console.log(`[RECORDING DELETED ON PROVIDER] Status: ${delRes.status}, SID: ${twilioSid}`);
      } catch (twilioErr: any) {
        console.error('[RECORDING DELETE PROVIDER ERROR]', twilioErr);
        return NextResponse.json(
          {
            error: `Provider error deleting recording: ${twilioErr.message || 'Provider deletion failed'}`,
            details: twilioErr,
          },
          { status: 500 }
        );
      }
    }

    // 7. Delete public.recordings database row using adminSupabase (preserves public.calls row intact)
    const { data: deletedRows, error: deleteError } = await (adminSupabase as any)
      .from('recordings')
      .delete()
      .eq('id', recordingId)
      .eq('organization_id', profile.organization_id)
      .select();

    if (deleteError) {
      console.error('Error deleting recording row from database:', deleteError);
      return NextResponse.json(
        { error: `Database error removing recording metadata: ${deleteError.message || deleteError.code}` },
        { status: 500 }
      );
    }

    if (!deletedRows || deletedRows.length === 0) {
      console.error(`Database deletion matched 0 rows for recording ID ${recordingId}`);
      return NextResponse.json(
        { error: 'Database record deletion failed. Record was not found or could not be removed.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Recording permanently deleted successfully.',
      recordingId,
    });
  } catch (error: any) {
    console.error('Error in DELETE /api/recordings/[recordingId]:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error deleting recording.' },
      { status: 500 }
    );
  }
}
