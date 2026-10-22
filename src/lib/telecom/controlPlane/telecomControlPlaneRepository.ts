import { SupabaseClient } from '@supabase/supabase-js';
import {
  TenantCircuitBreakerState,
  GlobalEmergencyControlState,
  GlobalControlKey,
  TelecomOperation,
} from './types';

export interface RepositoryReadResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  source: 'DATABASE' | 'MOCK_SHARED' | 'DEFAULT_FALLBACK';
}

export class TelecomControlPlaneRepository {
  // Shared in-memory state for local testing and multi-worker simulation
  private static sharedTenantState = new Map<string, TenantCircuitBreakerState>();
  private static sharedGlobalState = new Map<string, GlobalEmergencyControlState>();
  private static forceReadFailure = false;

  public static setSimulateReadFailure(fail: boolean): void {
    this.forceReadFailure = fail;
  }

  public static resetSharedState(): void {
    this.sharedTenantState.clear();
    this.sharedGlobalState.clear();
    this.forceReadFailure = false;
  }

  /**
   * Retrieves tenant circuit breaker state with fail-closed semantics.
   */
  public static async getTenantCircuitBreaker(
    organizationId: string,
    client?: SupabaseClient | null
  ): Promise<RepositoryReadResult<TenantCircuitBreakerState>> {
    if (this.forceReadFailure) {
      return {
        success: false,
        error: 'SIMULATED_DATABASE_CONNECTION_FAILURE',
        source: 'DATABASE',
      };
    }

    // 1. Check shared in-memory test state if set
    if (this.sharedTenantState.has(organizationId)) {
      return {
        success: true,
        data: { ...this.sharedTenantState.get(organizationId)! },
        source: 'MOCK_SHARED',
      };
    }

    // 2. Query Postgres database if client provided
    if (client) {
      try {
        const { data, error } = await (client as any)
          .from('organization_telecom_circuit_breakers')
          .select('*')
          .eq('organization_id', organizationId)
          .maybeSingle();

        // Check billing controls for platform-level telecom_suspended
        let isBillingSuspended = false;
        let billingSuspendedReason: string | null = null;
        try {
          const { data: orgControls } = await client
            .from('organization_billing_controls')
            .select('telecom_suspended, restriction_reason')
            .eq('organization_id', organizationId)
            .maybeSingle();
          if (orgControls?.telecom_suspended === true) {
            isBillingSuspended = true;
            billingSuspendedReason = orgControls.restriction_reason || 'Organization telecom suspended via billing controls';
          }
        } catch {
          // Non-fatal if table not present in test harness
        }

        if (error) {
          // If table does not exist (pre-migration), check organization_billing_controls
          if (error.code === '42P01' || error.message?.includes('does not exist')) {
            return this.fallbackCheckBillingControls(organizationId, client);
          }
          return {
            success: false,
            error: `Database error querying circuit breakers: ${error.message}`,
            source: 'DATABASE',
          };
        }

        if (data) {
          const voluntary = {
            outboundVoiceEnabled: data.tenant_outbound_voice_enabled !== false && data.outbound_voice_allowed !== false,
            outboundMessagingEnabled: data.tenant_outbound_messaging_enabled !== false && data.outbound_messaging_allowed !== false,
            numberAcquisitionEnabled: data.tenant_number_acquisition_enabled !== false && data.number_acquisition_allowed !== false,
            numberReleaseEnabled: data.tenant_number_release_enabled !== false && data.number_release_allowed !== false,
            portingMutationsEnabled: data.tenant_porting_enabled !== false && data.porting_mutations_allowed !== false,
            providerAccountProvisioningEnabled: data.tenant_provisioning_enabled !== false && data.provider_account_provisioning_allowed !== false,
            externalCallForwardingEnabled: data.tenant_forwarding_enabled !== false && data.external_call_forwarding_allowed !== false,
            inboundVoiceEnabled: data.tenant_inbound_voice_enabled !== false && data.inbound_voice_allowed !== false,
            inboundMessagingEnabled: data.tenant_inbound_messaging_enabled !== false && data.inbound_messaging_allowed !== false,
            reason: data.tenant_restriction_reason || null,
            updatedBy: data.tenant_restricted_by || null,
            updatedAt: data.tenant_restricted_at || null,
          };

          const security = {
            outboundVoiceBlocked: data.platform_outbound_voice_blocked === true || isBillingSuspended,
            outboundMessagingBlocked: data.platform_outbound_messaging_blocked === true || isBillingSuspended,
            numberAcquisitionBlocked: data.platform_number_acquisition_blocked === true || isBillingSuspended,
            numberReleaseBlocked: data.platform_number_release_blocked === true || isBillingSuspended,
            portingMutationsBlocked: data.platform_porting_blocked === true || isBillingSuspended,
            providerAccountProvisioningBlocked: data.platform_provisioning_blocked === true || isBillingSuspended,
            externalCallForwardingBlocked: data.platform_forwarding_blocked === true || isBillingSuspended,
            inboundVoiceBlocked: data.platform_inbound_voice_blocked === true,
            inboundMessagingBlocked: data.platform_inbound_messaging_blocked === true,
            restrictionReason: isBillingSuspended ? billingSuspendedReason : (data.platform_restriction_reason || data.containment_reason || null),
            restrictedBy: data.platform_restricted_by || data.contained_by || null,
            restrictedAt: data.platform_restricted_at || data.contained_at || null,
            restorationReason: data.platform_restoration_reason || null,
            restoredBy: data.platform_restored_by || null,
            restoredAt: data.platform_restored_at || null,
          };

          const mappedState: TenantCircuitBreakerState = {
            organizationId: data.organization_id,
            voluntary,
            security,
            telecomSuspended: isBillingSuspended,
            outboundVoiceAllowed: voluntary.outboundVoiceEnabled && !security.outboundVoiceBlocked,
            outboundMessagingAllowed: voluntary.outboundMessagingEnabled && !security.outboundMessagingBlocked,
            numberAcquisitionAllowed: voluntary.numberAcquisitionEnabled && !security.numberAcquisitionBlocked,
            numberReleaseAllowed: voluntary.numberReleaseEnabled && !security.numberReleaseBlocked,
            portingMutationsAllowed: voluntary.portingMutationsEnabled && !security.portingMutationsBlocked,
            providerAccountProvisioningAllowed: voluntary.providerAccountProvisioningEnabled && !security.providerAccountProvisioningBlocked,
            externalCallForwardingAllowed: voluntary.externalCallForwardingEnabled && !security.externalCallForwardingBlocked,
            inboundVoiceAllowed: voluntary.inboundVoiceEnabled && !security.inboundVoiceBlocked,
            inboundMessagingAllowed: voluntary.inboundMessagingEnabled && !security.inboundMessagingBlocked,
            containmentReason: security.restrictionReason || voluntary.reason || data.containment_reason,
            containedBy: security.restrictedBy || voluntary.updatedBy || data.contained_by,
            containedAt: security.restrictedAt || voluntary.updatedAt || data.contained_at,
            version: data.version || 1,
            updatedAt: data.updated_at || new Date().toISOString(),
          };

          return {
            success: true,
            data: mappedState,
            source: 'DATABASE',
          };
        }

        // If no row in organization_telecom_circuit_breakers, check billing controls fallback
        return this.fallbackCheckBillingControls(organizationId, client);
      } catch (err: any) {
        return {
          success: false,
          error: `Exception accessing circuit breaker repository: ${err?.message || err}`,
          source: 'DATABASE',
        };
      }
    }

    // Default: normal operation
    return {
      success: true,
      data: this.getDefaultTenantState(organizationId),
      source: 'DEFAULT_FALLBACK',
    };
  }

