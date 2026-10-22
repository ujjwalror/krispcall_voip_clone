/**
 * Phase 23D.5 — Canonical Phone Number Assignment & Routing Types
 *
 * Fundamental Invariants:
 * - OWNERSHIP ≠ ASSIGNMENT
 * - ASSIGNMENT ≠ CAPABILITY
 * - CAPABILITY ≠ ASSIGNMENT
 * - ASSIGNMENT ≠ PROVIDER OWNERSHIP
 * - ROUTING TARGET ≠ PROVIDER ACCOUNT
 */

import type {
  PhoneNumberOwnershipState,
  PhoneNumberServiceState,
  NumberCapabilityType,
} from '@/lib/telecom/domain/types';

/**
 * The 7 frozen canonical assignment target types from Phase 23C / 23D.1.
 */
export type AssignmentTargetType =
  | 'USER'
  | 'TEAM'
  | 'QUEUE'
  | 'IVR'
  | 'WORKSPACE_MAIN'
  | 'VOICEMAIL'
  | 'UNASSIGNED_POOL';

/**
 * Standardized typed error and success codes for assignment & routing operations.
 */
export type AssignmentErrorCode =
  | 'ASSIGNMENT_SUCCESS'
  | 'NUMBER_NOT_FOUND'
  | 'NUMBER_NOT_OWNED'
  | 'CROSS_ORGANIZATION_FORBIDDEN'
  | 'ASSIGNMENT_TARGET_NOT_FOUND'
  | 'ASSIGNMENT_TARGET_INACTIVE'
  | 'ASSIGNMENT_TARGET_ORGANIZATION_MISMATCH'
  | 'UNSUPPORTED_ASSIGNMENT_TARGET_TYPE'
  | 'NUMBER_LIFECYCLE_FORBIDS_ASSIGNMENT'
  | 'PROVIDER_RESOURCE_MISSING'
  | 'PROVIDER_RESOURCE_INCONSISTENT'
  | 'PROVIDER_ACCOUNT_MISMATCH'
  | 'CUSTOMER_SUBACCOUNT_REQUIRED'
  | 'INSUFFICIENT_PERMISSIONS'
  | 'CONCURRENT_MODIFICATION_CONFLICT'
  | 'NUMBER_SUSPENDED'
  | 'NUMBER_RELEASED'
  | 'NUMBER_PORTED_OUT'
  | 'CAPABILITY_NOT_USABLE'
  | 'NO_ELIGIBLE_SENDER'
  | 'NOT_ASSIGNED_TO_NUMBER'
  | 'UNASSIGNED_ROUTE';

/**
 * Parameters for assigning a phone number.
 */
export interface AssignNumberParams {
  phoneNumberId: string;
  organizationId: string;
  targetType: AssignmentTargetType;
  targetId?: string | null;
  actorId?: string; // Requesting user ID for RBAC & audit
  expectedVersion?: string; // Optimistic locking on updated_at
}

/**
 * Parameters for unassigning a phone number (moves to UNASSIGNED_POOL).
 */
export interface UnassignNumberParams {
  phoneNumberId: string;
  organizationId: string;
  actorId?: string;
  expectedVersion?: string;
}

/**
 * Parameters for reassigning a phone number atomically.
 */
export interface ReassignNumberParams {
  phoneNumberId: string;
  organizationId: string;
  newTargetType: AssignmentTargetType;
  newTargetId?: string | null;
  actorId?: string;
  expectedVersion?: string;
}

/**
 * Result returned by assignment mutation methods.
 */
export interface AssignmentResult {
  success: boolean;
  code: AssignmentErrorCode;
  message: string;
  phoneNumberId: string;
  organizationId: string;
  targetType: AssignmentTargetType;
  targetId: string | null;
  assignedAt: string | null;
  previousTargetType?: AssignmentTargetType | null;
  previousTargetId?: string | null;
  carrierResourceUnchanged: boolean;
  providerAccountUnchanged: boolean;
}

/**
 * DTO representing current assignment details of a phone number.
 */
export interface NumberAssignmentDTO {
  phoneNumberId: string;
  phoneNumberE164: string;
  organizationId: string;
  targetType: AssignmentTargetType;
  targetId: string | null;
  assignedAt: string | null;
  ownershipState: PhoneNumberOwnershipState;
  serviceState: PhoneNumberServiceState;
}

/**
 * Parameters for inbound route resolution.
 */
export interface ResolveInboundRouteParams {
  organizationId: string;
  phoneNumberId?: string;
  phoneNumberE164?: string;
  channel: 'VOICE' | 'SMS' | 'MMS';
}

/**
 * Target detail payload populated upon successful resolution.
 */
export interface ResolvedTargetDetails {
  user?: {
    id: string;
    fullName: string;
    email?: string;
    twilioIdentity?: string | null;
    active: boolean;
  };
  queue?: {
    id: string;
    name: string;
    enabled: boolean;
    strategy?: string;
  };
  ivrMenu?: {
    id: string;
    name: string;
    enabled: boolean;
  };
}

/**
 * Result returned by RoutingResolutionService.
 */
export interface InboundRoutingResolutionResult {
  resolved: boolean;
  code: AssignmentErrorCode;
  reason: string;
  phoneNumberId: string;
  organizationId: string;
  channel: 'VOICE' | 'SMS' | 'MMS';
  targetType: AssignmentTargetType;
  targetId: string | null;
  targetDetails?: ResolvedTargetDetails;
  unassignedAction: 'UNAVAILABLE_GREETING' | 'VOICEMAIL' | 'BUSY';
}

/**
 * Parameters for checking outbound actor permission.
 */
export interface CanActorUseNumberParams {
  organizationId: string;
  actorId: string;
  phoneNumberId?: string;
  phoneNumberE164?: string;
  operation: NumberCapabilityType;
}

/**
 * Result returned by NumberPermissionService.
 */
export interface NumberPermissionResult {
  allowed: boolean;
  code: AssignmentErrorCode;
  reason: string;
  phoneNumberId: string;
  phoneNumberE164: string;
  organizationId: string;
  actorId: string;
  operation: NumberCapabilityType;
  targetType: AssignmentTargetType;
  targetId: string | null;
  isAssignedToActor: boolean;
  hasAdminOverride: boolean;
}
