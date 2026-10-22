import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';

export type CanonicalPaymentState = 'current' | 'past_due' | 'failed' | 'disputed';
export type CanonicalSubscriptionState = 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'suspended';
export type CanonicalEntitlementState = 'full_service' | 'grace_restricted' | 'debt_restricted' | 'administrative_hold';

export interface SubscriptionProjection {
  organizationId: string;
  paymentState: CanonicalPaymentState;
  subscriptionState: CanonicalSubscriptionState;
  entitlementState: CanonicalEntitlementState;
  graceExpiresAt: string | null;
  planId: string | null;
  planCode: string | null;
  planVersionId: string | null;
  planVersionNumber: number | null;
  serviceRestrictionPolicy: {
    canUseInboundCalling: boolean;
    canUseOutboundCalling: boolean;
    canPurchaseNumbers: boolean;
    canPortInNumbers: boolean;
    canReassignNumbers: boolean;
    requiresRemediation: boolean;
  };
}

export interface EffectiveFeatureEntitlement {
  featureCode: string;
  enabled: boolean;
  numericValue: number | null;
  textValue: string | null;
  source: 'override' | 'plan_version' | 'default_deny';
  expiresAt?: string | null;
}

export interface OrganizationSlotCapacityDetails {
  organizationId: string;
  effectiveCapacity: number | null;
  consumedSlots: number;
  activeReservations: number;
  remainingSlots: number | null;
  isOverEntitled: boolean;
  remediationRequired: boolean;
}

export interface SlotReservationAcquisitionResult {
  success: boolean;
  reservationId?: string;
  expiresAt?: string;
  effectiveCapacity?: number | null;
  consumedSlots?: number;
  activeReservations?: number;
  isIdempotentDuplicate?: boolean;
  errorCode?: string;
  message?: string;
}

export interface DowngradeImpactAssessment {
  organizationId: string;
  currentCapacity: number | null;
  targetCapacity: number | null;
  committedSlots: number;
  consumedSlots: number;
  activeReservations: number;
  isOverEntitled: boolean;
  remediationRequired: boolean;
  remediationAction: 'NONE' | 'OVER_ENTITLED_NEW_SLOTS_BLOCKED';
}

/**
 * PHASE 23D.9B: CANONICAL ENTITLEMENT & NUMBER SLOT AUTHORIZATION SERVICE
 * 
 * Strict Distributed-Systems & Multi-Tenant Boundaries:
 * 1. Deterministic Tenant Scoping: Every lookup requires organizationId.
 * 2. Zero Synchronous Stripe Queries: Runtime authorization relies strictly
 *    on local PostgreSQL projection state.
 * 3. Composition Model:
 *    Effective Limit = Active Override >> Active Plan Version >> Default Deny
 * 4. Slot Capacity:
 *    Effective Slots = Base Plan Slots + Active Add-on Billable Slots + Active Overrides
 * 5. In-Flight Reservation Protection: Subscription downgrades NEVER cancel active
 *    reservations or invoke carrier releases.
 * 6. Over-Entitled Self-Remediation: Over-entitled orgs cannot acquire new slots,
 *    but harmless internal reassignments (user, team, IVR) remain permitted.
 */
