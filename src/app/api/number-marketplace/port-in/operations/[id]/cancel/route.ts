import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createAdminClient } from '@/lib/supabase/admin';
import { PortInService } from '@/lib/telephony/lifecycle/portInService';

export async function POST(
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
    const { organizationId, reason } = body;

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
        { error: 'FORBIDDEN: Only Organization Owner or Admin can cancel port operations.' },
        { status: 403 }
      );
    }

    const dto = await PortInService.cancelPortIn(id, organizationId, reason, adminDb);
    return NextResponse.json({ success: true, operation: dto });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'CANCEL_PORT_OP_FAILED' }, { status: 500 });
  }
}
