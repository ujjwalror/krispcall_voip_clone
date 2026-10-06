import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PrepaidNumberRenewalService } from '@/lib/telephony/renewal/prepaidNumberRenewalService';
import { AdminRenewalPreviewService } from '@/lib/telephony/renewal/adminRenewalPreviewService';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: phoneNumberId } = await params;
    if (!phoneNumberId) {
      return NextResponse.json({ error: 'Phone number ID required' }, { status: 400 });
    }

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
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    const profileAny = profile as any;
    if (!profileAny?.organization_id) {
      return NextResponse.json({ error: 'Organization context not found' }, { status: 403 });
    }

    const record = await PrepaidNumberRenewalService.getPerNumberRenewalRecord(phoneNumberId);
    if (!record) {
      return NextResponse.json({ error: 'Phone number renewal record not found' }, { status: 404 });
    }

    // STRICT TENANT ISOLATION: Prevent reading another organization's number renewal status
    if (record.organizationId !== profileAny.organization_id && profileAny.role !== 'admin' && profileAny.role !== 'SUPER_ADMIN') {
      return NextResponse.json(
        { error: 'Forbidden: Cannot access another organization\'s number renewal status' },
        { status: 403 }
      );
    }

    const evaluation = await PrepaidNumberRenewalService.evaluateNumberRenewal(phoneNumberId);

    // If platform admin, include dynamic preview breakdown
    let adminPreview = null;
    if (profileAny.role === 'admin' || profileAny.role === 'SUPER_ADMIN' || profileAny.role === 'PLATFORM_ADMIN') {
      const previewRes = await AdminRenewalPreviewService.getNumberRenewalPreview(
        phoneNumberId,
        profileAny.role,
        user.id
      );
      if (previewRes.success) {
        adminPreview = previewRes.preview;
      }
    }

    return NextResponse.json({
      success: true,
      record,
      evaluation,
      adminPreview,
    });
  } catch (err: any) {
    console.error('[API /phone-numbers/[id]/renewal] GET Exception:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