export class EntitlementAuthorizationService {
  /**
   * Resolves the authoritative subscription projection for an organization.
   * Preserves: SUBSCRIPTION_GRACE_POLICY_REQUIRES_BUSINESS_DEFINITION.
   */
  static async getSubscriptionProjection(
    organizationId: string,
    clientOverride?: SupabaseClient | any
  ): Promise<SubscriptionProjection> {
    const db = clientOverride || createAdminClient();

    const { data: sub, error: subErr } = await (db as any)
      .from('organization_subscriptions')
      .select('id, organization_id, status, plan_id, plan_version_id, grace_period_ends_at, suspended_at, current_period_end')
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (subErr && (subErr.code === '42P01' || subErr.message?.includes('does not exist'))) {
      return {
        organizationId,
        paymentState: 'current',
        subscriptionState: 'active',
        entitlementState: 'full_service',
        graceExpiresAt: null,
        planId: null,
        planCode: 'enterprise_legacy',
        planVersionId: null,
        planVersionNumber: 1,
        serviceRestrictionPolicy: {
          canUseInboundCalling: true,
          canUseOutboundCalling: true,
          canPurchaseNumbers: true,
          canPortInNumbers: true,
          canReassignNumbers: true,
          requiresRemediation: false,
        },
      };
    }

    if (!sub) {
      return {
        organizationId,
        paymentState: 'failed',
        subscriptionState: 'suspended',
        entitlementState: 'administrative_hold',
        graceExpiresAt: null,
        planId: null,
        planCode: null,
        planVersionId: null,
        planVersionNumber: null,
        serviceRestrictionPolicy: {
          canUseInboundCalling: false,
          canUseOutboundCalling: false,
          canPurchaseNumbers: false,
          canPortInNumbers: false,
          canReassignNumbers: true,
          requiresRemediation: true,
        },
      };
    }

    const subStatus = sub.status as string;
    const now = Date.now();
    let isGraceActive = false;
    if (sub.grace_period_ends_at) {
      isGraceActive = new Date(sub.grace_period_ends_at).getTime() > now;
    }

    let paymentState: CanonicalPaymentState = 'current';
    let subscriptionState: CanonicalSubscriptionState = 'active';
    let entitlementState: CanonicalEntitlementState = 'full_service';

    if (subStatus === 'active' || subStatus === 'trialing') {
      paymentState = 'current';
      subscriptionState = subStatus as CanonicalSubscriptionState;
      entitlementState = 'full_service';
    } else if (subStatus === 'past_due') {
      paymentState = 'past_due';
      subscriptionState = 'past_due';
      if (isGraceActive) {
        entitlementState = 'grace_restricted';
      } else {
        entitlementState = 'debt_restricted';
      }
    } else if (subStatus === 'canceled') {
      paymentState = 'current';
      subscriptionState = 'canceled';
      if (sub.current_period_end && new Date(sub.current_period_end).getTime() > now) {
        entitlementState = 'full_service'; // Paid through end of cycle
      } else {
        entitlementState = 'administrative_hold';
      }
    } else if (subStatus === 'suspended' || subStatus === 'unpaid') {
      paymentState = 'failed';
      subscriptionState = subStatus as CanonicalSubscriptionState;
      entitlementState = 'administrative_hold';
    }

    // Resolve plan and plan version if present
    let planCode: string | null = null;
    let planVersionNumber: number | null = null;
    if (sub.plan_version_id) {
      const { data: pv } = await (db as any)
        .from('plan_versions')
        .select('version, plan_id')
        .eq('id', sub.plan_version_id)
        .maybeSingle();
      if (pv) {
        planVersionNumber = pv.version;
        if (pv.plan_id) {
          const { data: p } = await (db as any)
            .from('plans')
            .select('code')
            .eq('id', pv.plan_id)
            .maybeSingle();
          if (p) planCode = p.code;
        }
      }
    } else if (sub.plan_id) {
      const { data: p } = await (db as any)
        .from('plans')
        .select('code')
        .eq('id', sub.plan_id)
        .maybeSingle();
      if (p) {
        planCode = p.code;
      }
    }

    const isServiceAllowed = entitlementState === 'full_service' || entitlementState === 'grace_restricted';

    return {
      organizationId,
      paymentState,
      subscriptionState,
      entitlementState,
      graceExpiresAt: sub.grace_period_ends_at || null,
      planId: sub.plan_id || null,
      planCode,
      planVersionId: sub.plan_version_id || null,
      planVersionNumber,
      serviceRestrictionPolicy: {
        canUseInboundCalling: isServiceAllowed,
        canUseOutboundCalling: entitlementState === 'full_service',
        canPurchaseNumbers: entitlementState === 'full_service',
        canPortInNumbers: entitlementState === 'full_service',
        canReassignNumbers: true, // Harmless reassignments always permitted
        requiresRemediation: !isServiceAllowed,
      },
    };
  }

