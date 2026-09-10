import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Protected Server-side Recording Audio Proxy.
 * Streams Twilio recording media using server-side credentials.
 * Prevents exposing raw Twilio URLs or requesting user basic auth in browser.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ recordingId: string }> }
) {
  try {
    const { recordingId } = await context.params;

    console.log(`[Recording Playback] Request received recordingId: ${recordingId}`);

    if (!recordingId) {
      return NextResponse.json({ error: 'Recording ID is required' }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();

    // 1. Verify authenticated Supabase user session
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

    // 2. Fetch authenticated user profile to obtain organization_id
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single();

    const profile = profileData as { organization_id?: string } | null;

    if (profileError || !profile || !profile.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden. User organization not found.' },
        { status: 403 }
      );
    }

    // 3. Query database recording record and verify organization ownership
    const adminSupabase = createAdminClient();
    const { data: recordingData, error: recError } = await (adminSupabase as any)
      .from('recordings')
      .select('id, organization_id, recording_url, twilio_recording_sid')
      .eq('id', recordingId)
      .single();

    const recording = recordingData as {
      id: string;
      organization_id: string;
      recording_url: string;
      twilio_recording_sid?: string | null;
    } | null;

    if (recError || !recording) {
      return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    }

    if (recording.organization_id !== profile.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden. Recording does not belong to your organization.' },
        { status: 403 }
      );
    }

    // 4. Extract Twilio Account credentials server-side
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      console.error('[Recording Playback] Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN credentials.');
      return NextResponse.json({ error: 'Twilio server credentials unconfigured' }, { status: 500 });
    }

    // Construct server-side Twilio API URL for MP3 audio stream
    let twilioMediaUrl = recording.recording_url;
    if (recording.twilio_recording_sid) {
      twilioMediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recording.twilio_recording_sid}.mp3`;
    } else if (twilioMediaUrl && !twilioMediaUrl.endsWith('.mp3') && !twilioMediaUrl.endsWith('.wav')) {
      twilioMediaUrl = `${twilioMediaUrl}.mp3`;
    }

    // 5. Fetch media from Twilio using HTTP Basic Auth (Server-to-Server)
    const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const twilioRes = await fetch(twilioMediaUrl, {
      headers: {
        Authorization: authHeader,
      },
    });

    if (!twilioRes.ok) {
      console.error(`[Recording Playback] Failed to fetch recording from Twilio. HTTP Status: ${twilioRes.status}`);
      return NextResponse.json(
        { error: 'Failed to stream recording media from Twilio' },
        { status: twilioRes.status }
      );
    }

    console.log(`[Recording Playback] Streaming audio successfully`);

    // Stream audio/mpeg response back to browser
    const headers = new Headers();
    headers.set('Content-Type', twilioRes.headers.get('content-type') || 'audio/mpeg');
    if (twilioRes.headers.get('content-length')) {
      headers.set('Content-Length', twilioRes.headers.get('content-length')!);
    }
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'private, max-age=3600');

    return new NextResponse(twilioRes.body as any, {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error('[Recording Playback] Exception processing recording stream:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error while playing recording' },
      { status: 500 }
    );
  }
}
