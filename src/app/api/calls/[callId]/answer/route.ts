import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/**
 * Authenticated Browser Agent Answer Endpoint.
 * Invoked by the WebRTC client when an incoming call is explicitly accepted by an agent.
 * Verifies Supabase authentication, organization membership, and inbound call direction.
 * Idempotently sets public.calls.answered_at = NOW and status = 'in-progress'.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ callId: string }> }
) {
  try {
    const { callId } = await params;
    if (!callId) {
      return NextResponse.json({ error: 'Missing callId parameter' }, { status: 400 });
    }

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

    // 2. Fetch user profile & organization_id
    const { data: profileData, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id, active')
      .eq('id', user.id)
      .single();

    const profile = profileData as { id: string; organization_id?: string; active?: boolean } | null;

    if (profileError || !profile || !profile.organization_id || !profile.active) {
      return NextResponse.json(
        { error: 'Forbidden. User profile or organization unconfigured.' },
        { status: 403 }
      );
    }

    // 3. Fetch call record
    const { data: callData, error: callError } = await (supabase as any)
      .from('calls')
      .select('id, organization_id, direction, status, answered_at')
      .eq('id', callId)
      .single();

    const call = callData as { id: string; organization_id: string; direction: string; status: string; answered_at: string | null } | null;

    if (callError || !call) {
      return NextResponse.json({ error: 'Call record not found.' }, { status: 404 });
    }

    // 4. Validate authorization & inbound call direction
    if (call.organization_id !== profile.organization_id) {
      return NextResponse.json({ error: 'Forbidden. Call belongs to another organization.' }, { status: 403 });
    }

    if (call.direction !== 'inbound') {
      return NextResponse.json({ error: 'Invalid call direction for answer endpoint.' }, { status: 400 });
    }

    // 5. Idempotent check: if already answered, return success without mutating
    if (call.answered_at) {
      return NextResponse.json({
        success: true,
        alreadyAnswered: true,
        callId: call.id,
        answered_at: call.answered_at,
      });
    }

    const nowIso = new Date().toISOString();

    // 6. Update call record: mark status = 'in-progress', populate answered_at and user_id
    const { data: updatedCall, error: updateError } = await (supabase as any)
      .from('calls')
      .update({
        status: 'in-progress',
        answered_at: nowIso,
        user_id: user.id,
        updated_at: nowIso,
      })
      .eq('id', callId)
      .select()
      .single();

    if (updateError) {
      console.error('[API Answer Error] Error updating call answer status:', updateError);
      return NextResponse.json({ error: 'Failed to update call answer status.' }, { status: 500 });
    }

    console.log('[API Answer Success]', {
      dbCallId: callId,
      agentId: user.id,
      answered_at: nowIso,
      status: 'in-progress',
    });

    return NextResponse.json({
      success: true,
      callId: callId,
      answered_at: nowIso,
      call: updatedCall,
    });
  } catch (error: any) {
    console.error('[API Answer Error] Unhandled exception:', error.message || error);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
