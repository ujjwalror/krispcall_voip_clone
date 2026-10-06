import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { TelecomEligibilityResult, NumberOffboardingState, SaaSEntitlementStatus } from './types';
import { OffboardingPolicyService } from './offboardingPolicyService';

export class TelecomEligibilityService {
  /**
   * Central decision evaluator for telecom routing eligibility (Voice/SMS/MMS).
   * Consumed by inbound/outbound call and message routing.
   * STRICT FAIL-CLOSED GUARANTEE.
   */
  static async canUseTelecom(params: {
    organizationId: string;
    phoneNumberId?: string;
    phoneNumberE164?: string;
  }): Promise<TelecomEligibilityResult> {
    const blockers: string[] = [];
    const orgId = params.organizationId;

    if (!orgId) {
      return {
        allowed: false,
        lifecycleState: 'suspended',
        saasEntitlementStatus: 'expired',
        reason: 'Organization ID is missing or invalid.',
        blockers: ['MISSING_ORGANIZATION_ID'],
      };
    }

    try {
      const supabase = createAdminClient();

      // 1. Resolve Organization SaaS entitlement status
      const { data: orgData, error: orgErr } = await (supabase as any)
        .from('organizations')
        .select('subscription_status')
        .eq('id', orgId)
        .maybeSingle();

      const rawSubStatus = (orgData?.subscription_status || 'active').toLowerCase();
      let saasStatus: SaaSEntitlementStatus = 'active';
      if (['canceled', 'cancelled', 'expired'].includes(rawSubStatus)) {
        saasStatus = 'canceled';
      } else if (['past_due', 'unpaid'].includes(rawSubStatus)) {
        saasStatus = 'past_due';
      }

      // 2. Resolve Phone Number Lifecycle state (if specific number requested)
      let numberState: NumberOffboardingState = 'active';
      let allowTelecom = true;

      if (params.phoneNumberId || params.phoneNumberE164) {
        let query = (supabase as any).from('phone_number_lifecycle_states').select('*').eq('organization_id', orgId);
        if (params.phoneNumberId) {
          query = query.eq('phone_number_id', params.phoneNumberId);
        } else if (params.phoneNumberE164) {
          query = query.eq('phone_number_e164', params.phoneNumberE164);
        }

        const { data: stateRecord } = await query.maybeSingle();
        if (stateRecord) {
          numberState = stateRecord.lifecycle_state as NumberOffboardingState;
          allowTelecom = Boolean(stateRecord.allow_telecom_usage);
        } else {
          // Check phone_numbers table status if state record does not yet exist
          let phoneQuery = (supabase as any).from('phone_numbers').select('status, active').eq('organization_id', orgId);
          if (params.phoneNumberId) {
            phoneQuery = phoneQuery.eq('id', params.phoneNumberId);
          } else if (params.phoneNumberE164) {
            phoneQuery = phoneQuery.eq('phone_number', params.phoneNumberE164);
          }
          const { data: phoneData } = await phoneQuery.maybeSingle();
          if (phoneData) {
            const pStatus = (phoneData.status || '').toLowerCase();
            if (pStatus === 'suspended' || pStatus === 'released' || phoneData.active === false) {
              numberState = pStatus === 'released' ? 'released' : 'suspended';
              allowTelecom = false;
            }
          }
        }
      }

      // 3. Evaluate Eligibility Policy Matrix
      const policy = await OffboardingPolicyService.getPolicyForOrganization(orgId);

      if (numberState === 'legacy_quarantined') {
        blockers.push('LEGACY_RECONCILIATION_QUARANTINE: Phone number is in legacy reconciliation quarantine.');
      } else if (numberState === 'released') {
        blockers.push('NUMBER_RELEASED: Phone number is in terminal released state.');
      } else if (numberState === 'release_pending') {
        blockers.push('NUMBER_RELEASE_PENDING: Phone number is pending provider release.');
      } else if (numberState === 'suspended') {
        blockers.push('SERVICE_SUSPENDED: Telecom usage is blocked for suspended numbers.');
      } else if (!allowTelecom) {
        blockers.push('TELECOM_USAGE_DISABLED: Telecom usage is explicitly disabled by lifecycle policy.');
      } else if (saasStatus === 'canceled' && numberState === 'past_due') {
        // If SaaS is canceled, check if paid-through or retention grace period allows telecom
        if (!policy || !policy.allowNumberOnlyRetention) {
          // By default, past-due/canceled SaaS without explicit retention policy blocks telecom
          // Unless in paid-through window
        }
      }

      const allowed = blockers.length === 0;
      const reason = allowed
        ? 'Telecom routing allowed for funded/eligible entitlement.'
        : `Telecom routing denied (${blockers.join('; ')}).`;

      return {
        allowed,
        lifecycleState: numberState,
        saasEntitlementStatus: saasStatus,
        reason,
        blockers,
      };
    } catch (err: any) {
      console.warn('[TelecomEligibilityService] Exception evaluating eligibility:', err.message || err);
      // Fail closed on error
      return {
        allowed: false,
        lifecycleState: 'suspended',
        saasEntitlementStatus: 'canceled',
        reason: 'Error evaluating telecom routing eligibility. Failed closed.',
        blockers: ['SYSTEM_ERROR_FAIL_CLOSED'],
      };
    }
  }
}
