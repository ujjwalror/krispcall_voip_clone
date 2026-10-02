import { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { getStripeClient } from './stripeClient';
import { StripeClientFactory } from './stripeClientFactory';
import { ProviderAccountResolver } from '../providerAccountResolver';
import { isExpectedLegacySchemaMissingError } from '../../schemaUtils';

export class StripeCustomerService {
  /**
   * Resolves existing Stripe Customer ID for an organization, or creates a new one lazily in Stripe
   * and records the mapping idempotently in public.billing_provider_customers.
   *
   * Customer mappings and Stripe client instantiations are explicitly scoped by provider_account_id
   * to guarantee Customer IDs from Account A are never passed to Account B.
   */
  static async getOrCreateStripeCustomer(
    supabase: SupabaseClient,
    organizationId: string,
    orgName?: string,
    email?: string,
    options?: { stripeOverride?: Stripe; providerAccountId?: string; environment?: 'test' | 'live' }
  ): Promise<string> {
    if (!organizationId) {
      throw new Error('StripeCustomerService: organizationId is required.');
    }

    const env = options?.environment || 'test';
    let providerAccountId: string;

    if (options?.providerAccountId) {
      providerAccountId = options.providerAccountId;
    } else {
      const activeAccount = await ProviderAccountResolver.resolveActiveAccount(supabase, 'stripe', env);
      providerAccountId = activeAccount.id;
    }

    // 1. Check existing mapping in public.billing_provider_customers for exact provider_account_id
    let query = (supabase as any)
      .from('billing_provider_customers')
      .select('provider_customer_id')
      .eq('organization_id', organizationId)
      .eq('provider', 'stripe');

    if (providerAccountId) {
      query = query.eq('provider_account_id', providerAccountId);
    }

    const { data: existing, error: selectErr } = await query.maybeSingle();

    if (selectErr && !isExpectedLegacySchemaMissingError(selectErr)) {
      console.error('[StripeCustomerService] Select error:', selectErr.message);
      throw new Error(`StripeCustomerService database error: ${selectErr.message}`);
    }

    if (existing?.provider_customer_id) {
      return existing.provider_customer_id;
    }

    // 2. Obtain account-specific Stripe client instance
    let stripe: Stripe;
    if (options?.stripeOverride) {
      stripe = options.stripeOverride;
    } else {
      stripe = await StripeClientFactory.getClientForAccount(supabase, providerAccountId, { environment: env });
    }

    // 3. Lazily create customer in Stripe API with deterministic idempotency key
    const customer = await stripe.customers.create(
      {
        name: orgName || `Organization ${organizationId}`,
        email: email || undefined,
        metadata: {
          organization_id: organizationId,
        },
      },
      {
        idempotencyKey: `cus_${providerAccountId.slice(0, 8)}_org_${organizationId.replace(/[^a-zA-Z0-9_]/g, '_')}`,
      }
    );

    // 4. Persist mapping in billing_provider_customers
    const insertPayload: any = {
      organization_id: organizationId,
      provider: 'stripe',
      provider_customer_id: customer.id,
      provider_account_id: providerAccountId,
    };

    let { error: insertErr } = await (supabase as any)
      .from('billing_provider_customers')
      .insert(insertPayload);

    if (insertErr && isExpectedLegacySchemaMissingError(insertErr)) {
      delete insertPayload.provider_account_id;
      const retry = await (supabase as any)
        .from('billing_provider_customers')
        .insert(insertPayload);
      insertErr = retry.error;
    }

    if (insertErr) {
      if (insertErr.code === '23505') {
        // Unique violation: another concurrent request saved the mapping
        const { data: retryData } = await (supabase as any)
          .from('billing_provider_customers')
          .select('provider_customer_id')
          .eq('organization_id', organizationId)
          .eq('provider', 'stripe')
          .single();

        if (retryData?.provider_customer_id) {
          return retryData.provider_customer_id;
        }
      }
      console.error('[StripeCustomerService] Insert error:', insertErr.message);
      throw new Error(`StripeCustomerService mapping error: ${insertErr.message}`);
    }

    return customer.id;
  }
}
