import { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { ProviderCredentialRegistry } from './providers/stripe/providerCredentialRegistry';
import { StripeClientFactory } from './providers/stripe/stripeClientFactory';
import { CreditTopupWebhookService } from './creditTopupWebhookService';

export interface ExecuteTriggerResult {
  success: boolean;
  status?: string;
  alreadyFunded?: boolean;
  transient?: boolean;
  reason?: string;
  errorCode?: string;
  paymentIntentId?: string;
  clientSecret?: string;
}

export class CreditAutoTopupExecutionService {
  /**
   * Executes an in-flight Auto Top-Up trigger that has crossed the durable
   * `provider_mutation_authorized` boundary.
   *
   * Uses ONLY snapshotted trigger attributes.
   * Derives Stripe request idempotency deterministically: `atu_pi_<trigger_id>`.
   * Enforces exact-once funding via C.4 CreditTopupWebhookService / fund_credit_topup_from_payment_atomic.
   */
  static async executeAuthorizedTrigger(
    supabase: SupabaseClient,
    organizationId: string,
    triggerId: string
  ): Promise<ExecuteTriggerResult> {
    if (!organizationId || !triggerId) {
      return { success: false, reason: 'INVALID_ARGUMENTS' };
    }

    // 1. Fetch locked trigger row
    const { data: trigger, error: triggerErr } = await (supabase as any)
      .from('billing_auto_topup_triggers')
      .select('*')
      .eq('id', triggerId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (triggerErr) {
      return { success: false, transient: true, reason: triggerErr.message };
    }

    if (!trigger) {
      return { success: false, reason: 'TRIGGER_NOT_FOUND' };
    }

    if (trigger.status === 'funded') {
      return { success: true, status: 'funded', alreadyFunded: true, paymentIntentId: trigger.provider_payment_id };
    }

    if (!['provider_mutation_authorized', 'processing', 'ambiguous', 'requires_action'].includes(trigger.status)) {
      return { success: false, reason: 'INVALID_TRIGGER_STATUS', status: trigger.status };
    }

    // 2. Resolve credentials for SNAPSHOTTED provider_account_id
    const providerAccountId = trigger.provider_account_id_snapshot;
    if (!providerAccountId) {
      return { success: false, reason: 'MISSING_PROVIDER_ACCOUNT_ID' };
    }

    const env = ProviderCredentialRegistry.resolveServerRuntimeEnvironment();
    let stripe: Stripe;
    try {
      stripe = await StripeClientFactory.getClientForAccount(supabase, providerAccountId);
    } catch (credErr: any) {
      console.error(`[CreditAutoTopupExecutionService] Credential resolution failed for account ${providerAccountId}:`, credErr.message);
      return { success: false, transient: true, reason: 'PROVIDER_CREDENTIALS_UNAVAILABLE' };
    }

    // 3. Obtain or recover Stripe PaymentIntent using immutable idempotency rules
    let pi: Stripe.PaymentIntent;
    const idempotencyKey = trigger.provider_idempotency_key || `atu_pi_${trigger.id}`;

    try {
      if (trigger.provider_payment_id && trigger.provider_payment_id.startsWith('pi_')) {
        // CORRECTION 1: pi_... is known, retrieve exact PI
        pi = await stripe.paymentIntents.retrieve(trigger.provider_payment_id);
      } else {
        // Call create using idempotencyKey: atu_pi_<trigger_id>
        pi = await stripe.paymentIntents.create(
          {
            amount: Number(trigger.recharge_amount_minor_snapshot),
            currency: trigger.currency_snapshot.toLowerCase(),
            customer: trigger.provider_customer_id_snapshot || undefined,
            payment_method: trigger.provider_payment_method_id_snapshot || undefined,
            off_session: true,
            confirm: true,
            metadata: {
              operation_type: 'credit_topup',
              payment_operation_id: trigger.payment_operation_id || '',
              auto_topup_trigger_id: trigger.id,
              organization_id: trigger.organization_id,
            },
          },
          { idempotencyKey }
        );
      }
    } catch (stripeErr: any) {
      console.error(`[CreditAutoTopupExecutionService] Stripe API error for trigger ${trigger.id}:`, stripeErr.message);

      // Evaluate whether Stripe returned a definitive decline or transient network error
      const errCode = stripeErr.code || stripeErr.decline_code;
      if (stripeErr.type === 'StripeCardError' || ['card_declined', 'insufficient_funds', 'expired_card', 'incorrect_cvc'].includes(errCode)) {
        await (supabase as any).rpc('fail_auto_topup_trigger_atomic', {
          p_organization_id: organizationId,
          p_trigger_id: triggerId,
          p_error_code: errCode || 'CARD_DECLINED',
          p_reason: stripeErr.message,
        });
        return { success: false, status: 'failed', errorCode: errCode || 'CARD_DECLINED', reason: stripeErr.message };
      }

      // Transient network timeout or 5xx -> retain ambiguous/processing state
      return { success: false, transient: true, reason: stripeErr.message };
    }

    // 4. Persist real pi_... ID safely via CAS RPC
    if (pi && pi.id) {
      const { data: recResult, error: recErr } = await (supabase as any).rpc(
        'record_auto_topup_provider_payment_id_atomic',
        {
          p_organization_id: organizationId,
          p_trigger_id: triggerId,
          p_provider_payment_id: pi.id,
        }
      );

      if (recErr || (recResult && !recResult.success)) {
        const failReason = recErr?.message || recResult?.reason;
        if (failReason === 'PROVIDER_PAYMENT_ID_MISMATCH') {
          console.error(`[CreditAutoTopupExecutionService] CRITICAL: Different PI ID detected for trigger ${triggerId}! Failing closed.`);
          await (supabase as any).rpc('fail_auto_topup_trigger_atomic', {
            p_organization_id: organizationId,
            p_trigger_id: triggerId,
            p_error_code: 'PROVIDER_PAYMENT_ID_MISMATCH',
            p_reason: 'Observed conflicting Stripe PaymentIntent ID.',
          });
          return { success: false, status: 'failed', reason: 'PROVIDER_PAYMENT_ID_MISMATCH' };
        }
      }
    }

    // 5. Evaluate authoritative PaymentIntent status
    if (pi.status === 'succeeded') {
      // Build event context and execute exact-once C.4 funding
      const syntheticEvent: Stripe.Event = {
        id: `evt_atu_${pi.id}`,
        object: 'event',
        api_version: '2023-10-16',
        created: Math.floor(Date.now() / 1000),
        type: 'payment_intent.succeeded',
        data: { object: pi },
        livemode: pi.livemode,
        pending_webhooks: 0,
        request: null,
      };

      const fundingResult = await CreditTopupWebhookService.processPaymentIntentSucceeded(supabase, syntheticEvent, {
        providerAccountId,
      });

      if (!fundingResult.success && fundingResult.code !== 'ALREADY_FUNDED') {
        console.error(`[CreditAutoTopupExecutionService] processPaymentIntentSucceeded failed for trigger ${triggerId}:`, fundingResult.message);
        return { success: false, transient: true, reason: fundingResult.message };
      }

      // Mark trigger funded and re-arm threshold atomically
      await (supabase as any).rpc('complete_auto_topup_funding_atomic', {
        p_organization_id: organizationId,
        p_trigger_id: triggerId,
      });

      return {
        success: true,
        status: 'funded',
        alreadyFunded: fundingResult.alreadyFunded,
        paymentIntentId: pi.id,
      };
    } else if (pi.status === 'requires_action' || pi.status === 'requires_confirmation') {
      await (supabase as any).rpc('mark_auto_topup_requires_action_atomic', {
        p_organization_id: organizationId,
        p_trigger_id: triggerId,
        p_client_secret: pi.client_secret || undefined,
      });

      return {
        success: true,
        status: 'requires_action',
        paymentIntentId: pi.id,
        clientSecret: pi.client_secret || undefined,
      };
    } else if (pi.status === 'requires_payment_method' || pi.status === 'canceled') {
      const errCode = pi.last_payment_error?.code || 'PAYMENT_METHOD_REQUIRED';
      await (supabase as any).rpc('fail_auto_topup_trigger_atomic', {
        p_organization_id: organizationId,
        p_trigger_id: triggerId,
        p_error_code: errCode,
        p_reason: pi.last_payment_error?.message || 'Payment method required or canceled.',
      });

      return {
        success: false,
        status: 'failed',
        errorCode: errCode,
        reason: pi.last_payment_error?.message || 'Payment method failed.',
      };
    } else {
      // Processing or unhandled status
      return { success: false, transient: true, reason: `UNHANDLED_PI_STATUS: ${pi.status}` };
    }
  }

  /**
   * Recovers in-flight triggers stuck in processing or ambiguous state.
   */
  static async recoverAmbiguousTriggers(
    supabase: SupabaseClient,
    batchSize: number = 10
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    const { data: staleTriggers } = await (supabase as any)
      .from('billing_auto_topup_triggers')
      .select('id, organization_id')
      .in('status', ['provider_mutation_authorized', 'processing', 'ambiguous'])
      .lt('updated_at', new Date(Date.now() - 60000).toISOString())
      .limit(batchSize);

    if (!staleTriggers || staleTriggers.length === 0) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    let succeeded = 0;
    let failed = 0;

    for (const t of staleTriggers) {
      const res = await CreditAutoTopupExecutionService.executeAuthorizedTrigger(supabase, t.organization_id, t.id);
      if (res.success) succeeded++;
      else if (!res.transient) failed++;
    }

    return { processed: staleTriggers.length, succeeded, failed };
  }
}
