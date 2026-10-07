import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { ProviderAccountResolver } from '@/lib/billing/providers/providerAccountResolver';
import { StripeClientFactory } from '@/lib/billing/providers/stripe/stripeClientFactory';
import { StripeCustomerService } from '@/lib/billing/providers/stripe/stripeCustomerService';

export const OLD_MARKETPLACE_PI_ID = 'pi_3UMufrLmbwBcPj5g1SRmtlWP';

export interface CreateRenewalSetupIntentParams {
  organizationId: string;
  userId: string;
  userRole: string;
  attemptToken: string;
  phoneNumberId?: string;
  billableResourceId?: string;
}

export interface CreateRenewalSetupIntentResult {
  success: boolean;
  code?: string;
  message?: string;
  attemptToken?: string;
  clientSecret?: string;
  setupIntentId?: string;
  customerId?: string;
  mode?: 'TEST' | 'LIVE';
}

export interface CompleteRenewalSetupIntentParams {
  organizationId: string;
  userId: string;
  attemptToken: string;
  setupIntentId: string;
  consentAccepted: boolean;
  consentScope?: string;
}

export interface CompleteRenewalSetupIntentResult {
  success: boolean;
  code?: string;
  message?: string;
  customerId?: string;
  paymentMethodId?: string;
  autopayAuthorized?: boolean;
  scope?: string;
}

export class NumberRenewalPaymentIdentityService {
  /**
   * Resolves or creates a Stripe TEST customer idempotently for the organization.
   */
  static async getOrCreateTestCustomer(
    supabase: SupabaseClient,
    organizationId: string,
    orgName?: string,
    email?: string
  ): Promise<{ customerId: string; providerAccountId: string; mode: 'TEST' }> {
    if (!organizationId) {
      throw new Error('INVALID_ORGANIZATION_ID: organizationId is required.');
    }

    const activeAccount = await ProviderAccountResolver.resolveActiveAccount(supabase, 'stripe', 'test');
    const customerId = await StripeCustomerService.getOrCreateStripeCustomer(
      supabase,
      organizationId,
      orgName,
      email,
      { providerAccountId: activeAccount.id, environment: 'test' }
    );

    return {
      customerId,
      providerAccountId: activeAccount.id,
      mode: 'TEST',
    };
  }

  /**
   * Creates or recovers a controlled Stripe TEST SetupIntent for off-session phone-number rental payments.
   * STRICTLY NO PAYMENT INTENT / NO CHARGE. SetupIntent contains 0 dollar amount.
   */
  static async createRenewalSetupIntent(
    supabase: SupabaseClient,
    params: CreateRenewalSetupIntentParams
  ): Promise<CreateRenewalSetupIntentResult> {
    const { organizationId, userId, userRole, attemptToken, phoneNumberId, billableResourceId } = params;

    // 1. Role Authorization
    if (!['owner', 'admin'].includes((userRole || '').toLowerCase())) {
      return {
        success: false,
        code: 'FORBIDDEN',
        message: 'Only Organization Owners and Admins can configure recurring payment methods.',
      };
    }

    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!attemptToken || typeof attemptToken !== 'string' || !uuidRegex.test(attemptToken.trim())) {
      return {
        success: false,
        code: 'INVALID_ATTEMPT_TOKEN',
        message: 'A valid attemptToken UUID string is required.',
      };
    }

    const cleanAttemptToken = attemptToken.trim();

