import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { normalizeE164PhoneNumber } from '@/lib/utils';

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

    // 3. Extract & validate destination
    const body = await request.json().catch(() => ({}));
    const destination = body.destination || body.to || '';
    const validation = normalizeE164PhoneNumber(destination);

    if (!validation.isValid || !validation.normalized) {
      return NextResponse.json(
        { error: validation.error || 'Invalid destination phone number.' },
        { status: 400 }
      );
    }

    // 4. Server-authoritative blocked-number check for organization
    const { data: blockedRecord } = await (supabase as any)
      .from('blocked_numbers')
      .select('id, phone_number')
      .eq('organization_id', profile.organization_id)
      .eq('normalized_phone', validation.normalized)
      .maybeSingle();

    if (blockedRecord) {
      return NextResponse.json(
        { error: 'This number is blocked. Unblock it before calling.' },
        { status: 403 }
      );
    }

    // Also check contacts table if contact exists with is_blocked = true
    const { data: blockedContact } = await (supabase as any)
      .from('contacts')
      .select('id, full_name')
      .eq('organization_id', profile.organization_id)
      .eq('phone', validation.normalized)
      .eq('is_blocked', true)
      .is('archived_at', null)
      .maybeSingle();

    if (blockedContact) {
      return NextResponse.json(
        { error: 'This number is blocked. Unblock it before calling.' },
        { status: 403 }
      );
    }

    const recordCall = Boolean(body.recordCall);

    // 5. Resolve caller ID from request body or organization primary active phone number
    let fromNumber = (body.fromNumber || body.from || '').trim();
    if (!fromNumber) {
      const { data: primaryPhone } = await (supabase as any)
        .from('phone_numbers')
        .select('phone_number')
        .eq('organization_id', profile.organization_id)
        .eq('active', true)
        .order('is_primary', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (primaryPhone?.phone_number) {
        fromNumber = primaryPhone.phone_number;
      } else {
        fromNumber = process.env.TWILIO_PHONE_NUMBER || '+61348328472';
      }
    }

    // 6. Create database call record
    const { data: callRecord, error: insertError } = await supabase
      .from('calls')
      .insert({
        organization_id: profile.organization_id,
        user_id: user.id,
        direction: 'outbound',
        from_number: fromNumber,
        to_number: validation.normalized,
        status: 'initiated',
        record_call: recordCall,
        started_at: new Date().toISOString(),
      } as any)
      .select()
      .single();

    if (insertError || !callRecord) {
      console.error('Error creating database call record:', insertError);
      return NextResponse.json(
        { error: 'Failed to create database call log.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      callId: (callRecord as any).id,
      call: callRecord,
    });
  } catch (error: any) {
    console.error('Error in /api/twilio/calls/create:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error creating call record.' },
      { status: 500 }
    );
  }
}
