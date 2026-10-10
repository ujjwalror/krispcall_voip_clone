import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { CallControlService } from '@/lib/telephony/callControlService';

/**
 * POST /api/twilio/calls/transfer - Transfer active call to internal team member or external PSTN number
 * Accepts {
 *   callSid?: string,
 *   dbCallId?: string,
 *   targetType: 'internal' | 'external',
 *   targetUserId?: string,
 *   externalNumber?: string,
 *   transferType?: 'blind' | 'warm'
 * }
 */
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'unauthorized', message: 'Unauthorized session required.' }, { status: 401 });
    }

    const { data: profile } = await (supabase as any)
      .from('profiles')
      .select('organization_id, active')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json({ error: 'unauthorized_profile', message: 'Active profile required.' }, { status: 403 });
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'invalid_json', message: 'Malformed JSON payload.' }, { status: 400 });
    }

    const { callSid, dbCallId, transferOperationId, targetType, targetUserId, externalNumber, transferType } = body;

    if (targetType === 'internal') {
      if (!targetUserId) {
        return NextResponse.json({ error: 'missing_target_user', message: 'Team member target ID is required.' }, { status: 400 });
      }

      const result = await CallControlService.transferToInternalMember(
        {
          organizationId: profile.organization_id,
          userId: user.id,
          callSid: callSid || '',
          dbCallId: dbCallId || undefined,
          targetUserId,
          transferType: transferType || 'blind',
        },
        supabase
      );

      if (!result.success) {
        return NextResponse.json({ error: 'transfer_failed', message: result.message }, { status: 400 });
      }

      return NextResponse.json({ result });
    } else if (targetType === 'external') {
      if (!externalNumber) {
        return NextResponse.json({ error: 'missing_external_number', message: 'External destination phone number is required.' }, { status: 400 });
      }

      const result = await CallControlService.transferToExternalNumber(
        {
          organizationId: profile.organization_id,
          userId: user.id,
          callSid: callSid || '',
          dbCallId: dbCallId || undefined,
          transferOperationId: transferOperationId || undefined,
          externalNumber,
          transferType: transferType || 'blind',
        },
        supabase
      );

      if (!result.success) {
        return NextResponse.json({ error: 'transfer_failed', message: result.message }, { status: 400 });
      }

      return NextResponse.json({ result });
    } else {
      return NextResponse.json({ error: 'invalid_target_type', message: "targetType must be 'internal' or 'external'." }, { status: 400 });
    }
  } catch (err: any) {
    console.error('[POST /api/twilio/calls/transfer] Exception:', err.message || err);
    return NextResponse.json({ error: 'internal_error', message: 'Internal server error during call transfer.' }, { status: 500 });
  }
}
