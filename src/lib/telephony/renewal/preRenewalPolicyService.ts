import 'server-only';
import { PreRenewalPolicyConfig } from './types';
import { createAdminClient } from '@/lib/supabase/admin';

export class PreRenewalPolicyService {
  /**
   * Default fallback pre-renewal policy configuration.
   * NO timing values are hardcoded frozen constants — all timings derive from policy version.
   */
  private static DEFAULT_POLICY: PreRenewalPolicyConfig = {
    policyId: 'policy_v1_default',
    policyVersion: 1,
    preRenewalNoticeLeadHours: 72, // Advance notice before funded-through date (e.g. 3 days)
    autopayAttemptLeadHours: 48, // Autopay attempt before carrier exposure boundary (e.g. 2 days)
    paymentRetryWindowHours: 96, // Retry window after initial failure before final warning (e.g. 4 days)
    strongerWarningLeadHours: 24, // Stronger warning lead (e.g. 24h before expiry)
    finalWarningLeadHours: 12, // Final critical warning lead (e.g. 12h)
    releaseEligibilityBoundaryHours: 168, // Release eligibility boundary after grace/retries (e.g. 7 days)
    allowNumberOnlyRetention: true,
    isActive: true,
  };

  /**
   * Resolves the active pre-renewal commercial policy from DB or fallback.
   */
  static async getActivePolicy(organizationId?: string): Promise<PreRenewalPolicyConfig> {
    try {
      const supabase = createAdminClient();
      const { data: rows, error } = await (supabase as any)
        .from('number_lifecycle_policies')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1);

      if (!error && rows && rows.length > 0) {
        const row = rows[0];
        const meta = row.metadata || {};
        return {
          policyId: row.id || 'policy_db_v1',
          policyVersion: row.policy_version || meta.policyVersion || 1,
          preRenewalNoticeLeadHours: meta.preRenewalNoticeLeadHours ?? 72,
          autopayAttemptLeadHours: meta.autopayAttemptLeadHours ?? 48,
          paymentRetryWindowHours: meta.paymentRetryWindowHours ?? 96,
          strongerWarningLeadHours: meta.strongerWarningLeadHours ?? 24,
          finalWarningLeadHours: meta.finalWarningLeadHours ?? 12,
          releaseEligibilityBoundaryHours: meta.releaseEligibilityBoundaryHours ?? 168,
          allowNumberOnlyRetention: Boolean(row.allow_number_only_retention ?? true),
          isActive: true,
        };
      }
    } catch (err) {
      console.warn('[PreRenewalPolicyService] Policy query exception, using default:', err);
    }

    return this.DEFAULT_POLICY;
  }

  /**
   * Platform Administration Auth Check:
   * Validates if the requesting actor is authorized to manage global commercial timing policy.
   * REGULAR TENANT OWNERS / ADMINS ARE STRICTLY FORBIDDEN FROM ALTERING GLOBAL POLICY.
   */
  static isPlatformAdmin(actorRole?: string, actorId?: string): boolean {
    if (!actorRole) return false;
    const roleUpper = actorRole.toUpperCase();
    return roleUpper === 'SUPER_ADMIN' || roleUpper === 'PLATFORM_ADMIN';
  }

  /**
   * Updates or creates a new versioned pre-renewal commercial policy (Platform Admin Only).
   */
  static async updatePolicy(
    actorRole: string,
    actorId: string,
    newConfig: Partial<PreRenewalPolicyConfig>
  ): Promise<{ success: boolean; policy?: PreRenewalPolicyConfig; error?: string }> {
    if (!this.isPlatformAdmin(actorRole, actorId)) {
      return {
        success: false,
        error: 'FORBIDDEN: Commercial timing policies can only be managed by authorized PLATFORM administration.',
      };
    }

    try {
      const current = await this.getActivePolicy();
      const updatedVersion = (current.policyVersion || 1) + 1;

      const updatedPolicy: PreRenewalPolicyConfig = {
        ...current,
        ...newConfig,
        policyVersion: updatedVersion,
        policyId: `policy_v${updatedVersion}`,
        isActive: true,
      };

      const supabase = createAdminClient();
      await (supabase as any)
        .from('number_lifecycle_policies')
        .update({ is_active: false })
        .eq('is_active', true);

      const { data: inserted, error: insertErr } = await (supabase as any)
        .from('number_lifecycle_policies')
        .insert({
          policy_name: `PreRenewal_Policy_v${updatedVersion}`,
          policy_version: updatedVersion,
          allow_number_only_retention: updatedPolicy.allowNumberOnlyRetention,
          is_active: true,
          metadata: {
            policyVersion: updatedVersion,
            preRenewalNoticeLeadHours: updatedPolicy.preRenewalNoticeLeadHours,
            autopayAttemptLeadHours: updatedPolicy.autopayAttemptLeadHours,
            paymentRetryWindowHours: updatedPolicy.paymentRetryWindowHours,
            strongerWarningLeadHours: updatedPolicy.strongerWarningLeadHours,
            finalWarningLeadHours: updatedPolicy.finalWarningLeadHours,
            releaseEligibilityBoundaryHours: updatedPolicy.releaseEligibilityBoundaryHours,
            updatedBy: actorId,
            updatedAt: new Date().toISOString(),
          },
        })
        .select()
        .single();

      if (insertErr) {
        console.error('[PreRenewalPolicyService] DB Insert Error:', insertErr);
        return { success: false, error: 'Failed to persist policy in database.' };
      }

      return { success: true, policy: updatedPolicy };
    } catch (err: any) {
      console.error('[PreRenewalPolicyService] Update Exception:', err);
      return { success: false, error: err.message || 'Internal server error' };
    }
  }
}
