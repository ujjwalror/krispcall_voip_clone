import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getEntitlementLimit } from '@/lib/entitlements/server';

export const CURRENT_LEGACY_SEAT_POLICY = 'LEGACY_MEMBER_COUNT_MINUS_INCLUDED';

export const COMMERCIAL_PLAN_USER_LIMITS: Record<string, number> = {
  starter: 5,
  pro: 20,
  business: 50,
};

export interface SeatCalculationResult {
  policy: typeof CURRENT_LEGACY_SEAT_POLICY;
  organizationId: string;
  totalMembers: number;
  activeMembers: number;
  invitedMembers: number;
  pendingInvitations: number;
  usedOrReservedSeats: number;
  includedSeats: number;
  billableSeats: number;
  maxActiveUsersLimit: number | null;
  canAddMoreSeats: boolean;
}

/**
 * Centralized Seat Policy Foundation Service (Phase 18C & 19F.2A.1).
 * Encapsulates calculation of workspace member seat count under approved commercial policy.
 *
 * Rules:
 * - Billable seats = active Owner, Admin, Member.
 * - Used/Reserved seats = active accepted users + valid pending invitations (reserve seat capacity).
 * - Enforces plan active-user limit server-side (Starter: 5, Pro: 20, Business: 50).
 */
export class SeatBillingService {
  /**
   * Resolves the server-side maximum active users limit for a plan code/stable key.
   */
  static getMaxActiveUsersForPlan(planCode: string): number | null {
    if (!planCode) return null;
    const cleanKey = planCode.toLowerCase().trim();
    return COMMERCIAL_PLAN_USER_LIMITS[cleanKey] ?? null;
  }

  /**
   * Calculates the authoritative seat metrics and active user limit eligibility for an organization.
   */
  static async calculateSeats(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<SeatCalculationResult> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    // 1. Fetch organization profiles/members
    const { data: members, error } = await (supabase as any)
      .from('profiles')
      .select('id, active, role')
      .eq('organization_id', organizationId);

    if (error || !members) {
      console.error('[SeatBillingService] Error fetching organization profiles:', error);
      return {
        policy: CURRENT_LEGACY_SEAT_POLICY,
        organizationId,
        totalMembers: 0,
        activeMembers: 0,
        invitedMembers: 0,
        pendingInvitations: 0,
        usedOrReservedSeats: 0,
        includedSeats: 0,
        billableSeats: 0,
        maxActiveUsersLimit: null,
        canAddMoreSeats: false,
      };
    }

    const totalMembers = members.length;
    const activeMembers = members.filter((m: any) => m.active !== false).length;
    const invitedMembers = members.filter((m: any) => m.active === false).length;

    // 1b. Fetch valid pending invitations to reserve seat capacity
    const { data: pendingInvites } = await (supabase as any)
      .from('organization_invitations')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString());

    const pendingInvitations = pendingInvites ? pendingInvites.length : 0;
    const usedOrReservedSeats = activeMembers + pendingInvitations;

    // 2. Fetch organization subscription and plan to check max user limit
    const { data: sub } = await (supabase as any)
      .from('organization_subscriptions')
      .select('plans!inner(code, stable_key)')
      .eq('organization_id', organizationId)
      .maybeSingle();

    const planCode = sub?.plans?.stable_key || sub?.plans?.code || '';
    const maxLimitFromCatalog = this.getMaxActiveUsersForPlan(planCode);

    // Also check entitlement limit 'team.seats.max'
    const entitlementMax = await getEntitlementLimit('team.seats.max', supabase);
    const maxActiveUsersLimit = maxLimitFromCatalog ?? (entitlementMax !== null && entitlementMax > 0 ? entitlementMax : null);

    // 3. Resolve included seat entitlement for the organization
    const includedLimit = await getEntitlementLimit('team.seats.included', supabase);
    const includedSeats = includedLimit !== null && Number.isFinite(includedLimit) && includedLimit >= 0
      ? Math.floor(includedLimit)
      : 0;

    const billableSeats = Math.max(0, activeMembers - includedSeats);
    const canAddMoreSeats = maxActiveUsersLimit === null || usedOrReservedSeats < maxActiveUsersLimit;

    return {
      policy: CURRENT_LEGACY_SEAT_POLICY,
      organizationId,
      totalMembers,
      activeMembers,
      invitedMembers,
      pendingInvitations,
      usedOrReservedSeats,
      includedSeats,
      billableSeats,
      maxActiveUsersLimit,
      canAddMoreSeats,
    };
  }

  /**
   * Server-side check: Returns true if organization can add or activate another user without violating plan limits.
   */
  static async canAddActiveUser(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<{ allowed: boolean; activeMembers: number; usedOrReservedSeats: number; limit: number | null; reason?: string }> {
    const seatMetrics = await this.calculateSeats(organizationId, clientOverride);

    if (!seatMetrics.canAddMoreSeats && seatMetrics.maxActiveUsersLimit !== null) {
      return {
        allowed: false,
        activeMembers: seatMetrics.activeMembers,
        usedOrReservedSeats: seatMetrics.usedOrReservedSeats,
        limit: seatMetrics.maxActiveUsersLimit,
        reason: `Your workspace has reached its member limit. You’re using ${seatMetrics.usedOrReservedSeats} of ${seatMetrics.maxActiveUsersLimit} member seats on your current plan. Remove an unused member or upgrade your plan to invite another person.`,
      };
    }

    return {
      allowed: true,
      activeMembers: seatMetrics.activeMembers,
      usedOrReservedSeats: seatMetrics.usedOrReservedSeats,
      limit: seatMetrics.maxActiveUsersLimit,
    };
  }
}
