import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { createServerSupabaseClient } from '@/lib/supabase/server';

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

    // 3. Strict Admin-Only Role Authorization Check
    if (profile.role !== 'admin') {
      return NextResponse.json(
        { error: 'Forbidden. Admin privileges required to delete call recordings.' },
        { status: 403 }
      );
    }

    // 4. Fetch target recording record
    const { data: recordingRecord, error: fetchError } = await (supabase as any)
      .from('recordings')
      .select('id, organization_id, twilio_recording_sid, call_id')
      .eq('id', recordingId)
      .single();

    if (fetchError || !recordingRecord) {
      return NextResponse.json(
        { error: 'Recording not found.' },
        { status: 404 }
      );
    }

    // 5. Cross-Organization Security Check
    if (recordingRecord.organization_id !== profile.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden. Access denied to cross-organization recording.' },
        { status: 403 }
      );
    }

    // 6. Delete actual recording from Telephony Provider (Twilio REST API)
    const twilioSid = recordingRecord.twilio_recording_sid;
    if (twilioSid) {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const apiKey = process.env.TWILIO_API_KEY_SID;
      const apiSecret = process.env.TWILIO_API_KEY_SECRET;

      if (accountSid && apiKey && apiSecret) {
        try {
          const twilioClient = twilio(apiKey, apiSecret, { accountSid });
          await twilioClient.recordings(twilioSid).remove();
          console.log(`[RECORDING DELETED ON PROVIDER] Twilio Recording SID: ${twilioSid}`);
        } catch (twilioErr: any) {
          // If 20404 / 404 (already deleted on provider), continue safely to clean DB metadata
          if (twilioErr?.code === 20404 || twilioErr?.status === 404) {
            console.warn(`[RECORDING DELETE WARNING] Provider SID ${twilioSid} already missing on provider.`);
          } else {
            console.error('[RECORDING DELETE PROVIDER ERROR]', twilioErr);
            return NextResponse.json(
              {
                error: `Provider error deleting recording: ${twilioErr.message || 'Twilio REST API deletion failed'}`,
                details: twilioErr,
              },
              { status: 500 }
            );
          }
        }
      }
    }

    // 7. Delete public.recordings database row (preserves public.calls row intact)
    const { error: deleteError } = await (supabase as any)
      .from('recordings')
      .delete()
      .eq('id', recordingId)
      .eq('organization_id', profile.organization_id);

    if (deleteError) {
      console.error('Error deleting recording row from database:', deleteError);
      return NextResponse.json(
        { error: `Database error removing recording metadata: ${deleteError.message || deleteError.code}` },
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
