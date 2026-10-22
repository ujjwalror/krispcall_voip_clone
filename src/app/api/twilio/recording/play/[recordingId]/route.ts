import { NextResponse } from 'next/server';
import { ProviderAccountResolver } from '@/lib/telecom/provider/providerAccountResolver';
import { TwilioRecordingAdapter } from '@/lib/telecom/provider/adapters/recordingAdapter';
import { ProviderResourceManager } from '@/lib/telecom/provider/providerResourceManager';
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

    // 3. Query database recording record strictly scoped to authenticated organization
    const adminSupabase = createAdminClient();
    const { data: recordingData, error: recError } = await (adminSupabase as any)
      .from('recordings')
      .select('id, organization_id, recording_url, twilio_recording_sid')
      .eq('id', recordingId)
      .eq('organization_id', profile.organization_id)
      .maybeSingle();

    const recording = recordingData as {
      id: string;
      organization_id: string;
      recording_url: string;
      twilio_recording_sid?: string | null;
    } | null;

    if (recError || !recording) {
      return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    }

    // 4. Resolve Provider Context via Provider Abstraction
    const providerResolution = await ProviderAccountResolver.resolveAccount({
      organizationId: profile.organization_id,
      service: 'RECORDING',
    }, adminSupabase);

    if (!providerResolution.success || !providerResolution.context) {
      return NextResponse.json(
        { error: providerResolution.errorMessage || 'Unable to resolve provider account context for recording playback.' },
        { status: 500 }
      );
    }

    if (providerResolution.context.isSharedParent || providerResolution.context.accountType === 'SHARED_PARENT') {
      return NextResponse.json(
        { error: 'Forbidden. Customer organizations cannot access parent Twilio recording resources.' },
        { status: 403 }
      );
    }

    // 5. Remote Provider Resource Ownership Check
    if (recording.twilio_recording_sid) {
      const isOwner = await ProviderResourceManager.assertResourceOwnership(
        profile.organization_id,
        'RECORDING',
        recording.twilio_recording_sid,
        adminSupabase
      );
      if (!isOwner) {
        return NextResponse.json(
          { error: 'Forbidden. Cross-tenant or unmapped provider resource identifier.' },
          { status: 403 }
        );
      }
    }

    // 6. Fetch Media from Telephony Provider via Provider Adapter
    const recordingAdapter = new TwilioRecordingAdapter();
    const mediaResult = await recordingAdapter.fetchRecordingMedia(
      recording.twilio_recording_sid || recordingId,
      providerResolution.context
    );

    if (!mediaResult.ok || !mediaResult.data) {
      console.error(`[Recording Playback] Failed to fetch recording from provider: ${mediaResult.errorMessage}`);
      return NextResponse.json(
        { error: mediaResult.errorMessage || 'Failed to stream recording media from provider' },
        { status: mediaResult.status || 500 }
      );
    }

    console.log(`[Recording Playback] Streaming audio successfully`);

    // Stream audio/mpeg response back to browser
    const headers = new Headers();
    headers.set('Content-Type', mediaResult.contentType || 'audio/mpeg');
    headers.set('Content-Length', mediaResult.data.byteLength.toString());
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'private, max-age=3600');

    return new NextResponse(mediaResult.data, {
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