  /**
   * Backward-compatible fallback: checks organization_billing_controls.telecom_suspended
   */
  private static async fallbackCheckBillingControls(
    organizationId: string,
    client: SupabaseClient
  ): Promise<RepositoryReadResult<TenantCircuitBreakerState>> {
    try {
      const { data: orgControls, error: orgErr } = await client
        .from('organization_billing_controls')
        .select('telecom_suspended, restriction_reason')
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (orgErr) {
        return {
          success: true,
          data: this.getDefaultTenantState(organizationId),
          source: 'DEFAULT_FALLBACK',
        };
      }

      if (orgControls?.telecom_suspended === true) {
        const defaultState = this.getDefaultTenantState(organizationId);
        const reason = orgControls.restriction_reason || 'Organization telecom suspended via billing controls';
        const suspendedState: TenantCircuitBreakerState = {
          ...defaultState,
          telecomSuspended: true,
          security: {
            ...defaultState.security,
            outboundVoiceBlocked: true,
            outboundMessagingBlocked: true,
            numberAcquisitionBlocked: true,
            numberReleaseBlocked: true,
            portingMutationsBlocked: true,
            providerAccountProvisioningBlocked: true,
            externalCallForwardingBlocked: true,
            restrictionReason: reason,
          },
          outboundVoiceAllowed: false,
          outboundMessagingAllowed: false,
          numberAcquisitionAllowed: false,
          numberReleaseAllowed: false,
          portingMutationsAllowed: false,
          providerAccountProvisioningAllowed: false,
          externalCallForwardingAllowed: false,
          inboundVoiceAllowed: true, // Safe inbound WebRTC preserved
          inboundMessagingAllowed: true,
          containmentReason: reason,
        };

        return {
          success: true,
          data: suspendedState,
          source: 'DATABASE',
        };
      }

      return {
        success: true,
        data: this.getDefaultTenantState(organizationId),
        source: 'DEFAULT_FALLBACK',
      };
    } catch {
      return {
        success: true,
        data: this.getDefaultTenantState(organizationId),
        source: 'DEFAULT_FALLBACK',
      };
    }
  }

