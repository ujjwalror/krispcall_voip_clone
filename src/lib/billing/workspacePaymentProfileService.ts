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
    saasRecurringAuthorized: boolean;
    numberRentalRenewalAuthorized: boolean;
    walletAutoRechargeAuthorized: boolean;
  };
}

export class WorkspacePaymentProfileService {
  /**
   * Resolves the single authoritative Workspace Payment Profile and authorization scopes for an organization.
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

    // 3. Resolve authorization scopes independently
    // (a) Number rental scope check from organization_billable_resources
    const { data: billableRes } = await (supabase as any)
      .from('organization_billable_resources')
      .select('metadata')
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .limit(1);

    const rentalAuthMeta = billableRes?.[0]?.metadata?.rental_payment_authorization;
    const numberRentalRenewalAuthorized = rentalAuthMeta?.autopay_authorized ?? false;

    // (b) Wallet auto-recharge scope check from organization_billing_controls / auto top-up settings
    const { data: billingControls } = await (supabase as any)
      .from('organization_billing_controls')
      .select('disallow_high_cost_destinations, is_billing_restricted')
      .eq('organization_id', organizationId)
      .maybeSingle();

    const { data: walletSettings } = await (supabase as any)
      .from('billing_auto_topup_settings')
      .select('status')
      .eq('organization_id', organizationId)
      .maybeSingle();

    const walletAutoRechargeAuthorized = walletSettings?.status === 'enabled';

    // (c) SaaS recurring check
    const saasRecurringAuthorized = metadata.saas_autopay_authorized ?? true;

    return {
      success: true,
      hasCustomer: !!customerId,
      customerId,
      providerAccountId: activeAccount.id,
      mode: 'TEST',
      hasDefaultPaymentMethod: !!defaultPm,
      paymentMethod: defaultPm
        ? {
            id: defaultPm.id,
            brand: defaultPm.brand,
            last4: defaultPm.last4,
          }
        : null,
      scopes: {
        saasRecurringAuthorized,
        numberRentalRenewalAuthorized,
        walletAutoRechargeAuthorized,
      },
    };
  }

  /**
   * Updates product-specific authorization scopes independently for an organization.
   */
  static async updateAuthorizationScopes(
    supabase: SupabaseClient,
    organizationId: string,
    userId: string,
    userRole: string,
    scopes: {
      numberRentalRenewal?: boolean;
      saasRecurring?: boolean;
      walletAutoRecharge?: boolean;
    }
  ): Promise<{ success: boolean; scopes: WorkspacePaymentProfileDTO['scopes'] }> {
    if (!['owner', 'admin'].includes((userRole || '').toLowerCase())) {
      throw new Error('FORBIDDEN: Only Organization Owners and Admins can update payment authorization scopes.');
    }

    // 1. Update Number Rental Renewal scope in organization_billable_resources metadata
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
              scope: 'PHONE_NUMBER_RENTAL_RENEWAL',
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

    // 2. Update Wallet Auto-Recharge scope in billing_auto_topup_settings status if wallet settings exist
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

    // 3. Update SaaS recurring scope in billing_provider_customers metadata
    if (scopes.saasRecurring !== undefined) {
      const { data: custRow } = await (supabase as any)
        .from('billing_provider_customers')
        .select('metadata')
        .eq('organization_id', organizationId)
        .eq('provider', 'stripe')
        .maybeSingle();

      if (custRow) {
        const updatedMeta = {
          ...(custRow.metadata || {}),
          saas_autopay_authorized: scopes.saasRecurring,
          updated_at: new Date().toISOString(),
        };
        await (supabase as any)
          .from('billing_provider_customers')
          .update({ metadata: updatedMeta, updated_at: new Date().toISOString() })
          .eq('organization_id', organizationId)
          .eq('provider', 'stripe');
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
    },
    initialScopes?: {
      numberRentalRenewal?: boolean;
      saasRecurring?: boolean;
      walletAutoRecharge?: boolean;
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
    };

    await (supabase as any)
      .from('billing_provider_customers')
      .update({ metadata: updatedMeta, updated_at: new Date().toISOString() })
      .eq('organization_id', organizationId)
      .eq('provider', 'stripe');

    if (initialScopes) {
      await this.updateAuthorizationScopes(supabase, organizationId, 'system', 'admin', initialScopes);
    }

    return this.getWorkspacePaymentProfile(supabase, organizationId);
  }
}
