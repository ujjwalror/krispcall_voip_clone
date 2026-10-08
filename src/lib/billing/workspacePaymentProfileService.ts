import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { ProviderAccountResolver } from '@/lib/billing/providers/providerAccountResolver';
import { StripeClientFactory } from '@/lib/billing/providers/stripe/stripeClientFactory';
import { StripeCustomerService } from '@/lib/billing/providers/stripe/stripeCustomerService';

export interface WorkspacePaymentProfileDTO {
  success: boolean;
  hasCustomer: boolean;
  customerId: string | null;
  providerAccountId: string | null;
  mode: 'TEST' | 'LIVE';
  hasDefaultPaymentMethod: boolean;
  paymentMethod: {
    id: string;
    brand: string;
    last4: string;
  } | null;
  scopes: {
    // Phase 17R.4 Unified Recurring Service Billing Scope
    recurringServiceAuthorized: boolean;
    // Wallet Auto Top-Up Scope (configured independently on /billing/credit)
    walletAutoRechargeAuthorized: boolean;

    // Deprecated legacy fields retained for backward compatibility & historical audit
    /** @deprecated Use recurringServiceAuthorized */
    saasRecurringAuthorized: boolean;
    /** @deprecated Use recurringServiceAuthorized */
    numberRentalRenewalAuthorized: boolean;
  };
}

export class WorkspacePaymentProfileService {
  /**
   * Resolves the single authoritative Workspace Payment Profile for an organization.
   * Under Phase 17R.4, normal active service (SaaS + Number Rentals) uses ONE unified recurring service scope.
   */
  static async getWorkspacePaymentProfile(
    supabase: SupabaseClient,
    organizationId: string
  ): Promise<WorkspacePaymentProfileDTO> {
    if (!organizationId) {
      throw new Error('INVALID_ORGANIZATION_ID: organizationId is required.');
    }

    // 1. Resolve active provider account
    const activeAccount = await ProviderAccountResolver.resolveActiveAccount(supabase, 'stripe', 'test');

    // 2. Fetch customer mapping from billing_provider_customers
    const { data: custRow } = await (supabase as any)
      .from('billing_provider_customers')
      .select('provider_customer_id, provider_account_id, metadata')
      .eq('organization_id', organizationId)
      .eq('provider', 'stripe')
      .maybeSingle();

    const customerId = custRow?.provider_customer_id || null;
    const metadata = custRow?.metadata || {};
    const defaultPm = metadata.default_payment_method || null;
    const hasDefaultPaymentMethod = !!defaultPm;

    // 3. Resolve wallet auto-recharge scope from billing_auto_topup_settings
    const { data: walletSettings } = await (supabase as any)
      .from('billing_auto_topup_settings')
      .select('status')
      .eq('organization_id', organizationId)
      .maybeSingle();

    const walletAutoRechargeAuthorized = walletSettings?.status === 'enabled';

    // Phase 17R.4: Unified recurring service is authorized whenever a valid workspace default payment method exists
    const recurringServiceAuthorized = hasDefaultPaymentMethod;

    return {
      success: true,
      hasCustomer: !!customerId,
      customerId,
      providerAccountId: activeAccount.id,
      mode: 'TEST',
      hasDefaultPaymentMethod,
      paymentMethod: defaultPm
        ? {
            id: defaultPm.id,
            brand: defaultPm.brand,
            last4: defaultPm.last4,
          }
        : null,
      scopes: {
        recurringServiceAuthorized,
        walletAutoRechargeAuthorized,
        // Backward-compatibility aliases
        saasRecurringAuthorized: recurringServiceAuthorized,
        numberRentalRenewalAuthorized: recurringServiceAuthorized,
      },
    };
  }