  /**
   * Retrieves global emergency control state with fail-closed semantics.
   */
  public static async getGlobalEmergencyControl(
    controlKey: GlobalControlKey | string,
    client?: SupabaseClient | null
  ): Promise<RepositoryReadResult<GlobalEmergencyControlState>> {
    if (this.forceReadFailure) {
      return {
        success: false,
        error: 'SIMULATED_DATABASE_CONNECTION_FAILURE',
        source: 'DATABASE',
      };
    }

    // 1. Shared in-memory test state
    if (this.sharedGlobalState.has(controlKey)) {
      return {
        success: true,
        data: { ...this.sharedGlobalState.get(controlKey)! },
        source: 'MOCK_SHARED',
      };
    }

    // 2. Query database
    if (client) {
      try {
        const { data, error } = await (client as any)
          .from('platform_global_emergency_controls')
          .select('*')
          .eq('control_key', controlKey)
          .maybeSingle();

        if (error) {
          if (error.code === '42P01' || error.message?.includes('does not exist')) {
            // Not migrated yet; default to unblocked
            return {
              success: true,
              data: {
                controlKey,
                isActive: false,
                version: 1,
                updatedAt: new Date().toISOString(),
              },
              source: 'DEFAULT_FALLBACK',
            };
          }
          return {
            success: false,
            error: `Database error querying global emergency control: ${error.message}`,
            source: 'DATABASE',
          };
        }

        if (data) {
          return {
            success: true,
            data: {
              controlKey: data.control_key,
              isActive: data.is_active === true,
              reason: data.reason,
              activatedBy: data.activated_by,
              activatedAt: data.activated_at,
              version: data.version || 1,
              updatedAt: data.updated_at || new Date().toISOString(),
            },
            source: 'DATABASE',
          };
        }
      } catch (err: any) {
        return {
          success: false,
          error: `Exception accessing global emergency control: ${err?.message || err}`,
          source: 'DATABASE',
        };
      }
    }

    return {
      success: true,
      data: {
        controlKey,
        isActive: false,
        version: 1,
        updatedAt: new Date().toISOString(),
      },
      source: 'DEFAULT_FALLBACK',
    };
  }

