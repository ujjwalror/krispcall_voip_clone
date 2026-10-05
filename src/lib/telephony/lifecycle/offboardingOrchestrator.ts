import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { OffboardingPolicyService } from './offboardingPolicyService';
import { OffboardingLifecycleService } from './offboardingLifecycleService';
import { OffboardingNotificationService } from './offboardingNotificationService';
import {
  OffboardingEvaluationParams,
  OffboardingEvaluationResult,
  OffboardingExecutionResult,
  OffboardingBatchResult,
  NumberOffboardingState,
  CustomerOffboardingStatusDTO,
  AdminOffboardingSummaryDTO,
} from './types';

export class OffboardingOrchestrator {
  /**
   * Central decision orchestrator for offboarding lifecycle progression.
   * STRICT FAIL-CLOSED GUARANTEE: Without explicit active policy configuration,
   * no destructive lifecycle state transitions or release eligibility can be derived.
   */
  static async evaluateNextAction(
    params: OffboardingEvaluationParams
  ): Promise<OffboardingEvaluationResult> {
    const blockers: string[] = [];

    // 1. Resolve Policy
    let policy = params.policy;
    if (policy === undefined) {
      policy = await OffboardingPolicyService.getPolicyForOrganization(params.organizationId);
    }

    if (!policy || !policy.isActive) {
      blockers.push('MISSING_OR_INACTIVE_POLICY: No active offboarding policy configured. Fail closed.');
      return {
        nextAction: 'BLOCKED_BY_POLICY',
        reason: 'Offboarding evaluation blocked by missing or inactive policy.',
        blockers,
      };
    }

    // 2. Active Port-Out Interlock (CRITICAL INVARIANT)
    if (params.hasActivePortOut) {
      blockers.push('ACTIVE_PORT_OUT_PENDING: Number is undergoing active port-away.');
      return {
        nextAction: 'BLOCKED_BY_PORT_OUT',
        reason: 'Offboarding progression blocked by active port-out operation.',
        blockers,
        shouldEmitNotification: true,
        notificationEventType: 'port_out_blocking_release',
      };
    }

    // 3. Provider Ambiguity & Unresolved Reconciliation Lock
    if (params.hasProviderAmbiguity) {
      blockers.push('PROVIDER_AMBIGUITY_UNRESOLVED: Provider ownership status is ambiguous.');
      return {
        nextAction: 'BLOCKED_BY_RECONCILIATION',
        reason: 'Offboarding progression blocked by unresolved provider reconciliation.',
        blockers,
      };
    }

    // 4. Legal or Regulatory Hold
    if (params.hasLegalHold) {
      blockers.push('LEGAL_OR_REGULATORY_HOLD: Active legal hold placed on number.');
      return {
        nextAction: 'MANUAL_REVIEW_REQUIRED',
        reason: 'Offboarding progression blocked by legal hold. Manual review required.',
        blockers,
      };
    }

    const now = new Date();
    const currentState = params.currentLifecycleState || 'active';
    const saasStatus = params.saasEntitlementStatus || 'active';

    // 5. Terminal RELEASED state check
    if (currentState === 'released') {
      return {
        nextAction: 'NO_ACTION',
        reason: 'Phone number is in terminal RELEASED state.',
        blockers: [],
      };
    }

    // 6. Paid-Through Protection (Cancellation does NOT terminate active paid-through entitlement)
    const paidThrough = params.paidThroughAt ? new Date(params.paidThroughAt) : null;
    const paidThroughPassed = paidThrough ? paidThrough.getTime() <= now.getTime() : false;

    if (paidThrough && !paidThroughPassed) {
      return {
        nextAction: 'NO_ACTION',
        reason: 'Paid-through window is active. Customer entitlement preserved.',
        blockers: [],
      };
    }

    // 7. Restoration Path
    if (saasStatus === 'active' && ['past_due', 'suspended', 'release_pending'].includes(currentState)) {
      return {
        nextAction: 'RESTORE_SERVICE',
        targetState: 'active',
        shouldEmitNotification: true,
        notificationEventType: 'service_restored',
        reason: 'SaaS funding restored. Entitlement returning to ACTIVE state.',
        blockers: [],
      };
    }

    // 8. Lifecycle Transition Matrix according to configured policy thresholds
    if (currentState === 'active') {
      if (saasStatus !== 'active' && paidThroughPassed) {
        if (policy.pastDueRetentionDays === null || policy.pastDueRetentionDays === undefined) {
          blockers.push('UNCONFIGURED_POLICY_TIMING: pastDueRetentionDays is NULL.');
          return { nextAction: 'BLOCKED_BY_POLICY', reason: 'Unconfigured past-due timing. Fail closed.', blockers };
        }
        return {
          nextAction: 'ENTER_PAST_DUE',
          targetState: 'past_due',
          shouldEmitNotification: true,
          notificationEventType: 'retention_grace_warning',
          reason: 'Paid-through window ended. Entering PAST_DUE state.',
          blockers: [],
        };
      }
    }

    if (currentState === 'past_due') {
      if (policy.suspensionThresholdDays === null || policy.suspensionThresholdDays === undefined) {
        blockers.push('UNCONFIGURED_POLICY_TIMING: suspensionThresholdDays is NULL.');
        return { nextAction: 'BLOCKED_BY_POLICY', reason: 'Unconfigured suspension timing. Fail closed.', blockers };
      }

      const pastDueStarted = params.pastDueStartedAt ? new Date(params.pastDueStartedAt) : (paidThrough ?? params.serviceEndedAt ? new Date(params.serviceEndedAt!) : now);
      const elapsedDays = Math.floor((now.getTime() - pastDueStarted.getTime()) / (1000 * 60 * 60 * 24));

      if (elapsedDays >= policy.suspensionThresholdDays) {
        return {
          nextAction: 'SUSPEND_SERVICE',
          targetState: 'suspended',
          shouldEmitNotification: true,
          notificationEventType: 'service_suspended',
          reason: `Retention grace threshold (${policy.suspensionThresholdDays} days) reached. Suspending service.`,
          blockers: [],
        };
      }
    }

    if (currentState === 'suspended') {
      if (policy.releasePendingDurationDays === null || policy.releasePendingDurationDays === undefined) {
        blockers.push('UNCONFIGURED_POLICY_TIMING: releasePendingDurationDays is NULL.');
        return { nextAction: 'BLOCKED_BY_POLICY', reason: 'Unconfigured release-pending timing. Fail closed.', blockers };
      }

      const suspendedStarted = params.suspendedAt ? new Date(params.suspendedAt) : now;
      const elapsedDays = Math.floor((now.getTime() - suspendedStarted.getTime()) / (1000 * 60 * 60 * 24));

      if (elapsedDays >= policy.releasePendingDurationDays) {
        return {
          nextAction: 'ENTER_RELEASE_PENDING',
          targetState: 'release_pending',
          shouldEmitNotification: true,
          notificationEventType: 'number_release_pending',
          reason: `Suspension duration threshold (${policy.releasePendingDurationDays} days) reached. Entering RELEASE_PENDING.`,
          blockers: [],
        };
      }
    }

    if (currentState === 'release_pending') {
      if (policy.finalReleaseEligibilityDays === null || policy.finalReleaseEligibilityDays === undefined) {
        blockers.push('UNCONFIGURED_POLICY_TIMING: finalReleaseEligibilityDays is NULL.');
        return { nextAction: 'BLOCKED_BY_POLICY', reason: 'Unconfigured release eligibility timing. Fail closed.', blockers };
      }

      if (!params.finalReleaseNoticeSent) {
        blockers.push('FINAL_RELEASE_NOTICE_MISSING: Mandatory customer final release warning notice has not been sent.');
        return { nextAction: 'NO_ACTION', reason: 'Final release warning notice pending.', blockers };
      }

      const releasePendingStarted = params.releasePendingStartedAt ? new Date(params.releasePendingStartedAt) : (params.serviceEndedAt ? new Date(params.serviceEndedAt) : now);
      const elapsedDays = Math.floor((now.getTime() - releasePendingStarted.getTime()) / (1000 * 60 * 60 * 24));

      if (elapsedDays >= policy.finalReleaseEligibilityDays) {
        return {
          nextAction: 'MARK_ELIGIBLE_FOR_RELEASE',
          targetState: 'release_pending',
          shouldEmitNotification: true,
          notificationEventType: 'final_release_warning',
          reason: `Release pending duration (${policy.finalReleaseEligibilityDays} days) completed. Number is eligible for provider release.`,
          blockers: [],
        };
      }
    }

    return {
      nextAction: 'NO_ACTION',
      reason: 'No offboarding state transition required at current time.',
      blockers: [],
    };
  }

