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

    // 2. Fetch profile to resolve organization_id & role
    const { data: profile } = await (supabase as any)
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', user.id)
      .single();

    if (!profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'Forbidden. User organization unconfigured or account inactive.' },
        { status: 403 }
      );
    }

    const organizationId = profile.organization_id;
    const adminSupabase = createAdminClient();
    const isOwnerOrAdmin = ['owner', 'admin'].includes(profile.role || '');

    if (isOwnerOrAdmin) {
      // 3. Fetch active business lines with capabilities_sms = TRUE for Owner/Admin
      const { data: phoneNumbers, error: fetchErr } = await (adminSupabase as any)
        .from('phone_numbers')
        .select('id, phone_number, friendly_name, is_primary, capabilities_sms, capabilities_voice, active, status')
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

      const operational = (phoneNumbers || []).filter((pn: any) => pn && pn.active === true && pn.status === 'active');

      return NextResponse.json({
        success: true,
        phoneNumbers: operational,
      });
    } else {
      // 3. Fetch user-assigned SMS-capable business lines for Manager/Agent
      const { data: userAssignments, error: assignErr } = await (adminSupabase as any)
        .from('user_phone_assignments')
        .select(`
          phone_number_id,
          phone_numbers:phone_number_id (
            id,
            phone_number,
            friendly_name,
            is_primary,
            capabilities_sms,
            capabilities_voice,
            active,
            status
          )
        `)
        .eq('user_id', user.id)
        .eq('organization_id', organizationId);

      if (assignErr) {
        console.error('Error fetching assigned SMS phone numbers:', assignErr);
        return NextResponse.json(
          { error: 'Failed to fetch assigned SMS business numbers.' },
          { status: 500 }
        );
      }

      const assignedSmsNumbers = (userAssignments || [])
        .map((a: any) => a.phone_numbers)
        .filter(
          (pn: any) =>
            pn &&
            pn.active === true &&
            pn.capabilities_sms === true &&
            pn.status === 'active'
        );

      return NextResponse.json({
        success: true,
        phoneNumbers: assignedSmsNumbers,
      });
    }
  } catch (error: any) {
    console.error('Error in GET /api/phone-numbers/sms-capable:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error fetching SMS phone numbers.' },
      { status: 500 }
    );
  }
}