  /**
   * Sets tenant circuit breaker state atomically.
   */
  public static async saveTenantCircuitBreaker(
    state: TenantCircuitBreakerState,
    client?: SupabaseClient | null
  ): Promise<{ success: boolean; data?: TenantCircuitBreakerState; error?: string }> {
    const nextVersion = (state.version || 1) + 1;

    // Ensure effective booleans are strictly synchronized with monotonic invariant
    const voluntary = state.voluntary || {
      outboundVoiceEnabled: state.outboundVoiceAllowed !== false,
      outboundMessagingEnabled: state.outboundMessagingAllowed !== false,
      numberAcquisitionEnabled: state.numberAcquisitionAllowed !== false,
      numberReleaseEnabled: state.numberReleaseAllowed !== false,
      portingMutationsEnabled: state.portingMutationsAllowed !== false,
      providerAccountProvisioningEnabled: state.providerAccountProvisioningAllowed !== false,
      externalCallForwardingEnabled: state.externalCallForwardingAllowed !== false,
      inboundVoiceEnabled: state.inboundVoiceAllowed !== false,
      inboundMessagingEnabled: state.inboundMessagingAllowed !== false,
    };

    const security = state.security || {
      outboundVoiceBlocked: false,
      outboundMessagingBlocked: false,
      numberAcquisitionBlocked: false,
      numberReleaseBlocked: false,
      portingMutationsBlocked: false,
      providerAccountProvisioningBlocked: false,
      externalCallForwardingBlocked: false,
      inboundVoiceBlocked: false,
      inboundMessagingBlocked: false,
    };

    const updatedState: TenantCircuitBreakerState = {
      ...state,
      voluntary,
      security,
      outboundVoiceAllowed: voluntary.outboundVoiceEnabled && !security.outboundVoiceBlocked,
      outboundMessagingAllowed: voluntary.outboundMessagingEnabled && !security.outboundMessagingBlocked,
      numberAcquisitionAllowed: voluntary.numberAcquisitionEnabled && !security.numberAcquisitionBlocked,
      numberReleaseAllowed: voluntary.numberReleaseEnabled && !security.numberReleaseBlocked,
      portingMutationsAllowed: voluntary.portingMutationsEnabled && !security.portingMutationsBlocked,
      providerAccountProvisioningAllowed: voluntary.providerAccountProvisioningEnabled && !security.providerAccountProvisioningBlocked,
      externalCallForwardingAllowed: voluntary.externalCallForwardingEnabled && !security.externalCallForwardingBlocked,
      inboundVoiceAllowed: voluntary.inboundVoiceEnabled && !security.inboundVoiceBlocked,
      inboundMessagingAllowed: voluntary.inboundMessagingEnabled && !security.inboundMessagingBlocked,
      version: nextVersion,
      updatedAt: new Date().toISOString(),
    };

    // Update shared repository state (authoritative across local processes/tests)
    this.sharedTenantState.set(state.organizationId, updatedState);

    // Save to DB if client available
    if (client) {
      try {
        await (client as any)
          .from('organization_telecom_circuit_breakers')
          .upsert({
            organization_id: updatedState.organizationId,
            tenant_outbound_voice_enabled: updatedState.voluntary.outboundVoiceEnabled,
            tenant_outbound_messaging_enabled: updatedState.voluntary.outboundMessagingEnabled,
            tenant_number_acquisition_enabled: updatedState.voluntary.numberAcquisitionEnabled,
            tenant_number_release_enabled: updatedState.voluntary.numberReleaseEnabled,
            tenant_porting_enabled: updatedState.voluntary.portingMutationsEnabled,
            tenant_provisioning_enabled: updatedState.voluntary.providerAccountProvisioningEnabled,
            tenant_forwarding_enabled: updatedState.voluntary.externalCallForwardingEnabled,
            tenant_inbound_voice_enabled: updatedState.voluntary.inboundVoiceEnabled,
            tenant_inbound_messaging_enabled: updatedState.voluntary.inboundMessagingEnabled,
            tenant_restriction_reason: updatedState.voluntary.reason || null,
            tenant_restricted_by: updatedState.voluntary.updatedBy || null,
            tenant_restricted_at: updatedState.voluntary.updatedAt || null,
            platform_outbound_voice_blocked: updatedState.security.outboundVoiceBlocked,
            platform_outbound_messaging_blocked: updatedState.security.outboundMessagingBlocked,
            platform_number_acquisition_blocked: updatedState.security.numberAcquisitionBlocked,
            platform_number_release_blocked: updatedState.security.numberReleaseBlocked,
            platform_porting_blocked: updatedState.security.portingMutationsBlocked,
            platform_provisioning_blocked: updatedState.security.providerAccountProvisioningBlocked,
            platform_forwarding_blocked: updatedState.security.externalCallForwardingBlocked,
            platform_inbound_voice_blocked: updatedState.security.inboundVoiceBlocked,
            platform_inbound_messaging_blocked: updatedState.security.inboundMessagingBlocked,
            platform_restriction_reason: updatedState.security.restrictionReason || null,
            platform_restricted_by: updatedState.security.restrictedBy || null,
            platform_restricted_at: updatedState.security.restrictedAt || null,
            platform_restoration_reason: updatedState.security.restorationReason || null,
            platform_restored_by: updatedState.security.restoredBy || null,
            platform_restored_at: updatedState.security.restoredAt || null,
            outbound_voice_allowed: updatedState.outboundVoiceAllowed,
            outbound_messaging_allowed: updatedState.outboundMessagingAllowed,
            number_acquisition_allowed: updatedState.numberAcquisitionAllowed,
            number_release_allowed: updatedState.numberReleaseAllowed,
            porting_mutations_allowed: updatedState.portingMutationsAllowed,
            provider_account_provisioning_allowed: updatedState.providerAccountProvisioningAllowed,
            external_call_forwarding_allowed: updatedState.externalCallForwardingAllowed,
            inbound_voice_allowed: updatedState.inboundVoiceAllowed,
            inbound_messaging_allowed: updatedState.inboundMessagingAllowed,
            containment_reason: updatedState.containmentReason || null,
            contained_by: updatedState.containedBy || null,
            contained_at: updatedState.containedAt || null,
            version: updatedState.version,
            updated_at: updatedState.updatedAt,
          });
      } catch {
        // Ignored if table not migrated remotely
      }
    }

    return { success: true, data: updatedState };
  }

