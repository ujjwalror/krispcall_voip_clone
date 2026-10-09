import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { VoicemailService } from '@/lib/telephony/voicemailService';

/**
 * GET /api/voicemails/[id]/play
 * Authenticated, tenant-isolated audio streaming / playback route for voicemail.
 * Strictly verifies organization ownership of the requested voicemail.
 * Prevents cross-organization access and unauthorized public enumeration.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createServerSupabaseClient();

    // 1. Authenticate user session
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'unauthorized', message: 'Unauthorized session required.' }, { status: 401 });
    }

    // 2. Fetch authenticated profile
    const { data: profile } = await (supabase as any)
      .from('profiles')
      .select('organization_id, active')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json({ error: 'unauthorized_profile', message: 'Active profile required.' }, { status: 403 });
    }

    // 3. Entitlement check
    const isEntitled = await VoicemailService.isEntitled(supabase);
    if (!isEntitled) {
      return NextResponse.json({ error: 'entitlement_denied', message: 'Voicemail feature is not enabled.' }, { status: 403 });
    }

    // 4. Fetch voicemail with strict tenant isolation check
    const voicemail = await VoicemailService.getVoicemailById(
      profile.organization_id,
      id,
      supabase
    );

    if (!voicemail) {
      return NextResponse.json({ error: 'not_found', message: 'Voicemail not found or access denied.' }, { status: 404 });
    }

    // If caller requests JSON summary format (e.g. for audio player initialization)
    const { searchParams } = new URL(request.url);
    if (searchParams.get('format') === 'json') {
      return NextResponse.json({
        success: true,
        voicemailId: voicemail.id,
        audioUrl: voicemail.recordingUrl,
        durationSeconds: voicemail.durationSeconds,
      });
    }

    // Proxy audio stream securely from provider/storage to avoid exposing provider credentials
    let streamUrl = voicemail.recordingUrl;
    if (streamUrl && !streamUrl.endsWith('.mp3') && !streamUrl.endsWith('.wav')) {
      streamUrl = `${streamUrl}.mp3`;
    }

    try {
      const audioRes = await fetch(streamUrl, {
        headers: {
          'Accept': 'audio/mpeg, audio/wav, audio/*',
        },
      });

      if (!audioRes.ok) {
        // Fallback: return redirect or JSON audio location if direct proxy fails
        return NextResponse.redirect(streamUrl);
      }

      const audioBuffer = await audioRes.arrayBuffer();
      const contentType = audioRes.headers.get('content-type') || 'audio/mpeg';

      return new NextResponse(audioBuffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': audioBuffer.byteLength.toString(),
          'Cache-Control': 'private, max-age=3600',
        },
      });
    } catch (fetchErr) {
      console.warn('[GET /api/voicemails/[id]/play] Direct proxy stream failed, redirecting to recording URL:', fetchErr);
      return NextResponse.redirect(streamUrl);
    }
  } catch (err: any) {
    console.error('[GET /api/voicemails/[id]/play] Exception:', err.message || err);
    return NextResponse.json({ error: 'internal_error', message: 'Internal server error.' }, { status: 500 });
  }
}
