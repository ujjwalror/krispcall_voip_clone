/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import crypto from 'crypto';
import type { BackfillPlanItem } from './types';

export const PROTECTED_PILOT_E164 = '+61348328472';
export const PROTECTED_PILOT_SID = 'PN832a10dec98cbb48d02033a83afecff3';
export const PROTECTED_PILOT_UUID = '03edd0bc-b025-49e6-8171-a0c2fcd6cb78';
export const PROTECTED_PILOT_ORG_ID = '00000000-0000-0000-0000-000000000001';

export interface RawLegacyRecordContext {
  phoneNumberRow: any;
  lifecycleStateRow?: any;
  providerMappingRow?: any;
  providerResourceRow?: any;
  providerAccountRow?: any;
  userAssignments?: any[];
  allActiveNumbersWithSameE164?: any[];
  allActiveNumbersWithSameSid?: any[];
  ivrExists?: boolean;
  userExists?: boolean;
  userOrgId?: string;
  activePortOp?: any;
}

export class BackfillClassifier {
  /**
   * Generates a deterministic hash of the source evidence to detect
   * SOURCE_CHANGED_SINCE_PLAN during atomic application.
   */
  static computeSourceVersionHash(phoneRow: Record<string, unknown>): string {
    const raw = [
      phoneRow?.phone_number || '',
      phoneRow?.status || '',
      String(phoneRow?.active ?? ''),
      String(phoneRow?.capabilities_voice ?? ''),
      String(phoneRow?.capabilities_sms ?? ''),
      phoneRow?.inbound_routing_type || '',
      String(phoneRow?.inbound_routing_destination_id || ''),
    ].join(':');

    return crypto.createHash('md5').update(raw).digest('hex');
  }

