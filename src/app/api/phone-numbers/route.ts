import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * GET /api/phone-numbers
 * Fetches provider-neutral business numbers for the authenticated user's organization.
 * Strictly derives organization identity server-side.
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
      .select('organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'Forbidden. User organization unconfigured or account inactive.' },
        { status: 403 }
      );
    }

    const isOwnerOrAdmin = ['owner', 'admin'].includes(profile.role || '');

    if (isOwnerOrAdmin) {
      // Fetch active lifecycle business numbers for the authenticated organization (excluding historical released/ported_out rows)
      const { data: phoneNumbers, error: fetchError } = await (supabase as any)
        .from('phone_numbers')
        .select('*')
        .eq('organization_id', profile.organization_id)
        .in('status', ['active', 'inactive', 'suspended'])
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true });

      if (fetchError) {
        console.error('Error fetching phone numbers:', fetchError);
        return NextResponse.json(
          { error: `Database error retrieving business numbers: ${fetchError.message || fetchError.code}` },
          { status: 500 }
        );
      }

      return NextResponse.json({
        success: true,
        phoneNumbers: phoneNumbers || [],
      });
    } else {
      // Manager/Agent: Return only numbers explicitly assigned to this user
      const adminSupabase = createAdminClient();
      const { data: userAssignments, error: assignErr } = await (adminSupabase as any)
        .from('user_phone_assignments')
        .select(`
          phone_number_id,
          phone_numbers:phone_number_id (*)
        `)
        .eq('user_id', user.id)
        .eq('organization_id', profile.organization_id);

      if (assignErr) {
        console.error('Error fetching assigned phone numbers:', assignErr);
        return NextResponse.json(
          { error: 'Database error retrieving assigned business numbers.' },
          { status: 500 }
        );
      }

      const assignedNumbers = (userAssignments || [])
        .map((a: any) => a.phone_numbers)
        .filter((pn: any) => pn && pn.active === true && pn.status === 'active');

      return NextResponse.json({
        success: true,
        phoneNumbers: assignedNumbers,
      });
    }
  } catch (error: any) {
    console.error('Error in GET /api/phone-numbers:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error fetching business numbers.' },
      { status: 500 }
    );
  }
}