  /**
   * Executes next safe offboarding action and records structured logs/notifications.
   */
  static async executeNextAction(
    params: OffboardingEvaluationParams
  ): Promise<OffboardingExecutionResult> {
    const evalRes = await OffboardingOrchestrator.evaluateNextAction(params);
    const supabase = createAdminClient();
    const now = new Date().toISOString();
    const currentState = params.currentLifecycleState || 'active';

    // Structured Observability Logging
    console.log('[OffboardingOrchestrator:Event]', JSON.stringify({
      event: 'offboarding_evaluated',
      organizationId: params.organizationId,
      phoneNumberId: params.phoneNumberId,
      phoneNumberE164: params.phoneNumberE164,
      currentState,
      nextAction: evalRes.nextAction,
      reason: evalRes.reason,
      blockers: evalRes.blockers,
      timestamp: now,
    }));

    if (evalRes.nextAction === 'BLOCKED_BY_POLICY') {
      console.warn('[OffboardingOrchestrator:Event]', JSON.stringify({
        event: 'offboarding_blocked_policy',
        organizationId: params.organizationId,
        phoneNumberId: params.phoneNumberId,
        blockers: evalRes.blockers,
        timestamp: now,
      }));
      return {
        success: false,
        previousState: currentState,
        newState: currentState,
        nextAction: evalRes.nextAction,
        notificationCreated: false,
        reason: evalRes.reason,
      };
    }

    if (evalRes.nextAction === 'BLOCKED_BY_PORT_OUT') {
      console.warn('[OffboardingOrchestrator:Event]', JSON.stringify({
        event: 'offboarding_blocked_port',
        organizationId: params.organizationId,
        phoneNumberId: params.phoneNumberId,
        phoneNumberE164: params.phoneNumberE164,
        timestamp: now,
      }));

      // Record idempotent port-out blocking notice
      const notif = await OffboardingNotificationService.recordNotificationEvent({
        organizationId: params.organizationId,
        phoneNumberId: params.phoneNumberId,
        phoneNumberE164: params.phoneNumberE164,
        eventType: 'port_out_blocking_release',
      });

      return {
        success: true,
        previousState: currentState,
        newState: currentState,
        nextAction: evalRes.nextAction,
        notificationCreated: notif.created,
        notificationEventType: 'port_out_blocking_release',
        reason: evalRes.reason,
      };
    }

    if (evalRes.nextAction === 'BLOCKED_BY_RECONCILIATION') {
      console.warn('[OffboardingOrchestrator:Event]', JSON.stringify({
        event: 'offboarding_blocked_reconciliation',
        organizationId: params.organizationId,
        phoneNumberId: params.phoneNumberId,
        timestamp: now,
      }));
      return {
        success: false,
        previousState: currentState,
        newState: currentState,
        nextAction: evalRes.nextAction,
        notificationCreated: false,
        reason: evalRes.reason,
      };
    }

    if (evalRes.nextAction === 'RESTORE_SERVICE') {
      const restoreRes = await OffboardingLifecycleService.restoreFundedEntitlement(
        params.organizationId,
        params.phoneNumberId
      );
      console.log('[OffboardingOrchestrator:Event]', JSON.stringify({
        event: 'offboarding_restored',
        organizationId: params.organizationId,
        phoneNumberId: params.phoneNumberId,
        phoneNumberE164: params.phoneNumberE164,
        restoredCount: restoreRes.restoredCount,
        timestamp: now,
      }));
      return {
        success: restoreRes.success,
        previousState: currentState,
        newState: 'active',
        nextAction: evalRes.nextAction,
        notificationCreated: true,
        notificationEventType: 'service_restored',
        reason: restoreRes.reason,
      };
    }

    if (evalRes.targetState && evalRes.targetState !== currentState) {
      const target = evalRes.targetState;
      const isUnfunded = ['past_due', 'suspended', 'release_pending'].includes(target);
      const allowTelecom = target === 'active' || target === 'past_due';

      await (supabase as any)
        .from('phone_number_lifecycle_states')
        .upsert(
          {
            organization_id: params.organizationId,
            phone_number_id: params.phoneNumberId,
            phone_number_e164: params.phoneNumberE164,
            lifecycle_state: target,
            saas_entitlement_status: params.saasEntitlementStatus || 'canceled',
            past_due_started_at: target === 'past_due' ? now : params.pastDueStartedAt,
            suspended_at: target === 'suspended' ? now : params.suspendedAt,
            release_pending_started_at: target === 'release_pending' ? now : params.releasePendingStartedAt,
            unfunded_company_liability: isUnfunded,
            allow_telecom_usage: allowTelecom,
            updated_at: now,
          },
          { onConflict: 'phone_number_id' }
        );

      console.log('[OffboardingOrchestrator:Event]', JSON.stringify({
        event: 'offboarding_transition',
        organizationId: params.organizationId,
        phoneNumberId: params.phoneNumberId,
        previousState: currentState,
        newState: target,
        timestamp: now,
      }));

      if (target === 'suspended') {
        console.warn('[OffboardingOrchestrator:Event]', JSON.stringify({
          event: 'offboarding_suspended',
          organizationId: params.organizationId,
          phoneNumberId: params.phoneNumberId,
          phoneNumberE164: params.phoneNumberE164,
          timestamp: now,
        }));
      }

      if (isUnfunded) {
        console.warn('[OffboardingOrchestrator:Event]', JSON.stringify({
          event: 'offboarding_unfunded_exposure',
          organizationId: params.organizationId,
          phoneNumberId: params.phoneNumberId,
          phoneNumberE164: params.phoneNumberE164,
          lifecycleState: target,
          timestamp: now,
        }));
      }

      let notifCreated = false;
      if (evalRes.shouldEmitNotification && evalRes.notificationEventType) {
        const notif = await OffboardingNotificationService.recordNotificationEvent({
          organizationId: params.organizationId,
          phoneNumberId: params.phoneNumberId,
          phoneNumberE164: params.phoneNumberE164,
          eventType: evalRes.notificationEventType,
        });
        notifCreated = notif.created;
      }

      return {
        success: true,
        previousState: currentState,
        newState: target,
        nextAction: evalRes.nextAction,
        notificationCreated: notifCreated,
        notificationEventType: evalRes.notificationEventType,
        reason: evalRes.reason,
      };
    }

    if (evalRes.nextAction === 'MARK_ELIGIBLE_FOR_RELEASE') {
      console.warn('[OffboardingOrchestrator:Event]', JSON.stringify({
        event: 'offboarding_release_eligible',
        organizationId: params.organizationId,
        phoneNumberId: params.phoneNumberId,
        phoneNumberE164: params.phoneNumberE164,
        timestamp: now,
      }));

      let notifCreated = false;
      if (evalRes.shouldEmitNotification && evalRes.notificationEventType) {
        const notif = await OffboardingNotificationService.recordNotificationEvent({
          organizationId: params.organizationId,
          phoneNumberId: params.phoneNumberId,
          phoneNumberE164: params.phoneNumberE164,
          eventType: evalRes.notificationEventType,
        });
        notifCreated = notif.created;
      }

      return {
        success: true,
        previousState: currentState,
        newState: currentState,
        nextAction: evalRes.nextAction,
        notificationCreated: notifCreated,
        notificationEventType: evalRes.notificationEventType,
        reason: evalRes.reason,
      };
    }

    return {
      success: true,
      previousState: currentState,
      newState: currentState,
      nextAction: evalRes.nextAction,
      notificationCreated: false,
      reason: evalRes.reason,
    };
  }

