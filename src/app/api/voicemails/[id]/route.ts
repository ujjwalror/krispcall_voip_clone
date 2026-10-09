import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { VoicemailService } from '@/lib/telephony/voicemailService';

/**
 * PATCH /api/voicemails/[id]
 * Updates read state of a voicemail.
 *
 * DELETE /api/voicemails/[id]
 * Soft-deletes a voicemail record for the tenant organization.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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

    const isEntitled = await VoicemailService.isEntitled(supabase);
    if (!isEntitled) {
      return NextResponse.json({ error: 'entitlement_denied', message: 'Voicemail feature is not enabled.' }, { status: 403 });
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'invalid_json', message: 'Malformed JSON payload.' }, { status: 400 });
    }

    const isRead = typeof body.isRead === 'boolean' ? body.isRead : Boolean(body.is_read);

    const result = await VoicemailService.markAsRead(
      profile.organization_id,
      id,
      isRead,
      supabase
    );

    if (!result.success) {
      return NextResponse.json({ error: 'update_failed', message: result.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, isRead });
  } catch (err: any) {
    console.error('[PATCH /api/voicemails/[id]] Exception:', err.message || err);
    return NextResponse.json({ error: 'internal_error', message: 'Internal server error.' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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
      .select('organization_id, active, role')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json({ error: 'unauthorized_profile', message: 'Active profile required.' }, { status: 403 });
    }

    const isEntitled = await VoicemailService.isEntitled(supabase);
    if (!isEntitled) {
      return NextResponse.json({ error: 'entitlement_denied', message: 'Voicemail feature is not enabled.' }, { status: 403 });
    }

    const result = await VoicemailService.softDeleteVoicemail(
      profile.organization_id,
      id,
      supabase
    );

    if (!result.success) {
      return NextResponse.json({ error: 'delete_failed', message: result.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, message: 'Voicemail deleted successfully.' });
  } catch (err: any) {
    console.error('[DELETE /api/voicemails/[id]] Exception:', err.message || err);
    return NextResponse.json({ error: 'internal_error', message: 'Internal server error.' }, { status: 500 });
  }
}
