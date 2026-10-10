import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { NumberAudioService } from '@/lib/telephony/numberAudioService';

/**
 * GET /api/phone-numbers/[id]/audio - Fetch audio configuration for a phone number
 * POST /api/phone-numbers/[id]/audio - Save audio configuration for a phone number
 */
export async function GET(
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

    const settings = await NumberAudioService.getAudioSettings(profile.organization_id, id, supabase);
    return NextResponse.json({ settings });
  } catch (err: any) {
    console.error('[GET /api/phone-numbers/[id]/audio] Exception:', err.message || err);
    return NextResponse.json({ error: 'internal_error', message: 'Internal server error.' }, { status: 500 });
  }
}

export async function POST(
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

    const role = (profile.role || '').toLowerCase();
    if (role !== 'owner' && role !== 'admin') {
      return NextResponse.json({ error: 'insufficient_permissions', message: 'Only Owners or Admins can configure Greetings & Audio.' }, { status: 403 });
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'invalid_json', message: 'Malformed JSON payload.' }, { status: 400 });
    }

    const result = await NumberAudioService.saveAudioSettings(profile.organization_id, id, body, supabase);

    if (!result.success) {
      return NextResponse.json({ error: 'save_failed', message: result.message }, { status: 400 });
    }

    return NextResponse.json({ result });
  } catch (err: any) {
    console.error('[POST /api/phone-numbers/[id]/audio] Exception:', err.message || err);
    return NextResponse.json({ error: 'internal_error', message: 'Internal server error.' }, { status: 500 });
  }
}
