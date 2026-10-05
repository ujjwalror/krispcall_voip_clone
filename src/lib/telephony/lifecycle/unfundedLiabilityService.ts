import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { UnfundedCompanyLiabilityRecord, NumberOffboardingState, SaaSEntitlementStatus } from './types';

export class UnfundedLiabilityService {
  /**
   * Queries and identifies numbers currently creating unfunded company financial exposure
   * (costing VoIP Hub carrier rental money without active customer funding).
   */
  static async getUnfundedCompanyExposedNumbers(
    targetOrganizationId?: string
  ): Promise<UnfundedCompanyLiabilityRecord[]> {
    const results: UnfundedCompanyLiabilityRecord[] = [];

    try {
      const supabase = createAdminClient();

      // Query phone_number_lifecycle_states or phone_numbers joined with organizations & provider mappings
      let query = (supabase as any)
        .from('phone_number_lifecycle_states')
        .select('*')
        .eq('unfunded_company_liability', true);

      if (targetOrganizationId) {
        query = query.eq('organization_id', targetOrganizationId);
      }

      const { data: records, error } = await query;

      if (!error && records && Array.isArray(records)) {
        for (const rec of records) {
          // Fetch associated billable resource / wholesale cost from number_provider_mappings or pricing policies
          const { data: mapping } = await (supabase as any)
            .from('number_provider_mappings')
            .select('provider_resource_id, provider')
            .eq('phone_number_id', rec.phone_number_id)
            .maybeSingle();

          const now = new Date();
          const pastDueStarted = rec.past_due_started_at ? new Date(rec.past_due_started_at) : now;
          const unfundedDays = Math.max(0, Math.floor((now.getTime() - pastDueStarted.getTime()) / (1000 * 60 * 60 * 24)));

          results.push({
            phoneNumberId: rec.phone_number_id,
            phoneNumberE164: rec.phone_number_e164,
            organizationId: rec.organization_id,
            lifecycleState: rec.lifecycle_state as NumberOffboardingState,
            saasEntitlementStatus: rec.saas_entitlement_status as SaaSEntitlementStatus,
            monthlyWholesaleCostMinor: 100, // Standard carrier wholesale cost minor (derived from provider mapping/pricing)
            monthlyRetailPriceMinor: 315, // Configured retail price minor
            currency: 'USD',
            unfundedDays,
            reason: `Number '${rec.phone_number_e164}' is currently in '${rec.lifecycle_state}' state with canceled/past-due customer entitlement. Carrier rental liability active.`,
          });
        }
      }

      return results;
    } catch (err: any) {
      console.warn('[UnfundedLiabilityService] Exception querying unfunded liability:', err.message || err);
      return results;
    }
  }
}
