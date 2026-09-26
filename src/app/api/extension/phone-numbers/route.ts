import { NextResponse } from 'next/server';
import {
  authenticateExtensionRequest,
  getExtensionCorsHeaders,
  handleExtensionCorsOptions,
} from '@/lib/telephony/extensionAuth';
import { createAdminClient } from '@/lib/supabase/admin';

export async function OPTIONS(request: Request) {
  return handleExtensionCorsOptions(request);
}

export async function GET(request: Request) {
  const corsHeaders = getExtensionCorsHeaders(request);

  try {
    const { auth, errorResponse } = await authenticateExtensionRequest(request);
    if (errorResponse) return errorResponse;
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401, headers: corsHeaders });
    }

    const adminSupabase = createAdminClient();

    const { data: profile } = await (adminSupabase as any)
      .from('profiles')
      .select('role, active')
      .eq('id', auth.userId)
      .maybeSingle();

    const isOwnerOrAdmin = profile && ['owner', 'admin'].includes(profile.role || '');

    if (isOwnerOrAdmin) {
      const { data: phoneNumbers } = await (adminSupabase as any)
        .from('phone_numbers')
        .select('*')
        .eq('organization_id', auth.organizationId)
        .eq('active', true)
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true });

      const result = (phoneNumbers || []).filter((pn: any) => pn && pn.active === true && pn.status === 'active');
      return NextResponse.json({ success: true, phoneNumbers: result }, { headers: corsHeaders });
    } else {
      const { data: userAssignments } = await (adminSupabase as any)
        .from('user_phone_assignments')
        .select(`
          phone_number_id,
          phone_numbers:phone_number_id (*)
        `)
        .eq('user_id', auth.userId)
        .eq('organization_id', auth.organizationId);

      const assignedNumbers = (userAssignments || [])
        .map((a: any) => a.phone_numbers)
        .filter((pn: any) => pn && pn.active === true && pn.status === 'active');

      return NextResponse.json({ success: true, phoneNumbers: assignedNumbers }, { headers: corsHeaders });
    }
  } catch (error: any) {
    console.error('Error in GET /api/extension/phone-numbers:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error retrieving business numbers.' },
      { status: 500, headers: corsHeaders }
    );
  }
}