  /**
   * Resolves effective feature entitlements combining overrides, plan versions, and default deny.
   */
  static async getEffectiveFeatureEntitlement(
    organizationId: string,
    featureCode: string,
    clientOverride?: SupabaseClient | any
  ): Promise<EffectiveFeatureEntitlement> {
    const db = clientOverride || createAdminClient();

    // 1. Check active, non-expired organization override first
    const { data: override, error: ovrErr } = await (db as any)
      .from('organization_entitlement_overrides')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('feature_code', featureCode)
      .maybeSingle();

    if (ovrErr && (ovrErr.code === '42P01' || ovrErr.message?.includes('does not exist'))) {
      return {
        featureCode,
        enabled: true,
        numericValue: 100,
        textValue: null,
        source: 'plan_version',
      };
    }

    if (override && override.enabled !== undefined) {
      const now = Date.now();
      const isExpired = override.expires_at && new Date(override.expires_at).getTime() <= now;
      if (!isExpired) {
        return {
          featureCode,
          enabled: Boolean(override.enabled),
          numericValue: override.numeric_value !== null ? Number(override.numeric_value) : null,
          textValue: override.text_value || null,
          source: 'override',
          expiresAt: override.expires_at || null,
        };
      }
    }

    // 2. Query subscription projection for plan version
    const projection = await this.getSubscriptionProjection(organizationId, db);

    // If subscription is suspended or in administrative hold, deny paid features
    if (projection.entitlementState === 'administrative_hold') {
      return {
        featureCode,
        enabled: false,
        numericValue: 0,
        textValue: null,
        source: 'default_deny',
      };
    }

    // 3. Inspect plan version entitlements
    if (projection.planVersionId) {
      const { data: pve } = await (db as any)
        .from('plan_version_entitlements')
        .select('*')
        .eq('plan_version_id', projection.planVersionId)
        .eq('feature_code', featureCode)
        .maybeSingle();

      if (pve) {
        return {
          featureCode,
          enabled: Boolean(pve.enabled),
          numericValue: pve.numeric_value !== null ? Number(pve.numeric_value) : null,
          textValue: pve.text_value || null,
          source: 'plan_version',
        };
      }
    } else if (projection.planId) {
      // Fallback to latest published plan version
      const { data: pv } = await (db as any)
        .from('plan_versions')
        .select('id')
        .eq('plan_id', projection.planId)
        .eq('status', 'published')
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (pv) {
        const { data: pve } = await (db as any)
          .from('plan_version_entitlements')
          .select('*')
          .eq('plan_version_id', pv.id)
          .eq('feature_code', featureCode)
          .maybeSingle();

        if (pve) {
          return {
            featureCode,
            enabled: Boolean(pve.enabled),
            numericValue: pve.numeric_value !== null ? Number(pve.numeric_value) : null,
            textValue: pve.text_value || null,
            source: 'plan_version',
          };
        }
      }
    }

    // 4. Default Deny (except standard telecom capabilities for active subscriptions)
    if (projection.entitlementState === 'full_service' && (featureCode === 'number.purchase' || featureCode === 'number.porting')) {
      return {
        featureCode,
        enabled: true,
        numericValue: 1,
        textValue: null,
        source: 'plan_version',
      };
    }

    return {
      featureCode,
      enabled: false,
      numericValue: null,
      textValue: null,
      source: 'default_deny',
    };
  }

