import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
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

    const adminSupabase = createAdminClient();

    // 3. Clean up expired reservations
    await (adminSupabase as any)
      .from('agent_call_reservations')
      .delete()
      .lte('expires_at', new Date().toISOString());

    // 4. Atomic outbound reservation lock: Guarantee only 1 call setup per user at a time
    const expiresAt = new Date(Date.now() + 45 * 1000).toISOString();
    const { data: resRow, error: resErr } = await (adminSupabase as any)
      .from('agent_call_reservations')
      .insert({
        organization_id: profile.organization_id,
        user_id: user.id,
        reservation_type: 'outbound',
        expires_at: expiresAt,
      })
      .select('id')
      .maybeSingle();

    if (resErr || !resRow) {
      return NextResponse.json(
        { error: 'You already have an active call or pending call setup. Finish your current call before starting another.' },
        { status: 409 }
      );
    }

    const reservationId = resRow.id;

    try {
      // 5. Check if agent already owns an active call row in database
      const { data: existingActiveCall } = await (adminSupabase as any)
        .from('calls')
        .select('id')
        .eq('organization_id', profile.organization_id)
        .in('status', ['initiated', 'ringing', 'in-progress', 'queued'])
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle();

      if (existingActiveCall) {
        throw new Error('You already have an active call. Finish your current call before starting another.');
      }

      // 6. Extract & validate destination
      const body = await request.json().catch(() => ({}));
      const destination = body.destination || body.to || '';
      const validation = normalizeE164PhoneNumber(destination);

      if (!validation.isValid || !validation.normalized) {
        throw new Error(validation.error || 'Invalid destination phone number.');
      }

      // 7. Blocked-number check for organization
      const { data: blockedRecord } = await (adminSupabase as any)
        .from('blocked_numbers')
        .select('id')
        .eq('organization_id', profile.organization_id)
        .eq('normalized_phone', validation.normalized)
        .maybeSingle();

      if (blockedRecord) {
        throw new Error('This number is blocked. Unblock it before calling.');
      }

      const { data: blockedContact } = await (adminSupabase as any)
        .from('contacts')
        .select('id')
        .eq('organization_id', profile.organization_id)
        .eq('phone', validation.normalized)
        .eq('is_blocked', true)
        .is('archived_at', null)
        .maybeSingle();

      if (blockedContact) {
        throw new Error('This number is blocked. Unblock it before calling.');
      }

      const recordCall = Boolean(body.recordCall);

      // 8. Resolve caller ID
      let fromNumber = (body.fromNumber || body.from || '').trim();
      if (!fromNumber) {
        const { data: primaryPhone } = await (adminSupabase as any)
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

      // 9. Create database call record
      const { data: callRecord, error: insertError } = await (adminSupabase as any)
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
        })
        .select()
        .single();

      if (insertError || !callRecord) {
        console.error('Error creating database call record:', insertError);
        throw new Error('Failed to create database call log.');
      }

      // 10. Update reservation to link call_id
      await (adminSupabase as any)
        .from('agent_call_reservations')
        .update({ call_id: callRecord.id })
        .eq('id', reservationId);

      return NextResponse.json({
        success: true,
        callId: callRecord.id,
        call: callRecord,
      });
    } catch (opError: any) {
      // Outbound failure cleanup: Release reservation immediately if any validation or DB step failed
      await (adminSupabase as any)
        .from('agent_call_reservations')
        .delete()
        .eq('id', reservationId);

      const errorMessage = opError.message || 'Failed to initiate call.';
      const status = errorMessage.includes('blocked') ? 403 : errorMessage.includes('active call') ? 409 : 400;

      return NextResponse.json({ error: errorMessage }, { status });
    }
  } catch (error: any) {
    console.error('Error in /api/twilio/calls/create:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error creating call record.' },
      { status: 500 }
    );
  }
}
