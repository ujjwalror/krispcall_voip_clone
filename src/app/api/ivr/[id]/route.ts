import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { IvrService } from '@/lib/telephony/ivrService';
import { hasEntitlement } from '@/lib/entitlements/server';

/**
 * GET /api/ivr/[id] - Get IVR menu details + options
 * PATCH /api/ivr/[id] - Update IVR menu (Owner/Admin required)
 * DELETE /api/ivr/[id] - Archive/Disable IVR menu (Owner/Admin required)
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

    const menu = await IvrService.getIvrMenu(profile.organization_id, id, supabase);

    if (!menu) {
      return NextResponse.json({ error: 'not_found', message: 'IVR menu not found or unauthorized.' }, { status: 404 });
    }

    return NextResponse.json({ menu });
  } catch (err: any) {
    console.error('[GET /api/ivr/[id]] Exception:', err.message || err);
    return NextResponse.json({ error: 'internal_error', message: 'Internal server error.' }, { status: 500 });
  }
}

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
      .select('organization_id, active, role')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json({ error: 'unauthorized_profile', message: 'Active profile required.' }, { status: 403 });
    }

    const entitled = await hasEntitlement('ivr', supabase);
    if (!entitled) {
      return NextResponse.json({ error: 'entitlement_required', message: 'IVR feature requires a Pro subscription plan.' }, { status: 403 });
    }

    const role = (profile.role || '').toLowerCase();
    if (role !== 'owner' && role !== 'admin') {
      return NextResponse.json({ error: 'insufficient_permissions', message: 'Only Owners or Admins can update IVR menus.' }, { status: 403 });
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'invalid_json', message: 'Malformed JSON payload.' }, { status: 400 });
    }

    const result = await IvrService.updateIvrMenu(profile.organization_id, id, body, supabase);

    if (!result.success) {
      return NextResponse.json({ error: 'update_failed', message: result.message }, { status: 400 });
    }

    return NextResponse.json({ result });
  } catch (err: any) {
    console.error('[PATCH /api/ivr/[id]] Exception:', err.message || err);
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

    const entitled = await hasEntitlement('ivr', supabase);
    if (!entitled) {
      return NextResponse.json({ error: 'entitlement_required', message: 'IVR feature requires a Pro subscription plan.' }, { status: 403 });
    }

    const role = (profile.role || '').toLowerCase();
    if (role !== 'owner' && role !== 'admin') {
      return NextResponse.json({ error: 'insufficient_permissions', message: 'Only Owners or Admins can disable IVR menus.' }, { status: 403 });
    }

    const result = await IvrService.deleteIvrMenu(profile.organization_id, id, supabase);

    if (!result.success) {
      return NextResponse.json({ error: 'delete_failed', message: result.message }, { status: 400 });
    }

    return NextResponse.json({ result });
  } catch (err: any) {
    console.error('[DELETE /api/ivr/[id]] Exception:', err.message || err);
    return NextResponse.json({ error: 'internal_error', message: 'Internal server error.' }, { status: 500 });
  }
}
