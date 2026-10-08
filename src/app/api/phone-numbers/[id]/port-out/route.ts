import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { PortOutService } from '@/lib/telephony/lifecycle/portOutService';
import { PortOutInstructionService } from '@/lib/telephony/lifecycle/portOutInstructionService';
import { PortOperationService } from '@/lib/telephony/lifecycle/portOperationService';

/**
 * POST /api/phone-numbers/[id]/port-out
 * Initiates Port-Out preparation for a phone number.
 * STRICT ENFORCEMENT:
 * - Server-resolved organization ID from user profile.
 * - Owner or Admin authorization only (Manager/Agent rejected with 403).
 * - Number must belong to authenticated organization.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createServerSupabaseClient();

    // 1. Authenticate user session
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    // 2. Resolve organization identity & role server-side
    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id) {
      return NextResponse.json(
        { error: 'forbidden', message: 'User organization assignment not found.' },
        { status: 403 }
      );
    }

    const userRole = (profile.role || '').toLowerCase();
    if (userRole !== 'owner' && userRole !== 'admin') {
      return NextResponse.json(
        { error: 'forbidden', message: 'Port-Out preparation requires Owner or Admin role.' },
        { status: 403 }
      );
    }

    // 2b. Enforce number.porting entitlement for initiating NEW port-out
    const { requireEntitlement } = await import('@/lib/entitlements/server');
    const entitlementRes = await requireEntitlement('number.porting');
    if (!entitlementRes.success) {
      return entitlementRes.errorResponse;
    }

    // 3. Query phone number strictly scoped to authenticated organization
    const { data: phoneNumber, error: fetchError } = await (supabase as any)
      .from('phone_numbers')
      .select('*')
      .eq('id', id)
      .eq('organization_id', profile.organization_id)
      .maybeSingle();

    if (fetchError || !phoneNumber) {
      return NextResponse.json(
        { error: 'not_found', message: 'Phone number record not found or access denied.' },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => ({}));

    // 4. Request Port-Out via PortOutService
    const result = await PortOutService.requestPortOut(
      {
        organizationId: profile.organization_id,
        phoneNumberId: phoneNumber.id,
        phoneNumberE164: phoneNumber.phone_number_e164 || phoneNumber.phone_number,
        userRole,
        customerName: body.customerName,
        serviceAddress: body.serviceAddress,
      },
      createAdminClient()
    );

    return NextResponse.json({
      success: true,
      operation: result.operation,
      instructions: result.instructions,
    });
  } catch (err: any) {
    const status = err.message?.includes('ROLE_UNAUTHORIZED')
      ? 403
      : err.message?.includes('PORT_OUT_INELIGIBLE')
      ? 422
      : 500;

    return NextResponse.json(
      { error: err.message || 'PORT_OUT_REQUEST_FAILED' },
      { status }
    );
  }
}

/**
 * GET /api/phone-numbers/[id]/port-out
 * Fetches active Port-Out status & dynamic customer instructions.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id) {
      return NextResponse.json(
        { error: 'forbidden', message: 'User organization assignment not found.' },
        { status: 403 }
      );
    }

    // Query phone number scoped to authenticated organization
    const { data: phoneNumber } = await (supabase as any)
      .from('phone_numbers')
      .select('*')
      .eq('id', id)
      .eq('organization_id', profile.organization_id)
      .maybeSingle();

    if (!phoneNumber) {
      return NextResponse.json(
        { error: 'not_found', message: 'Phone number record not found or access denied.' },
        { status: 404 }
      );
    }

    const canonicalE164 = phoneNumber.phone_number_e164 || phoneNumber.phone_number;

    // Fetch latest port-out operation
    const adminDb = createAdminClient();
    const { data: opRow } = await (adminDb as any)
      .from('number_port_operations')
      .select('*')
      .eq('organization_id', profile.organization_id)
      .eq('phone_number_e164', canonicalE164)
      .eq('direction', 'port_out')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!opRow) {
      return NextResponse.json({
        hasActivePortOut: false,
        operation: null,
        instructions: null,
      });
    }

    const operation = PortOperationService.toCustomerSafeDTO(opRow);
    const instructions = PortOutInstructionService.generateInstructions({
      phoneNumberE164: canonicalE164,
      status: opRow.status,
    });

    return NextResponse.json({
      hasActivePortOut: true,
      operation,
      instructions,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'PORT_OUT_STATUS_FAILED' }, { status: 500 });
  }
}