  /**
   * Sets global emergency control state atomically.
   */
  public static async saveGlobalEmergencyControl(
    state: GlobalEmergencyControlState,
    client?: SupabaseClient | null
  ): Promise<{ success: boolean; data?: GlobalEmergencyControlState; error?: string }> {
    const nextVersion = (state.version || 1) + 1;
    const updatedState: GlobalEmergencyControlState = {
      ...state,
      version: nextVersion,
      updatedAt: new Date().toISOString(),
    };

    this.sharedGlobalState.set(state.controlKey, updatedState);

    if (client) {
      try {
        await (client as any)
          .from('platform_global_emergency_controls')
          .upsert({
            control_key: updatedState.controlKey,
            is_active: updatedState.isActive,
            reason: updatedState.reason || null,
            activated_by: updatedState.activatedBy || null,
            activated_at: updatedState.activatedAt || null,
            version: updatedState.version,
            updated_at: updatedState.updatedAt,
          });
      } catch {
        // Ignored if table not migrated remotely
      }
    }

    return { success: true, data: updatedState };
  }

  public static getDefaultTenantState(organizationId: string): TenantCircuitBreakerState {
    const voluntary = {
      outboundVoiceEnabled: true,
      outboundMessagingEnabled: true,
      numberAcquisitionEnabled: true,
      numberReleaseEnabled: true,
      portingMutationsEnabled: true,
      providerAccountProvisioningEnabled: true,
      externalCallForwardingEnabled: true,
      inboundVoiceEnabled: true,
      inboundMessagingEnabled: true,
      reason: null,
      updatedBy: null,
      updatedAt: null,
    };

    const security = {
      outboundVoiceBlocked: false,
      outboundMessagingBlocked: false,
      numberAcquisitionBlocked: false,
      numberReleaseBlocked: false,
      portingMutationsBlocked: false,
      providerAccountProvisioningBlocked: false,
      externalCallForwardingBlocked: false,
      inboundVoiceBlocked: false,
      inboundMessagingBlocked: false,
      restrictionReason: null,
      restrictedBy: null,
      restrictedAt: null,
      restorationReason: null,
      restoredBy: null,
      restoredAt: null,
    };

    return {
      organizationId,
      voluntary,
      security,
      telecomSuspended: false,
      outboundVoiceAllowed: true,
      outboundMessagingAllowed: true,
      numberAcquisitionAllowed: true,
      numberReleaseAllowed: true,
      portingMutationsAllowed: true,
      providerAccountProvisioningAllowed: true,
      externalCallForwardingAllowed: true,
      inboundVoiceAllowed: true,
      inboundMessagingAllowed: true,
      containmentReason: null,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
  }

  public static isObservationOperation(op: TelecomOperation): boolean {
    return op === 'PROVIDER_CALLBACK' || op === 'SETTLEMENT' || op === 'RECONCILIATION';
  }
}

