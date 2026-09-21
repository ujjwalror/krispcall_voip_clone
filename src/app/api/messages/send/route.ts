import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { sendOutboundSms, SmsServiceError } from '@/lib/telephony/smsService';

export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();

    // 1. Authenticate user web session
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

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
