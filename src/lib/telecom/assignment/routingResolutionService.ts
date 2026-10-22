import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import type {
  AssignmentTargetType,
  ResolveInboundRouteParams,
  InboundRoutingResolutionResult,
} from './types';

export class RoutingResolutionService {
  /**
   * Resolves the canonical inbound routing destination for an incoming call or message.
   */
  static async resolveInboundRoute(
    params: ResolveInboundRouteParams,
    clientOverride?: SupabaseClient
  ): Promise<InboundRoutingResolutionResult> {
    const client = clientOverride || createAdminClient();
    const { organizationId, phoneNumberId, phoneNumberE164, channel } = params;

    // 1. Locate phone number by ID or E.164
    let query = (client as any)
      .from('phone_numbers')
      .select(`
        id,
        phone_number,
        organization_id,
        active,
        status,
        ownership_state,
        service_state,
        is_suspended,
        assignment_target_type,
        assignment_target_id,
        assigned_at
      `);

    if (phoneNumberId) {
      query = query.eq('id', phoneNumberId);
    } else if (phoneNumberE164) {
      query = query.eq('phone_number', phoneNumberE164);
    } else {
      return {
        resolved: false,
        code: 'NUMBER_NOT_FOUND',
        reason: 'Either phoneNumberId or phoneNumberE164 must be provided.',
        phoneNumberId: '',
        organizationId,
        channel,
        targetType: 'UNASSIGNED_POOL',
        targetId: null,
        unassignedAction: 'UNAVAILABLE_GREETING',
      };
    }

    const { data: phoneRow, error: phoneErr } = await query.maybeSingle();

    if (phoneErr || !phoneRow) {
      return {
        resolved: false,
        code: 'NUMBER_NOT_FOUND',
        reason: 'Phone number not found in directory.',
        phoneNumberId: phoneNumberId || '',
        organizationId,
        channel,
        targetType: 'UNASSIGNED_POOL',
        targetId: null,
        unassignedAction: 'UNAVAILABLE_GREETING',
      };
    }

    // 2. Tenant Isolation Check
    if (phoneRow.organization_id !== organizationId) {
      return {
        resolved: false,
        code: 'CROSS_ORGANIZATION_FORBIDDEN',
        reason: 'Destination phone number belongs to another organization.',
        phoneNumberId: phoneRow.id,
        organizationId,
        channel,
        targetType: 'UNASSIGNED_POOL',
        targetId: null,
        unassignedAction: 'BUSY',
      };
    }

    // 3. Service Lifecycle & Suspension Gates
    const serviceState = phoneRow.service_state || (phoneRow.is_suspended ? 'SUSPENDED' : 'ACTIVE');
    if (serviceState === 'SUSPENDED') {
      return {
        resolved: false,
        code: 'NUMBER_SUSPENDED',
        reason: 'Phone number service is currently suspended.',
        phoneNumberId: phoneRow.id,
        organizationId,
        channel,
        targetType: (phoneRow.assignment_target_type || 'UNASSIGNED_POOL') as AssignmentTargetType,
        targetId: phoneRow.assignment_target_id || null,
        unassignedAction: 'BUSY',
      };
    }

    const ownershipState = phoneRow.ownership_state || 'OWNED';
    if (ownershipState === 'RELEASED') {
      return {
        resolved: false,
        code: 'NUMBER_RELEASED',
        reason: 'Phone number has been released and is no longer owned.',
        phoneNumberId: phoneRow.id,
        organizationId,
        channel,
        targetType: 'UNASSIGNED_POOL',
        targetId: null,
        unassignedAction: 'BUSY',
      };
    }

    if (ownershipState === 'PORTED_OUT') {
      return {
        resolved: false,
        code: 'NUMBER_PORTED_OUT',
        reason: 'Phone number has been ported out to another carrier.',
        phoneNumberId: phoneRow.id,
        organizationId,
        channel,
        targetType: 'UNASSIGNED_POOL',
        targetId: null,
        unassignedAction: 'BUSY',
      };
    }

    // 4. Resolve Canonical Assignment Target
    const targetType = (phoneRow.assignment_target_type || 'UNASSIGNED_POOL') as AssignmentTargetType;
    const targetId = phoneRow.assignment_target_id || null;

    switch (targetType) {
      case 'USER': {
        if (!targetId) {
          return {
            resolved: false,
            code: 'ASSIGNMENT_TARGET_NOT_FOUND',
            reason: 'User assignment is missing target user ID.',
            phoneNumberId: phoneRow.id,
            organizationId,
            channel,
            targetType: 'USER',
            targetId: null,
            unassignedAction: 'UNAVAILABLE_GREETING',
          };
        }

        const { data: userProfile } = await (client as any)
          .from('profiles')
          .select('id, full_name, email, twilio_identity, active, organization_id')
          .eq('id', targetId)
          .maybeSingle();

        if (!userProfile) {
          return {
            resolved: false,
            code: 'ASSIGNMENT_TARGET_NOT_FOUND',
            reason: `Assigned user ${targetId} no longer exists.`,
            phoneNumberId: phoneRow.id,
            organizationId,
            channel,
            targetType: 'USER',
            targetId,
            unassignedAction: 'UNAVAILABLE_GREETING',
          };
        }

        if (userProfile.organization_id !== organizationId) {
          return {
            resolved: false,
            code: 'ASSIGNMENT_TARGET_ORGANIZATION_MISMATCH',
            reason: 'Assigned user belongs to a different organization.',
            phoneNumberId: phoneRow.id,
            organizationId,
            channel,
            targetType: 'USER',
            targetId,
            unassignedAction: 'UNAVAILABLE_GREETING',
          };
        }

        if (userProfile.active === false) {
          return {
            resolved: false,
            code: 'ASSIGNMENT_TARGET_INACTIVE',
            reason: `Assigned user ${userProfile.full_name || targetId} is currently deactivated.`,
            phoneNumberId: phoneRow.id,
            organizationId,
            channel,
            targetType: 'USER',
            targetId,
            unassignedAction: 'UNAVAILABLE_GREETING',
          };
        }

        return {
          resolved: true,
          code: 'ASSIGNMENT_SUCCESS',
          reason: `Resolved to direct user client (${userProfile.full_name}).`,
          phoneNumberId: phoneRow.id,
          organizationId,
          channel,
          targetType: 'USER',
          targetId: userProfile.id,
          targetDetails: {
            user: {
              id: userProfile.id,
              fullName: userProfile.full_name,
              email: userProfile.email,
              twilioIdentity: userProfile.twilio_identity,
              active: userProfile.active,
            },
          },
          unassignedAction: 'UNAVAILABLE_GREETING',
        };
      }

      case 'QUEUE': {
        if (!targetId) {
          return {
            resolved: false,
            code: 'ASSIGNMENT_TARGET_NOT_FOUND',
            reason: 'Queue assignment is missing target queue ID.',
            phoneNumberId: phoneRow.id,
            organizationId,
            channel,
            targetType: 'QUEUE',
            targetId: null,
            unassignedAction: 'UNAVAILABLE_GREETING',
          };
        }

        const { data: queue } = await (client as any)
          .from('call_queues')
          .select('id, name, enabled, strategy, organization_id')
          .eq('id', targetId)
          .maybeSingle();

        if (!queue) {
          return {
            resolved: false,
            code: 'ASSIGNMENT_TARGET_NOT_FOUND',
            reason: `Assigned call queue ${targetId} no longer exists.`,
            phoneNumberId: phoneRow.id,
            organizationId,
            channel,
            targetType: 'QUEUE',
            targetId,
            unassignedAction: 'UNAVAILABLE_GREETING',
          };
        }

        if (queue.organization_id !== organizationId) {
          return {
            resolved: false,
            code: 'ASSIGNMENT_TARGET_ORGANIZATION_MISMATCH',
            reason: 'Assigned call queue belongs to another organization.',
            phoneNumberId: phoneRow.id,
            organizationId,
            channel,
            targetType: 'QUEUE',
            targetId,
            unassignedAction: 'UNAVAILABLE_GREETING',
          };
        }

        if (queue.enabled === false) {
          return {
            resolved: false,
            code: 'ASSIGNMENT_TARGET_INACTIVE',
            reason: `Assigned call queue "${queue.name}" is disabled.`,
            phoneNumberId: phoneRow.id,
            organizationId,
            channel,
            targetType: 'QUEUE',
            targetId,
            unassignedAction: 'UNAVAILABLE_GREETING',
          };
        }

        return {
          resolved: true,
          code: 'ASSIGNMENT_SUCCESS',
          reason: `Resolved to call queue "${queue.name}".`,
          phoneNumberId: phoneRow.id,
          organizationId,
          channel,
          targetType: 'QUEUE',
          targetId: queue.id,
          targetDetails: {
            queue: {
              id: queue.id,
              name: queue.name,
              enabled: queue.enabled,
              strategy: queue.strategy,
            },
          },
          unassignedAction: 'UNAVAILABLE_GREETING',
        };
      }

      case 'IVR': {
        if (!targetId) {
          return {
            resolved: false,
            code: 'ASSIGNMENT_TARGET_NOT_FOUND',
            reason: 'IVR assignment is missing target menu ID.',
            phoneNumberId: phoneRow.id,
            organizationId,
            channel,
            targetType: 'IVR',
            targetId: null,
            unassignedAction: 'UNAVAILABLE_GREETING',
          };
        }

        const { data: ivrMenu } = await (client as any)
          .from('ivr_menus')
          .select('id, name, enabled, organization_id')
          .eq('id', targetId)
          .maybeSingle();

        if (!ivrMenu) {
          return {
            resolved: false,
            code: 'ASSIGNMENT_TARGET_NOT_FOUND',
            reason: `Assigned IVR menu ${targetId} no longer exists.`,
            phoneNumberId: phoneRow.id,
            organizationId,
            channel,
            targetType: 'IVR',
            targetId,
            unassignedAction: 'UNAVAILABLE_GREETING',
          };
        }

        if (ivrMenu.organization_id !== organizationId) {
          return {
            resolved: false,
            code: 'ASSIGNMENT_TARGET_ORGANIZATION_MISMATCH',
            reason: 'Assigned IVR menu belongs to another organization.',
            phoneNumberId: phoneRow.id,
            organizationId,
            channel,
            targetType: 'IVR',
            targetId,
            unassignedAction: 'UNAVAILABLE_GREETING',
          };
        }

        if (ivrMenu.enabled === false) {
          return {
            resolved: false,
            code: 'ASSIGNMENT_TARGET_INACTIVE',
            reason: `Assigned IVR menu "${ivrMenu.name}" is disabled.`,
            phoneNumberId: phoneRow.id,
            organizationId,
            channel,
            targetType: 'IVR',
            targetId,
            unassignedAction: 'UNAVAILABLE_GREETING',
          };
        }

        return {
          resolved: true,
          code: 'ASSIGNMENT_SUCCESS',
          reason: `Resolved to IVR menu "${ivrMenu.name}".`,
          phoneNumberId: phoneRow.id,
          organizationId,
          channel,
          targetType: 'IVR',
          targetId: ivrMenu.id,
          targetDetails: {
            ivrMenu: {
              id: ivrMenu.id,
              name: ivrMenu.name,
              enabled: ivrMenu.enabled,
            },
          },
          unassignedAction: 'UNAVAILABLE_GREETING',
        };
      }

      case 'WORKSPACE_MAIN':
        return {
          resolved: true,
          code: 'ASSIGNMENT_SUCCESS',
          reason: 'Resolved to workspace main line (rings available organization agents).',
          phoneNumberId: phoneRow.id,
          organizationId,
          channel,
          targetType: 'WORKSPACE_MAIN',
          targetId: null,
          unassignedAction: 'UNAVAILABLE_GREETING',
        };

      case 'VOICEMAIL':
        return {
          resolved: true,
          code: 'ASSIGNMENT_SUCCESS',
          reason: 'Resolved directly to organization voicemail.',
          phoneNumberId: phoneRow.id,
          organizationId,
          channel,
          targetType: 'VOICEMAIL',
          targetId,
          unassignedAction: 'VOICEMAIL',
        };

      case 'UNASSIGNED_POOL':
      default:
        return {
          resolved: false,
          code: 'UNASSIGNED_ROUTE',
          reason: 'Phone number is in the company unassigned pool.',
          phoneNumberId: phoneRow.id,
          organizationId,
          channel,
          targetType: 'UNASSIGNED_POOL',
          targetId: null,
          unassignedAction: 'UNAVAILABLE_GREETING',
        };
    }
  }
}
