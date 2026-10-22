import { SupabaseClient } from '@supabase/supabase-js';
import {
  TelecomOperation,
  ControlPlaneEvaluationParams,
  ControlPlaneEvaluationResult,
  TenantCircuitBreakerState,
  TenantVoluntaryControls,
  PlatformSecurityRestrictions,
  GlobalEmergencyControlState,
  GlobalControlKey,
} from './types';
import { TelecomControlPlaneRepository } from './telecomControlPlaneRepository';
import { TelecomControlPlaneAuditService } from './telecomControlPlaneAuditService';

export interface SetTenantControlsParams {
  organizationId: string;
  actorId: string;
  actorRole: string;
  actorOrgId?: string;
  updates: Partial<Omit<TenantCircuitBreakerState, 'organizationId' | 'version' | 'updatedAt' | 'voluntary' | 'security'>>;
  reason?: string;
  correlationId?: string;
}

export interface SetTenantVoluntaryControlsParams {
  organizationId: string;
  actorId: string;
  actorRole: string;
  actorOrgId?: string;
  controls: Partial<Omit<TenantVoluntaryControls, 'reason' | 'updatedBy' | 'updatedAt'>>;
  reason?: string;
  correlationId?: string;
}

export interface SetPlatformSecurityRestrictionsParams {
  organizationId: string;
  actorId: string;
  actorRole: string;
  restrictions: Partial<Omit<PlatformSecurityRestrictions, 'restrictionReason' | 'restrictedBy' | 'restrictedAt' | 'restorationReason' | 'restoredBy' | 'restoredAt'>>;
  reason?: string;
  restorationReason?: string;
  correlationId?: string;
}

export interface SetGlobalEmergencyStopParams {
  controlKey: GlobalControlKey;
  isActive: boolean;
  actorId: string;
  actorRole: string;
  reason: string;
  correlationId?: string;
}

export interface AuthoritativeActor {
  actorId: string;
  actorRole: string;
  actorOrgId: string;
}

export class TelecomControlPlaneService {
  /**
   * Resolves the authoritative actor identity, role, and organization from server-side database state.
   * Client-supplied claims (e.g. role, admin flag, organizationId) are NEVER trusted.
   */
  public static async resolveAuthoritativeActor(
    actorId: string,
    client?: SupabaseClient | null
  ): Promise<AuthoritativeActor> {
    if (!actorId || typeof actorId !== 'string') {
      throw new Error('ACTOR_INVALID: Missing or invalid actor ID');
    }

    if (!client) {
      throw new Error('CLIENT_REQUIRED: Supabase client is required for server-side authority resolution');
    }

    const { data: profile, error } = await (client as any)
      .from('profiles')
      .select('id, role, organization_id')
      .eq('id', actorId)
      .maybeSingle();

    if (error || !profile) {
      throw new Error(`ACTOR_NOT_FOUND: Authoritative actor ${actorId} not found in system profiles`);
    }

    return {
      actorId: profile.id,
      actorRole: profile.role || 'member',
      actorOrgId: profile.organization_id || '',
    };
  }

