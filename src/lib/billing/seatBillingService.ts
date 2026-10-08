import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getEntitlementLimit } from '@/lib/entitlements/server';

export const CURRENT_LEGACY_SEAT_POLICY = 'LEGACY_MEMBER_COUNT_MINUS_INCLUDED';

export interface SeatCalculationResult {
  policy: typeof CURRENT_LEGACY_SEAT_POLICY;
  organizationId: string;
  totalMembers: number;
  activeMembers: number;
  invitedMembers: number;
  includedSeats: number;
  billableSeats: number;
}

/**
 * Centralized Seat Policy Foundation Service (Phase 18B).
 * Encapsulates calculation of workspace member seat count under CURRENT_LEGACY_SEAT_POLICY.
 *
 * Rule:
 * Total seats = count of active and invited profiles in the organization.
 * Billable extra seats = Math.max(0, Total seats - includedSeats from entitlement 'team.seats.included').
 */
export class SeatBillingService {
  /**
   * Calculates the authoritative seat metrics for an organization.
   */
  static async calculateSeats(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<SeatCalculationResult> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    // 1. Fetch organization profiles/members count
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
        includedSeats: 0,
        billableSeats: 0,
      };
    }

    const totalMembers = members.length;
    const activeMembers = members.filter((m: any) => m.active !== false).length;
    const invitedMembers = members.filter((m: any) => m.active === false).length;

    // 2. Resolve included seat entitlement for the organization
    const includedLimit = await getEntitlementLimit('team.seats.included', supabase);
    const includedSeats = includedLimit !== null && Number.isFinite(includedLimit) && includedLimit >= 0
      ? Math.floor(includedLimit)
      : 0;

    const billableSeats = Math.max(0, totalMembers - includedSeats);

    return {
      policy: CURRENT_LEGACY_SEAT_POLICY,
      organizationId,
      totalMembers,
      activeMembers,
      invitedMembers,
      includedSeats,
      billableSeats,
    };
  }
}
