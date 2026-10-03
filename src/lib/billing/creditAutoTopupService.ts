import { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { ProviderAccountResolver } from './providers/providerAccountResolver';
import { ProviderCredentialRegistry } from './providers/stripe/providerCredentialRegistry';
import { StripeClientFactory } from './providers/stripe/stripeClientFactory';
import { StripeCustomerService } from './providers/stripe/stripeCustomerService';
import { validateAutoTopupConfigMajor, MIN_AUTO_TOPUP_THRESHOLD_MAJOR, MIN_AUTO_TOPUP_RECHARGE_MAJOR, CURRENT_CONSENT_TERMS_VERSION } from './autoTopupPolicy';
import { majorToMinorUnits, minorToMajorUnits } from './creditTopupPolicy';

export interface AutoTopupStatusCustomerDto {
  enabled: boolean;
  status: 'disabled' | 'enabled' | 'action_required' | 'paused_failure' | 'paused_debt' | 'paused_dispute';
  reason?: string;
  thresholdMajor: number;
  thresholdMinor: number;
  rechargeAmountMajor: number;
  rechargeAmountMinor: number;
  currency: string;
  paymentMethodBrand?: string;
  paymentMethodLast4?: string;
  enrolledAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  failureCount: number;
}

export interface CreateSetupIntentResult {
  success: boolean;
  code?: string;
  message?: string;
  attemptToken?: string;
  clientSecret?: string;
  setupIntentId?: string;
}

export interface EnrolmentCompletionResult {
  success: boolean;
  code?: string;
  message?: string;
  settings?: AutoTopupStatusCustomerDto;
}

export class CreditAutoTopupService {
  /**
   * Creates or recovers a durable enrolment attempt and Stripe SetupIntent.
   * Derives Stripe idempotency key deterministically from attemptToken: `auto_topup_setup_${attemptToken}`.
   * Owner / Admin ONLY.
   */
  static async createOrRecoverSetupIntent(
    supabase: SupabaseClient,
    organizationId: string,
    userId: string,
    userRole: string,
    params: {
      attemptToken: string;
      thresholdMajor?: number;
      rechargeAmountMajor?: number;
      currency?: string;
    }
  ): Promise<CreateSetupIntentResult> {
    if (!['owner', 'admin'].includes(userRole.toLowerCase())) {
      return {
        success: false,
        code: 'FORBIDDEN',
        message: 'Only Organization Owners and Admins can configure Auto Top-Up.',
      };
    }

    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!params.attemptToken || typeof params.attemptToken !== 'string' || !uuidRegex.test(params.attemptToken.trim())) {
      return {
        success: false,
        code: 'INVALID_ATTEMPT_TOKEN',
        message: 'A valid attemptToken UUID string is required.',
      };
    }

    const attemptToken = params.attemptToken.trim();
    const thresholdMajor = params.thresholdMajor || 10;
    const rechargeAmountMajor = params.rechargeAmountMajor || 25;
    const currency = (params.currency || 'USD').toUpperCase();

    const policyResult = validateAutoTopupConfigMajor(thresholdMajor, rechargeAmountMajor, currency);
    if (!policyResult.valid) {
      return {
        success: false,
        code: policyResult.code || 'INVALID_POLICY',
        message: policyResult.message || 'Invalid Auto Top-Up policy parameters.',
      };
    }

    try {
      const activeAccount = await ProviderAccountResolver.resolveActiveAccount(supabase, 'stripe');
      const stripeCustomerId = await StripeCustomerService.getOrCreateStripeCustomer(
        supabase,
        organizationId,
        undefined,
        undefined,
        { providerAccountId: activeAccount.id }
      );

      // Check existing durable attempt in billing_auto_topup_attempts for this attempt_token
      const { data: existingAttempt } = await (supabase as any)
        .from('billing_auto_topup_attempts')
        .select('*')
        .eq('attempt_token', attemptToken)
        .maybeSingle();

      if (existingAttempt) {
        if (existingAttempt.organization_id !== organizationId) {
          return {
            success: false,
            code: 'CROSS_TENANT_ATTEMPT_REJECTED',
            message: 'Attempt token belongs to another organization.',
          };
        }

        if (existingAttempt.setup_intent_id) {
          const stripe = await StripeClientFactory.getClientForAccount(supabase, activeAccount.id);
          const recoveredSi = await stripe.setupIntents.retrieve(existingAttempt.setup_intent_id);
          return {
            success: true,
            attemptToken,
            clientSecret: recoveredSi.client_secret || undefined,
            setupIntentId: recoveredSi.id,
          };
        }
      }

      // Record durable attempt locally BEFORE calling Stripe
      const thresholdMinor = policyResult.thresholdMinor!;
      const rechargeAmountMinor = policyResult.rechargeAmountMinor!;

      const attemptPayload = {
        organization_id: organizationId,
        attempt_token: attemptToken,
        provider_account_id: activeAccount.id,
        provider_customer_id: stripeCustomerId,
        threshold_minor: thresholdMinor,
        recharge_amount_minor: rechargeAmountMinor,
        currency,
        initiated_by_user_id: userId,
        status: 'initiated',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { data: savedAttempt, error: attemptErr } = await (supabase as any)
        .from('billing_auto_topup_attempts')
        .upsert(attemptPayload, { onConflict: 'attempt_token' })
        .select('*')
        .single();

      if (attemptErr && attemptErr.code !== '23505') {
        console.error('[CreditAutoTopupService] Failed to persist attempt:', attemptErr.message);
      }

      // Call Stripe SetupIntent API with deterministic attempt idempotency key
      const stripe = await StripeClientFactory.getClientForAccount(supabase, activeAccount.id);

      const setupIntent = await stripe.setupIntents.create(
        {
          customer: stripeCustomerId,
          usage: 'off_session',
          payment_method_types: ['card'],
          metadata: {
            organization_id: organizationId,
            enrolled_by_user_id: userId,
            provider_account_id: activeAccount.id,
            attempt_token: attemptToken,
            type: 'auto_topup_enrolment',
          },
        },
        {
          idempotencyKey: `setup_autotopup_${attemptToken.replace(/-/g, '')}`,
        }
      );

      // Persist setup_intent_id on attempt row
      await (supabase as any)
        .from('billing_auto_topup_attempts')
        .update({
          setup_intent_id: setupIntent.id,
          status: 'setup_created',
          updated_at: new Date().toISOString(),
        })
        .eq('attempt_token', attemptToken);

      return {
        success: true,
        attemptToken,
        clientSecret: setupIntent.client_secret || undefined,
        setupIntentId: setupIntent.id,
      };
    } catch (err: any) {
      console.error('[CreditAutoTopupService] createOrRecoverSetupIntent error:', err.message);
      return {
        success: false,
        code: err.code || 'SETUP_INTENT_CREATION_FAILED',
        message: err.message || 'Failed to create SetupIntent.',
      };
    }
  }

  /**
   * Authoritatively verifies SetupIntent completion with Stripe and invokes atomic DB RPC primitive.
   * Owner / Admin ONLY.
   */
  static async completeAutoTopupEnrolment(
    supabase: SupabaseClient,
    organizationId: string,
    userId: string,
    userRole: string,
    params: {
      attemptToken: string;
      setupIntentId: string;
    }
  ): Promise<EnrolmentCompletionResult> {
    if (!['owner', 'admin'].includes(userRole.toLowerCase())) {
      return {
        success: false,
        code: 'FORBIDDEN',
        message: 'Only Organization Owners and Admins can configure Auto Top-Up.',
      };
    }

    if (!params.attemptToken || !params.setupIntentId) {
      return {
        success: false,
        code: 'INVALID_ARGUMENTS',
        message: 'attemptToken and setupIntentId are required.',
      };
    }

    try {
      const activeAccount = await ProviderAccountResolver.resolveActiveAccount(supabase, 'stripe');
      const stripeCustomerId = await StripeCustomerService.getOrCreateStripeCustomer(
        supabase,
        organizationId,
        undefined,
        undefined,
        { providerAccountId: activeAccount.id }
      );

      const stripe = await StripeClientFactory.getClientForAccount(supabase, activeAccount.id);

      // Authoritative retrieval from Stripe API
      const setupIntent = await stripe.setupIntents.retrieve(params.setupIntentId);

      if (setupIntent.status !== 'succeeded') {
        return {
          success: false,
          code: 'SETUP_INTENT_NOT_SUCCEEDED',
          message: `SetupIntent status is ${setupIntent.status}. Expected succeeded.`,
        };
      }

      if (setupIntent.customer !== stripeCustomerId) {
        console.error(`[CreditAutoTopupService] Customer mismatch: SI customer ${setupIntent.customer} vs org customer ${stripeCustomerId}`);
        return {
          success: false,
          code: 'CUSTOMER_MISMATCH',
          message: 'SetupIntent customer does not match organization customer.',
        };
      }

      const pmId = typeof setupIntent.payment_method === 'string'
        ? setupIntent.payment_method
        : (setupIntent.payment_method as any)?.id;

      if (!pmId) {
        return {
          success: false,
          code: 'MISSING_PAYMENT_METHOD',
          message: 'SetupIntent has no attached PaymentMethod.',
        };
      }

      // Retrieve PaymentMethod for safe customer brand & last4
      const pm = await stripe.paymentMethods.retrieve(pmId);
      const cardBrand = pm.card?.brand ? pm.card.brand.toUpperCase() : 'CARD';
      const cardLast4 = pm.card?.last4 || '****';

      // Invoke atomic DB RPC primitive complete_auto_topup_enrolment_atomic
      const { data: rpcRes, error: rpcErr } = await (supabase as any).rpc(
        'complete_auto_topup_enrolment_atomic',
        {
          p_organization_id: organizationId,
          p_attempt_token: params.attemptToken,
          p_setup_intent_id: params.setupIntentId,
          p_provider_payment_method_id: pmId,
          p_payment_method_brand: cardBrand,
          p_payment_method_last4: cardLast4,
          p_user_id: userId,
        }
      );

      if (rpcErr) {
        console.error('[CreditAutoTopupService] complete_auto_topup_enrolment_atomic RPC error:', rpcErr.message);
        if (rpcErr.message?.includes('STALE_ENROLMENT')) {
          return {
            success: false,
            code: 'STALE_ENROLMENT',
            message: 'A newer enrolment attempt supersedes this setup attempt.',
          };
        }
        if (rpcErr.message?.includes('ENROLMENT_SUPERSEDED_BY_DISABLE')) {
          return {
            success: false,
            code: 'ENROLMENT_SUPERSEDED_BY_DISABLE',
            message: 'Auto Top-Up was disabled after this attempt was initiated.',
          };
        }
        return {
          success: false,
          code: 'ATOMIC_COMPLETION_FAILED',
          message: rpcErr.message,
        };
      }

      // Fetch resulting settings for DTO
      const { settings } = await this.getAutoTopupSettings(supabase, organizationId);

      return {
        success: true,
        settings,
      };
    } catch (err: any) {
      console.error('[CreditAutoTopupService] completeAutoTopupEnrolment error:', err.message);
      return {
        success: false,
        code: err.code || 'ENROLMENT_FAILED',
        message: err.message || 'Failed to complete Auto Top-Up enrolment.',
      };
    }
  }

  /**
   * Retrieves customer-safe Auto Top-Up status DTO.
   * Excludes all internal provider IDs (pm_..., cus_..., provider_account_id).
   */
  static async getAutoTopupSettings(
    supabase: SupabaseClient,
    organizationId: string
  ): Promise<{ success: boolean; settings: AutoTopupStatusCustomerDto }> {
    try {
      const { data: row } = await (supabase as any)
        .from('billing_auto_topup_settings')
        .select('*')
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (!row) {
        return {
          success: true,
          settings: {
            enabled: false,
            status: 'disabled',
            thresholdMajor: MIN_AUTO_TOPUP_THRESHOLD_MAJOR,
            thresholdMinor: majorToMinorUnits(MIN_AUTO_TOPUP_THRESHOLD_MAJOR),
            rechargeAmountMajor: MIN_AUTO_TOPUP_RECHARGE_MAJOR,
            rechargeAmountMinor: majorToMinorUnits(MIN_AUTO_TOPUP_RECHARGE_MAJOR),
            currency: 'USD',
            failureCount: 0,
          },
        };
      }

      let effectiveStatus = row.status as any;
      let reason = row.disabled_reason || undefined;

      try {
        const activeAccount = await ProviderAccountResolver.resolveActiveAccount(supabase, 'stripe');
        if (row.provider_account_id && row.provider_account_id !== activeAccount.id && row.status === 'enabled') {
          effectiveStatus = 'action_required';
          reason = 'PROVIDER_ACCOUNT_CHANGED';
        }
      } catch (e) {}

      const thresholdMinor = Number(row.threshold_minor || 1000);
      const rechargeAmountMinor = Number(row.recharge_amount_minor || 2500);
      const currency = row.currency || 'USD';

      return {
        success: true,
        settings: {
          enabled: effectiveStatus === 'enabled',
          status: effectiveStatus,
          reason,
          thresholdMajor: minorToMajorUnits(thresholdMinor, currency),
          thresholdMinor,
          rechargeAmountMajor: minorToMajorUnits(rechargeAmountMinor, currency),
          rechargeAmountMinor,
          currency,
          paymentMethodBrand: row.payment_method_brand || undefined,
          paymentMethodLast4: row.payment_method_last4 || undefined,
          enrolledAt: row.enrolled_at || undefined,
          lastSuccessAt: row.last_success_at || undefined,
          lastFailureAt: row.last_failure_at || undefined,
          failureCount: row.failure_count || 0,
        },
      };
    } catch (err: any) {
      console.error('[CreditAutoTopupService] getAutoTopupSettings error:', err.message);
      return {
        success: false,
        settings: {
          enabled: false,
          status: 'disabled',
          thresholdMajor: MIN_AUTO_TOPUP_THRESHOLD_MAJOR,
          thresholdMinor: majorToMinorUnits(MIN_AUTO_TOPUP_THRESHOLD_MAJOR),
          rechargeAmountMajor: MIN_AUTO_TOPUP_RECHARGE_MAJOR,
          rechargeAmountMinor: majorToMinorUnits(MIN_AUTO_TOPUP_RECHARGE_MAJOR),
          currency: 'USD',
          failureCount: 0,
        },
      };
    }
  }

  /**
   * Disables Auto Top-Up for an organization.
   * Owner / Admin ONLY.
   */
  static async disableAutoTopup(
    supabase: SupabaseClient,
    organizationId: string,
    userId: string,
    userRole: string,
    reason: string = 'customer_disabled'
  ): Promise<{ success: boolean; code?: string; message?: string }> {
    if (!['owner', 'admin'].includes(userRole.toLowerCase())) {
      return {
        success: false,
        code: 'FORBIDDEN',
        message: 'Only Organization Owners and Admins can configure Auto Top-Up.',
      };
    }

    try {
      const { data: currentSettings } = await (supabase as any)
        .from('billing_auto_topup_settings')
        .select('configuration_generation, payment_authorization_generation')
        .eq('organization_id', organizationId)
        .maybeSingle();

      const nextConfigGen = (currentSettings?.configuration_generation || 1) + 1;
      const nextAuthGen = (currentSettings?.payment_authorization_generation || 1) + 1;

      const { error: err } = await (supabase as any)
        .from('billing_auto_topup_settings')
        .update({
          status: 'disabled',
          disabled_at: new Date().toISOString(),
          disabled_by_user_id: userId,
          disabled_reason: reason,
          configuration_generation: nextConfigGen,
          payment_authorization_generation: nextAuthGen,
          updated_at: new Date().toISOString(),
        })
        .eq('organization_id', organizationId);

      if (err) {
        return {
          success: false,
          code: 'DISABLE_FAILED',
          message: err.message,
        };
      }

      return { success: true };
    } catch (err: any) {
      return {
        success: false,
        code: 'DISABLE_FAILED',
        message: err.message,
      };
    }
  }

  /**
   * Evaluates eligibility for Auto Top-Up without performing any charges.
   * Pure read-only checker for future trigger engine.
   */
  static async checkAutoTopupEligibility(
    supabase: SupabaseClient,
    organizationId: string
  ): Promise<{ eligible: boolean; reason?: string; settings?: any }> {
    const { data: settings } = await (supabase as any)
      .from('billing_auto_topup_settings')
      .select('*')
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!settings || settings.status !== 'enabled') {
      return { eligible: false, reason: `Settings status is ${settings?.status || 'disabled'}` };
    }

    // Check account debt
    const { data: debts } = await (supabase as any)
      .from('billing_account_debts')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('status', 'active');

    if (debts && debts.length > 0) {
      return { eligible: false, reason: 'Organization has active account debt' };
    }

    // Check provider account match
    try {
      const activeAccount = await ProviderAccountResolver.resolveActiveAccount(supabase, 'stripe');
      if (settings.provider_account_id !== activeAccount.id) {
        return { eligible: false, reason: 'PROVIDER_ACCOUNT_CHANGED' };
      }
    } catch (e: any) {
      return { eligible: false, reason: 'ACTIVE_PROVIDER_ACCOUNT_UNAVAILABLE' };
    }

    return { eligible: true, settings };
  }

  /**
   * C.5C.2: Evaluates spendable balance and atomically claims an Auto Top-Up trigger if eligible.
   * Invokes claim_auto_topup_trigger_atomic RPC.
   */
  static async claimAutoTopupTriggerAtomic(
    supabase: SupabaseClient,
    organizationId: string,
    leaseOwner: string = 'worker_node'
  ): Promise<any> {
    try {
      const { data, error } = await (supabase as any).rpc('claim_auto_topup_trigger_atomic', {
        p_organization_id: organizationId,
        p_lease_owner: leaseOwner,
      });

      if (error) {
        return { success: false, claimed: false, reason: error.message };
      }
      return data;
    } catch (err: any) {
      return { success: false, claimed: false, reason: err.message };
    }
  }

  /**
   * C.5C.2: Evaluates spendable balance and atomically re-arms threshold_state if spendable_balance > threshold_minor.
   * Invokes rearm_auto_topup_threshold_atomic RPC.
   */
  static async rearmAutoTopupThresholdAtomic(
    supabase: SupabaseClient,
    organizationId: string
  ): Promise<any> {
    try {
      const { data, error } = await (supabase as any).rpc('rearm_auto_topup_threshold_atomic', {
        p_organization_id: organizationId,
      });

      if (error) {
        return { success: false, rearmed: false, reason: error.message };
      }
      return data;
    } catch (err: any) {
      return { success: false, rearmed: false, reason: err.message };
    }
  }

  /**
   * C.5C.2: Irreversible local provider mutation authorization RPC.
   * Creates/links billing_payment_operations row and transitions trigger status to 'provider_mutation_authorized'.
   * DOES NOT CALL STRIPE.
   */
  static async authorizeAutoTopupProviderMutationAtomic(
    supabase: SupabaseClient,
    organizationId: string,
    triggerId: string
  ): Promise<any> {
    try {
      const { data, error } = await (supabase as any).rpc('authorize_auto_topup_provider_mutation_atomic', {
        p_organization_id: organizationId,
        p_trigger_id: triggerId,
      });

      if (error) {
        return { success: false, authorized: false, reason: error.message };
      }
      return data;
    } catch (err: any) {
      return { success: false, authorized: false, reason: err.message };
    }
  }

  /**
   * C.5C.2: Computes authoritative spendable balance in minor units.
   * Invokes get_spendable_credit_balance_minor RPC.
   */
  static async getSpendableCreditBalanceMinor(
    supabase: SupabaseClient,
    organizationId: string
  ): Promise<number> {
    try {
      const { data, error } = await (supabase as any).rpc('get_spendable_credit_balance_minor', {
        p_organization_id: organizationId,
      });

      if (error) {
        console.error('[CreditAutoTopupService] getSpendableCreditBalanceMinor RPC error:', error.message);
        return 0;
      }
      return Number(data || 0);
    } catch (err: any) {
      console.error('[CreditAutoTopupService] getSpendableCreditBalanceMinor error:', err.message);
      return 0;
    }
  }
}
