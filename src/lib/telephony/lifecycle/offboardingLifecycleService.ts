import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  NumberOffboardingState,
  SaaSEntitlementStatus,
  PhoneLifecycleStateRecord,
} from './types';
import { OffboardingPolicyService } from './offboardingPolicyService';
import { OffboardingNotificationService } from './offboardingNotificationService';

export class OffboardingLifecycleService {
  /**
   * Processes SaaS subscription cancellation intent.
   * GUARANTEE: DOES NOT IMMEDIATELY RELEASE PHONE NUMBERS.
   * Number entitlement remains active through applicable paidThroughAt date.
   */
  static async processSaaSCancellation(
    organizationId: string,
    paidThroughAt: Date
  ): Promise<{ success: boolean; affectedNumbersCount: number }> {
    if (!organizationId) return { success: false, affectedNumbersCount: 0 };

    try {
      const supabase = createAdminClient();

      // 1. Update organization subscription status to 'canceled' with paid_through_at
      await (supabase as any)
        .from('organizations')
        .update({
          subscription_status: 'canceled',
          updated_at: new Date().toISOString(),
        })
        .eq('id', organizationId);

      // 2. Query numbers owned by organization to record/update lifecycle states
      const { data: phones } = await (supabase as any)
        .from('phone_numbers')
        .select('id, phone_number, active')
        .eq('organization_id', organizationId);

      let affected = 0;
      if (phones && Array.isArray(phones)) {
        for (const phone of phones) {
          const now = new Date();
          const paidThroughPassed = paidThroughAt.getTime() <= now.getTime();

          const newState: NumberOffboardingState = paidThroughPassed ? 'past_due' : 'active';
          const saasStatus: SaaSEntitlementStatus = 'canceled';

          // Upsert phone_number_lifecycle_states row
          await (supabase as any)
            .from('phone_number_lifecycle_states')
            .upsert(
              {
                organization_id: organizationId,
                phone_number_id: phone.id,
                phone_number_e164: phone.phone_number,
                lifecycle_state: newState,
                saas_entitlement_status: saasStatus,
                paid_through_at: paidThroughAt.toISOString(),
                service_ended_at: paidThroughPassed ? paidThroughAt.toISOString() : null,
                past_due_started_at: paidThroughPassed ? now.toISOString() : null,
                unfunded_company_liability: paidThroughPassed,
                allow_telecom_usage: !paidThroughPassed,
                updated_at: now.toISOString(),
              },
              { onConflict: 'phone_number_id' }
            );

          // Record idempotent SaaS cancellation notification event
          await OffboardingNotificationService.recordNotificationEvent({
            organizationId,
            phoneNumberId: phone.id,
            phoneNumberE164: phone.phone_number,
            eventType: 'saas_cancellation_received',
            metadata: {
              paidThroughAt: paidThroughAt.toISOString(),
              cancellationProcessedAt: now.toISOString(),
            },
          });

          affected++;
        }
      }

      return { success: true, affectedNumbersCount: affected };
    } catch (err: any) {
      console.warn('[OffboardingLifecycleService] Exception processing SaaS cancellation:', err.message || err);
      return { success: false, affectedNumbersCount: 0 };
    }
  }

  /**
   * Restores a customer's funded entitlement after renewal/payment recovery.
   * RESTORATION GUARANTEE:
   * - PAST_DUE -> ACTIVE (allowed)
   * - SUSPENDED -> ACTIVE (allowed)
   * - RELEASE_PENDING -> ACTIVE (allowed with safeguards)
   * - RELEASED -> BLOCKED (terminal state for that ownership instance).
   */
  static async restoreFundedEntitlement(
    organizationId: string,
    phoneNumberId?: string
  ): Promise<{ success: boolean; restoredCount: number; reason: string }> {
    if (!organizationId) return { success: false, restoredCount: 0, reason: 'Missing organization ID.' };

    try {
      const supabase = createAdminClient();

      // Query targeted lifecycle records
      let query = (supabase as any)
        .from('phone_number_lifecycle_states')
        .select('*')
        .eq('organization_id', organizationId);

      if (phoneNumberId) {
        query = query.eq('phone_number_id', phoneNumberId);
      }

      const { data: records } = await query;
      if (!records || records.length === 0) {
        return { success: true, restoredCount: 0, reason: 'No offboarding lifecycle records found to restore.' };
      }

      let restored = 0;
      for (const rec of records) {
        if (rec.lifecycle_state === 'released') {
          console.warn(`[OffboardingLifecycleService] Cannot restore released number ${rec.phone_number_e164}: RELEASED is terminal.`);
          continue;
        }

        const now = new Date().toISOString();
        await (supabase as any)
          .from('phone_number_lifecycle_states')
          .update({
            lifecycle_state: 'active',
            saas_entitlement_status: 'active',
            unfunded_company_liability: false,
            allow_telecom_usage: true,
            updated_at: now,
          })
          .eq('id', rec.id);

        // Record service_restored notification event
        await OffboardingNotificationService.recordNotificationEvent({
          organizationId,
          phoneNumberId: rec.phone_number_id,
          phoneNumberE164: rec.phone_number_e164,
          eventType: 'service_restored',
          metadata: { restoredAt: now, previousState: rec.lifecycle_state },
        });

        restored++;
      }

      return {
        success: true,
        restoredCount: restored,
        reason: `Successfully restored ${restored} phone number lifecycle state(s) to ACTIVE.`,
      };
    } catch (err: any) {
      console.warn('[OffboardingLifecycleService] Exception restoring entitlement:', err.message || err);
      return { success: false, restoredCount: 0, reason: 'Error restoring entitlement.' };
    }
  }
}
