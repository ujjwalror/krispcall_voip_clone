import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { NumberAssignmentService } from '@/lib/telecom/assignment/numberAssignmentService';
import { NumberReleaseSagaCoordinator } from '@/lib/telecom/saga/numberReleaseSagaCoordinator';
import { canonicalErrorResponse } from '@/lib/telecom/errors/canonicalErrorContract';

function sanitizePhoneNumberDetail(row: any): Record<string, any> {
  const ownershipState = row.ownership_state || (row.status === 'active' ? 'OWNED' : 'ACQUISITION_PENDING');
  const serviceState = row.service_state || (row.status === 'active' && row.active ? 'ACTIVE' : 'SUSPENDED');
  const assignmentTargetType = row.assignment_target_type || 'UNASSIGNED_POOL';

  return {
    id: row.id,
    phone_number: row.phone_number,
    phone_number_e164: row.phone_number_e164 || row.phone_number,
    friendly_name: row.friendly_name || null,
    country_code: row.country_code || 'US',
    is_primary: Boolean(row.is_primary),
    // Canonical Dimensions
    ownership_state: ownershipState,
    service_state: serviceState,
    billing_state: row.billing_state || 'CURRENT',
    porting_state: row.porting_state || 'NONE',
    compliance_state: row.compliance_state || 'NOT_REQUIRED',
    capabilities_state: row.capabilities_state || {
      VOICE_INBOUND: { stage: 'USABLE' },
      VOICE_OUTBOUND: { stage: 'USABLE' },
      SMS_INBOUND: { stage: 'USABLE' },
      SMS_OUTBOUND: { stage: 'USABLE' },
    },
    // Canonical Assignment
    assignment_target_type: assignmentTargetType,
    assignment_target_id: row.assignment_target_id || null,
    assigned_at: row.assigned_at || null,
    provider_account_id: row.provider_account_id || null,
    // Display Compatibility Projections
    active: row.active ?? true,
    status: row.status || 'active',
    capabilities: row.capabilities || { voice: true, sms: true, mms: false },
    inbound_routing_type: row.inbound_routing_type || 'user',
    inbound_routing_destination_id: row.inbound_routing_destination_id || null,
    unanswered_call_strategy: row.unanswered_call_strategy || 'voicemail',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * GET /api/phone-numbers/[id]
 * Tenant-safe single phone number detail endpoint.
 * Strictly derives organization identity from auth.uid() -> profiles.organization_id.
 * Selected phone number must belong to authenticated organization.
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
      return canonicalErrorResponse(new Error('Unauthorized. Authenticated session required.'), {
        customCode: 'ROLE_NOT_AUTHORIZED',
        httpStatus: 401,
      });
    }

    // 2. Fetch authenticated profile & organization_id
    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id) {
      return canonicalErrorResponse(new Error('TENANT_MISMATCH: User organization assignment not found.'), {
        httpStatus: 403,
      });
    }

    // 3. Query phone number strictly scoped to authenticated organization
    const { data: phoneNumber, error: fetchError } = await (supabase as any)
      .from('phone_numbers')
      .select('*')
      .eq('id', id)
      .eq('organization_id', profile.organization_id)
      .maybeSingle();

    if (fetchError || !phoneNumber) {
      return canonicalErrorResponse(new Error('Phone number record not found or access denied.'), {
        customCode: 'TENANT_MISMATCH',
        httpStatus: 404,
      });
    }

    return NextResponse.json({
      success: true,
      phoneNumber: sanitizePhoneNumberDetail(phoneNumber),
    });
  } catch (error: any) {
    return canonicalErrorResponse(error);
  }
}

