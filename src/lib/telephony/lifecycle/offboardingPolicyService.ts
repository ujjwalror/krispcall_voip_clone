import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { OffboardingPolicyRecord } from './types';

export class OffboardingPolicyService {
  /**
   * Resolves authoritative offboarding policy for an organization or system default.
   * If policy is disabled, unconfigured, or unresolvable, returns null to enforce strict fail-closed behavior.
   */
  static async getPolicyForOrganization(
    organizationId: string
  ): Promise<OffboardingPolicyRecord | null> {
    if (!organizationId) return null;

    try {
      const supabase = createAdminClient();

      // 1. Check organization-specific active policy
      const { data: orgPolicy, error: orgErr } = await (supabase as any)
        .from('number_lifecycle_policies')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('is_active', true)
        .maybeSingle();

      if (!orgErr && orgPolicy) {
        return {
          id: orgPolicy.id,
          organizationId: orgPolicy.organization_id,
          policyName: orgPolicy.policy_name,
          advanceCancellationNoticeDays: orgPolicy.advance_cancellation_notice_days !== null && orgPolicy.advance_cancellation_notice_days !== undefined ? Number(orgPolicy.advance_cancellation_notice_days) : null,
          pastDueRetentionDays: orgPolicy.past_due_retention_days !== null && orgPolicy.past_due_retention_days !== undefined ? Number(orgPolicy.past_due_retention_days) : null,
          suspensionThresholdDays: orgPolicy.suspension_threshold_days !== null && orgPolicy.suspension_threshold_days !== undefined ? Number(orgPolicy.suspension_threshold_days) : null,
          releasePendingDurationDays: orgPolicy.release_pending_duration_days !== null && orgPolicy.release_pending_duration_days !== undefined ? Number(orgPolicy.release_pending_duration_days) : null,
          finalReleaseEligibilityDays: orgPolicy.final_release_eligibility_days !== null && orgPolicy.final_release_eligibility_days !== undefined ? Number(orgPolicy.final_release_eligibility_days) : null,
          allowNumberOnlyRetention: Boolean(orgPolicy.allow_number_only_retention),
          isActive: Boolean(orgPolicy.is_active),
        };
      }

      // 2. Check system default policy (organization_id IS NULL)
      const { data: sysPolicy, error: sysErr } = await (supabase as any)
        .from('number_lifecycle_policies')
        .select('*')
        .is('organization_id', null)
        .eq('is_active', true)
        .maybeSingle();

      if (!sysErr && sysPolicy) {
        return {
          id: sysPolicy.id,
          organizationId: null,
          policyName: sysPolicy.policy_name,
          advanceCancellationNoticeDays: sysPolicy.advance_cancellation_notice_days !== null && sysPolicy.advance_cancellation_notice_days !== undefined ? Number(sysPolicy.advance_cancellation_notice_days) : null,
          pastDueRetentionDays: sysPolicy.past_due_retention_days !== null && sysPolicy.past_due_retention_days !== undefined ? Number(sysPolicy.past_due_retention_days) : null,
          suspensionThresholdDays: sysPolicy.suspension_threshold_days !== null && sysPolicy.suspension_threshold_days !== undefined ? Number(sysPolicy.suspension_threshold_days) : null,
          releasePendingDurationDays: sysPolicy.release_pending_duration_days !== null && sysPolicy.release_pending_duration_days !== undefined ? Number(sysPolicy.release_pending_duration_days) : null,
          finalReleaseEligibilityDays: sysPolicy.final_release_eligibility_days !== null && sysPolicy.final_release_eligibility_days !== undefined ? Number(sysPolicy.final_release_eligibility_days) : null,
          allowNumberOnlyRetention: Boolean(sysPolicy.allow_number_only_retention),
          isActive: Boolean(sysPolicy.is_active),
        };
      }

      // Strict fail-closed: return null if no active policy is configured in DB
      return null;
    } catch (err: any) {
      console.warn('[OffboardingPolicyService] Exception resolving policy:', err.message || err);
      // Return null to enforce strict fail-closed
      return null;
    }
  }
}