  /**
   * Worker Batch Evaluation Entry Point.
   * Processes bounded batch of offboarding lifecycle records deterministically and safely.
   */
  static async processBatch(batchSize: number = 50): Promise<OffboardingBatchResult> {
    const supabase = createAdminClient();
    const result: OffboardingBatchResult = {
      totalProcessed: 0,
      transitions: 0,
      blockedByPolicy: 0,
      blockedByPortOut: 0,
      blockedByReconciliation: 0,
      restored: 0,
      errors: 0,
    };

    try {
      const { data: records, error } = await (supabase as any)
        .from('phone_number_lifecycle_states')
        .select('*')
        .neq('lifecycle_state', 'released')
        .order('created_at', { ascending: true })
        .limit(batchSize);

      if (error || !records || !Array.isArray(records)) {
        return result;
      }

      for (const rec of records) {
        result.totalProcessed++;
        try {
          // Check for active port-out in porting_operations
          const { data: portOps } = await (supabase as any)
            .from('porting_operations')
            .select('id')
            .eq('phone_number_id', rec.phone_number_id)
            .eq('direction', 'port_out')
            .not('status', 'in', '("completed","canceled","failed")')
            .maybeSingle();

          const hasActivePortOut = Boolean(portOps);

          const execRes = await OffboardingOrchestrator.executeNextAction({
            organizationId: rec.organization_id,
            phoneNumberId: rec.phone_number_id,
            phoneNumberE164: rec.phone_number_e164,
            saasEntitlementStatus: rec.saas_entitlement_status,
            paidThroughAt: rec.paid_through_at,
            serviceEndedAt: rec.service_ended_at,
            pastDueStartedAt: rec.past_due_started_at,
            suspendedAt: rec.suspended_at,
            releasePendingStartedAt: rec.release_pending_started_at,
            currentLifecycleState: rec.lifecycle_state,
            hasActivePortOut,
          });

          if (execRes.nextAction === 'BLOCKED_BY_POLICY') result.blockedByPolicy++;
          else if (execRes.nextAction === 'BLOCKED_BY_PORT_OUT') result.blockedByPortOut++;
          else if (execRes.nextAction === 'BLOCKED_BY_RECONCILIATION') result.blockedByReconciliation++;
          else if (execRes.nextAction === 'RESTORE_SERVICE') result.restored++;
          else if (execRes.previousState !== execRes.newState) result.transitions++;

        } catch (err: any) {
          console.error('[OffboardingOrchestrator] Batch item error:', err.message || err);
          result.errors++;
        }
      }

      return result;
    } catch (batchErr: any) {
      console.error('[OffboardingOrchestrator] Batch process exception:', batchErr.message || batchErr);
      return result;
    }
  }