  /**
   * Authoritative single evaluation point for the VoIP Hub parent-protection control plane.
   * STRICT FAIL-CLOSED GUARANTEE for all new chargeable/mutating telecom operations.
   *
   * Monotonic Intersection:
   * effective_allowed = !globalEmergencyStop
   *   AND !telecomSuspended
   *   AND !platformSecurityRestriction
   *   AND tenantVoluntaryControl
   */
  public static async evaluate(
    params: ControlPlaneEvaluationParams,
    client?: SupabaseClient | null
  ): Promise<ControlPlaneEvaluationResult> {
    const { organizationId, operation, correlationId } = params;
    const evaluatedAt = new Date().toISOString();

    // 0. Parameter validation
    if (!organizationId || typeof organizationId !== 'string' || organizationId.trim().length === 0) {
      if (TelecomControlPlaneRepository.isObservationOperation(operation)) {
        return {
          allowed: true,
          operation,
          organizationId: organizationId || 'unknown',
          reasonCode: 'OPERATION_ALLOWED',
          reason: 'Observation operation permitted with missing organization ID',
          controlSource: 'SYSTEM_DEFAULT',
          evaluatedAt,
        };
      }
      return {
        allowed: false,
        operation,
        organizationId: organizationId || 'unknown',
        reasonCode: 'INVALID_ORGANIZATION_ID',
        reason: 'Organization ID is missing or invalid',
        controlSource: 'FAIL_CLOSED_DEFAULT',
        evaluatedAt,
      };
    }

    // 1. Observation operations bypass security stops so callbacks/settlement never drop
    if (TelecomControlPlaneRepository.isObservationOperation(operation)) {
      return {
        allowed: true,
        operation,
        organizationId,
        reasonCode: 'OPERATION_ALLOWED',
        reason: 'Observation operation permitted by system policy',
        controlSource: 'SYSTEM_DEFAULT',
        evaluatedAt,
      };
    }

    // 2. Map telecom operation to corresponding global emergency control key
    const globalKey = this.mapOperationToGlobalKey(operation);

    // 3. Evaluate Global Emergency Control
    if (globalKey) {
      const globalRes = await TelecomControlPlaneRepository.getGlobalEmergencyControl(globalKey, client);
      if (!globalRes.success) {
        // Fail closed for new chargeable operations
        return {
          allowed: false,
          operation,
          organizationId,
          reasonCode: 'CONTROL_PLANE_STATE_UNAVAILABLE',
          reason: `Failed to determine global emergency state: ${globalRes.error}`,
          controlSource: 'FAIL_CLOSED_DEFAULT',
          evaluatedAt,
        };
      }

      if (globalRes.data?.isActive === true) {
        await TelecomControlPlaneAuditService.logControlEvent({
          organizationId,
          authority: 'GLOBAL_EMERGENCY',
          controlType: 'GLOBAL_EMERGENCY',
          operation,
          decision: 'BLOCKED',
          reasonCode: 'GLOBAL_EMERGENCY_BLOCK',
          reason: globalRes.data.reason || `Global emergency stop is active for ${globalKey}`,
          correlationId,
        }, client);

        return {
          allowed: false,
          operation,
          organizationId,
          reasonCode: 'GLOBAL_EMERGENCY_BLOCK',
          reason: globalRes.data.reason || `Global emergency stop is active for ${operation}`,
          controlSource: 'GLOBAL_EMERGENCY',
          stateVersion: globalRes.data.version,
          evaluatedAt,
        };
      }
    }

    // Special case for external call forwarding: also respect global voice stop
    if (operation === 'EXTERNAL_CALL_FORWARDING') {
      const globalVoiceRes = await TelecomControlPlaneRepository.getGlobalEmergencyControl('NEW_OUTBOUND_VOICE', client);
      if (globalVoiceRes.success && globalVoiceRes.data?.isActive === true) {
        return {
          allowed: false,
          operation,
          organizationId,
          reasonCode: 'GLOBAL_EMERGENCY_BLOCK',
          reason: globalVoiceRes.data.reason || 'Global emergency stop for outbound voice is active; forwarding disallowed',
          controlSource: 'GLOBAL_EMERGENCY',
          stateVersion: globalVoiceRes.data.version,
          evaluatedAt,
        };
      }
    }

    // 4. Evaluate Tenant Circuit Breaker State
    const tenantRes = await TelecomControlPlaneRepository.getTenantCircuitBreaker(organizationId, client);
    if (!tenantRes.success) {
      return {
        allowed: false,
        operation,
        organizationId,
        reasonCode: 'CONTROL_PLANE_STATE_UNAVAILABLE',
        reason: `Failed to determine tenant circuit breaker state: ${tenantRes.error}`,
        controlSource: 'FAIL_CLOSED_DEFAULT',
        evaluatedAt,
      };
    }

    const tenantState = tenantRes.data!;

    // 4a. Check legacy/billing suspension (platform-level deny)
    if (tenantState.telecomSuspended === true) {
      const suspendReason = tenantState.security?.restrictionReason || tenantState.containmentReason || 'Organization telecom suspended via billing controls';
      await TelecomControlPlaneAuditService.logControlEvent({
        organizationId,
        authority: 'PLATFORM_SECURITY',
        controlType: 'PLATFORM_SECURITY',
        operation,
        decision: 'BLOCKED',
        reasonCode: 'ORGANIZATION_TELECOM_SUSPENDED',
        reason: suspendReason,
        correlationId,
      }, client);

      return {
        allowed: false,
        operation,
        organizationId,
        reasonCode: 'ORGANIZATION_TELECOM_SUSPENDED',
        reason: suspendReason,
        controlSource: 'ORGANIZATION_BILLING_SUSPENSION',
        stateVersion: tenantState.version,
        evaluatedAt,
      };
    }

    // 4b. Check Platform Security Restrictions (Platform DENY cannot be overridden by tenant)
    const isPlatformBlocked = this.checkPlatformSecurityBlocked(tenantState, operation);
    if (isPlatformBlocked) {
      const reason = tenantState.security?.restrictionReason || `Platform security restriction active: ${operation} blocked`;
      await TelecomControlPlaneAuditService.logControlEvent({
        organizationId,
        authority: 'PLATFORM_SECURITY',
        controlType: 'PLATFORM_SECURITY',
        operation,
        decision: 'BLOCKED',
        reasonCode: 'PLATFORM_SECURITY_BLOCK',
        reason,
        correlationId,
      }, client);

      return {
        allowed: false,
        operation,
        organizationId,
        reasonCode: 'PLATFORM_SECURITY_BLOCK',
        reason,
        controlSource: 'PLATFORM_SECURITY',
        stateVersion: tenantState.version,
        evaluatedAt,
      };
    }

    // 4c. Check Tenant Voluntary Controls
    const isTenantEnabled = this.checkTenantVoluntaryAllowed(tenantState, operation);
    if (!isTenantEnabled) {
      const reason = tenantState.voluntary?.reason || tenantState.containmentReason || `Tenant voluntary restriction active: ${operation} disabled`;
      const reasonCode = operation === 'EXTERNAL_CALL_FORWARDING'
        ? 'EXTERNAL_FORWARDING_RESTRICTED'
        : 'TENANT_SECURITY_BLOCK';

      await TelecomControlPlaneAuditService.logControlEvent({
        organizationId,
        authority: 'TENANT_ADMIN',
        controlType: 'TENANT_CIRCUIT_BREAKER',
        operation,
        decision: 'BLOCKED',
        reasonCode,
        reason,
        correlationId,
      }, client);

      return {
        allowed: false,
        operation,
        organizationId,
        reasonCode,
        reason,
        controlSource: 'TENANT_CIRCUIT_BREAKER',
        stateVersion: tenantState.version,
        evaluatedAt,
      };
    }

    // Operation is authoritatively permitted by all layers
    return {
      allowed: true,
      operation,
      organizationId,
      reasonCode: 'OPERATION_ALLOWED',
      reason: 'Operation permitted by local voluntary controls, platform security, and global control plane',
      controlSource: 'SYSTEM_DEFAULT',
      stateVersion: tenantState.version,
      evaluatedAt,
    };
  }

