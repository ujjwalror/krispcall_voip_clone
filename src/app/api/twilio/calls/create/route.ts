import { NextResponse } from 'next/server';
import { executeOutboundCallSetup, OutboundCallError } from '@/lib/telephony/outboundCallService';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';

export async function POST(request: Request) {
  try {
    // 1. Enforce active session authority
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    // 2. Fetch user profile & organization_id
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id, active')
      .eq('id', user.id)
      .single();

    const profile = profileData as { organization_id?: string; active?: boolean } | null;

    if (profileError || !profile || !profile.organization_id || !profile.active) {
      return NextResponse.json(
        { error: 'Forbidden. User profile or organization unconfigured.' },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const destination = body.destination || body.to || '';
    const fromNumber = body.fromNumber || body.from || '';
    const recordCall = Boolean(body.recordCall);
    const defaultCountry = body.defaultCountry || body.country || undefined;

    // 3. Delegate to shared server-only outbound call service
    const result = await executeOutboundCallSetup({
      userId: user.id,
      organizationId: profile.organization_id,
      destination,
      fromNumber,
      recordCall,
      defaultCountry,
    });

    return NextResponse.json(result);
  } catch (error: any) {
    if (error instanceof OutboundCallError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }

    console.error('Error in /api/twilio/calls/create:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error creating call record.' },
      { status: 500 }
    );
  }
}
