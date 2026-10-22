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

    const { CapabilityAuthorizationService } = await import('@/lib/telecom/capability');

    if (isOwnerOrAdmin) {
      // 3. Fetch active business lines and filter by canonical SMS_OUTBOUND authorization
      const { data: phoneNumbers, error: fetchErr } = await (adminSupabase as any)
        .from('phone_numbers')
        .select('id, phone_number, friendly_name, is_primary, capabilities_sms, capabilities_voice, active, status')
        .eq('organization_id', organizationId)
        .eq('active', true)
        .order('is_primary', { ascending: false });

      if (fetchErr) {
        console.error('Error fetching SMS phone numbers:', fetchErr);
        return NextResponse.json(
          { error: 'Failed to fetch SMS business numbers.' },
          { status: 500 }
        );
      }

      const operational: any[] = [];
      for (const pn of phoneNumbers || []) {
        const auth = await CapabilityAuthorizationService.canUseCapability(
          pn.id,
          'SMS_OUTBOUND',
          organizationId,
          { userId: user.id, requireAssignment: false },
          adminSupabase
        );
        if (auth.allowed) {
          operational.push(pn);
        }
      }

      return NextResponse.json({
        success: true,
        phoneNumbers: operational,
      });
    } else {
      // 3. Fetch user-assigned business lines and filter by canonical SMS_OUTBOUND authorization
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

      const candidates = (userAssignments || [])
        .map((a: any) => a.phone_numbers)
        .filter((pn: any) => pn && pn.id);

      const assignedSmsNumbers: any[] = [];
      for (const pn of candidates) {
        const auth = await CapabilityAuthorizationService.canUseCapability(
          pn.id,
          'SMS_OUTBOUND',
          organizationId,
          { userId: user.id, requireAssignment: true },
          adminSupabase
        );
        if (auth.allowed) {
          assignedSmsNumbers.push(pn);
        }
      }

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
