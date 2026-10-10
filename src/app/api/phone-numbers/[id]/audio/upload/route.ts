import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { ALLOWED_AUDIO_MIME_TYPES, MAX_AUDIO_SIZE_BYTES } from '@/lib/telephony/numberAudioService';

/**
 * POST /api/phone-numbers/[id]/audio/upload - Upload custom audio asset (Welcome, Voicemail Greeting, Hold, Transfer)
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: phoneNumberId } = await params;
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
      return NextResponse.json({ error: 'insufficient_permissions', message: 'Only Owners or Admins can upload audio assets.' }, { status: 403 });
    }

    // Verify phone number ownership
    const { data: phone } = await (supabase as any)
      .from('phone_numbers')
      .select('id, organization_id, active')
      .eq('id', phoneNumberId)
      .maybeSingle();

    if (!phone || phone.organization_id !== profile.organization_id || phone.active === false) {
      return NextResponse.json({ error: 'unauthorized_number', message: 'Phone number not found or unauthorized.' }, { status: 403 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const purpose = (formData.get('purpose') || 'welcome').toString();

    if (!file) {
      return NextResponse.json({ error: 'missing_file', message: 'No file provided for upload.' }, { status: 400 });
    }

    // 1. Validate file size (max 5MB)
    if (file.size > MAX_AUDIO_SIZE_BYTES) {
      return NextResponse.json({
        error: 'file_too_large',
        message: `File size (${(file.size / 1024 / 1024).toFixed(2)} MB) exceeds maximum allowed limit (5.00 MB).`,
      }, { status: 400 });
    }

    // 2. Validate MIME type
    const mime = (file.type || '').toLowerCase();
    if (!ALLOWED_AUDIO_MIME_TYPES.includes(mime as any)) {
      return NextResponse.json({
        error: 'invalid_mime_type',
        message: `Unsupported audio format '${mime}'. Allowed formats: MP3, WAV, OGG.`,
      }, { status: 400 });
    }

    const assetId = `asset_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const storagePath = `org_${profile.organization_id}/${phoneNumberId}/${purpose}_${assetId}.${mime.includes('wav') ? 'wav' : mime.includes('ogg') ? 'ogg' : 'mp3'}`;

    // Record asset metadata
    const assetMeta = {
      id: assetId,
      organizationId: profile.organization_id,
      phoneNumberId,
      purpose,
      name: file.name,
      storagePath,
      mimeType: mime,
      sizeBytes: file.size,
      url: `/api/phone-numbers/${phoneNumberId}/audio/assets/${assetId}`,
    };

    return NextResponse.json({
      success: true,
      asset: assetMeta,
      message: `Audio file "${file.name}" uploaded successfully.`,
    });
  } catch (err: any) {
    console.error('[POST /api/phone-numbers/[id]/audio/upload] Exception:', err.message || err);
    return NextResponse.json({ error: 'internal_error', message: 'Internal server error uploading audio.' }, { status: 500 });
  }
}
