import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { executeOutboundCallSetup, OutboundCallError } from '@/lib/telephony/outboundCallService';

export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();

    // 1. Authenticate user
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

    // 3. Delegate to shared server-only outbound call service
    const result = await executeOutboundCallSetup({
      userId: user.id,
      organizationId: profile.organization_id,
      destination,
      fromNumber,
      recordCall,
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