  /**
   * Imposes or removes platform-level security restrictions.
   * STRICTLY RESTRICTED TO PLATFORM SECURITY ADMINISTRATORS.
   *
   * Rules:
   * - Tenant owners/admins CANNOT call this method.
   * - Setting a restriction (true) requires a non-empty `reason`.
   * - Removing a restriction (false) requires a non-empty `restorationReason`.
   * - Silent unblocking is strictly prohibited.
   */
  public static async setPlatformSecurityRestrictions(
    params: SetPlatformSecurityRestrictionsParams,
    client?: SupabaseClient | null
  ): Promise<{ success: boolean; data?: TenantCircuitBreakerState; error?: string }> {
    const { organizationId, actorId, actorRole, restrictions, reason, restorationReason, correlationId } = params;

    // RBAC: actor must be platform admin
    const isPlatformAdmin = actorRole === 'super_admin' || actorRole === 'platform_admin';
    if (!isPlatformAdmin) {
      throw new Error(
        'PLATFORM_SECURITY_CONTROL_UNAUTHORIZED: Only platform security administrators can modify platform security restrictions'
      );
    }

    // Audit requirement: any new restriction being imposed requires non-empty reason
    const isImposing = Object.values(restrictions).some((v) => v === true);
    if (isImposing && (!reason || reason.trim().length === 0)) {
      throw new Error(
        'PLATFORM_RESTRICTION_REASON_REQUIRED: A non-empty reason is required to impose platform security restrictions'
      );
    }

    // Audit requirement: any restriction being removed/unblocked requires non-empty restorationReason
    const isRestoring = Object.values(restrictions).some((v) => v === false);
    if (isRestoring && (!restorationReason || restorationReason.trim().length === 0)) {
      throw new Error(
        'PLATFORM_RESTORATION_REASON_REQUIRED: A non-empty restoration reason is required to remove platform security restrictions'
      );
    }

    const existingRes = await TelecomControlPlaneRepository.getTenantCircuitBreaker(organizationId, client);
    const existing = existingRes.data || TelecomControlPlaneRepository.getDefaultTenantState(organizationId);

    const nowIso = new Date().toISOString();
    const updatedSecurity: PlatformSecurityRestrictions = {
      ...existing.security,
      ...restrictions,
      restrictionReason: isImposing ? reason : existing.security.restrictionReason,
      restrictedBy: isImposing ? actorId : existing.security.restrictedBy,
      restrictedAt: isImposing ? nowIso : existing.security.restrictedAt,
      restorationReason: isRestoring ? restorationReason : existing.security.restorationReason,
      restoredBy: isRestoring ? actorId : existing.security.restoredBy,
      restoredAt: isRestoring ? nowIso : existing.security.restoredAt,
    };

    const updatedState: TenantCircuitBreakerState = {
      ...existing,
      security: updatedSecurity,
      containmentReason: isImposing ? reason : updatedSecurity.restrictionReason,
      containedBy: actorId,
      containedAt: nowIso,
    };

    const saveRes = await TelecomControlPlaneRepository.saveTenantCircuitBreaker(updatedState, client);

    await TelecomControlPlaneAuditService.logControlEvent({
      organizationId,
      actorId,
      authority: 'PLATFORM_SECURITY',
      controlType: 'PLATFORM_SECURITY',
      operation: 'UPDATE_PLATFORM_SECURITY_RESTRICTIONS',
      decision: isImposing ? 'BLOCKED' : 'ALLOWED',
      reasonCode: isImposing ? 'PLATFORM_RESTRICTION_IMPOSED' : 'PLATFORM_RESTRICTION_REMOVED',
      reason: isImposing ? reason! : restorationReason!,
      previousState: existing.security as any,
      newState: updatedSecurity as any,
      correlationId,
      metadata: { actorRole, restrictions },
    }, client);

    return saveRes;
  }