  /**
   * Resolves Customer-Facing Offboarding Status DTO for UI.
   */
  static async getCustomerOffboardingStatusDTO(
    organizationId: string,
    phoneNumberId?: string
  ): Promise<CustomerOffboardingStatusDTO[]> {
    if (!organizationId) return [];
    const supabase = createAdminClient();

    let query = (supabase as any)
      .from('phone_number_lifecycle_states')
      .select('*')
      .eq('organization_id', organizationId);

    if (phoneNumberId) {
      query = query.eq('phone_number_id', phoneNumberId);
    }

    const { data: records } = await query;
    if (!records || records.length === 0) return [];

    return records.map((rec: any) => {
      const state: NumberOffboardingState = rec.lifecycle_state || 'active';
      const actionRequired = ['past_due', 'suspended', 'release_pending'].includes(state);
      const numberAtRisk = ['suspended', 'release_pending'].includes(state);
      const portOutAvailable = state !== 'released';

      let actionMessage = 'Your phone number is active and fully funded.';
      if (state === 'past_due') {
        actionMessage = 'Subscription payment is past due. Renew now to avoid service suspension.';
      } else if (state === 'suspended') {
        actionMessage = 'Service is suspended due to unpaid entitlement. Renew now to restore calling & messaging.';
      } else if (state === 'release_pending') {
        actionMessage = 'Number is pending carrier release. Immediate payment renewal required to prevent permanent loss.';
      } else if (state === 'released') {
        actionMessage = 'Number has been released and is no longer assigned to your account.';
      }

      return {
        phoneNumberId: rec.phone_number_id,
        phoneNumberE164: rec.phone_number_e164,
        status: state,
        paidThroughAt: rec.paid_through_at,
        serviceEndedAt: rec.service_ended_at,
        actionRequired,
        actionMessage,
        numberAtRisk,
        portOutOptionsAvailable: portOutAvailable,
      };
    });
  }