    try {
      // 2. Resolve/Create TEST Stripe Customer for Organization
      const customerInfo = await this.getOrCreateTestCustomer(supabase, organizationId);
      const stripe = await StripeClientFactory.getClientForAccount(supabase, customerInfo.providerAccountId, {
        environment: 'test',
      });

      // 3. Create Stripe SetupIntent with usage='off_session' and explicit metadata
      const setupIntent = await stripe.setupIntents.create(
        {
          customer: customerInfo.customerId,
          usage: 'off_session',
          payment_method_types: ['card'],
          metadata: {
            organization_id: organizationId,
            purpose: 'PHONE_NUMBER_RENTAL_RENEWAL',
            initiated_by_user_id: userId,
            attempt_token: cleanAttemptToken,
            phone_number_id: phoneNumberId || '',
            billable_resource_id: billableResourceId || '',
          },
        },
        {
          idempotencyKey: `num_renewal_setup_${customerInfo.providerAccountId.slice(0, 8)}_${organizationId.replace(/[^a-zA-Z0-9_]/g, '_')}_${cleanAttemptToken}`,
        }
      );

      // 4. Record initiation attempt in DB idempotently if billing_auto_topup_attempts exists
      await (supabase as any)
        .from('billing_auto_topup_attempts')
        .insert({
          organization_id: organizationId,
          attempt_token: cleanAttemptToken,
          provider_account_id: customerInfo.providerAccountId,
          provider_customer_id: customerInfo.customerId,
          setup_intent_id: setupIntent.id,
          threshold_minor: 1, // dummy constraint satisfaction
          recharge_amount_minor: 1, // dummy constraint satisfaction
          currency: 'USD',
          initiated_by_user_id: userId,
          status: 'setup_created',
        })
        .catch(() => {
          // Non-blocking fallback if attempts table is not used
        });

      return {
        success: true,
        attemptToken: cleanAttemptToken,
        clientSecret: setupIntent.client_secret || undefined,
        setupIntentId: setupIntent.id,
        customerId: customerInfo.customerId,
        mode: 'TEST',
      };
    } catch (err: any) {
      console.error('[NumberRenewalPaymentIdentityService] createRenewalSetupIntent error:', err.message || err);
      return {
        success: false,
        code: 'SETUP_INTENT_CREATION_FAILED',
        message: err.message || 'Failed to create renewal SetupIntent.',
      };
    }
  }

  /**
   * Verifies SetupIntent completion with Stripe and records explicit customer consent in DB.
   * FAILS CLOSED if SetupIntent status is not 'succeeded' or if explicit consent was not given.
   */
  static async completeRenewalSetupIntent(
    supabase: SupabaseClient,
    params: CompleteRenewalSetupIntentParams
  ): Promise<CompleteRenewalSetupIntentResult> {
    const { organizationId, userId, attemptToken, setupIntentId, consentAccepted, consentScope } = params;

    // 1. Explicit Consent Gate
    if (!consentAccepted) {
      return {
        success: false,
        code: 'CONSENT_REQUIRED',
        message: 'Explicit customer consent is required to enable automatic recurring number-rental charges.',
      };
    }

    if (!attemptToken || !setupIntentId) {
      return {
        success: false,
        code: 'INVALID_ARGUMENTS',
        message: 'attemptToken and setupIntentId are required.',
      };
    }

    try {
      const customerInfo = await this.getOrCreateTestCustomer(supabase, organizationId);
      const stripe = await StripeClientFactory.getClientForAccount(supabase, customerInfo.providerAccountId, {
        environment: 'test',
      });

      // 2. Retrieve SetupIntent from Stripe
      const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);

      // 3. Strict Verification & Fail-Closed Checks
      if (setupIntent.status !== 'succeeded') {
        return {
          success: false,
          code: 'SETUP_INTENT_NOT_SUCCEEDED',
          message: `SetupIntent status is ${setupIntent.status}. Expected succeeded.`,
        };
      }

      if (setupIntent.customer !== customerInfo.customerId) {
        return {
          success: false,
          code: 'CUSTOMER_MISMATCH',
          message: 'SetupIntent customer does not match organization customer.',
        };
      }

      const pmId =
        typeof setupIntent.payment_method === 'string'
          ? setupIntent.payment_method
          : (setupIntent.payment_method as any)?.id;

      if (!pmId) {
        return {
          success: false,
          code: 'NO_PAYMENT_METHOD',
          message: 'SetupIntent has no attached PaymentMethod.',
        };
      }

      // Fetch payment method details (brand, last4) from Stripe
      const pmObj = await stripe.paymentMethods.retrieve(pmId);

      const brand = pmObj.card?.brand || 'card';
      const last4 = pmObj.card?.last4 || '0000';
      const scope = consentScope || 'PHONE_NUMBER_RENTAL_RENEWAL';

      // 4. Record explicit consent and saved off-session payment method in billing_auto_topup_settings
      const settingsPayload: any = {
        organization_id: organizationId,
        status: 'enabled',
        threshold_minor: 1, // satisfies schema check
        recharge_amount_minor: 1, // satisfies schema check
        currency: 'USD',
        provider_account_id: customerInfo.providerAccountId,
        provider_customer_id: customerInfo.customerId,
        provider_payment_method_id: pmId,
        payment_method_brand: brand,
        payment_method_last4: last4,
        enrolled_by_user_id: userId,
        enrolled_at: new Date().toISOString(),
        consent_terms_version: 'v1.0',
        updated_at: new Date().toISOString(),
      };

      const { error: upsertErr } = await (supabase as any)
        .from('billing_auto_topup_settings')
        .upsert(settingsPayload, { onConflict: 'organization_id' });

      if (upsertErr) {
        console.error('[NumberRenewalPaymentIdentityService] Settings upsert error:', upsertErr.message);
        throw new Error(`Database save error: ${upsertErr.message}`);
      }

      // 5. Update attempt status
      await (supabase as any)
        .from('billing_auto_topup_attempts')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('attempt_token', attemptToken);

      return {
        success: true,
        customerId: customerInfo.customerId,
        paymentMethodId: pmId,
        autopayAuthorized: true,
        scope,
      };
    } catch (err: any) {
      console.error('[NumberRenewalPaymentIdentityService] completeRenewalSetupIntent error:', err.message || err);
      return {
        success: false,
        code: 'SETUP_COMPLETION_FAILED',
        message: err.message || 'Failed to complete renewal setup.',
      };
    }
  }
}
