import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createAdminClient } from '@/lib/supabase/admin';
import { PortOperationService } from '@/lib/telephony/lifecycle/portOperationService';
import { PortInService } from '@/lib/telephony/lifecycle/portInService';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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
      return NextResponse.json({ error: 'INVALID_INPUT: organizationId query parameter required.' }, { status: 400 });
    }

    const adminDb = createAdminClient();

    const row = await PortOperationService.getOperationById(id, organizationId, adminDb);
    if (!row) {
      return NextResponse.json({ error: 'NOT_FOUND: Port operation not found.' }, { status: 404 });
    }

    const dto = PortOperationService.toCustomerSafeDTO(row);
    return NextResponse.json({ success: true, operation: dto });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'GET_OPERATION_FAILED' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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
    const {
      organizationId,
      accountNumberPlaintext,
      pinPlaintext,
      authorizedRepresentativeName,
      authorizedRepresentativeEmail,
      carrierName,
      billingAddress,
      customerMessage,
    } = body;

    if (!organizationId) {
      return NextResponse.json({ error: 'INVALID_INPUT: organizationId is required.' }, { status: 400 });
    }

    const adminDb = createAdminClient();

    // Verify Owner or Admin role
    const { data: member } = await (adminDb as any)
      .from('organization_members')
      .select('role')
      .eq('organization_id', organizationId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!member || !['owner', 'admin'].includes((member.role || '').toLowerCase())) {
      return NextResponse.json(
        { error: 'FORBIDDEN: Only Organization Owner or Admin can update port operations.' },
        { status: 403 }
      );
    }

    const updatedDto = await PortInService.updatePortInDetails(
      {
        operationId: id,
        organizationId,
        accountNumberPlaintext,
        pinPlaintext,
        authorizedRepresentativeName,
        authorizedRepresentativeEmail,
        carrierName,
        billingAddress,
        customerMessage,
      },
      adminDb
    );

    return NextResponse.json({ success: true, operation: updatedDto });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'UPDATE_OPERATION_FAILED' }, { status: 500 });
  }
}
