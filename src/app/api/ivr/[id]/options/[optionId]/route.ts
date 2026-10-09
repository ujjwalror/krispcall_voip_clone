import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { IvrService } from '@/lib/telephony/ivrService';
import { hasEntitlement } from '@/lib/entitlements/server';

/**
 * DELETE /api/ivr/[id]/options/[optionId] - Remove a DTMF option node
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; optionId: string }> }
) {
  try {
    const { id, optionId } = await params;
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
      return NextResponse.json({ error: 'insufficient_permissions', message: 'Only Owners or Admins can delete IVR options.' }, { status: 403 });
    }

    const result = await IvrService.deleteIvrOption(profile.organization_id, id, optionId, supabase);

    if (!result.success) {
      return NextResponse.json({ error: 'delete_failed', message: result.message }, { status: 400 });
    }

    return NextResponse.json({ result });
  } catch (err: any) {
    console.error('[DELETE /api/ivr/[id]/options/[optionId]] Exception:', err.message || err);
    return NextResponse.json({ error: 'internal_error', message: 'Internal server error.' }, { status: 500 });
  }
}
