import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/**
 * POST /api/phone-numbers/verify-caller-id
 * Foundation API endpoint for requesting external outbound Caller ID verification.
 * Designed around Twilio OutgoingCallerIds validation workflow requirements.
 *
 * Authorization: Owner & Admin role only.
 * Tenant Isolation: Strictly derives tenant organization server-side from active session.
 * Safety: Does NOT trigger live Twilio API calls in Phase 19D.1A.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();

    // 1. Authenticate user session
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Unauthorized session required.' },
        { status: 401 }
      );
    }

    // 2. Fetch profile & verify active organization membership & Owner/Admin role
    const { data: profile } = await (supabase as any)
      .from('profiles')
      .select('organization_id, active, role')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'forbidden', message: 'Active organization assignment required.' },
        { status: 403 }
      );
    }

    const role = (profile.role || '').toLowerCase();
    if (role !== 'owner' && role !== 'admin') {
      return NextResponse.json(
        { error: 'forbidden', message: 'External Caller ID verification requires Owner or Admin role.' },
        { status: 403 }
      );
    }

    // 3. Parse and validate request body
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'invalid_json', message: 'Malformed JSON payload.' },
        { status: 400 }
      );
    }

    const countryCode = (body.countryCode || '+1').trim();
    let rawNumber = (body.phoneNumber || '').trim();

    if (!rawNumber) {
      return NextResponse.json(
        { error: 'invalid_phone', message: 'Phone number is required.' },
        { status: 400 }
      );
    }

    // Clean number input and construct E.164 format
    let e164Number = rawNumber.replace(/[^0-9+]/g, '');
    if (!e164Number.startsWith('+')) {
      const cleanCountry = countryCode.replace(/[^0-9]/g, '');
      e164Number = `+${cleanCountry}${e164Number.replace(/^0+/, '')}`;
    }

    const e164Regex = /^\+[1-9]\d{1,14}$/;
    if (!e164Regex.test(e164Number)) {
      return NextResponse.json(
        { error: 'invalid_e164', message: 'Please provide a valid phone number in standard E.164 format.' },
        { status: 400 }
      );
    }

    // 4. Check if number is already owned by organization as an active business number
    const { data: existingOrgPhone } = await (supabase as any)
      .from('phone_numbers')
      .select('id, friendly_name')
      .eq('organization_id', profile.organization_id)
      .eq('phone_number', e164Number)
      .maybeSingle();

    if (existingOrgPhone) {
      return NextResponse.json({
        success: true,
        alreadyOwned: true,
        phoneNumber: e164Number,
        message: 'This phone number is already owned and authorized for your organization.',
      });
    }

    // Generate deterministic validation code placeholder for UX workflow
    const mockValidationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // In Phase 19D.1A, live Twilio OutgoingCallerIds validation calls are NOT executed.
    // Return structured pending status object for UX presentation.
    return NextResponse.json({
      success: true,
      verification: {
        organizationId: profile.organization_id,
        phoneNumber: e164Number,
        countryCode,
        status: 'verification_pending_provider_call',
        validationCode: mockValidationCode,
        customerMessage:
          'Caller ID verification request registered. Live verification phone calls will be initiated in an upcoming release.',
        liveMutationsExecuted: false,
      },
    });
  } catch (error: any) {
    console.error('[POST /api/phone-numbers/verify-caller-id] Exception:', error.message || error);
    return NextResponse.json(
      { error: 'internal_error', message: 'Internal server error processing caller ID verification.' },
      { status: 500 }
    );
  }
}
