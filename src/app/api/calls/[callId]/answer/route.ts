import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

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

    const adminSupabase = createAdminClient();

    // 3. Attempt atomic call claim via database RPC function (requires service_role execution rights)
    const { data: rpcRes, error: rpcErr } = await (adminSupabase as any).rpc(
      'claim_inbound_call_answer',
      {
        p_call_id: callId,
        p_user_id: user.id,
        p_organization_id: profile.organization_id,
      }
    );

    if (!rpcErr && rpcRes && rpcRes.length > 0) {
      const claimResult = rpcRes[0];
      if (!claimResult.success) {
        return NextResponse.json(
          {
            error: claimResult.error_message || 'Call already answered by another agent.',
            callId,
            alreadyAnswered: claimResult.already_answered,
          },
          { status: 409 }
        );
      }

      console.log('[API Answer Success via RPC]', {
        dbCallId: callId,
        agentId: user.id,
        answered_at: claimResult.answered_at,
        status: 'in-progress',
      });

      return NextResponse.json({
        success: true,
        callId: callId,
        answered_at: claimResult.answered_at,
        alreadyAnswered: claimResult.already_answered,
      });
    }

    // Fallback: If RPC function is not yet available, execute application-level atomic answer & reservation cleanup
    const { data: userActiveCall } = await (supabase as any)
      .from('calls')
      .select('id')
      .eq('organization_id', profile.organization_id)
      .in('status', ['initiated', 'ringing', 'in-progress', 'queued'])
      .eq('user_id', user.id)
      .neq('id', callId)
      .maybeSingle();

    if (userActiveCall) {
      return NextResponse.json(
        { error: 'You are already handling another active call.', callId },
        { status: 409 }
      );
    }

    // Fetch call record
    const { data: callData, error: callError } = await (supabase as any)
      .from('calls')
      .select('id, organization_id, direction, status, user_id, answered_at')
      .eq('id', callId)
      .single();

    const call = callData as {
      id: string;
      organization_id: string;
      direction: string;
      status: string;
      user_id: string | null;
      answered_at: string | null;
    } | null;

    if (callError || !call) {
      return NextResponse.json({ error: 'Call record not found.' }, { status: 404 });
    }

    if (call.organization_id !== profile.organization_id) {
      return NextResponse.json({ error: 'Forbidden. Call belongs to another organization.' }, { status: 403 });
    }

    if (call.direction !== 'inbound') {
      return NextResponse.json({ error: 'Invalid call direction for answer endpoint.' }, { status: 400 });
    }

    if (call.user_id && call.user_id !== user.id) {
      return NextResponse.json(
        { error: 'Call already answered by another agent.', callId, alreadyAnswered: true },
        { status: 409 }
      );
    }

    if (call.answered_at && call.user_id === user.id) {
      return NextResponse.json({
        success: true,
        alreadyAnswered: true,
        callId: call.id,
        answered_at: call.answered_at,
      });
    }

    const nowIso = new Date().toISOString();

    // Atomic update: claim ownership ONLY if user_id is null OR matches user.id
    const { data: updatedCall, error: updateError } = await (supabase as any)
      .from('calls')
      .update({
        status: 'in-progress',
        answered_at: nowIso,
        user_id: user.id,
        updated_at: nowIso,
      })
      .eq('id', callId)
      .or(`user_id.is.null,user_id.eq.${user.id}`)
      .select()
      .maybeSingle();

    if (updateError || !updatedCall) {
      console.warn('[API Answer Conflict] Call ownership claim failed or already answered:', { callId, userId: user.id, updateError });
      return NextResponse.json(
        { error: 'Call already answered by another agent.', callId, alreadyAnswered: true },
        { status: 409 }
      );
    }

    // Release reservations for this call and winning user
    await (supabase as any)
      .from('agent_call_reservations')
      .delete()
      .or(`call_id.eq.${callId},user_id.eq.${user.id}`);

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
