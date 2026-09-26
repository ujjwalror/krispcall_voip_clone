import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { ComplianceDocumentService } from '@/lib/telephony/compliance/complianceDocumentService';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = (await createServerSupabaseClient()) as any;
    const { data: authData } = await supabase.auth.getUser();

    if (!authData.user) {
      return NextResponse.json({ success: false, error: 'UNAUTHORIZED: Authentication required.' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('organization_id, role')
      .eq('id', authData.user.id)
      .single();

    if (!profile || !profile.organization_id) {
      return NextResponse.json({ success: false, error: 'UNAUTHORIZED: Organization profile not found.' }, { status: 403 });
    }

    if (profile.role !== 'owner' && profile.role !== 'admin') {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED_ROLE: Downloading compliance documents requires Owner or Admin workspace role.' },
        { status: 403 }
      );
    }

    const downloadInfo = await ComplianceDocumentService.generateDownloadUrl(
      profile.organization_id,
      id,
      profile.role
    );

    return NextResponse.json({ success: true, ...downloadInfo });
  } catch (err: any) {
    console.error('[GET /api/compliance/documents/[id]/download] Error:', err);
    return NextResponse.json(
      { success: false, error: err.message || 'Failed to generate download URL.' },
      { status: 500 }
    );
  }
}
