import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import type {
  AssignmentTargetType,
  AssignNumberParams,
  UnassignNumberParams,
  ReassignNumberParams,
  AssignmentResult,
  NumberAssignmentDTO,
} from './types';

export class NumberAssignmentService {
  /**
   * Assigns an organization-owned phone number to a valid target.
   */
  static async assignNumber(
    params: AssignNumberParams,
    clientOverride?: SupabaseClient
  ): Promise<AssignmentResult> {
    const client = clientOverride || createAdminClient();
    const {
      phoneNumberId,
      organizationId,
      targetType,
      targetId = null,
      actorId,
      expectedVersion,
    } = params;

    // 1. RBAC Check on Actor
    if (actorId) {
      const rbacCheck = await this.verifyActorPermission(client, actorId, organizationId);
      if (!rbacCheck.allowed) {
        return {
          success: false,
          code: 'INSUFFICIENT_PERMISSIONS',
          message: rbacCheck.reason,
          phoneNumberId,
          organizationId,
          targetType,
          targetId,
          assignedAt: null,
          carrierResourceUnchanged: true,
          providerAccountUnchanged: true,
        };
      }
    }

    // 2. Fetch Phone Number Record & Verify Organization Ownership
    const { data: phoneRow, error: phoneErr } = await (client as any)
      .from('phone_numbers')
      .select(`
        id,
        phone_number,
        organization_id,
        ownership_state,
        service_state,
        provider_account_id,
        provider_resource_record_id,
        assignment_target_type,
        assignment_target_id,
        assigned_at,
        updated_at
      `)
      .eq('id', phoneNumberId)
      .maybeSingle();

    if (phoneErr || !phoneRow) {
      return {
        success: false,
        code: 'NUMBER_NOT_FOUND',
        message: `Phone number ${phoneNumberId} was not found.`,
        phoneNumberId,
        organizationId,
        targetType,
        targetId,
        assignedAt: null,
        carrierResourceUnchanged: true,
        providerAccountUnchanged: true,
      };
    }

    if (phoneRow.organization_id !== organizationId) {
      return {
        success: false,
        code: 'CROSS_ORGANIZATION_FORBIDDEN',
        message: 'Phone number belongs to a different organization.',
        phoneNumberId,
        organizationId,
        targetType,
        targetId,
        assignedAt: null,
        carrierResourceUnchanged: true,
        providerAccountUnchanged: true,
      };
    }

    // 3. Lifecycle Interlocks (RELEASED, PORTED_OUT, RELEASE_PENDING, ACQUISITION_PENDING cannot be assigned)
    const lifecycleState = phoneRow.ownership_state || 'OWNED';
    if (
      lifecycleState === 'RELEASED' ||
      lifecycleState === 'PORTED_OUT' ||
      lifecycleState === 'RELEASE_PENDING' ||
      lifecycleState === 'ACQUISITION_PENDING'
    ) {
      return {
        success: false,
        code: 'NUMBER_LIFECYCLE_FORBIDS_ASSIGNMENT',
        message: `Cannot assign phone number in lifecycle state "${lifecycleState}".`,
        phoneNumberId,
        organizationId,
        targetType,
        targetId,
        assignedAt: null,
        carrierResourceUnchanged: true,
        providerAccountUnchanged: true,
      };
    }

    // 4. Authoritative Provider Resource Bridge Integrity Check
    const bridgeCheck = await this.verifyCarrierBridge(client, phoneRow, organizationId);
    if (!bridgeCheck.valid) {
      return {
        success: false,
        code: bridgeCheck.code,
        message: bridgeCheck.reason,
        phoneNumberId,
        organizationId,
        targetType,
        targetId,
        assignedAt: null,
        carrierResourceUnchanged: true,
        providerAccountUnchanged: true,
      };
    }

    // 5. Target Validation & Eligibility
    const targetCheck = await this.validateTargetEligibility(client, organizationId, targetType, targetId);
    if (!targetCheck.valid) {
      return {
        success: false,
        code: targetCheck.code,
        message: targetCheck.reason,
        phoneNumberId,
        organizationId,
        targetType,
        targetId,
        assignedAt: null,
        carrierResourceUnchanged: true,
        providerAccountUnchanged: true,
      };
    }

    // 6. Idempotency Check
    const currentTargetType = (phoneRow.assignment_target_type || 'UNASSIGNED_POOL') as AssignmentTargetType;
    const currentTargetId = phoneRow.assignment_target_id || null;
    if (currentTargetType === targetType && currentTargetId === targetId) {
      return {
        success: true,
        code: 'ASSIGNMENT_SUCCESS',
        message: 'Number is already assigned to the requested target (idempotent).',
        phoneNumberId,
        organizationId,
        targetType,
        targetId,
        assignedAt: phoneRow.assigned_at,
        previousTargetType: currentTargetType,
        previousTargetId: currentTargetId,
        carrierResourceUnchanged: true,
        providerAccountUnchanged: true,
      };
    }

    // 7. Optimistic Concurrency Control
    if (expectedVersion && phoneRow.updated_at !== expectedVersion) {
      return {
        success: false,
        code: 'CONCURRENT_MODIFICATION_CONFLICT',
        message: 'Phone number assignment was modified concurrently. Please reload and retry.',
        phoneNumberId,
        organizationId,
        targetType,
        targetId,
        assignedAt: null,
        carrierResourceUnchanged: true,
        providerAccountUnchanged: true,
      };
    }

    // 8. Atomically Update Canonical Assignment Fields
    const assignedAt = targetType === 'UNASSIGNED_POOL' ? null : new Date().toISOString();
    const nowIso = new Date().toISOString();

    const { error: updateErr } = await (client as any)
      .from('phone_numbers')
      .update({
        assignment_target_type: targetType,
        assignment_target_id: targetId,
        assigned_at: assignedAt,
        updated_at: nowIso,
      })
      .eq('id', phoneNumberId)
      .eq('organization_id', organizationId);

    if (updateErr) {
      return {
        success: false,
        code: 'CONCURRENT_MODIFICATION_CONFLICT',
        message: `Database error updating assignment: ${updateErr.message}`,
        phoneNumberId,
        organizationId,
        targetType,
        targetId,
        assignedAt: null,
        carrierResourceUnchanged: true,
        providerAccountUnchanged: true,
      };
    }

    // 9. Sync Compatibility Projection in user_phone_assignments
    await this.syncLegacyProjection(
      client,
      organizationId,
      phoneNumberId,
      currentTargetType,
      currentTargetId,
      targetType,
      targetId
    );

    // 10. Audit Trail in phone_number_lifecycle_events
    await this.recordAuditEvent(client, {
      phoneNumberId,
      organizationId,
      eventType: targetType === 'UNASSIGNED_POOL' ? 'UNASSIGNED' : 'ASSIGNED',
      actorId,
      details: {
        previous_target_type: currentTargetType,
        previous_target_id: currentTargetId,
        new_target_type: targetType,
        new_target_id: targetId,
      },
    });

    return {
      success: true,
      code: 'ASSIGNMENT_SUCCESS',
      message: `Number successfully assigned to ${targetType}.`,
      phoneNumberId,
      organizationId,
      targetType,
      targetId,
      assignedAt,
      previousTargetType: currentTargetType,
      previousTargetId: currentTargetId,
      carrierResourceUnchanged: true,
      providerAccountUnchanged: true,
    };
  }

