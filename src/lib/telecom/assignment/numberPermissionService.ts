import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { CapabilityAuthorizationService } from '@/lib/telecom/capability';
import type {
  AssignmentTargetType,
  CanActorUseNumberParams,
  NumberPermissionResult,
} from './types';

export class NumberPermissionService {
  /**
   * Evaluates whether a specific actor (user) is authorized to use a phone number
   * for an outbound operation (VOICE_OUTBOUND, SMS_OUTBOUND, MMS_OUTBOUND).
   *
   * Composes:
   * 1. Tenant Membership & Profile Status
   * 2. Assignment / RBAC Permission Boundary
   * 3. Canonical Capability Authorization (23D.4)
   */
  static async canActorUseNumber(
    params: CanActorUseNumberParams,
    clientOverride?: SupabaseClient
  ): Promise<NumberPermissionResult> {
    const client = clientOverride || createAdminClient();
    const { organizationId, actorId, phoneNumberId, phoneNumberE164, operation } = params;

    // 1. Verify Actor Membership & Active Profile
    const { data: actorProfile, error: profileErr } = await (client as any)
      .from('profiles')
      .select('id, organization_id, role, active, telecom_suspended')
      .eq('id', actorId)
      .maybeSingle();

    if (profileErr || !actorProfile || actorProfile.active === false) {
      return {
        allowed: false,
        code: 'INSUFFICIENT_PERMISSIONS',
        reason: 'Active user profile is required.',
        phoneNumberId: phoneNumberId || '',
        phoneNumberE164: phoneNumberE164 || '',
        organizationId,
        actorId,
        operation,
        targetType: 'UNASSIGNED_POOL',
        targetId: null,
        isAssignedToActor: false,
        hasAdminOverride: false,
      };
    }

    if (actorProfile.organization_id !== organizationId) {
      return {
        allowed: false,
        code: 'CROSS_ORGANIZATION_FORBIDDEN',
        reason: 'Actor does not belong to the requested organization.',
        phoneNumberId: phoneNumberId || '',
        phoneNumberE164: phoneNumberE164 || '',
        organizationId,
        actorId,
        operation,
        targetType: 'UNASSIGNED_POOL',
        targetId: null,
        isAssignedToActor: false,
        hasAdminOverride: false,
      };
    }

    if (actorProfile.telecom_suspended) {
      return {
        allowed: false,
        code: 'NUMBER_SUSPENDED',
        reason: 'User telecom access is currently suspended.',
        phoneNumberId: phoneNumberId || '',
        phoneNumberE164: phoneNumberE164 || '',
        organizationId,
        actorId,
        operation,
        targetType: 'UNASSIGNED_POOL',
        targetId: null,
        isAssignedToActor: false,
        hasAdminOverride: false,
      };
    }

    // 2. Fetch Phone Number
    let query = (client as any)
      .from('phone_numbers')
      .select(`
        id,
        phone_number,
        organization_id,
        ownership_state,
        service_state,
        is_suspended,
        assignment_target_type,
        assignment_target_id
      `);

    if (phoneNumberId) {
      query = query.eq('id', phoneNumberId);
    } else if (phoneNumberE164) {
      query = query.eq('phone_number', phoneNumberE164);
    } else {
      return {
        allowed: false,
        code: 'NUMBER_NOT_FOUND',
        reason: 'Either phoneNumberId or phoneNumberE164 must be provided.',
        phoneNumberId: '',
        phoneNumberE164: '',
        organizationId,
        actorId,
        operation,
        targetType: 'UNASSIGNED_POOL',
        targetId: null,
        isAssignedToActor: false,
        hasAdminOverride: false,
      };
    }

    const { data: phoneRow, error: phoneErr } = await query.maybeSingle();

    if (phoneErr || !phoneRow) {
      return {
        allowed: false,
        code: 'NUMBER_NOT_FOUND',
        reason: 'Phone number was not found.',
        phoneNumberId: phoneNumberId || '',
        phoneNumberE164: phoneNumberE164 || '',
        organizationId,
        actorId,
        operation,
        targetType: 'UNASSIGNED_POOL',
        targetId: null,
        isAssignedToActor: false,
        hasAdminOverride: false,
      };
    }

    if (phoneRow.organization_id !== organizationId) {
      return {
        allowed: false,
        code: 'CROSS_ORGANIZATION_FORBIDDEN',
        reason: 'Phone number belongs to another organization.',
        phoneNumberId: phoneRow.id,
        phoneNumberE164: phoneRow.phone_number,
        organizationId,
        actorId,
        operation,
        targetType: 'UNASSIGNED_POOL',
        targetId: null,
        isAssignedToActor: false,
        hasAdminOverride: false,
      };
    }

    const targetType = (phoneRow.assignment_target_type || 'UNASSIGNED_POOL') as AssignmentTargetType;
    const targetId = phoneRow.assignment_target_id || null;

    // 3. Evaluate Assignment & RBAC Rights
    const role = (actorProfile.role || '').toLowerCase();
    const isOwnerOrAdmin = ['owner', 'admin'].includes(role);
    let isAssignedToActor = false;

    if (targetType === 'USER' && targetId === actorId) {
      isAssignedToActor = true;
    } else if (targetType === 'WORKSPACE_MAIN') {
      // Shared workspace main number is accessible to all active organization members
      isAssignedToActor = true;
    } else {
      // Check legacy user_phone_assignments compatibility projection
      const { data: legacyAss } = await (client as any)
        .from('user_phone_assignments')
        .select('id')
        .eq('phone_number_id', phoneRow.id)
        .eq('user_id', actorId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (legacyAss) {
        isAssignedToActor = true;
      }
    }

    // Manager / Agent: Must be assigned to the number
    if (!isOwnerOrAdmin && !isAssignedToActor) {
      return {
        allowed: false,
        code: 'NOT_ASSIGNED_TO_NUMBER',
        reason: 'You are not assigned to this business phone number.',
        phoneNumberId: phoneRow.id,
        phoneNumberE164: phoneRow.phone_number,
        organizationId,
        actorId,
        operation,
        targetType,
        targetId,
        isAssignedToActor: false,
        hasAdminOverride: false,
      };
    }

    // 4. Compose with Canonical Capability Authorization (23D.4)
    const capAuth = await CapabilityAuthorizationService.canUseCapability(
      phoneRow.id,
      operation,
      organizationId,
      {
        userId: actorId,
        requireAssignment: !isOwnerOrAdmin,
      },
      client
    );

    if (!capAuth.allowed) {
      return {
        allowed: false,
        code: capAuth.code as any,
        reason: capAuth.reason,
        phoneNumberId: phoneRow.id,
        phoneNumberE164: phoneRow.phone_number,
        organizationId,
        actorId,
        operation,
        targetType,
        targetId,
        isAssignedToActor,
        hasAdminOverride: isOwnerOrAdmin,
      };
    }

    return {
      allowed: true,
      code: 'ASSIGNMENT_SUCCESS',
      reason: 'Actor authorized to use phone number.',
      phoneNumberId: phoneRow.id,
      phoneNumberE164: phoneRow.phone_number,
      organizationId,
      actorId,
      operation,
      targetType,
      targetId,
      isAssignedToActor,
      hasAdminOverride: isOwnerOrAdmin,
    };
  }
}