  /**
   * Resolves Operational Admin Offboarding Summary DTO for Ops/Admin Dashboard.
   */
  static async getAdminOffboardingSummaryDTO(
    organizationId?: string
  ): Promise<AdminOffboardingSummaryDTO> {
    const supabase = createAdminClient();
    let query = (supabase as any).from('phone_number_lifecycle_states').select('*');

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const { data: records } = await query;
    const summary: AdminOffboardingSummaryDTO = {
      totalTracked: records?.length ?? 0,
      activeCount: 0,
      pastDueCount: 0,
      suspendedCount: 0,
      releasePendingCount: 0,
      releaseEligibleCount: 0,
      unfundedCompanyLiabilityCount: 0,
      blockedByPortOutCount: 0,
      reconciliationRequiredCount: 0,
    };

    if (!records) return summary;

    for (const rec of records) {
      if (rec.lifecycle_state === 'active') summary.activeCount++;
      if (rec.lifecycle_state === 'past_due') summary.pastDueCount++;
      if (rec.lifecycle_state === 'suspended') summary.suspendedCount++;
      if (rec.lifecycle_state === 'release_pending') summary.releasePendingCount++;
      if (rec.unfunded_company_liability) summary.unfundedCompanyLiabilityCount++;
    }

    return summary;
  }
}
