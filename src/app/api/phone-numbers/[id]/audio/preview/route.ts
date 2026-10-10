import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export const VERIFIED_TTS_VOICE_IDS = [
  'Polly.Joanna',
  'Polly.Matthew',
  'Polly.Amy',
  'Polly.Brian',
  'Polly.Salli',
  'Polly.Joey',
] as const;

export const MAX_TTS_PREVIEW_LENGTH = 500;

// Simple in-memory sliding window rate limiter: max 30 requests per minute per user
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 30;

  const current = rateLimitMap.get(userId);
  if (!current || now > current.resetTime) {
    rateLimitMap.set(userId, { count: 1, resetTime: now + windowMs });
    return true;
  }

  if (current.count >= maxRequests) {
    return false;
  }

  current.count += 1;
  return true;
}

/**
 * POST /api/phone-numbers/[id]/audio/preview
 * Secure, non-chargeable TTS preview authorization & validation endpoint.
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
      .select('organization_id, active')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json({ error: 'unauthorized_profile', message: 'Active profile required.' }, { status: 403 });
    }

    // Verify phone number ownership
    const { data: phone } = await (supabase as any)
      .from('phone_numbers')
      .select('id, organization_id, active')
      .eq('id', id)
      .maybeSingle();

    if (!phone || phone.organization_id !== profile.organization_id || phone.active === false) {
      return NextResponse.json({ error: 'unauthorized_phone', message: 'Phone number not found or unauthorized.' }, { status: 403 });
    }

    // Rate limiting check
    if (!checkRateLimit(user.id)) {
      return NextResponse.json(
        { error: 'rate_limit_exceeded', message: 'Rate limit exceeded. Please wait a minute before generating more previews.' },
        { status: 429 }
      );
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'invalid_json', message: 'Malformed JSON payload.' }, { status: 400 });
    }

    const rawText = typeof body.text === 'string' ? body.text.trim() : '';
    const rawVoice = typeof body.voice === 'string' ? body.voice.trim() : '';

    if (!rawText) {
      return NextResponse.json({ error: 'empty_text', message: 'Please enter a spoken message before playing preview.' }, { status: 400 });
    }

    if (rawText.length > MAX_TTS_PREVIEW_LENGTH) {
      return NextResponse.json(
        { error: 'text_too_long', message: `Message exceeds maximum preview length of ${MAX_TTS_PREVIEW_LENGTH} characters.` },
        { status: 400 }
      );
    }

    if (!VERIFIED_TTS_VOICE_IDS.includes(rawVoice as any)) {
      return NextResponse.json(
        { error: 'invalid_voice', message: `Selected voice "${rawVoice}" is not in the verified catalogue.` },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      text: rawText,
      voice: rawVoice,
      validatedAt: new Date().toISOString(),
      providerCost: 0,
    });
  } catch (err: any) {
    console.error('[POST /api/phone-numbers/[id]/audio/preview] Exception:', err.message || err);
    return NextResponse.json({ error: 'internal_error', message: 'Internal server error.' }, { status: 500 });
  }
}
