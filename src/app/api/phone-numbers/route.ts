import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { normalizeE164PhoneNumber } from '@/lib/utils';

/**
 * GET /api/phone-numbers
 * Fetches provider-neutral business numbers for the authenticated user's organization.
 */
export async function GET() {
  try {
    const supabase = await createServerSupabaseClient();

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

    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile || !profile.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden. User organization unconfigured.' },
        { status: 403 }
      );
    }

    // 1. Fetch active business numbers from public.phone_numbers
    const { data: phoneNumbers, error: fetchError } = await (supabase as any)
      .from('phone_numbers')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .eq('active', true)
      .order('created_at', { ascending: true });

    if (fetchError) {
      console.error('Error fetching phone numbers:', fetchError);
      return NextResponse.json(
        { error: `Database error retrieving business numbers: ${fetchError.message || fetchError.code}` },
        { status: 500 }
      );
    }

    let result = phoneNumbers || [];

    // 2. Auto-initialize default primary business number if database table is currently empty for this org
    if (result.length === 0) {
      const defaultPhone = process.env.TWILIO_PHONE_NUMBER || '+61348328472';
      const validation = normalizeE164PhoneNumber(defaultPhone);
      const normalizedPhone = validation.normalized || defaultPhone;

      const { data: insertedNumber } = await (supabase as any)
        .from('phone_numbers')
        .insert({
          organization_id: profile.organization_id,
          phone_number: normalizedPhone,
          friendly_name: 'Primary Business Line',
          active: true,
        })
        .select()
        .maybeSingle();

      if (insertedNumber) {
        result = [insertedNumber];
      } else {
        // Fallback transient object if insertion restricted
        result = [
          {
            id: 'default-primary',
            organization_id: profile.organization_id,
            phone_number: normalizedPhone,
            friendly_name: 'Primary Business Line',
            active: true,
            created_at: new Date().toISOString(),
          },
        ];
      }
    }

    return NextResponse.json({
      success: true,
      phoneNumbers: result,
    });
  } catch (error: any) {
    console.error('Error in GET /api/phone-numbers:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error fetching business numbers.' },
      { status: 500 }
    );
  }
}