  /**
   * Classifies a legacy phone number record against Phase 23 canonical truth.
   */
  static classifyRecord(ctx: RawLegacyRecordContext): BackfillPlanItem {
    const phone = ctx.phoneNumberRow;
    const e164 = String(phone.phone_number || phone.phone_number_e164 || '');
    const orgId = String(phone.organization_id || '');
    const sourceHash = this.computeSourceVersionHash(phone);

    // 1. Task 15: Protected Australian Pilot Quarantine Guard
    if (
      e164 === PROTECTED_PILOT_E164 ||
      phone.id === PROTECTED_PILOT_UUID ||
      ctx.providerMappingRow?.provider_phone_number_sid === PROTECTED_PILOT_SID ||
      ctx.providerResourceRow?.remote_resource_id === PROTECTED_PILOT_SID ||
      orgId === PROTECTED_PILOT_ORG_ID
    ) {
      return {
        organizationId: orgId,
        phoneNumberId: phone.id,
        phoneNumberE164: e164,
        sourceEvidence: { phone, mapping: ctx.providerMappingRow, resource: ctx.providerResourceRow },
        targetCanonicalState: {
          ownership_state: 'OWNED',
          service_state: 'ACTIVE',
          porting_state: 'NONE',
          compliance_state: 'APPROVED',
          port_out_locked: true,
        },
        classification: 'PROTECTED_RESOURCE_DO_NOT_TOUCH',
        confidenceScore: 1.0,
        evidenceReason: 'PROTECTED_PILOT_QUARANTINE: Australian pilot number (+61348328472) must not be mutated or reconfigured.',
        plannedAction: 'QUARANTINE_NO_OP',
        status: 'PLANNED',
        sourceVersionHash: sourceHash,
      };
    }

    // 2. Task 46: Duplicate Active E.164 Conflict
    if (ctx.allActiveNumbersWithSameE164 && ctx.allActiveNumbersWithSameE164.length > 1) {
      return {
        organizationId: orgId,
        phoneNumberId: phone.id,
        phoneNumberE164: e164,
        sourceEvidence: { duplicates: ctx.allActiveNumbersWithSameE164 },
        targetCanonicalState: {},
        classification: 'REQUIRES_OPERATOR_REVIEW',
        confidenceScore: 0.0,
        evidenceReason: `DUPLICATE_ACTIVE_E164: Multiple local records (${ctx.allActiveNumbersWithSameE164.length}) claim active status for ${e164}.`,
        plannedAction: 'MANUAL_REVIEW',
        status: 'PLANNED',
        sourceVersionHash: sourceHash,
      };
    }

    // 3. Task 45: Duplicate Provider SID Conflict
    if (ctx.allActiveNumbersWithSameSid && ctx.allActiveNumbersWithSameSid.length > 1) {
      return {
        organizationId: orgId,
        phoneNumberId: phone.id,
        phoneNumberE164: e164,
        sourceEvidence: { duplicates: ctx.allActiveNumbersWithSameSid },
        targetCanonicalState: {},
        classification: 'REQUIRES_OPERATOR_REVIEW',
        confidenceScore: 0.0,
        evidenceReason: `DUPLICATE_PROVIDER_SID: Same remote carrier resource mapped to multiple local phone records.`,
        plannedAction: 'MANUAL_REVIEW',
        status: 'PLANNED',
        sourceVersionHash: sourceHash,
      };
    }

    // 4. Task 5: CUSTOMER_SUBACCOUNT Verification & Shared Parent Rejection
    const providerAccount = ctx.providerAccountRow;
    if (providerAccount && (providerAccount.account_type === 'SHARED_PARENT' || providerAccount.is_shared_parent === true)) {
      return {
        organizationId: orgId,
        phoneNumberId: phone.id,
        phoneNumberE164: e164,
        sourceEvidence: { providerAccount },
        targetCanonicalState: {},
        classification: 'REQUIRES_OPERATOR_REVIEW',
        confidenceScore: 0.0,
        evidenceReason: 'SHARED_PARENT_REJECTED: Customer runtime phone numbers cannot be bound to SHARED_PARENT accounts. Subaccount provisioning required.',
        plannedAction: 'MANUAL_REVIEW',
        status: 'PLANNED',
        sourceVersionHash: sourceHash,
      };
    }

    // 5. Task 44: Cross-Tenant Resource Ownership Conflict
    if (providerAccount && providerAccount.organization_id && providerAccount.organization_id !== orgId) {
      return {
        organizationId: orgId,
        phoneNumberId: phone.id,
        phoneNumberE164: e164,
        sourceEvidence: { phoneOrg: orgId, providerAccountOrg: providerAccount.organization_id },
        targetCanonicalState: {},
        classification: 'REQUIRES_OPERATOR_REVIEW',
        confidenceScore: 0.0,
        evidenceReason: `CROSS_TENANT_CONFLICT: Provider account belongs to organization ${providerAccount.organization_id}, mismatching phone organization ${orgId}.`,
        plannedAction: 'MANUAL_REVIEW',
        status: 'PLANNED',
        sourceVersionHash: sourceHash,
      };
    }

    // 6. Task 4 & 48: Provider Resource Evidence Check
    const remoteSid = ctx.providerResourceRow?.remote_resource_id || ctx.providerMappingRow?.provider_phone_number_sid;
    if (!remoteSid && (phone.status === 'active' || phone.active === true)) {
      return {
        organizationId: orgId,
        phoneNumberId: phone.id,
        phoneNumberE164: e164,
        sourceEvidence: { phone },
        targetCanonicalState: {},
        classification: 'REQUIRES_PROVIDER_RECONCILIATION',
        confidenceScore: 0.2,
        evidenceReason: 'ORPHAN_PHONE_MISSING_PROVIDER_RESOURCE: Active phone record lacks carrier SID evidence in provider tables.',
        plannedAction: 'PROVIDER_RECONCILE',
        status: 'PLANNED',
        sourceVersionHash: sourceHash,
      };
    }

    // 7. Task 6 & 7: Canonical Lifecycle & Orthogonal Service State Reconciler
    let targetOwnership = 'OWNED';
    let targetService = 'ACTIVE';

    const legacyStatus = (phone.status || '').toLowerCase();
    const lifecycleState = (ctx.lifecycleStateRow?.lifecycle_state || '').toLowerCase();

    if (legacyStatus === 'released' || lifecycleState === 'released') {
      targetOwnership = 'RELEASED';
      targetService = 'UNAVAILABLE';
    } else if (legacyStatus === 'ported_out' || lifecycleState === 'ported_out') {
      targetOwnership = 'PORTED_OUT';
      targetService = 'UNAVAILABLE';
    } else if (legacyStatus === 'pending_release' || lifecycleState === 'pending_release') {
      targetOwnership = 'RELEASE_PENDING';
      targetService = 'SUSPENDED';
    } else if (legacyStatus === 'suspended' || lifecycleState === 'suspended') {
      targetOwnership = 'OWNED';
      targetService = 'SUSPENDED';
    } else if (legacyStatus === 'active' || lifecycleState === 'active') {
      targetOwnership = 'OWNED';
      targetService = phone.active === false ? 'SUSPENDED' : 'ACTIVE';
    } else {
      // Ambiguous legacy status
      return {
        organizationId: orgId,
        phoneNumberId: phone.id,
        phoneNumberE164: e164,
        sourceEvidence: { legacyStatus, lifecycleState },
        targetCanonicalState: {},
        classification: 'CANNOT_SAFELY_INFER',
        confidenceScore: 0.1,
        evidenceReason: `AMBIGUOUS_LIFECYCLE_STATUS: Unrecognized combination (status='${legacyStatus}', lifecycle_state='${lifecycleState}').`,
        plannedAction: 'MANUAL_REVIEW',
        status: 'PLANNED',
        sourceVersionHash: sourceHash,
      };
    }

    // 8. Task 9: Assignment Backfill & Conflict Check
    let targetAssignmentType = 'UNASSIGNED_POOL';
    let targetAssignmentId: string | null = null;

    const userAssignments = ctx.userAssignments || [];
    if (userAssignments.length > 1) {
      return {
        organizationId: orgId,
        phoneNumberId: phone.id,
        phoneNumberE164: e164,
        sourceEvidence: { userAssignments },
        targetCanonicalState: {},
        classification: 'REQUIRES_OPERATOR_REVIEW',
        confidenceScore: 0.0,
        evidenceReason: `CONFLICTING_ASSIGNMENT: Multiple active user assignments (${userAssignments.length}) found for single number.`,
        plannedAction: 'MANUAL_REVIEW',
        status: 'PLANNED',
        sourceVersionHash: sourceHash,
      };
    }

    if (userAssignments.length === 1) {
      const singleAssign = userAssignments[0];
      if (ctx.userExists === false) {
        return {
          organizationId: orgId,
          phoneNumberId: phone.id,
          phoneNumberE164: e164,
          sourceEvidence: { deletedUserAssignment: singleAssign },
          targetCanonicalState: {},
          classification: 'REQUIRES_OPERATOR_REVIEW',
          confidenceScore: 0.0,
          evidenceReason: `DELETED_ASSIGNEE_TARGET: Assigned user ${singleAssign.user_id} no longer exists in profiles.`,
          plannedAction: 'MANUAL_REVIEW',
          status: 'PLANNED',
          sourceVersionHash: sourceHash,
        };
      }

      if (ctx.userOrgId && ctx.userOrgId !== orgId) {
        return {
          organizationId: orgId,
          phoneNumberId: phone.id,
          phoneNumberE164: e164,
          sourceEvidence: { crossTenantAssignee: singleAssign, userOrgId: ctx.userOrgId },
          targetCanonicalState: {},
          classification: 'REQUIRES_OPERATOR_REVIEW',
          confidenceScore: 0.0,
          evidenceReason: `CROSS_TENANT_ASSIGNEE: Assigned user belongs to organization ${ctx.userOrgId}, mismatching phone organization ${orgId}.`,
          plannedAction: 'MANUAL_REVIEW',
          status: 'PLANNED',
          sourceVersionHash: sourceHash,
        };
      }

      targetAssignmentType = 'USER';
      targetAssignmentId = singleAssign.user_id;
    } else if (phone.inbound_routing_type) {
      const routingType = phone.inbound_routing_type.toLowerCase();
      if (routingType === 'ivr') {
        if (ctx.ivrExists === false) {
          return {
            organizationId: orgId,
            phoneNumberId: phone.id,
            phoneNumberE164: e164,
            sourceEvidence: { missingIvrId: phone.inbound_routing_destination_id },
            targetCanonicalState: {},
            classification: 'REQUIRES_OPERATOR_REVIEW',
            confidenceScore: 0.0,
            evidenceReason: `INVALID_IVR_ROUTING_TARGET: Configured IVR menu ${phone.inbound_routing_destination_id} does not exist.`,
            plannedAction: 'MANUAL_REVIEW',
            status: 'PLANNED',
            sourceVersionHash: sourceHash,
          };
        }
        targetAssignmentType = 'IVR';
        targetAssignmentId = phone.inbound_routing_destination_id || null;
      } else if (routingType === 'call_queue' || routingType === 'queue') {
        targetAssignmentType = 'QUEUE';
        targetAssignmentId = phone.inbound_routing_destination_id || null;
      } else if (routingType === 'voicemail') {
        targetAssignmentType = 'VOICEMAIL';
        targetAssignmentId = phone.inbound_routing_destination_id || null;
      } else if (routingType === 'user' && phone.inbound_routing_destination_id) {
        targetAssignmentType = 'USER';
        targetAssignmentId = phone.inbound_routing_destination_id;
      }
    }

    // 9. Task 8: Staged Capability Progression
    // Legacy booleans are evidence; they do not automatically grant USABLE.
    const isCarrierActive = targetOwnership === 'OWNED' && targetService === 'ACTIVE';
    const voiceUsable = isCarrierActive && Boolean(phone.capabilities_voice ?? true);
    const smsUsable = isCarrierActive && Boolean(phone.capabilities_sms ?? true);

    const capabilitiesState = {
      VOICE_INBOUND: { stage: voiceUsable ? 'USABLE' : 'SUSPENDED' },
      VOICE_OUTBOUND: { stage: voiceUsable ? 'USABLE' : 'SUSPENDED' },
      SMS_INBOUND: { stage: smsUsable ? 'USABLE' : 'SUSPENDED' },
      SMS_OUTBOUND: { stage: smsUsable ? 'USABLE' : 'SUSPENDED' },
    };

    // 10. Task 11: In-flight Porting Interlock Check
    let portingState = 'NONE';
    if (ctx.activePortOp) {
      portingState = ctx.activePortOp.direction === 'port_in' ? 'PORT_IN_PENDING' : 'PORT_OUT_REQUESTED';
    }

    return {
      organizationId: orgId,
      phoneNumberId: phone.id,
      phoneNumberE164: e164,
      sourceEvidence: {
        phone,
        mapping: ctx.providerMappingRow,
        resource: ctx.providerResourceRow,
        account: ctx.providerAccountRow,
      },
      targetCanonicalState: {
        ownership_state: targetOwnership,
        service_state: targetService,
        capabilities_state: capabilitiesState,
        assignment_target_type: targetAssignmentType,
        assignment_target_id: targetAssignmentId,
        provider_account_id: providerAccount?.id || null,
        provider_resource_record_id: ctx.providerResourceRow?.id || null,
        remote_resource_id: remoteSid || null,
        compliance_state: phone.compliance_state || 'NOT_REQUIRED',
        porting_state: portingState,
        port_out_locked: phone.port_out_locked ?? true,
      },
      classification: 'DETERMINISTIC_FROM_LOCAL_DATA',
      confidenceScore: 0.95,
      evidenceReason: 'Complete deterministic local evidence reconciled from legacy tables.',
      plannedAction: 'UPDATE_CANONICAL',
      status: 'PLANNED',
      sourceVersionHash: sourceHash,
    };
  }
}
