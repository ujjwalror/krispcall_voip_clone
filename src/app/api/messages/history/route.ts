import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const customerNumber = searchParams.get('customerNumber') || searchParams.get('customer') || '';
    const businessNumber = searchParams.get('businessNumber') || searchParams.get('business') || '';

    if (!customerNumber || !businessNumber) {
      return NextResponse.json(
        { error: 'customerNumber and businessNumber parameters are required.' },
        { status: 400 }
      );
    }

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

    // 3. Query messages matching the conversation tuple
    const { data: messages, error: fetchErr } = await (adminSupabase as any)
      .from('messages')
      .select('id, organization_id, user_id, contact_id, from_number, to_number, body, direction, status, error_code, error_message, is_read, sent_at, created_at, updated_at')
      .eq('organization_id', organizationId)
      .or(`and(from_number.eq.${businessNumber},to_number.eq.${customerNumber}),and(from_number.eq.${customerNumber},to_number.eq.${businessNumber})`)
      .order('created_at', { ascending: true });

    if (fetchErr) {
      console.error('Error fetching message history:', fetchErr);
      return NextResponse.json(
        { error: 'Failed to fetch message history.' },
        { status: 500 }
      );
    }

    // 4. Attach agent names for outbound messages where user_id is present
    const userIds = Array.from(
      new Set(
        (messages || [])
          .map((m: any) => m.user_id)
          .filter(Boolean) as string[]
      )
    );

    const userNameMap = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: profiles } = await (adminSupabase as any)
        .from('profiles')
        .select('id, full_name, email')
        .in('id', userIds);

      if (profiles) {
        profiles.forEach((p: any) => {
          userNameMap.set(p.id, p.full_name || p.email);
        });
      }
    }

    const enrichedMessages = (messages || []).map((m: any) => ({
      ...m,
      senderName: m.user_id ? userNameMap.get(m.user_id) || 'Agent' : null,
    }));

    return NextResponse.json({
      success: true,
      messages: enrichedMessages,
    });
  } catch (error: any) {
    console.error('Error in GET /api/messages/history:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error fetching message history.' },
      { status: 500 }
    );
  }
}
