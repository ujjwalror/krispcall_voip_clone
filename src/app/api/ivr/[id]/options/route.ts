import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { IvrService } from '@/lib/telephony/ivrService';

/**
 * POST /api/ivr/[id]/options - Upsert DTMF keypress option node on IVR menu
 */
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
      return NextResponse.json({ error: 'insufficient_permissions', message: 'Only Owners or Admins can modify IVR options.' }, { status: 403 });
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'invalid_json', message: 'Malformed JSON payload.' }, { status: 400 });
    }

    const result = await IvrService.upsertIvrOption(
      profile.organization_id,
      id,
      {
        digit: body.digit,
        destinationType: body.destinationType || body.destination_type,
        destinationId: body.destinationId || body.destination_id,
        enabled: body.enabled !== false,
      },
      supabase
    );

    if (!result.success) {
      return NextResponse.json({ error: 'option_failed', message: result.message }, { status: 400 });
    }

    return NextResponse.json({ result });
  } catch (err: any) {
    console.error('[POST /api/ivr/[id]/options] Exception:', err.message || err);
    return NextResponse.json({ error: 'internal_error', message: 'Internal server error.' }, { status: 500 });
  }
}
