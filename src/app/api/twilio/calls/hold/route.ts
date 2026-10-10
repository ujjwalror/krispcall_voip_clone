import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { CallControlService } from '@/lib/telephony/callControlService';

/**
 * POST /api/twilio/calls/hold - Hold or resume an active call
 * Accepts { callSid: string, dbCallId?: string, hold: boolean }
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

    const { callSid, dbCallId, hold } = body;

    const result = await CallControlService.setCallHold(
      {
        organizationId: profile.organization_id,
        userId: user.id,
        callSid: callSid || '',
        dbCallId: dbCallId || undefined,
        hold: Boolean(hold),
      },
      supabase
    );

    if (!result.success) {
      return NextResponse.json({ error: 'hold_operation_failed', message: result.message }, { status: 400 });
    }

    return NextResponse.json({ result });
  } catch (err: any) {
    console.error('[POST /api/twilio/calls/hold] Exception:', err.message || err);
    return NextResponse.json({ error: 'internal_error', message: 'Internal server error during hold operation.' }, { status: 500 });
  }
}