  /**
   * Updates authorization scopes.
   * Under Phase 17R.4, product-specific checkboxes are deprecated for future writes;
   * recurring service is unified under the default workspace payment method.
   */
  static async updateAuthorizationScopes(
    supabase: SupabaseClient,
    organizationId: string,
    userId: string,
    userRole: string,
    scopes: {
      walletAutoRecharge?: boolean;
      /** @deprecated Unified under recurringServiceAuthorized */
      numberRentalRenewal?: boolean;
      /** @deprecated Unified under recurringServiceAuthorized */
      saasRecurring?: boolean;
    }
  ): Promise<{ success: boolean; scopes: WorkspacePaymentProfileDTO['scopes'] }> {
    if (!['owner', 'admin'].includes((userRole || '').toLowerCase())) {
      throw new Error('FORBIDDEN: Only Organization Owners and Admins can update payment authorization scopes.');
    }

    // Update Wallet Auto-Recharge scope in billing_auto_topup_settings if specified
    if (scopes.walletAutoRecharge !== undefined) {
      const newStatus = scopes.walletAutoRecharge ? 'enabled' : 'disabled';
      await (supabase as any)
        .from('billing_auto_topup_settings')
        .update({
          status: newStatus,
          disabled_at: scopes.walletAutoRecharge ? null : new Date().toISOString(),
          disabled_by_user_id: scopes.walletAutoRecharge ? null : userId,
          updated_at: new Date().toISOString(),
        })
        .eq('organization_id', organizationId);
    }

    // Historical audit trace preservation in organization_billable_resources
    if (scopes.numberRentalRenewal !== undefined) {
      const { data: billableRes } = await (supabase as any)
        .from('organization_billable_resources')
        .select('id, metadata')
        .eq('organization_id', organizationId)
        .eq('status', 'active');

      if (billableRes && billableRes.length > 0) {
        for (const item of billableRes) {
          const currentRentalAuth = item.metadata?.rental_payment_authorization || {};
          const updatedMeta = {
            ...(item.metadata || {}),
            rental_payment_authorization: {
              ...currentRentalAuth,
              scope: 'UNIFIED_RECURRING_SERVICE_BILLING',
              autopay_authorized: scopes.numberRentalRenewal,
              updated_by_user_id: userId,
              updated_at: new Date().toISOString(),
            },
          };
          await (supabase as any)
            .from('organization_billable_resources')
            .update({ metadata: updatedMeta, updated_at: new Date().toISOString() })
            .eq('id', item.id);
        }
      }
    }

    const currentProfile = await this.getWorkspacePaymentProfile(supabase, organizationId);
    return {
      success: true,
      scopes: currentProfile.scopes,
    };
  }

  /**
   * Records a saved default workspace payment method in billing_provider_customers metadata.
   */
  static async saveDefaultWorkspacePaymentMethod(
    supabase: SupabaseClient,
    organizationId: string,
    paymentMethod: {
      id: string;
      brand: string;
      last4: string;
    }
  ): Promise<WorkspacePaymentProfileDTO> {
    const { data: custRow } = await (supabase as any)
      .from('billing_provider_customers')
      .select('metadata')
      .eq('organization_id', organizationId)
      .eq('provider', 'stripe')
      .maybeSingle();

    const currentMeta = custRow?.metadata || {};
    const updatedMeta = {
      ...currentMeta,
      default_payment_method: {
        id: paymentMethod.id,
        brand: paymentMethod.brand,
        last4: paymentMethod.last4,
        updated_at: new Date().toISOString(),
      },
      // Deprecated flag retained for historical audit only
      saas_autopay_authorized: true,
    };

    await (supabase as any)
      .from('billing_provider_customers')
      .update({ metadata: updatedMeta, updated_at: new Date().toISOString() })
      .eq('organization_id', organizationId)
      .eq('provider', 'stripe');

    // Update organization_billable_resources metadata for historical audit trace
    const { data: billableRes } = await (supabase as any)
      .from('organization_billable_resources')
      .select('id, metadata')
      .eq('organization_id', organizationId)
      .eq('status', 'active');

    if (billableRes && billableRes.length > 0) {
      for (const item of billableRes) {
        const currentRentalAuth = item.metadata?.rental_payment_authorization || {};
        const updatedMeta = {
          ...(item.metadata || {}),
          rental_payment_authorization: {
            ...currentRentalAuth,
            scope: 'UNIFIED_RECURRING_SERVICE_BILLING',
            autopay_authorized: true,
            updated_at: new Date().toISOString(),
          },
        };
        await (supabase as any)
          .from('organization_billable_resources')
          .update({ metadata: updatedMeta, updated_at: new Date().toISOString() })
          .eq('id', item.id);
      }
    }

    return this.getWorkspacePaymentProfile(supabase, organizationId);
  }
}
