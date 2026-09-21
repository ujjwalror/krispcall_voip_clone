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

    const { data: phoneNumbers } = await (adminSupabase as any)
      .from('phone_numbers')
      .select('*')
      .eq('organization_id', auth.organizationId)
      .eq('active', true)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: true });

    let result = phoneNumbers || [];
    if (result.length === 0) {
      const defaultPhone = process.env.TWILIO_PHONE_NUMBER || '+61348328472';
      result = [
        {
          id: 'default-primary',
          organization_id: auth.organizationId,
          phone_number: defaultPhone,
          friendly_name: 'Primary Business Number',
          active: true,
          is_primary: true,
        },
      ];
    }

    return NextResponse.json({ success: true, phoneNumbers: result }, { headers: corsHeaders });
  } catch (error: any) {
    console.error('Error in GET /api/extension/phone-numbers:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error retrieving business numbers.' },
      { status: 500, headers: corsHeaders }
    );
  }
}
