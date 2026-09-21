import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { formatDisplayPhoneNumber } from '@/lib/utils';

export interface ConversationSummary {
  id: string; // Key: `${businessNumber}:${customerNumber}`
  customerPhoneNumber: string;
  businessPhoneNumber: string;
  contactName: string | null;
  contactId: string | null;
  displayTitle: string;
  lastMessage: string;
  lastMessageAt: string;
  lastMessageDirection: 'inbound' | 'outbound';
  lastMessageStatus: string;
  unreadCount: number;
}

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

    // 2. Fetch user profile for organization_id
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

    // 3. Fetch all messages for the organization ordered by created_at DESC
    const { data: allMessages, error: msgError } = await (adminSupabase as any)
      .from('messages')
      .select('id, from_number, to_number, body, direction, status, is_read, created_at, contact_id')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (msgError) {
      console.error('Error fetching organization messages for conversations:', msgError);
      return NextResponse.json(
        { error: 'Failed to fetch messages.' },
        { status: 500 }
      );
    }

    if (!allMessages || allMessages.length === 0) {
      return NextResponse.json({ success: true, conversations: [] });
    }

    // 4. Group messages into conversation threads
    const conversationMap = new Map<string, ConversationSummary>();
    const customerPhonesSet = new Set<string>();

    for (const msg of allMessages) {
      const isOutbound = msg.direction === 'outbound';
      const businessNum = isOutbound ? msg.from_number : msg.to_number;
      const customerNum = isOutbound ? msg.to_number : msg.from_number;

      customerPhonesSet.add(customerNum);
      const key = `${businessNum}:${customerNum}`;

      if (!conversationMap.has(key)) {
        conversationMap.set(key, {
          id: key,
          customerPhoneNumber: customerNum,
          businessPhoneNumber: businessNum,
          contactName: null,
          contactId: msg.contact_id || null,
          displayTitle: formatDisplayPhoneNumber(customerNum),
          lastMessage: msg.body || '',
          lastMessageAt: msg.created_at,
          lastMessageDirection: msg.direction as 'inbound' | 'outbound',
          lastMessageStatus: msg.status || 'sent',
          unreadCount: 0,
        });
      }

      const conv = conversationMap.get(key)!;
      if (msg.direction === 'inbound' && msg.is_read === false) {
        conv.unreadCount += 1;
      }
    }

    // 5. Match customer phone numbers against contacts table
    const customerPhones = Array.from(customerPhonesSet);
    if (customerPhones.length > 0) {
      const { data: matchedContacts } = await (adminSupabase as any)
        .from('contacts')
        .select('id, full_name, phone')
        .eq('organization_id', organizationId)
        .in('phone', customerPhones)
        .is('archived_at', null);

      if (matchedContacts && matchedContacts.length > 0) {
        const contactByPhone = new Map<string, { id: string; name: string }>();
        matchedContacts.forEach((c: any) => {
          contactByPhone.set(c.phone, { id: c.id, name: c.full_name });
        });

        conversationMap.forEach((conv) => {
          const match = contactByPhone.get(conv.customerPhoneNumber);
          if (match) {
            conv.contactName = match.name;
            conv.contactId = match.id;
            conv.displayTitle = `${match.name} (${formatDisplayPhoneNumber(conv.customerPhoneNumber)})`;
          }
        });
      }
    }

    const conversations = Array.from(conversationMap.values()).sort(
      (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
    );

    return NextResponse.json({
      success: true,
      conversations,
    });
  } catch (error: any) {
    console.error('Error in GET /api/messages/conversations:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error fetching conversations.' },
      { status: 500 }
    );
  }
}
