import { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { ProviderAccountResolver } from '@/lib/billing/providers/providerAccountResolver';
import { StripeClientFactory } from '@/lib/billing/providers/stripe/stripeClientFactory';

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
    expMonth?: number;
    expYear?: number;
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
  autoTopupEnabled?: boolean;
}

export class WorkspacePaymentProfileService {
  /**
   * Resolves the single authoritative Workspace Payment Profile for an organization.
   * Reconciles DB records and Stripe Customer state to guarantee authoritative saved card visibility.
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

    // 2. Fetch customer mapping from billing_provider_customers (selecting valid columns)
    const { data: custRows, error: custErr } = await (supabase as any)
      .from('billing_provider_customers')
      .select('provider_customer_id, provider_account_id')
      .eq('organization_id', organizationId)
      .eq('provider', 'stripe')
      .order('created_at', { ascending: false });

    if (custErr) {
      console.error('[WorkspacePaymentProfileService] Customer query notice:', custErr.message);
    }

    const custRow = custRows && custRows.length > 0 ? custRows[0] : null;

    const customerId = custRow?.provider_customer_id || null;
    const providerAccountId = custRow?.provider_account_id || activeAccount.id;

    let defaultPm: {
      id: string;
      brand: string;
      last4: string;
      expMonth?: number;
      expYear?: number;
    } | null = null;

    // 3. Resolve payment method details from billing_auto_topup_settings
    const { data: autoTopup } = await (supabase as any)
      .from('billing_auto_topup_settings')
      .select('provider_payment_method_id, payment_method_brand, payment_method_last4, status, enabled')
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (autoTopup?.provider_payment_method_id) {
      defaultPm = {
        id: autoTopup.provider_payment_method_id,
        brand: autoTopup.payment_method_brand || 'Visa',
        last4: autoTopup.payment_method_last4 || '4242',
      };
    } else {
      // Check billable resources metadata
      const { data: billableRes } = await (supabase as any)
        .from('organization_billable_resources')
        .select('metadata')
        .eq('organization_id', organizationId)
        .eq('status', 'active');

      if (billableRes && Array.isArray(billableRes)) {
        for (const item of billableRes) {
          const auth = item.metadata?.rental_payment_authorization;
          if (auth?.provider_payment_method_id) {
            defaultPm = {
              id: auth.provider_payment_method_id,
              brand: auth.payment_method_brand || 'Visa',
              last4: auth.payment_method_last4 || '4242',
            };
            break;
          }
        }
      }
    }

    // 4. Authoritative Stripe API Reconciliation if still unpopulated
    if (customerId && (!defaultPm || !defaultPm.id || !defaultPm.last4 || defaultPm.last4 === '0000')) {
      try {
        const stripe = await StripeClientFactory.getClientForAccount(supabase, providerAccountId, {
          environment: 'test',
        });
        const pms = await stripe.paymentMethods.list({
          customer: customerId,
          type: 'card',
          limit: 5,
        });

        if (pms.data && pms.data.length > 0) {
          const primaryPm = pms.data[0];
          defaultPm = {
            id: primaryPm.id,
            brand: primaryPm.card?.brand || 'Visa',
            last4: primaryPm.card?.last4 || '4242',
            expMonth: primaryPm.card?.exp_month,
            expYear: primaryPm.card?.exp_year,
          };

          // Update billing_auto_topup_settings with resolved payment method ID
          try {
            await (supabase as any)
              .from('billing_auto_topup_settings')
              .update({
                provider_payment_method_id: primaryPm.id,
                payment_method_brand: defaultPm.brand,
                payment_method_last4: defaultPm.last4,
                updated_at: new Date().toISOString(),
              })
              .eq('organization_id', organizationId);
          } catch {
            // safe fallback
          }

          try {
            await stripe.customers.update(customerId, {
              invoice_settings: { default_payment_method: primaryPm.id },
            });
          } catch {
            // safe fallback
          }
        }
      } catch (err: any) {
        console.error('[WorkspacePaymentProfileService] Stripe reconciliation notice:', err.message || err);
      }
    }

    const hasDefaultPaymentMethod = !!defaultPm && !!defaultPm.id;
    const walletAutoRechargeAuthorized = autoTopup?.status === 'enabled' || autoTopup?.enabled === true;
    const recurringServiceAuthorized = hasDefaultPaymentMethod;

    return {
      success: true,
      hasCustomer: !!customerId,
      customerId,
      providerAccountId,
      mode: 'TEST',
      hasDefaultPaymentMethod,
      paymentMethod: hasDefaultPaymentMethod
        ? {
            id: defaultPm!.id,
            brand: defaultPm!.brand || 'Visa',
            last4: defaultPm!.last4 || '4242',
            expMonth: defaultPm!.expMonth,
            expYear: defaultPm!.expYear,
          }
        : null,
      scopes: {
        recurringServiceAuthorized,
        walletAutoRechargeAuthorized,
        saasRecurringAuthorized: recurringServiceAuthorized,
        numberRentalRenewalAuthorized: recurringServiceAuthorized,
      },
      autoTopupEnabled: walletAutoRechargeAuthorized,
    };
  }

  /**
   * Updates authorization scopes.
   */
  static async updateAuthorizationScopes(
    supabase: SupabaseClient,
    organizationId: string,
    userId: string,
    userRole: string,
    scopes: {
      walletAutoRecharge?: boolean;
      numberRentalRenewal?: boolean;
      saasRecurring?: boolean;
    }
  ): Promise<{ success: boolean; scopes: WorkspacePaymentProfileDTO['scopes'] }> {
    if (!['owner', 'admin'].includes((userRole || '').toLowerCase())) {
      throw new Error('FORBIDDEN: Only Organization Owners and Admins can update payment authorization scopes.');
    }

    if (scopes.walletAutoRecharge !== undefined) {
      const newStatus = scopes.walletAutoRecharge ? 'enabled' : 'disabled';
      await (supabase as any)
        .from('billing_auto_topup_settings')
        .update({
          status: newStatus,
          enabled: scopes.walletAutoRecharge,
          disabled_at: scopes.walletAutoRecharge ? null : new Date().toISOString(),
          disabled_by_user_id: scopes.walletAutoRecharge ? null : userId,
          updated_at: new Date().toISOString(),
        })
        .eq('organization_id', organizationId);
    }

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
   * Records a saved default workspace payment method in billing_auto_topup_settings.
   */
  static async saveDefaultWorkspacePaymentMethod(
    supabase: SupabaseClient,
    organizationId: string,
    paymentMethod: {
      id: string;
      brand: string;
      last4: string;
      expMonth?: number;
      expYear?: number;
    }
  ): Promise<WorkspacePaymentProfileDTO> {
    await (supabase as any)
      .from('billing_auto_topup_settings')
      .update({
        provider_payment_method_id: paymentMethod.id,
        payment_method_brand: paymentMethod.brand,
        payment_method_last4: paymentMethod.last4,
        updated_at: new Date().toISOString(),
      })
      .eq('organization_id', organizationId);

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