  /**
   * Modifies tenant voluntary controls.
   *
   * Rules:
   * - Allowed for: platform admins OR tenant owner/admin for their OWN organization.
   * - Tenant A owner/admin CANNOT modify Tenant B controls (cross-tenant rejected).
   * - Ordinary users/agents CANNOT modify controls.
   * - Modifying tenant voluntary controls strictly CANNOT alter or remove platform security restrictions.
   */
  public static async setTenantVoluntaryControls(
    params: SetTenantVoluntaryControlsParams,
    client?: SupabaseClient | null
  ): Promise<{ success: boolean; data?: TenantCircuitBreakerState; error?: string }> {
    const { organizationId, actorId, actorRole, actorOrgId, controls, reason, correlationId } = params;

    const isPlatformAdmin = actorRole === 'super_admin' || actorRole === 'platform_admin';
    const isTenantAdmin = (actorRole === 'owner' || actorRole === 'admin') && actorOrgId === organizationId;

    if (!isPlatformAdmin && !isTenantAdmin) {
      if (actorRole === 'owner' || actorRole === 'admin') {
        throw new Error('TENANT_CONTROL_UNAUTHORIZED: Cross-organization modification forbidden');
      }
      throw new Error('TENANT_CONTROL_UNAUTHORIZED: Insufficient permissions to modify tenant voluntary controls');
    }

    const existingRes = await TelecomControlPlaneRepository.getTenantCircuitBreaker(organizationId, client);
    const existing = existingRes.data || TelecomControlPlaneRepository.getDefaultTenantState(organizationId);

    const nowIso = new Date().toISOString();
    const updatedVoluntary: TenantVoluntaryControls = {
      ...existing.voluntary,
      ...controls,
      reason: reason !== undefined ? reason : existing.voluntary.reason,
      updatedBy: actorId,
      updatedAt: nowIso,
    };

    // Notice: existing.security remains strictly untouched!
    const updatedState: TenantCircuitBreakerState = {
      ...existing,
      voluntary: updatedVoluntary,
    };

    const saveRes = await TelecomControlPlaneRepository.saveTenantCircuitBreaker(updatedState, client);

    await TelecomControlPlaneAuditService.logControlEvent({
      organizationId,
      actorId,
      authority: isPlatformAdmin ? 'PLATFORM_SECURITY' : 'TENANT_ADMIN',
      controlType: 'TENANT_CIRCUIT_BREAKER',
      operation: 'UPDATE_TENANT_VOLUNTARY_CONTROLS',
      decision: Object.values(controls).some((v) => v === false) ? 'RESTRICTED' : 'ALLOWED',
      reasonCode: 'TENANT_VOLUNTARY_UPDATED',
      reason: reason || 'Tenant voluntary controls updated',
      previousState: existing.voluntary as any,
      newState: updatedVoluntary as any,
      correlationId,
      metadata: { actorRole, controls },
    }, client);

    return saveRes;
  }

