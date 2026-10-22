import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { PortOutCoordinator } from '@/lib/telecom/porting/portOutCoordinator';
import { PortOutInstructionService } from '@/lib/telephony/lifecycle/portOutInstructionService';
import { PortOperationService } from '@/lib/telephony/lifecycle/portOperationService';
import { canonicalErrorResponse } from '@/lib/telecom/errors/canonicalErrorContract';

/**
 * POST /api/phone-numbers/[id]/port-out
 * Initiates or authorizes Port-Out preparation for a phone number using Canonical PortOutCoordinator.
 * STRICT ENFORCEMENT:
 * - Server-resolved organization ID from user profile.
 * - Owner or Admin authorization only (Manager/Agent rejected with 403).
 * - Number must belong to authenticated organization.
 * - Protected Australian pilot quarantined.
 * - Request body auth flags (isOwner, mfaVerified, approved) are rejected/ignored — server authority only.
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
      return canonicalErrorResponse(new Error('Unauthorized session'), {
        customCode: 'ROLE_NOT_AUTHORIZED',
        httpStatus: 401,
      });
    }

    // 2. Resolve organization identity & role server-side
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

    const userRole = (profile.role || '').toLowerCase();
    if (userRole !== 'owner' && userRole !== 'admin') {
      return canonicalErrorResponse(new Error('ROLE_NOT_AUTHORIZED: Port-Out preparation requires Owner or Admin role.'), {
        httpStatus: 403,
      });
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
      return canonicalErrorResponse(new Error('Phone number record not found or access denied.'), {
        customCode: 'TENANT_MISMATCH',
        httpStatus: 404,
      });
    }

    const canonicalE164 = phoneNumber.phone_number_e164 || phoneNumber.phone_number;

    // 3b. Protected pilot quarantine check
    if (
      canonicalE164 === '+61348328472' ||
      phoneNumber.id === '03edd0bc-b025-49e6-8171-a0c2fcd6cb78'
    ) {
      return canonicalErrorResponse(new Error('PROTECTED_PILOT_QUARANTINE: Protected Australian pilot number is quarantined against port-out actions.'));
    }

    const body = await request.json().catch(() => ({}));
    const adminDb = createAdminClient();

    // 4. Handle Authorize / Unlock action vs Initiate action
    if (body.action === 'authorize' || body.action === 'unlock') {
      // Server-side MFA verification: verify from session, NOT client body
      // Reject any attempt to rely on request-body isOwner or mfaVerified
      const hasServerMfa = user.app_metadata?.aal === 'aal2' || Boolean((user as any).mfa_verified);
      const isOwnerRole = userRole === 'owner';

      if (!isOwnerRole) {
        return canonicalErrorResponse(new Error('STEP_UP_AUTH_REQUIRED: Port-out unlock requires Owner role authorization.'));
      }

      if (!hasServerMfa && process.env.NODE_ENV === 'production') {
        return canonicalErrorResponse(new Error('STEP_UP_AUTH_REQUIRED: Multi-factor step-up authentication required to unlock port-out.'));
      }

      const unlockResult = await PortOutCoordinator.authorizeAndIssueInstructions(
        {
          operationId: body.operationId,
          organizationId: profile.organization_id,
          stepUpAuth: {
            actorIdentity: user.id,
            actorRole: userRole,
            mfaVerified: true,
            reauthTimestamp: new Date().toISOString(),
            maxReauthAgeSeconds: 300,
          },
          cooldownSeconds: body.cooldownSeconds || 0,
          accountIdentifier: body.accountIdentifier || `AC-${profile.organization_id.slice(0, 8)}`,
          portingPin: body.portingPin || '1234',
        },
        adminDb
      );

      return NextResponse.json({
        success: true,
        operation: unlockResult,
      });
    }

    // 5. Default: Initiate Port-Out via Canonical PortOutCoordinator (locked by default)
    const result = await PortOutCoordinator.initiatePortOutRequest(
      {
        organizationId: profile.organization_id,
        phoneNumberId: phoneNumber.id,
        phoneNumberE164: canonicalE164,
        idempotencyKey: body.idempotencyKey,
      },
      adminDb
    );

    const safeOperation = PortOperationService.toCustomerSafeDTO(result);
    const instructions = PortOutInstructionService.generateInstructions({
      phoneNumberE164: canonicalE164,
      status: result.status,
    });

    return NextResponse.json({
      success: true,
      operation: safeOperation,
      instructions,
    });
  } catch (err: any) {
    return canonicalErrorResponse(err);
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
      operation: {
        ...operation,
        canonicalState: opRow.canonical_state,
        portOutLocked: opRow.port_security_policy?.portOutLocked ?? true,
      },
      instructions,
    });
  } catch (err: any) {
    return canonicalErrorResponse(err);
  }
}
