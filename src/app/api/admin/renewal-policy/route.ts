import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PreRenewalPolicyService } from '@/lib/telephony/renewal/preRenewalPolicyService';

export async function GET(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    const userRole = (profile as any)?.role || 'agent';

    if (!PreRenewalPolicyService.isPlatformAdmin(userRole, user.id)) {
      return NextResponse.json(
        { error: 'Forbidden: Global commercial policy preview requires PLATFORM_ADMIN authorization' },
        { status: 403 }
      );
    }

    const policy = await PreRenewalPolicyService.getActivePolicy();
    return NextResponse.json({ success: true, policy });
  } catch (err: any) {
    console.error('[API /admin/renewal-policy] GET Exception:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    const userRole = (profile as any)?.role || 'agent';

    if (!PreRenewalPolicyService.isPlatformAdmin(userRole, user.id)) {
      return NextResponse.json(
        { error: 'Forbidden: Global commercial policies can only be altered by PLATFORM_ADMIN.' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const result = await PreRenewalPolicyService.updatePolicy(userRole, user.id, body || {});

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: true, policy: result.policy });
  } catch (err: any) {
    console.error('[API /admin/renewal-policy] POST Exception:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
