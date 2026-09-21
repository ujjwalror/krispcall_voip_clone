import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

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

    // 2. Fetch profile to resolve authenticated organization_id
    const { data: profile } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id')
      .eq('id', user.id)
      .single();

    if (!profile || !profile.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden. User organization unconfigured.' },
        { status: 403 }
      );
    }

    const organizationId = profile.organization_id;

    // 3. Parse conversation identity from request body
    const jsonBody = await request.json().catch(() => ({}));
    const customerNumber = jsonBody.customerNumber || jsonBody.customer || '';
    const businessNumber = jsonBody.businessNumber || jsonBody.business || '';

    if (!customerNumber || !businessNumber) {
      return NextResponse.json(
        { error: 'customerNumber and businessNumber parameters are required.' },
        { status: 400 }
      );
    }

    const adminSupabase = createAdminClient();

    // 4. Perform narrow update of is_read = TRUE for inbound messages in this exact conversation
    const { data, error: updateErr } = await (adminSupabase as any)
      .from('messages')
      .update({
        is_read: true,
        updated_at: new Date().toISOString(),
      })
      .eq('organization_id', organizationId)
      .eq('direction', 'inbound')
      .eq('from_number', customerNumber)
      .eq('to_number', businessNumber)
      .eq('is_read', false)
      .select('id');

    if (updateErr) {
      console.error('Error updating unread message status:', updateErr);
      return NextResponse.json(
        { error: 'Failed to mark messages as read.' },
        { status: 500 }
      );
    }

    const updatedCount = Array.isArray(data) ? data.length : 0;
    return NextResponse.json({
      success: true,
      updatedCount,
    });
  } catch (error: any) {
    console.error('Error in POST /api/messages/read:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error marking messages read.' },
      { status: 500 }
    );
  }
}
