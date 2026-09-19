import { NextResponse } from 'next/server';
import {
  authenticateExtensionRequest,
  getExtensionCorsHeaders,
  handleExtensionCorsOptions,
} from '@/lib/telephony/extensionAuth';
import { createAdminClient } from '@/lib/supabase/admin';

export async function OPTIONS(request: Request) {
  return handleExtensionCorsOptions(request);
}

export async function POST(request: Request) {
  const corsHeaders = getExtensionCorsHeaders(request);

  try {
    const { auth, errorResponse } = await authenticateExtensionRequest(request);
    if (errorResponse) return errorResponse;
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401, headers: corsHeaders });
    }

    const body = await request.json().catch(() => ({}));
    const callId = body.callId || body.id || '';

    if (!callId || typeof callId !== 'string' || callId.trim() === '') {
      return NextResponse.json({ error: 'Bad Request. Valid callId is required.' }, { status: 400, headers: corsHeaders });
    }

    console.log('[VoIP Hub][CALL] setup abort requested for callId:', callId);

    const adminSupabase = createAdminClient();

    // Find call record matching authenticated user and organization
    const { data: callRec, error: fetchErr } = await (adminSupabase as any)
      .from('calls')
      .select('id, status, user_id, organization_id, direction')
      .eq('id', callId)
      .eq('organization_id', auth.organizationId)
      .eq('user_id', auth.userId)
      .eq('direction', 'outbound')
      .maybeSingle();

    if (fetchErr || !callRec) {
      return NextResponse.json({ error: 'Call record not found.' }, { status: 404, headers: corsHeaders });
    }

    const currentStatus = callRec.status || '';

    // Terminal statuses: idempotent return
    const terminalStatuses = ['failed', 'canceled', 'completed', 'no-answer', 'busy', 'missed'];
    if (terminalStatuses.includes(currentStatus)) {
      return NextResponse.json({
        success: true,
        callId,
        status: currentStatus,
        message: 'Call is already in terminal state.',
      }, { headers: corsHeaders });
    }

    // Protected active statuses: cannot abort genuine active calls
    const protectedActiveStatuses = ['ringing', 'in-progress', 'answered'];
    if (protectedActiveStatuses.includes(currentStatus)) {
      return NextResponse.json({
        error: 'Conflict. Cannot abort an active or connected call.',
      }, { status: 409, headers: corsHeaders });
    }

    // Abort setup state ('initiated')
    const nowIso = new Date().toISOString();
    const { error: updateErr } = await (adminSupabase as any)
      .from('calls')
      .update({
        status: 'failed',
        ended_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', callId);

    if (updateErr) {
      console.error('[VoIP Hub][CALL] Error terminalizing aborted call:', updateErr);
      return NextResponse.json({ error: 'Failed to terminalize call record.' }, { status: 500, headers: corsHeaders });
    }

    // Release matching agent reservation
    await (adminSupabase as any)
      .from('agent_call_reservations')
      .delete()
      .eq('call_id', callId);

    console.log('[VoIP Hub][CALL] setup abort completed for callId:', callId);

    return NextResponse.json({
      success: true,
      callId,
      status: 'failed',
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error('Error in POST /api/extension/calls/abort:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error aborting call setup.' },
      { status: 500, headers: corsHeaders }
    );
  }
}
