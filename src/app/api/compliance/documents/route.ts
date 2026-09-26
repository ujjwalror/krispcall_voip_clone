import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { ComplianceDocumentService } from '@/lib/telephony/compliance/complianceDocumentService';

export async function POST(req: Request) {
  try {
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
        { success: false, error: 'UNAUTHORIZED_ROLE: Document upload requires Owner or Admin workspace role.' },
        { status: 403 }
      );
    }

    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const profileId = formData.get('complianceProfileId') as string | null;
    const requirementKey = formData.get('requirementKey') as string | null;
    const documentType = formData.get('documentType') as string | null;

    if (!file || !profileId || !requirementKey || !documentType) {
      return NextResponse.json(
        { success: false, error: 'Missing required upload parameters: file, complianceProfileId, requirementKey, documentType.' },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const doc = await ComplianceDocumentService.uploadDocument({
      organizationId: profile.organization_id,
      complianceProfileId: profileId,
      requirementKey,
      documentType,
      originalFilename: file.name,
      mimeType: file.type || 'application/pdf',
      fileBuffer: buffer,
      userId: authData.user.id,
      userRole: profile.role,
    });

    return NextResponse.json({ success: true, document: doc });
  } catch (err: any) {
    console.error('[POST /api/compliance/documents] Error:', err);
    return NextResponse.json(
      { success: false, error: err.message || 'Failed to upload compliance document.' },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  try {
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
        { success: false, error: 'UNAUTHORIZED_ROLE: Listing documents requires Owner or Admin workspace role.' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(req.url);
    const profileId = searchParams.get('profileId');

    if (!profileId) {
      return NextResponse.json({ success: false, error: 'profileId parameter is required.' }, { status: 400 });
    }

    const docs = await ComplianceDocumentService.getProfileDocuments(
      profile.organization_id,
      profileId,
      profile.role
    );

    return NextResponse.json({ success: true, documents: docs });
  } catch (err: any) {
    console.error('[GET /api/compliance/documents] Error:', err);
    return NextResponse.json(
      { success: false, error: err.message || 'Failed to list compliance documents.' },
      { status: 500 }
    );
  }
}
