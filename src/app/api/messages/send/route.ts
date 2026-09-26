import { NextResponse } from 'next/server';
import { sendOutboundSms, SmsServiceError } from '@/lib/telephony/smsService';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';

export async function POST(request: Request) {
  try {
    // 1. Enforce active session authority
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    // 2. Fetch profile to resolve authenticated organization_id & active status
    const { data: profileData, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id, active, role')
      .eq('id', user.id)
      .single();

    const profile = profileData as {
      id: string;
      organization_id?: string;
      active?: boolean;
      role?: string;
    } | null;

    if (profileError || !profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'Forbidden. User profile or organization unconfigured or inactive.' },
        { status: 403 }
      );
    }

    // 3. Parse request payload
    const jsonBody = await request.json().catch(() => ({}));
    const fromNumber = jsonBody.fromNumber || jsonBody.from || '';
    const toNumber = jsonBody.toNumber || jsonBody.to || jsonBody.destination || '';
    const messageBody = jsonBody.body || jsonBody.message || '';
    const defaultCountry = jsonBody.defaultCountry || jsonBody.country || undefined;

    // 4. Delegate to authoritative server-only SMS domain service
    const result = await sendOutboundSms({
      userId: user.id,
      organizationId: profile.organization_id,
      fromNumber,
      toNumber,
      body: messageBody,
      defaultCountry,
    });

    return NextResponse.json(result);
  } catch (error: any) {
    if (error instanceof SmsServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }

    console.error('Error in POST /api/messages/send:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error processing outbound SMS.' },
      { status: 500 }
    );
  }
}
