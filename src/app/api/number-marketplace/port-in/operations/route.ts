import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createAdminClient } from '@/lib/supabase/admin';
import { PortOperationService } from '@/lib/telephony/lifecycle/portOperationService';

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options)
              );
            } catch {}
          },
        },
      }
    );

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) {
      return NextResponse.json({ error: 'UNAUTHORIZED: Authentication required.' }, { status: 401 });
    }

    const body = await request.json();
    const { organizationId, phoneNumberE164, workflowMode, idempotencyKey, requestFingerprint } = body;

    if (!organizationId || !phoneNumberE164) {
      return NextResponse.json(
        { error: 'INVALID_INPUT: organizationId and phoneNumberE164 are required.' },
        { status: 400 }
      );
    }

    const adminDb = createAdminClient();

    // Verify tenant membership
    const { data: member } = await (adminDb as any)
      .from('organization_members')
      .select('role')
      .eq('organization_id', organizationId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!member || !['owner', 'admin'].includes((member.role || '').toLowerCase())) {
      return NextResponse.json(
        { error: 'FORBIDDEN: Only Organization Owner or Admin can initiate port operations.' },
        { status: 403 }
      );
    }

    const createdRow = await PortOperationService.createPortOperation(
      {
        organizationId,
        phoneNumberE164,
        direction: 'port_in',
        status: 'draft',
        workflowMode: workflowMode || 'automated_api',
        idempotencyKey,
        requestFingerprint,
      },
      adminDb
    );

    const dto = PortOperationService.toCustomerSafeDTO(createdRow);
    return NextResponse.json({ success: true, operation: dto });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'CREATE_PORT_OP_FAILED' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options)
              );
            } catch {}
          },
        },
      }
    );

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) {
      return NextResponse.json({ error: 'UNAUTHORIZED: Authentication required.' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get('organizationId');

    if (!organizationId) {
      return NextResponse.json(
        { error: 'INVALID_INPUT: organizationId query parameter is required.' },
        { status: 400 }
      );
    }

    const adminDb = createAdminClient();

    // Verify tenant membership
    const { data: member } = await (adminDb as any)
      .from('organization_members')
      .select('role')
      .eq('organization_id', organizationId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!member) {
      return NextResponse.json({ error: 'FORBIDDEN: Tenant membership required.' }, { status: 403 });
    }

    const { data: rows } = await (adminDb as any)
      .from('number_port_operations')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('direction', 'port_in')
      .order('created_at', { ascending: false });

    const operations = (rows || []).map((row: any) => PortOperationService.toCustomerSafeDTO(row));

    return NextResponse.json({ success: true, operations });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'FETCH_PORT_OPS_FAILED' }, { status: 500 });
  }
}
