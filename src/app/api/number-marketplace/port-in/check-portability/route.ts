import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { PortabilityService } from '@/lib/telephony/lifecycle/portabilityService';
import { PortOperationService } from '@/lib/telephony/lifecycle/portOperationService';

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options)
              );
            } catch {}
          },
        },
      }
    );

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) {
      return NextResponse.json({ error: 'UNAUTHORIZED: Authentication required.' }, { status: 401 });
    }

    const body = await request.json();
    const { phoneNumberE164, countryCode, numberType } = body;

    if (!phoneNumberE164) {
      return NextResponse.json({ error: 'INVALID_INPUT: phoneNumberE164 is required.' }, { status: 400 });
    }

    const rawE164 = String(phoneNumberE164).replace(/[\s\(\)\-\.]/g, '');
    if (!/^\+[1-9]\d{1,14}$/.test(rawE164)) {
      return NextResponse.json(
        { error: 'INVALID_E164: Valid canonical E.164 phone number is required.' },
        { status: 400 }
      );
    }

    // Evaluate portability dynamically without exposing provider internals
    const result = await PortabilityService.evaluatePortability({
      phoneNumberE164: rawE164,
      countryCode: countryCode || 'US',
      numberType: numberType || 'local',
    });

    return NextResponse.json({
      success: true,
      portability: {
        phoneNumberE164: rawE164,
        portable: result.portable,
        workflowMode: result.workflowMode,
        accountNumberRequired: result.accountNumberRequired,
        pinRequired: result.pinRequired,
        customerReason: result.customerReason,
        checkedAt: result.checkedAt,
        expiresAt: result.expiresAt,
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'PORTABILITY_CHECK_FAILED' },
      { status: 500 }
    );
  }
}