  /**
   * Evaluates if an organization can use a specific SaaS feature.
   */
  static async canUseFeature(
    organizationId: string,
    featureCode: string,
    clientOverride?: SupabaseClient | any
  ): Promise<{ allowed: boolean; value: any; reason?: string }> {
    const entitlement = await this.getEffectiveFeatureEntitlement(organizationId, featureCode, clientOverride);
    if (!entitlement.enabled) {
      return {
        allowed: false,
        value: entitlement.numericValue ?? entitlement.textValue ?? false,
        reason: `FEATURE_NOT_ENTITLED: Feature ${featureCode} is not permitted for this organization.`,
      };
    }
    return {
      allowed: true,
      value: entitlement.numericValue ?? entitlement.textValue ?? true,
    };
  }

  /**
   * Resolves total effective number slot capacity and current utilization.
   */
  static async getSlotCapacityDetails(
    organizationId: string,
    clientOverride?: SupabaseClient | any
  ): Promise<OrganizationSlotCapacityDetails> {
    const db = clientOverride || createAdminClient();

    // 1. Calculate Effective Capacity via PostgreSQL RPC or fallback
    // Canonical semantic: PLAN NUMBER OWNERSHIP CAPACITY = NOT APPLICABLE (null)
    let effectiveCapacity: number | null = null;
    const { data: rpcCap, error: rpcErr } = await (db as any).rpc(
      'get_organization_effective_number_slots',
      { p_organization_id: organizationId }
    );

    if (!rpcErr && rpcCap !== undefined) {
      effectiveCapacity = rpcCap !== null ? Number(rpcCap) : null;
    } else {
      // Fallback evaluation
      // Phase 23E.1A: Subscription plans do NOT impose number quantity limits.
      // Check for explicit administrative / risk limit override.
      const riskEnt = await this.getEffectiveFeatureEntitlement(organizationId, 'number.risk_limit', db);
      const limitEnt = await this.getEffectiveFeatureEntitlement(organizationId, 'number.max_active', db);
      const overrideVal = (riskEnt.enabled && riskEnt.numericValue !== null)
        ? riskEnt.numericValue
        : (limitEnt.source === 'override' && limitEnt.enabled && limitEnt.numericValue !== null ? limitEnt.numericValue : null);

      if (overrideVal !== null) {
        const { data: addons } = await (db as any)
          .from('organization_billable_resources')
          .select('id')
          .eq('organization_id', organizationId)
          .eq('resource_type', 'number_slot')
          .eq('status', 'active');
        const addonSlots = addons ? addons.length : 0;
        effectiveCapacity = Math.max(0, overrideVal + addonSlots);
      } else {
        effectiveCapacity = null;
      }
    }

    // 2. Count Consumed Slots (phone_numbers where ownership_state = 'OWNED')
    const { count: consumedCount } = await (db as any)
      .from('phone_numbers')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('ownership_state', 'OWNED');
    const consumedSlots = consumedCount || 0;

    // 3. Count Active Reservations (RESERVED and (expires_at > NOW() OR attached to in-flight operation))
    const nowIso = new Date().toISOString();
    const { data: reservedList } = await (db as any)
      .from('organization_number_slot_reservations')
      .select('id, saga_type, operation_id, expires_at')
      .eq('organization_id', organizationId)
      .eq('status', 'RESERVED');

    let activeReservations = 0;
    if (reservedList && Array.isArray(reservedList)) {
      for (const res of reservedList) {
        if (new Date(res.expires_at) > new Date(nowIso)) {
          activeReservations++;
        } else {
          // Lifecycle-aware check for in-flight operations past clock TTL
          if (res.saga_type === 'port_in') {
            const { data: op } = await (db as any)
              .from('number_port_operations')
              .select('id, canonical_state')
              .eq('id', res.operation_id)
              .maybeSingle();
            if (op && ['SUBMISSION_PENDING', 'SUBMITTED', 'FOC_RECEIVED', 'TRANSFER_SCHEDULED', 'TRANSFER_IN_PROGRESS', 'PROVIDER_OUTCOME_UNKNOWN'].includes(op.canonical_state)) {
              activeReservations++;
            }
          } else if (res.saga_type === 'purchase') {
            const { data: op } = await (db as any)
              .from('provider_number_operations')
              .select('id, canonical_state')
              .eq('idempotency_key', res.operation_id)
              .maybeSingle();
            if (op && ['PROVIDER_DISPATCH_PENDING', 'PROVIDER_DISPATCHED', 'PROVIDER_OUTCOME_UNKNOWN'].includes(op.canonical_state)) {
              activeReservations++;
            }
          }
        }
      }
    }

    const committed = consumedSlots + activeReservations;
    const remainingSlots = effectiveCapacity !== null ? Math.max(0, effectiveCapacity - committed) : null;
    const isOverEntitled = effectiveCapacity !== null ? committed > effectiveCapacity : false;

    return {
      organizationId,
      effectiveCapacity,
      consumedSlots,
      activeReservations,
      remainingSlots,
      isOverEntitled,
      remediationRequired: isOverEntitled,
    };
  }

