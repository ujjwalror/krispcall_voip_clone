import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { IvrService } from '@/lib/telephony/ivrService';
import { hasEntitlement } from '@/lib/entitlements/server';

/**
 * GET /api/ivr - List IVR menus for authenticated organization
 * POST /api/ivr - Create new IVR menu for authenticated organization (Owner/Admin required)
 */
export async function GET() {
  try {
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Unauthorized session required.' },
        { status: 401 }
      );
    }

    const { data: profile } = await (supabase as any)
      .from('profiles')
      .select('organization_id, active')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'unauthorized_profile', message: 'Active profile and organization assignment required.' },
        { status: 403 }
      );
    }

    const entitled = await hasEntitlement('ivr', supabase);
    const callQueueEntitled = await hasEntitlement('call_queue', supabase);
    const voicemailEntitled = await hasEntitlement('voicemail', supabase);
    const menus = await IvrService.listIvrMenus(profile.organization_id, supabase);

    return NextResponse.json({
      entitled,
      callQueueEntitled,
      voicemailEntitled,
      menus,
    });
  } catch (err: any) {
    console.error('[GET /api/ivr] Exception:', err.message || err);
    return NextResponse.json(
      { error: 'internal_error', message: 'Internal server error listing IVR menus.' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Unauthorized session required.' },
        { status: 401 }
      );
    }

    const { data: profile } = await (supabase as any)
      .from('profiles')
      .select('organization_id, active, role')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'unauthorized_profile', message: 'Active profile and organization assignment required.' },
        { status: 403 }
      );
    }

    const entitled = await hasEntitlement('ivr', supabase);
    if (!entitled) {
      return NextResponse.json(
        { error: 'entitlement_required', message: 'IVR feature requires a Pro subscription plan.' },
        { status: 403 }
      );
    }

    const role = (profile.role || '').toLowerCase();
    if (role !== 'owner' && role !== 'admin') {
      return NextResponse.json(
        { error: 'insufficient_permissions', message: 'Only Owners or Admins can create IVR menus.' },
        { status: 403 }
      );
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'invalid_json', message: 'Malformed JSON payload.' }, { status: 400 });
    }

    const result = await IvrService.createIvrMenu(profile.organization_id, body, supabase);

    if (!result.success) {
      return NextResponse.json({ error: 'creation_failed', message: result.message }, { status: 400 });
    }

    return NextResponse.json({
      result,
    });
  } catch (err: any) {
    console.error('[POST /api/ivr] Exception:', err.message || err);
    return NextResponse.json(
      { error: 'internal_error', message: 'Internal server error creating IVR menu.' },
      { status: 500 }
    );
  }
}
