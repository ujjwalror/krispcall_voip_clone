import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * GET /api/phone-numbers/[id]
 * Tenant-safe single phone number detail endpoint.
 * Strictly derives organization identity from auth.uid() -> profiles.organization_id.
 * Selected phone number must belong to authenticated organization.
 * Querying another organization's UUID returns 404 Not Found (fail-closed).
 */
export async function GET(
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

    // 2. Fetch authenticated profile & organization_id
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

    return NextResponse.json({
      success: true,
      phoneNumber,
    });
  } catch (error: any) {
    console.error('[GET /api/phone-numbers/[id]] Exception:', error.message || error);
    return NextResponse.json(
      { error: 'internal_error', message: 'Internal server error fetching phone number details.' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/phone-numbers/[id]
 * Safe phone number management operations:
 * 1. Edit friendly name (friendlyName)
 * 2. Set as primary business number (isPrimary) via authoritative RPC
 *
 * Authorization: Owner & Admin only.
 * Tenant Isolation: Strictly derives tenant organization server-side from user session.
 */
export async function PATCH(
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

    // 2. Fetch profile & enforce Owner/Admin role authority
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

    const isAuthorized = ['owner', 'admin'].includes(profile.role);
    if (!isAuthorized) {
      return NextResponse.json(
        { error: 'forbidden', message: 'Only workspace Owners and Admins can modify phone number settings.' },
        { status: 403 }
      );
    }

    // 3. Verify target phone number belongs to authenticated tenant
    const { data: existingNumber, error: findError } = await (supabase as any)
      .from('phone_numbers')
      .select('*')
      .eq('id', id)
      .eq('organization_id', profile.organization_id)
      .maybeSingle();

    if (findError || !existingNumber) {
      return NextResponse.json(
        { error: 'not_found', message: 'Phone number record not found or access denied.' },
        { status: 404 }
      );
    }

    // 4. Parse request body
    const body = await request.json().catch(() => ({}));
    const { friendlyName, isPrimary } = body;

    // Operation A: Set as Primary Business Number via Authoritative PostgreSQL RPC
    if (isPrimary === true) {
      const isNumberActive = existingNumber.active === true && existingNumber.status === 'active';
      if (!isNumberActive) {
        return NextResponse.json(
          { error: 'bad_request', message: 'Only active business numbers can be designated as primary.' },
          { status: 400 }
        );
      }

      // Invoke authoritative PostgreSQL RPC function set_primary_phone_number
      // If RPC fails or is unavailable, stop execution immediately without modifying any rows.
      const { error: rpcError } = await (supabase as any).rpc('set_primary_phone_number', {
        p_phone_number_id: id,
      });

      if (rpcError) {
        console.error('[PATCH /api/phone-numbers/[id]] Primary RPC execution error:', rpcError.message || rpcError);
        return NextResponse.json(
          { error: 'rpc_error', message: rpcError.message || 'Failed to set primary business number.' },
          { status: 500 }
        );
      }
    }

    // Operation B: Edit Friendly Name
    if (friendlyName !== undefined) {
      const trimmed = typeof friendlyName === 'string' ? friendlyName.trim() : '';
      if (trimmed.length > 100) {
        return NextResponse.json(
          { error: 'bad_request', message: 'Friendly name cannot exceed 100 characters.' },
          { status: 400 }
        );
      }

      const adminSupabase = createAdminClient();
      const { error: updateError } = await (adminSupabase as any)
        .from('phone_numbers')
        .update({
          friendly_name: trimmed || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('organization_id', profile.organization_id);

      if (updateError) {
        console.error('[PATCH /api/phone-numbers/[id]] Friendly name update failed:', updateError);
        return NextResponse.json(
          { error: 'internal_error', message: 'Failed to update friendly name.' },
          { status: 500 }
        );
      }
    }

    // Fetch and return the authoritative updated phone number record
    const { data: updatedNumber, error: fetchUpdatedError } = await (supabase as any)
      .from('phone_numbers')
      .select('*')
      .eq('id', id)
      .eq('organization_id', profile.organization_id)
      .single();

    if (fetchUpdatedError || !updatedNumber) {
      return NextResponse.json({
        success: true,
        phoneNumber: { ...existingNumber, is_primary: isPrimary === true ? true : existingNumber.is_primary },
      });
    }

    return NextResponse.json({
      success: true,
      phoneNumber: updatedNumber,
    });
  } catch (error: any) {
    console.error('[PATCH /api/phone-numbers/[id]] Exception:', error.message || error);
    return NextResponse.json(
      { error: 'internal_error', message: 'Internal server error updating phone number settings.' },
      { status: 500 }
    );
  }
}
