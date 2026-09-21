import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(request: Request) {
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

    // 2. Fetch profile to resolve organization_id
    const { data: profile } = await (supabase as any)
      .from('profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single();

    if (!profile || !profile.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden. User organization unconfigured.' },
        { status: 403 }
      );
    }

    const organizationId = profile.organization_id;
    const adminSupabase = createAdminClient();

    // 3. Fetch active business lines with capabilities_sms = TRUE
    const { data: phoneNumbers, error: fetchErr } = await (adminSupabase as any)
      .from('phone_numbers')
      .select('id, phone_number, friendly_name, is_primary, capabilities_sms, capabilities_voice, active')
      .eq('organization_id', organizationId)
      .eq('active', true)
      .eq('capabilities_sms', true)
      .order('is_primary', { ascending: false });

    if (fetchErr) {
      console.error('Error fetching SMS-capable phone numbers:', fetchErr);
      return NextResponse.json(
        { error: 'Failed to fetch SMS business numbers.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      phoneNumbers: phoneNumbers || [],
    });
  } catch (error: any) {
    console.error('Error in GET /api/phone-numbers/sms-capable:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error fetching SMS phone numbers.' },
      { status: 500 }
    );
  }
}