  /**
   * Unassigns an organization-owned phone number (moves to UNASSIGNED_POOL).
   */
  static async unassignNumber(
    params: UnassignNumberParams,
    clientOverride?: SupabaseClient
  ): Promise<AssignmentResult> {
    return this.assignNumber(
      {
        phoneNumberId: params.phoneNumberId,
        organizationId: params.organizationId,
        targetType: 'UNASSIGNED_POOL',
        targetId: null,
        actorId: params.actorId,
        expectedVersion: params.expectedVersion,
      },
      clientOverride
    );
  }

  /**
   * Reassigns an organization-owned phone number from its current target to a new target.
   */
  static async reassignNumber(
    params: ReassignNumberParams,
    clientOverride?: SupabaseClient
  ): Promise<AssignmentResult> {
    return this.assignNumber(
      {
        phoneNumberId: params.phoneNumberId,
        organizationId: params.organizationId,
        targetType: params.newTargetType,
        targetId: params.newTargetId,
        actorId: params.actorId,
        expectedVersion: params.expectedVersion,
      },
      clientOverride
    );
  }

  /**
   * Resolves current assignment state for a phone number.
   */
  static async resolveAssignment(
    phoneNumberId: string,
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<AssignmentResult> {
    const client = clientOverride || createAdminClient();

    const { data: phoneRow, error: phoneErr } = await (client as any)
      .from('phone_numbers')
      .select('id, organization_id, assignment_target_type, assignment_target_id, assigned_at')
      .eq('id', phoneNumberId)
      .maybeSingle();

    if (phoneErr || !phoneRow) {
      return {
        success: false,
        code: 'NUMBER_NOT_FOUND',
        message: 'Phone number not found.',
        phoneNumberId,
        organizationId,
        targetType: 'UNASSIGNED_POOL',
        targetId: null,
        assignedAt: null,
        carrierResourceUnchanged: true,
        providerAccountUnchanged: true,
      };
    }

    if (phoneRow.organization_id !== organizationId) {
      return {
        success: false,
        code: 'CROSS_ORGANIZATION_FORBIDDEN',
        message: 'Phone number belongs to a different organization.',
        phoneNumberId,
        organizationId,
        targetType: 'UNASSIGNED_POOL',
        targetId: null,
        assignedAt: null,
        carrierResourceUnchanged: true,
        providerAccountUnchanged: true,
      };
    }

    const targetType = (phoneRow.assignment_target_type || 'UNASSIGNED_POOL') as AssignmentTargetType;
    return {
      success: true,
      code: 'ASSIGNMENT_SUCCESS',
      message: 'Assignment resolved.',
      phoneNumberId,
      organizationId,
      targetType,
      targetId: phoneRow.assignment_target_id || null,
      assignedAt: phoneRow.assigned_at,
      carrierResourceUnchanged: true,
      providerAccountUnchanged: true,
    };
  }

  /**
   * Lists all assignments for an organization.
   */
  static async listAssignments(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<NumberAssignmentDTO[]> {
    const client = clientOverride || createAdminClient();

    const { data: rows, error } = await (client as any)
      .from('phone_numbers')
      .select(`
        id,
        phone_number,
        organization_id,
        assignment_target_type,
        assignment_target_id,
        assigned_at,
        ownership_state,
        service_state
      `)
      .eq('organization_id', organizationId);

    if (error || !rows) {
      return [];
    }

    return rows.map((r: any) => ({
      phoneNumberId: r.id,
      phoneNumberE164: r.phone_number,
      organizationId: r.organization_id,
      targetType: (r.assignment_target_type || 'UNASSIGNED_POOL') as AssignmentTargetType,
      targetId: r.assignment_target_id || null,
      assignedAt: r.assigned_at,
      ownershipState: r.ownership_state || 'OWNED',
      serviceState: r.service_state || 'ACTIVE',
    }));
  }

  // --------------------------------------------------------------------------
  // Private Helper Methods
  // --------------------------------------------------------------------------

  private static async verifyActorPermission(
    client: SupabaseClient,
    actorId: string,
    organizationId: string
  ): Promise<{ allowed: boolean; reason: string }> {
    const { data: actorProfile } = await (client as any)
      .from('profiles')
      .select('id, organization_id, role, active')
      .eq('id', actorId)
      .maybeSingle();

    if (!actorProfile || actorProfile.active === false) {
      return { allowed: false, reason: 'Actor profile is inactive or not found.' };
    }

    if (actorProfile.organization_id !== organizationId) {
      return { allowed: false, reason: 'Actor does not belong to the target organization.' };
    }

    const role = (actorProfile.role || '').toLowerCase();
    if (!['owner', 'admin'].includes(role)) {
      return {
        allowed: false,
        reason: 'Only workspace Owners or Admins are authorized to mutate phone number assignments.',
      };
    }

    return { allowed: true, reason: 'Actor authorized.' };
  }

  private static async verifyCarrierBridge(
    client: SupabaseClient,
    phoneRow: any,
    organizationId: string
  ): Promise<{ valid: boolean; code: any; reason: string }> {
    // 1. Authoritative Carrier Bridge lookup
    const { data: carrierRec } = await (client as any)
      .from('telecom_provider_resource_records')
      .select('id, organization_id, provider_account_id, status')
      .eq('domain_phone_number_id', phoneRow.id)
      .maybeSingle();

    if (!carrierRec) {
      return {
        valid: false,
        code: 'PROVIDER_RESOURCE_MISSING',
        reason: 'Authoritative carrier resource record is missing for this phone number.',
      };
    }

    if (carrierRec.organization_id !== organizationId) {
      return {
        valid: false,
        code: 'CROSS_ORGANIZATION_FORBIDDEN',
        reason: 'Authoritative carrier resource belongs to a different organization.',
      };
    }

    // 2. Denormalized reference consistency check
    if (phoneRow.provider_resource_record_id && phoneRow.provider_resource_record_id !== carrierRec.id) {
      return {
        valid: false,
        code: 'PROVIDER_RESOURCE_INCONSISTENT',
        reason: 'Phone number denormalized provider_resource_record_id does not match carrier bridge.',
      };
    }

    // 3. Provider Account Subaccount Verification
    const { data: accountRow } = await (client as any)
      .from('telecom_provider_accounts')
      .select('id, organization_id, account_purpose, status')
      .eq('id', carrierRec.provider_account_id)
      .maybeSingle();

    if (!accountRow) {
      return {
        valid: false,
        code: 'PROVIDER_ACCOUNT_MISMATCH',
        reason: 'Provider account associated with carrier resource does not exist.',
      };
    }

    if (accountRow.organization_id !== organizationId) {
      return {
        valid: false,
        code: 'CROSS_ORGANIZATION_FORBIDDEN',
        reason: 'Provider account belongs to a different organization.',
      };
    }

    if (accountRow.account_purpose !== 'CUSTOMER_SUBACCOUNT') {
      return {
        valid: false,
        code: 'CUSTOMER_SUBACCOUNT_REQUIRED',
        reason: 'Customer phone numbers cannot be bound to SHARED_PARENT accounts.',
      };
    }

    return { valid: true, code: 'ASSIGNMENT_SUCCESS', reason: 'Carrier bridge verified.' };
  }

  private static async validateTargetEligibility(
    client: SupabaseClient,
    organizationId: string,
    targetType: AssignmentTargetType,
    targetId: string | null
  ): Promise<{ valid: boolean; code: any; reason: string }> {
    switch (targetType) {
      case 'UNASSIGNED_POOL':
      case 'WORKSPACE_MAIN':
        // No specific entity ID required
        return { valid: true, code: 'ASSIGNMENT_SUCCESS', reason: 'Target eligible.' };

      case 'USER': {
        if (!targetId) {
          return { valid: false, code: 'ASSIGNMENT_TARGET_NOT_FOUND', reason: 'Target user ID is required for USER assignment.' };
        }
        const { data: profile } = await (client as any)
          .from('profiles')
          .select('id, organization_id, active')
          .eq('id', targetId)
          .maybeSingle();

        if (!profile) {
          return { valid: false, code: 'ASSIGNMENT_TARGET_NOT_FOUND', reason: `Target user ${targetId} was not found.` };
        }
        if (profile.organization_id !== organizationId) {
          return { valid: false, code: 'ASSIGNMENT_TARGET_ORGANIZATION_MISMATCH', reason: 'Target user belongs to another organization.' };
        }
        if (profile.active === false) {
          return { valid: false, code: 'ASSIGNMENT_TARGET_INACTIVE', reason: 'Target user is deactivated.' };
        }
        return { valid: true, code: 'ASSIGNMENT_SUCCESS', reason: 'Target user eligible.' };
      }

      case 'QUEUE': {
        if (!targetId) {
          return { valid: false, code: 'ASSIGNMENT_TARGET_NOT_FOUND', reason: 'Target queue ID is required for QUEUE assignment.' };
        }
        const { data: queue } = await (client as any)
          .from('call_queues')
          .select('id, organization_id, enabled')
          .eq('id', targetId)
          .maybeSingle();

        if (!queue) {
          return { valid: false, code: 'ASSIGNMENT_TARGET_NOT_FOUND', reason: `Target call queue ${targetId} was not found.` };
        }
        if (queue.organization_id !== organizationId) {
          return { valid: false, code: 'ASSIGNMENT_TARGET_ORGANIZATION_MISMATCH', reason: 'Target call queue belongs to another organization.' };
        }
        if (queue.enabled === false) {
          return { valid: false, code: 'ASSIGNMENT_TARGET_INACTIVE', reason: 'Target call queue is disabled.' };
        }
        return { valid: true, code: 'ASSIGNMENT_SUCCESS', reason: 'Target queue eligible.' };
      }

      case 'IVR': {
        if (!targetId) {
          return { valid: false, code: 'ASSIGNMENT_TARGET_NOT_FOUND', reason: 'Target IVR menu ID is required for IVR assignment.' };
        }
        const { data: ivrMenu } = await (client as any)
          .from('ivr_menus')
          .select('id, organization_id, enabled')
          .eq('id', targetId)
          .maybeSingle();

        if (!ivrMenu) {
          return { valid: false, code: 'ASSIGNMENT_TARGET_NOT_FOUND', reason: `Target IVR menu ${targetId} was not found.` };
        }
        if (ivrMenu.organization_id !== organizationId) {
          return { valid: false, code: 'ASSIGNMENT_TARGET_ORGANIZATION_MISMATCH', reason: 'Target IVR menu belongs to another organization.' };
        }
        if (ivrMenu.enabled === false) {
          return { valid: false, code: 'ASSIGNMENT_TARGET_INACTIVE', reason: 'Target IVR menu is disabled.' };
        }
        return { valid: true, code: 'ASSIGNMENT_SUCCESS', reason: 'Target IVR menu eligible.' };
      }

      case 'VOICEMAIL': {
        if (targetId) {
          const { data: profile } = await (client as any)
            .from('profiles')
            .select('id, organization_id')
            .eq('id', targetId)
            .maybeSingle();
          if (profile && profile.organization_id !== organizationId) {
            return { valid: false, code: 'ASSIGNMENT_TARGET_ORGANIZATION_MISMATCH', reason: 'Target voicemail box belongs to another organization.' };
          }
        }
        return { valid: true, code: 'ASSIGNMENT_SUCCESS', reason: 'Voicemail target eligible.' };
      }

      case 'TEAM':
        return {
          valid: false,
          code: 'UNSUPPORTED_ASSIGNMENT_TARGET_TYPE',
          reason: 'TEAM assignment target type is not yet supported in current schema.',
        };

      default:
        return {
          valid: false,
          code: 'UNSUPPORTED_ASSIGNMENT_TARGET_TYPE',
          reason: `Unknown assignment target type: ${targetType}`,
        };
    }
  }

  private static async syncLegacyProjection(
    client: SupabaseClient,
    organizationId: string,
    phoneNumberId: string,
    previousTargetType: AssignmentTargetType | null,
    previousTargetId: string | null,
    newTargetType: AssignmentTargetType,
    newTargetId: string | null
  ): Promise<void> {
    try {
      // 1. If previously assigned to a USER, remove old mapping if changed
      if (previousTargetType === 'USER' && previousTargetId) {
        if (newTargetType !== 'USER' || newTargetId !== previousTargetId) {
          await (client as any)
            .from('user_phone_assignments')
            .delete()
            .eq('phone_number_id', phoneNumberId)
            .eq('organization_id', organizationId)
            .eq('user_id', previousTargetId);
        }
      }

      // 2. If new target is a USER, ensure user_phone_assignments row exists
      if (newTargetType === 'USER' && newTargetId) {
        await (client as any)
          .from('user_phone_assignments')
          .upsert(
            {
              organization_id: organizationId,
              user_id: newTargetId,
              phone_number_id: phoneNumberId,
            },
            { onConflict: 'user_id, phone_number_id' }
          );
      }

      // 3. If new target is UNASSIGNED_POOL, purge any remaining user assignments for this number
      if (newTargetType === 'UNASSIGNED_POOL') {
        await (client as any)
          .from('user_phone_assignments')
          .delete()
          .eq('phone_number_id', phoneNumberId)
          .eq('organization_id', organizationId);
      }
    } catch (err: any) {
      console.warn('[NumberAssignmentService] Error syncing user_phone_assignments projection:', err.message || err);
    }
  }

  private static async recordAuditEvent(
    client: SupabaseClient,
    event: {
      phoneNumberId: string;
      organizationId: string;
      eventType: string;
      actorId?: string;
      details: Record<string, any>;
    }
  ): Promise<void> {
    try {
      await (client as any)
        .from('phone_number_lifecycle_events')
        .insert({
          organization_id: event.organizationId,
          phone_number_id: event.phoneNumberId,
          event_type: event.eventType,
          actor_id: event.actorId || null,
          details: event.details,
        });
    } catch (err: any) {
      console.warn('[NumberAssignmentService] Error recording assignment audit event:', err.message || err);
    }
  }
}