/**
 * PATCH /api/phone-numbers/[id]
 * Safe phone number management operations:
 * 1. Edit friendly name (friendlyName)
 * 2. Set as primary business number (isPrimary) via authoritative RPC
 * 3. Assign/Reassign/Unassign (assignmentTargetType, assignmentTargetId) via Canonical NumberAssignmentService
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
      return canonicalErrorResponse(new Error('Unauthorized'), { customCode: 'ROLE_NOT_AUTHORIZED', httpStatus: 401 });
    }

    // 2. Fetch profile & enforce Owner/Admin role authority
    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id) {
      return canonicalErrorResponse(new Error('TENANT_MISMATCH: User organization assignment not found.'), {
        httpStatus: 403,
      });
    }

    const isAuthorized = ['owner', 'admin'].includes(profile.role);
    if (!isAuthorized) {
      return canonicalErrorResponse(new Error('ROLE_NOT_AUTHORIZED: Only workspace Owners and Admins can modify phone number settings.'), {
        httpStatus: 403,
      });
    }

    // 3. Verify target phone number belongs to authenticated tenant
    const { data: existingNumber, error: findError } = await (supabase as any)
      .from('phone_numbers')
      .select('*')
      .eq('id', id)
      .eq('organization_id', profile.organization_id)
      .maybeSingle();

    if (findError || !existingNumber) {
      return canonicalErrorResponse(new Error('Phone number record not found or access denied.'), {
        customCode: 'TENANT_MISMATCH',
        httpStatus: 404,
      });
    }

    // 4. Parse request body
    const body = await request.json().catch(() => ({}));
    const { friendlyName, isPrimary, assignmentTargetType, assignmentTargetId } = body;

    // Operation A: Canonical Assignment Delegation (Phase 23D.5 / Phase 23D.10B)
    if (assignmentTargetType !== undefined) {
      const adminSupabase = createAdminClient();
      const assignRes = await NumberAssignmentService.assignNumber(
        {
          phoneNumberId: id,
          organizationId: profile.organization_id,
          targetType: assignmentTargetType,
          targetId: assignmentTargetId || null,
          actorId: user.id,
        },
        adminSupabase
      );

      if (!assignRes.success) {
        return canonicalErrorResponse(new Error(assignRes.message || assignRes.code), {
          customCode: assignRes.code,
          httpStatus: 400,
        });
      }
    }

    // Operation B: Set as Primary Business Number via Authoritative PostgreSQL RPC
    if (isPrimary === true) {
      const isNumberActive = existingNumber.active === true && existingNumber.status === 'active';
      if (!isNumberActive) {
        return canonicalErrorResponse(new Error('Only active business numbers can be designated as primary.'), {
          customCode: 'CAPABILITY_NOT_USABLE',
          httpStatus: 400,
        });
      }

      const { error: rpcError } = await (supabase as any).rpc('set_primary_phone_number', {
        p_phone_number_id: id,
      });

      if (rpcError) {
        return canonicalErrorResponse(rpcError, {
          customMessage: 'Failed to set primary business number.',
          httpStatus: 500,
        });
      }
    }

    // Operation C: Edit Friendly Name
    if (friendlyName !== undefined) {
      const trimmed = typeof friendlyName === 'string' ? friendlyName.trim() : '';
      if (trimmed.length > 100) {
        return canonicalErrorResponse(new Error('Friendly name cannot exceed 100 characters.'), {
          httpStatus: 400,
        });
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
        return canonicalErrorResponse(updateError, {
          customMessage: 'Failed to update friendly name.',
          httpStatus: 500,
        });
      }
    }

    // Fetch and return the authoritative updated phone number record
    const { data: updatedNumber } = await (supabase as any)
      .from('phone_numbers')
      .select('*')
      .eq('id', id)
      .eq('organization_id', profile.organization_id)
      .single();

    return NextResponse.json({
      success: true,
      phoneNumber: sanitizePhoneNumberDetail(updatedNumber || existingNumber),
    });
  } catch (error: any) {
    return canonicalErrorResponse(error);
  }
}

/**
 * DELETE /api/phone-numbers/[id]
 * Delegates number release strictly to Canonical NumberReleaseSagaCoordinator (Phase 23D.6 / 23D.10B).
 * Zero reachable uncoordinated provider release paths.
 * Enforces protected pilot quarantine and active traffic check.
 */
export async function DELETE(
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
      return canonicalErrorResponse(new Error('Unauthorized'), { customCode: 'ROLE_NOT_AUTHORIZED', httpStatus: 401 });
    }

    const { data: profile } = await (supabase as any)
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id) {
      return canonicalErrorResponse(new Error('TENANT_MISMATCH'), { httpStatus: 403 });
    }

    const userRole = (profile.role || '').toLowerCase();
    if (!['owner', 'admin'].includes(userRole)) {
      return canonicalErrorResponse(new Error('ROLE_NOT_AUTHORIZED: Only owners and admins can release numbers.'), {
        httpStatus: 403,
      });
    }

    const { data: phoneRow } = await (supabase as any)
      .from('phone_numbers')
      .select('*')
      .eq('id', id)
      .eq('organization_id', profile.organization_id)
      .maybeSingle();

    if (!phoneRow) {
      return canonicalErrorResponse(new Error('Phone number record not found or access denied.'), {
        customCode: 'TENANT_MISMATCH',
        httpStatus: 404,
      });
    }

    // Quarantine check for Australian pilot
    if (
      phoneRow.phone_number_e164 === '+61348328472' ||
      phoneRow.id === '03edd0bc-b025-49e6-8171-a0c2fcd6cb78'
    ) {
      return canonicalErrorResponse(new Error('PROTECTED_PILOT_QUARANTINE: Australian pilot number is quarantined against release.'));
    }

    const body = await request.json().catch(() => ({}));
    const confirmPhoneNumber = body.confirmPhoneNumber || body.confirm_phone_number || phoneRow.phone_number;

    const adminDb = createAdminClient();
    const result = await NumberReleaseSagaCoordinator.requestNumberRelease(
      {
        organizationId: profile.organization_id,
        actorId: user.id,
        phoneNumberId: id,
        confirmPhoneNumber,
        idempotencyKey: body.idempotencyKey || body.idempotency_key,
      },
      adminDb
    );

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (err: any) {
    return canonicalErrorResponse(err);
  }
}
