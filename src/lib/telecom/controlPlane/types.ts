export type TelecomOperation =
  | 'OUTBOUND_VOICE'
  | 'OUTBOUND_MESSAGING'
  | 'NUMBER_ACQUISITION'
  | 'NUMBER_RELEASE'
  | 'PORTING_MUTATION'
  | 'PROVIDER_ACCOUNT_PROVISIONING'
  | 'EXTERNAL_CALL_FORWARDING'
  | 'INBOUND_VOICE'
  | 'INBOUND_MESSAGING'
  | 'PROVIDER_CALLBACK'
  | 'SETTLEMENT'
  | 'RECONCILIATION';

export type TelecomControlReasonCode =
  | 'OPERATION_ALLOWED'
  | 'PLATFORM_SECURITY_BLOCK'
  | 'TENANT_VOLUNTARY_BLOCK'
  | 'TENANT_SECURITY_BLOCK'
  | 'GLOBAL_EMERGENCY_BLOCK'
  | 'ORGANIZATION_TELECOM_SUSPENDED'
  | 'EXTERNAL_FORWARDING_RESTRICTED'
  | 'CONTROL_PLANE_STATE_UNAVAILABLE'
  | 'TENANT_CONTROL_UNAUTHORIZED'
  | 'GLOBAL_EMERGENCY_CONTROL_UNAUTHORIZED'
  | 'PLATFORM_SECURITY_CONTROL_UNAUTHORIZED'
  | 'PLATFORM_RESTRICTION_REASON_REQUIRED'
  | 'PLATFORM_RESTORATION_REASON_REQUIRED'
  | 'CROSS_ORGANIZATION_UNAUTHORIZED'
  | 'INVALID_OPERATION'
  | 'INVALID_ORGANIZATION_ID';

export type TelecomControlSource =
  | 'SYSTEM_DEFAULT'
  | 'GLOBAL_EMERGENCY'
  | 'PLATFORM_SECURITY'
  | 'TENANT_VOLUNTARY'
  | 'TENANT_CIRCUIT_BREAKER'
  | 'ORGANIZATION_BILLING_SUSPENSION'
  | 'FAIL_CLOSED_DEFAULT';

export interface TenantVoluntaryControls {
  outboundVoiceEnabled: boolean;
  outboundMessagingEnabled: boolean;
  numberAcquisitionEnabled: boolean;
  numberReleaseEnabled: boolean;
  portingMutationsEnabled: boolean;
  providerAccountProvisioningEnabled: boolean;
  externalCallForwardingEnabled: boolean;
  inboundVoiceEnabled: boolean;
  inboundMessagingEnabled: boolean;
  reason?: string | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
}

export interface PlatformSecurityRestrictions {
  outboundVoiceBlocked: boolean;
  outboundMessagingBlocked: boolean;
  numberAcquisitionBlocked: boolean;
  numberReleaseBlocked: boolean;
  portingMutationsBlocked: boolean;
  providerAccountProvisioningBlocked: boolean;
  externalCallForwardingBlocked: boolean;
  inboundVoiceBlocked: boolean;
  inboundMessagingBlocked: boolean;
  restrictionReason?: string | null;
  restrictedBy?: string | null;
  restrictedAt?: string | null;
  restorationReason?: string | null;
  restoredBy?: string | null;
  restoredAt?: string | null;
}

export interface TenantCircuitBreakerState {
  organizationId: string;
  // Monotonic separation of authorities
  voluntary: TenantVoluntaryControls;
  security: PlatformSecurityRestrictions;
  telecomSuspended?: boolean;

  // Backward-compatible computed views
  outboundVoiceAllowed: boolean;
  outboundMessagingAllowed: boolean;
  numberAcquisitionAllowed: boolean;
  numberReleaseAllowed: boolean;
  portingMutationsAllowed: boolean;
  providerAccountProvisioningAllowed: boolean;
  externalCallForwardingAllowed: boolean;
  inboundVoiceAllowed: boolean;
  inboundMessagingAllowed: boolean;
  containmentReason?: string | null;
  containedBy?: string | null;
  containedAt?: string | null;
  version: number;
  updatedAt: string;
}

export type GlobalControlKey =
  | 'NEW_OUTBOUND_VOICE'
  | 'NEW_OUTBOUND_MESSAGING'
  | 'NEW_NUMBER_ACQUISITION'
  | 'NEW_NUMBER_RELEASE'
  | 'NEW_PORTING_MUTATIONS'
  | 'NEW_PROVIDER_ACCOUNT_PROVISIONING'
  | 'EXTERNAL_PSTN_FORWARDING';

export interface GlobalEmergencyControlState {
  controlKey: GlobalControlKey | string;
  isActive: boolean; // true = STOP ACTIVATED (BLOCKED)
  reason?: string | null;
  activatedBy?: string | null;
  activatedAt?: string | null;
  version: number;
  updatedAt: string;
}

export interface ControlPlaneEvaluationParams {
  organizationId: string;
  operation: TelecomOperation;
  userId?: string | null;
  phoneNumber?: string | null;
  destination?: string | null;
  correlationId?: string;
  context?: Record<string, any>;
}

export interface ControlPlaneEvaluationResult {
  allowed: boolean;
  operation: TelecomOperation;
  organizationId: string;
  reasonCode: TelecomControlReasonCode;
  reason: string;
  controlSource: TelecomControlSource;
  stateVersion?: number;
  evaluatedAt: string;
}

export interface ControlPlaneAuditEvent {
  organizationId?: string | null;
  actorId?: string | null;
  authority?: 'PLATFORM_SECURITY' | 'TENANT_ADMIN' | 'GLOBAL_EMERGENCY' | 'SYSTEM_DEFAULT';
  controlType:
    | 'TENANT_CIRCUIT_BREAKER'
    | 'PLATFORM_SECURITY'
    | 'GLOBAL_EMERGENCY'
    | 'ACTIVE_CALL_TERMINATION'
    | 'CONTROL_OVERRIDE';
  operation: string;
  decision: 'ALLOWED' | 'BLOCKED' | 'RESTRICTED' | 'OVERRIDDEN';
  reasonCode: string;
  reason: string;
  previousState?: Record<string, any> | null;
  newState?: Record<string, any> | null;
  correlationId?: string | null;
  metadata?: Record<string, any> | null;
  createdAt?: string;
}