  /**
   * Modifies tenant circuit breaker state with strict RBAC enforcement (Backward-compatible wrapper).
   *
   * If caller is a tenant admin, updates are strictly mapped to tenant voluntary controls.
   * Tenant admins CANNOT modify or unblock platform-imposed security restrictions.
   */
  public static async setTenantCircuitBreakers(
    params: SetTenantControlsParams,
    client?: SupabaseClient | null
  ): Promise<{ success: boolean; data?: TenantCircuitBreakerState; error?: string }> {
    const { organizationId, actorId, actorRole, actorOrgId, updates, reason, correlationId } = params;

    const isPlatformAdmin = actorRole === 'super_admin' || actorRole === 'platform_admin';
    const isTenantAdmin = (actorRole === 'owner' || actorRole === 'admin') && actorOrgId === organizationId;

    if (!isPlatformAdmin && !isTenantAdmin) {
      if (actorRole === 'owner' || actorRole === 'admin') {
        throw new Error('TENANT_CONTROL_UNAUTHORIZED: Cross-organization modification forbidden');
      }
      throw new Error('TENANT_CONTROL_UNAUTHORIZED: Insufficient permissions to modify tenant circuit breakers');
    }

    // Map boolean updates to voluntary controls
    const voluntaryControls: Partial<Omit<TenantVoluntaryControls, 'reason' | 'updatedBy' | 'updatedAt'>> = {};
    if (updates.outboundVoiceAllowed !== undefined) voluntaryControls.outboundVoiceEnabled = updates.outboundVoiceAllowed;
    if (updates.outboundMessagingAllowed !== undefined) voluntaryControls.outboundMessagingEnabled = updates.outboundMessagingAllowed;
    if (updates.numberAcquisitionAllowed !== undefined) voluntaryControls.numberAcquisitionEnabled = updates.numberAcquisitionAllowed;
    if (updates.numberReleaseAllowed !== undefined) voluntaryControls.numberReleaseEnabled = updates.numberReleaseAllowed;
    if (updates.portingMutationsAllowed !== undefined) voluntaryControls.portingMutationsEnabled = updates.portingMutationsAllowed;
    if (updates.providerAccountProvisioningAllowed !== undefined) voluntaryControls.providerAccountProvisioningEnabled = updates.providerAccountProvisioningAllowed;
    if (updates.externalCallForwardingAllowed !== undefined) voluntaryControls.externalCallForwardingEnabled = updates.externalCallForwardingAllowed;
    if (updates.inboundVoiceAllowed !== undefined) voluntaryControls.inboundVoiceEnabled = updates.inboundVoiceAllowed;
    if (updates.inboundMessagingAllowed !== undefined) voluntaryControls.inboundMessagingEnabled = updates.inboundMessagingAllowed;

    return this.setTenantVoluntaryControls(
      {
        organizationId,
        actorId,
        actorRole,
        actorOrgId,
        controls: voluntaryControls,
        reason,
        correlationId,
      },
      client
    );
  }

