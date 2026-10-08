import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { SubscriptionStatus } from '@/lib/entitlements/server';

export type CanonicalSubscriptionState =
  | 'active'
  | 'past_due_grace'
  | 'suspended'
  | 'canceled'
  | 'expired'
  | 'unknown';

export interface SubscriptionStateDetails {
  organizationId: string;
  status: SubscriptionStatus;
  canonicalState: CanonicalSubscriptionState;
  gracePeriodEndsAt: string | null;
  suspendedAt: string | null;
  isGracePeriodValid: boolean;
}

export class SubscriptionPolicyService {
  /**
   * Resolves the authoritative commercial subscription state for an organization.
   */
  static async getSubscriptionState(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<SubscriptionStateDetails> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const { data: sub, error } = await (supabase as any)
      .from('organization_subscriptions')
      .select('id, organization_id, status, grace_period_ends_at, suspended_at, current_period_end')
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error || !sub) {
      return {
        organizationId,
        status: 'suspended',
        canonicalState: 'unknown',
        gracePeriodEndsAt: null,
        suspendedAt: null,
        isGracePeriodValid: false,
      };
    }

    const status = sub.status as SubscriptionStatus;
    const now = Date.now();

    let isGracePeriodValid = false;
    if (sub.grace_period_ends_at) {
      isGracePeriodValid = new Date(sub.grace_period_ends_at).getTime() > now;
    }

    let canonicalState: CanonicalSubscriptionState = 'unknown';

    if (status === 'active' || status === 'trialing') {
      canonicalState = 'active';
    } else if (status === 'past_due') {
      if (isGracePeriodValid) {
        canonicalState = 'past_due_grace';
      } else {
        canonicalState = 'suspended';
      }
    } else if (status === 'suspended') {
      canonicalState = 'suspended';
    } else if (status === 'canceled') {
      // Check if period end has expired
      if (sub.current_period_end && new Date(sub.current_period_end).getTime() > now) {
        canonicalState = 'active';
      } else {
        canonicalState = 'canceled';
      }
    } else if (status === 'expired') {
      canonicalState = 'expired';
    }

    return {
      organizationId,
      status,
      canonicalState,
      gracePeriodEndsAt: sub.grace_period_ends_at || null,
      suspendedAt: sub.suspended_at || null,
      isGracePeriodValid,
    };
  }

  /**
   * Evaluates if the organization may use existing Voice/SMS/MMS capabilities.
   * Allowed during 'active' and 'past_due_grace' ONLY if prepaid wallet has sufficient spendable balance.
   */
  static async mayUseExistingTelecom(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<boolean> {
    const details = await this.getSubscriptionState(organizationId, clientOverride);
    return details.canonicalState === 'active' || details.canonicalState === 'past_due_grace';
  }

  /**
   * Evaluates if the organization may purchase new phone numbers.
   * Allowed ONLY when subscription state is 'active'.
   */
  static async mayPurchaseNumber(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<boolean> {
    const details = await this.getSubscriptionState(organizationId, clientOverride);
    return details.canonicalState === 'active';
  }

  /**
   * Evaluates if the organization may add or invite new active seats.
   * Allowed ONLY when subscription state is 'active'.
   */
  static async mayIncreaseSeats(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<boolean> {
    const details = await this.getSubscriptionState(organizationId, clientOverride);
    return details.canonicalState === 'active';
  }

  /**
   * Evaluates if the organization may upgrade its subscription plan.
   * Allowed ONLY when subscription state is 'active'.
   */
  static async mayUpgradePlan(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<boolean> {
    const details = await this.getSubscriptionState(organizationId, clientOverride);
    return details.canonicalState === 'active';
  }

  /**
   * Evaluates if manual Telecom Credit top-up is allowed.
   * Allowed ONLY when subscription state is 'active'. Blocked during grace and suspension.
   */
  static async mayFundWallet(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<boolean> {
    const details = await this.getSubscriptionState(organizationId, clientOverride);
    return details.canonicalState === 'active';
  }

  /**
   * Evaluates if Wallet Auto Top-Up execution is allowed.
   * Allowed ONLY when subscription state is 'active'. Blocked during grace and suspension.
   */
  static async mayExecuteAutoTopup(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<boolean> {
    const details = await this.getSubscriptionState(organizationId, clientOverride);
    return details.canonicalState === 'active';
  }

  /**
   * Evaluates if workspace payment method management is allowed.
   * Allowed during 'active', 'past_due_grace', and 'suspended' for payment method repair.
   */
  static async mayManagePaymentMethod(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<boolean> {
    const details = await this.getSubscriptionState(organizationId, clientOverride);
    return details.canonicalState === 'active' || details.canonicalState === 'past_due_grace' || details.canonicalState === 'suspended';
  }

  /**
   * Evaluates if overdue subscription recovery is allowed.
   * Allowed during 'past_due_grace' and 'suspended'.
   */
  static async mayRecoverSubscription(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<boolean> {
    const details = await this.getSubscriptionState(organizationId, clientOverride);
    return details.canonicalState === 'past_due_grace' || details.canonicalState === 'suspended';
  }

  /**
   * Evaluates if port-out management is allowed.
   * Allowed during 'active', 'past_due_grace', and 'suspended'.
   */
  static async mayManagePortOut(
    organizationId: string,
    clientOverride?: SupabaseClient
  ): Promise<boolean> {
    const details = await this.getSubscriptionState(organizationId, clientOverride);
    return details.canonicalState === 'active' || details.canonicalState === 'past_due_grace' || details.canonicalState === 'suspended';
  }
}