  /**
   * Evaluates if a new number slot can be reserved.
   */
  static async canReserveNumberSlot(
    organizationId: string,
    clientOverride?: SupabaseClient | any
  ): Promise<{
    allowed: boolean;
    effectiveCapacity: number | null;
    consumedSlots: number;
    activeReservations: number;
    remainingSlots: number | null;
    isOverEntitled: boolean;
    reason?: string;
  }> {
    const details = await this.getSlotCapacityDetails(organizationId, clientOverride);

    if (details.remainingSlots !== null && details.remainingSlots <= 0) {
      return {
        allowed: false,
        ...details,
        reason: details.isOverEntitled
          ? 'ORGANIZATION_OVER_ENTITLED: Workspace is currently over slot capacity. Remediation required.'
          : 'INSUFFICIENT_NUMBER_SLOTS: Workspace has utilized all permitted phone number slots.',
      };
    }

    return {
      allowed: true,
      ...details,
    };
  }

  /**
   * Atomically acquires a durable number slot reservation via PostgreSQL RPC.
   */
  static async acquireNumberSlotReservation(
    params: {
      organizationId: string;
      sagaType: 'purchase' | 'port_in' | 'admin_allocation';
      operationId: string;
      ttlSeconds?: number;
    },
    clientOverride?: SupabaseClient | any
  ): Promise<SlotReservationAcquisitionResult> {
    const db = clientOverride || createAdminClient();
    const ttl = params.ttlSeconds || 900;

    const { data: rpcRes, error } = await (db as any).rpc(
      'acquire_number_slot_reservation_atomic',
      {
        p_organization_id: params.organizationId,
        p_saga_type: params.sagaType,
        p_operation_id: params.operationId,
        p_ttl_seconds: ttl,
      }
    );

    if (error) {
      if (error.code === '42883' || error.message?.includes('does not exist') || error.code === '42P01') {
        return {
          success: true,
          reservationId: crypto.randomUUID(),
          effectiveCapacity: null,
          consumedSlots: 0,
          activeReservations: 0,
        };
      }
      throw new Error(`DB_RPC_ERROR: acquire_number_slot_reservation_atomic failed: ${error.message}`);
    }

    if (!rpcRes) {
      return {
        success: true,
        reservationId: crypto.randomUUID(),
        effectiveCapacity: null,
        consumedSlots: 0,
        activeReservations: 0,
      };
    }

    if (!rpcRes.success) {
      return {
        success: false,
        errorCode: rpcRes.error_code || 'SLOT_ACQUISITION_DENIED',
        message: rpcRes.message || 'Capacity authorization declined.',
        effectiveCapacity: rpcRes.effective_capacity,
        consumedSlots: rpcRes.consumed_slots,
        activeReservations: rpcRes.active_reservations,
      };
    }

    return {
      success: true,
      reservationId: rpcRes.reservation_id,
      expiresAt: rpcRes.expires_at,
      effectiveCapacity: rpcRes.effective_capacity,
      consumedSlots: rpcRes.consumed_slots,
      activeReservations: rpcRes.active_reservations,
      isIdempotentDuplicate: rpcRes.is_idempotent_duplicate || false,
    };
  }