  /**
   * Toggles global emergency stop with strict platform administrator RBAC.
   * Tenant admins CANNOT activate or deactivate global controls.
   */
  public static async setGlobalEmergencyStop(
    params: SetGlobalEmergencyStopParams,
    client?: SupabaseClient | null
  ): Promise<{ success: boolean; data?: GlobalEmergencyControlState; error?: string }> {
    const { controlKey, isActive, actorId, actorRole, reason, correlationId } = params;

    // Strict platform admin check
    const isPlatformAdmin = actorRole === 'super_admin' || actorRole === 'platform_admin';
    if (!isPlatformAdmin) {
      throw new Error('GLOBAL_EMERGENCY_CONTROL_UNAUTHORIZED: Only platform security administrators can toggle global emergency controls');
    }

    if (!reason || reason.trim().length === 0) {
      throw new Error('REASON_REQUIRED: A non-empty reason is required to toggle global emergency controls');
    }

    const existingRes = await TelecomControlPlaneRepository.getGlobalEmergencyControl(controlKey, client);
    const existing = existingRes.data || {
      controlKey,
      isActive: false,
      version: 1,
      updatedAt: new Date().toISOString(),
    };

    const updatedState: GlobalEmergencyControlState = {
      ...existing,
      controlKey,
      isActive,
      reason,
      activatedBy: actorId,
      activatedAt: isActive ? new Date().toISOString() : existing.activatedAt,
    };

    const saveRes = await TelecomControlPlaneRepository.saveGlobalEmergencyControl(updatedState, client);

    await TelecomControlPlaneAuditService.logControlEvent({
      actorId,
      authority: 'GLOBAL_EMERGENCY',
      controlType: 'GLOBAL_EMERGENCY',
      operation: controlKey,
      decision: isActive ? 'BLOCKED' : 'ALLOWED',
      reasonCode: isActive ? 'EMERGENCY_STOP_ACTIVATED' : 'EMERGENCY_STOP_DEACTIVATED',
      reason,
      previousState: existing as any,
      newState: updatedState as any,
      correlationId,
    }, client);

    return saveRes;
  }

  /**
   * Terminate currently active chargeable OUTBOUND PSTN legs for an organization.
   * Safe non-chargeable and inbound WebRTC sessions are PRESERVED and never touched.
   */
  public static async terminateActiveOutboundLegs(
    organizationId: string,
    reason: string,
    options?: {
      client?: SupabaseClient | null;
      providerAdapter?: any;
    }
  ): Promise<{
    examinedCount: number;
    terminatedCount: number;
    skippedInboundCount: number;
    results: any[];
  }> {
    const client = options?.client;
    if (!client) {
      return { examinedCount: 0, terminatedCount: 0, skippedInboundCount: 0, results: [] };
    }

    const { data: activeCalls, error } = await (client as any)
      .from('calls')
      .select('id, organization_id, twilio_call_sid, direction, status')
      .eq('organization_id', organizationId)
      .in('status', ['initiated', 'ringing', 'in-progress']);

    if (error || !activeCalls) {
      return { examinedCount: 0, terminatedCount: 0, skippedInboundCount: 0, results: [] };
    }

    const results: any[] = [];
    let terminatedCount = 0;
    let skippedInboundCount = 0;

    const { ActiveCallTerminationService } = await import('@/lib/billing/telecom/activeCallTerminationService');

    for (const call of activeCalls) {
      // Invariant: NEVER terminate safe inbound sessions
      if (call.direction !== 'outbound') {
        skippedInboundCount++;
        continue;
      }

      const termRes = await ActiveCallTerminationService.terminateActiveCall(client, {
        organizationId,
        dbCallId: call.id,
        reason,
        providerAdapter: options?.providerAdapter,
      });

      results.push(termRes);
      if (termRes.terminated) {
        terminatedCount++;
      }
    }

    await TelecomControlPlaneAuditService.logControlEvent({
      organizationId,
      authority: 'PLATFORM_SECURITY',
      controlType: 'ACTIVE_CALL_TERMINATION',
      operation: 'TERMINATE_ACTIVE_OUTBOUND_LEGS',
      decision: terminatedCount > 0 ? 'BLOCKED' : 'ALLOWED',
      reasonCode: 'OUTBOUND_LEGS_TERMINATED',
      reason,
      metadata: { examinedCount: activeCalls.length, terminatedCount, skippedInboundCount },
    }, client);

    return {
      examinedCount: activeCalls.length,
      terminatedCount,
      skippedInboundCount,
      results,
    };
  }

