import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ProviderNumberOperationService } from '@/lib/telephony/commerce/providerNumberOperationService';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: operationId } = await params;
    const authHeader = req.headers.get('Authorization');
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;

    if (!token) {
      return NextResponse.json({ error: 'UNAUTHORIZED: Authentication token required.' }, { status: 401 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: 'UNAUTHORIZED: Invalid session token.' }, { status: 401 });
    }

    // Resolve tenant organization ID server-side
    const { data: profile, error: profileError } = await userClient
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile || !profile.organization_id) {
      return NextResponse.json({ error: 'FORBIDDEN: User does not belong to an active organization.' }, { status: 403 });
    }

    const op = await ProviderNumberOperationService.getOperationById(operationId, profile.organization_id);

    if (!op) {
      return NextResponse.json({ error: 'NOT_FOUND: Operation not found or access denied.' }, { status: 404 });
    }

    const dto = ProviderNumberOperationService.toCustomerSafeDTO(op);
    return NextResponse.json(dto, { status: 200 });
  } catch (error: any) {
    console.error('Error fetching purchase operation status:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR: Failed to retrieve purchase operation status.' },
      { status: 500 }
    );
  }
}
