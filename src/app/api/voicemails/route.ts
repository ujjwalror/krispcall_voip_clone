import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { VoicemailService } from '@/lib/telephony/voicemailService';

/**
 * GET /api/voicemails
 * Lists voicemails for the authenticated user's organization.
 * Derives organization strictly server-side from auth user -> profile.
 * Checks 'voicemail' entitlement.
 */
export async function GET(request: Request) {
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

    const isEntitled = await VoicemailService.isEntitled(supabase);
    if (!isEntitled) {
      return NextResponse.json(
        {
          error: 'entitlement_denied',
          message: 'Voicemail feature is not enabled for your subscription plan. Please upgrade to Pro or Business.',
        },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1', 10);
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    const isReadParam = searchParams.get('isRead');
    const isRead = isReadParam !== null ? isReadParam === 'true' : undefined;

    const result = await VoicemailService.listVoicemails(
      profile.organization_id,
      { page, limit, isRead },
      supabase
    );

    return NextResponse.json(result);
  } catch (err: any) {
    console.error('[GET /api/voicemails] Exception:', err.message || err);
    return NextResponse.json({ error: 'internal_error', message: 'Internal server error.' }, { status: 500 });
  }
}