  private static mapOperationToGlobalKey(operation: TelecomOperation): GlobalControlKey | null {
    switch (operation) {
      case 'OUTBOUND_VOICE':
        return 'NEW_OUTBOUND_VOICE';
      case 'OUTBOUND_MESSAGING':
        return 'NEW_OUTBOUND_MESSAGING';
      case 'NUMBER_ACQUISITION':
        return 'NEW_NUMBER_ACQUISITION';
      case 'NUMBER_RELEASE':
        return 'NEW_NUMBER_RELEASE';
      case 'PORTING_MUTATION':
        return 'NEW_PORTING_MUTATIONS';
      case 'PROVIDER_ACCOUNT_PROVISIONING':
        return 'NEW_PROVIDER_ACCOUNT_PROVISIONING';
      case 'EXTERNAL_CALL_FORWARDING':
        return 'EXTERNAL_PSTN_FORWARDING';
      default:
        return null;
    }
  }

  private static checkPlatformSecurityBlocked(state: TenantCircuitBreakerState, operation: TelecomOperation): boolean {
    const sec = state.security;
    if (!sec) return false;

    switch (operation) {
      case 'OUTBOUND_VOICE':
        return sec.outboundVoiceBlocked === true;
      case 'OUTBOUND_MESSAGING':
        return sec.outboundMessagingBlocked === true;
      case 'NUMBER_ACQUISITION':
        return sec.numberAcquisitionBlocked === true;
      case 'NUMBER_RELEASE':
        return sec.numberReleaseBlocked === true;
      case 'PORTING_MUTATION':
        return sec.portingMutationsBlocked === true;
      case 'PROVIDER_ACCOUNT_PROVISIONING':
        return sec.providerAccountProvisioningBlocked === true;
      case 'EXTERNAL_CALL_FORWARDING':
        return sec.externalCallForwardingBlocked === true || sec.outboundVoiceBlocked === true;
      case 'INBOUND_VOICE':
        return sec.inboundVoiceBlocked === true;
      case 'INBOUND_MESSAGING':
        return sec.inboundMessagingBlocked === true;
      default:
        return false;
    }
  }

  private static checkTenantVoluntaryAllowed(state: TenantCircuitBreakerState, operation: TelecomOperation): boolean {
    const vol = state.voluntary;
    if (!vol) {
      // Fallback to top-level booleans
      return this.checkLegacyTenantOperationAllowed(state, operation);
    }

    switch (operation) {
      case 'OUTBOUND_VOICE':
        return vol.outboundVoiceEnabled !== false;
      case 'OUTBOUND_MESSAGING':
        return vol.outboundMessagingEnabled !== false;
      case 'NUMBER_ACQUISITION':
        return vol.numberAcquisitionEnabled !== false;
      case 'NUMBER_RELEASE':
        return vol.numberReleaseEnabled !== false;
      case 'PORTING_MUTATION':
        return vol.portingMutationsEnabled !== false;
      case 'PROVIDER_ACCOUNT_PROVISIONING':
        return vol.providerAccountProvisioningEnabled !== false;
      case 'EXTERNAL_CALL_FORWARDING':
        return vol.externalCallForwardingEnabled !== false && vol.outboundVoiceEnabled !== false;
      case 'INBOUND_VOICE':
        return vol.inboundVoiceEnabled !== false;
      case 'INBOUND_MESSAGING':
        return vol.inboundMessagingEnabled !== false;
      default:
        return true;
    }
  }

  private static checkLegacyTenantOperationAllowed(state: TenantCircuitBreakerState, operation: TelecomOperation): boolean {
    switch (operation) {
      case 'OUTBOUND_VOICE':
        return state.outboundVoiceAllowed !== false;
      case 'OUTBOUND_MESSAGING':
        return state.outboundMessagingAllowed !== false;
      case 'NUMBER_ACQUISITION':
        return state.numberAcquisitionAllowed !== false;
      case 'NUMBER_RELEASE':
        return state.numberReleaseAllowed !== false;
      case 'PORTING_MUTATION':
        return state.portingMutationsAllowed !== false;
      case 'PROVIDER_ACCOUNT_PROVISIONING':
        return state.providerAccountProvisioningAllowed !== false;
      case 'EXTERNAL_CALL_FORWARDING':
        return state.externalCallForwardingAllowed !== false && state.outboundVoiceAllowed !== false;
      case 'INBOUND_VOICE':
        return state.inboundVoiceAllowed !== false;
      case 'INBOUND_MESSAGING':
        return state.inboundMessagingAllowed !== false;
      default:
        return true;
    }
  }
}