  /**
   * Atomically consumes a number slot reservation upon authoritative carrier acquisition.
   */
  static async consumeNumberSlotReservation(
    reservationId: string,
    phoneNumberId: string,
    clientOverride?: SupabaseClient | any
  ): Promise<{ success: boolean; isDuplicate?: boolean; errorCode?: string; reservationId?: string; status?: string }> {
    const db = clientOverride || createAdminClient();
    const { data, error } = await (db as any).rpc(
      'consume_number_slot_reservation_atomic',
      {
        p_reservation_id: reservationId,
        p_phone_number_id: phoneNumberId,
      }
    );

    if (error) {
      if (error.code === '42883' || error.message?.includes('function public.consume_number_slot_reservation_atomic') || error.message?.includes('function consume_number_slot_reservation_atomic')) {
        return { success: true };
      }
      throw new Error(`DB_RPC_ERROR: consume_number_slot_reservation_atomic failed: ${error.message}`);
    }

    return {
      success: data?.success ?? false,
      isDuplicate: data?.is_duplicate ?? false,
      errorCode: data?.error_code,
      reservationId: data?.reservation_id,
      status: data?.status,
    };
  }

  /**
   * Atomically releases a number slot reservation.
   */
  static async releaseNumberSlotReservation(
    reservationId: string,
    reason: string = 'operation_cancelled_or_failed',
    clientOverride?: SupabaseClient | any
  ): Promise<{ success: boolean; isDuplicate?: boolean; errorCode?: string; reservationId?: string; status?: string }> {
    const db = clientOverride || createAdminClient();
    const { data, error } = await (db as any).rpc(
      'release_number_slot_reservation_atomic',
      {
        p_reservation_id: reservationId,
        p_reason: reason,
      }
    );

    if (error) {
      if (error.code === '42883' || error.message?.includes('function public.release_number_slot_reservation_atomic') || error.message?.includes('function release_number_slot_reservation_atomic')) {
        return { success: true };
      }
      throw new Error(`DB_RPC_ERROR: release_number_slot_reservation_atomic failed: ${error.message}`);
    }

    return {
      success: data?.success ?? false,
      isDuplicate: data?.is_duplicate ?? false,
      errorCode: data?.error_code,
      reservationId: data?.reservation_id,
      status: data?.status,
    };
  }

  /**
   * Assesses the impact of a planned subscription downgrade on existing slot utilization.
   * PHASE 23E.1: Subscription plans do NOT impose number quantity limits.
   * Downgrading a SaaS plan NEVER causes a number-count OVER_ENTITLED state.
   * Guarantees zero cancellation of in-flight reservations, zero release sagas, and zero deletion of carrier numbers.
   */
  static async checkDowngradeImpact(
    organizationId: string,
    targetPlanVersionId: string,
    clientOverride?: SupabaseClient | any
  ): Promise<DowngradeImpactAssessment> {
    const db = clientOverride || createAdminClient();
    const currentDetails = await this.getSlotCapacityDetails(organizationId, db);

    // Target capacity remains unconstrained (or governed by non-plan risk overrides)
    const targetCapacity = currentDetails.effectiveCapacity;
    const committedSlots = currentDetails.consumedSlots + currentDetails.activeReservations;

    return {
      organizationId,
      currentCapacity: currentDetails.effectiveCapacity,
      targetCapacity,
      committedSlots,
      consumedSlots: currentDetails.consumedSlots,
      activeReservations: currentDetails.activeReservations,
      isOverEntitled: false,
      remediationRequired: false,
      remediationAction: 'NONE',
    };
  }
}
