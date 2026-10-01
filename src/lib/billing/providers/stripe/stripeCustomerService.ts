import { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { getStripeClient } from './stripeClient';
import { ProviderAccountResolver } from '../providerAccountResolver';
import { isExpectedLegacySchemaMissingError } from '../../schemaUtils';

export class StripeCustomerService {
  /**
   * Resolves existing Stripe Customer ID for an organization, or creates a new one lazily in Stripe
   * and records the mapping idempotently in public.billing_provider_customers.
   *
   * Concurrency-safe: Uses deterministic Stripe idempotency key + DB unique constraint handling.
   */
  static async getOrCreateStripeCustomer(
    supabase: SupabaseClient,
    organizationId: string,
    orgName?: string,
    email?: string,
    options?: { stripeOverride?: Stripe }
  ): Promise<string> {
    if (!organizationId) {
      throw new Error('StripeCustomerService: organizationId is required.');
    }

    const providerAccount = await ProviderAccountResolver.resolveActiveAccount(supabase, 'stripe', 'test');

    // 1. Check existing mapping in public.billing_provider_customers
    let query = (supabase as any)
      .from('billing_provider_customers')
      .select('provider_customer_id')
      .eq('organization_id', organizationId)
      .eq('provider', 'stripe');

    if (providerAccount?.id) {
      query = query.eq('provider_account_id', providerAccount.id);
    }

    const { data: existing, error: selectErr } = await query.maybeSingle();

    if (selectErr && !isExpectedLegacySchemaMissingError(selectErr)) {
      console.error('[StripeCustomerService] Select error:', selectErr.message);
      throw new Error(`StripeCustomerService database error: ${selectErr.message}`);
    }

    if (existing?.provider_customer_id) {
      return existing.provider_customer_id;
    }

    // 2. Lazily create customer in Stripe API with deterministic idempotency key
    const stripe = options?.stripeOverride || getStripeClient();
    const customer = await stripe.customers.create(
      {
        name: orgName || `Organization ${organizationId}`,
        email: email || undefined,
        metadata: {
          organization_id: organizationId,
        },
      },
      {
        idempotencyKey: `cus_org_${organizationId.replace(/[^a-zA-Z0-9_]/g, '_')}`,
      }
    );

    // 3. Persist mapping in billing_provider_customers
    const insertPayload: any = {
      organization_id: organizationId,
      provider: 'stripe',
      provider_customer_id: customer.id,
      provider_account_id: providerAccount.id,
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

  /**
   * Reads existing Stripe Customer ID for an organization without mutating Stripe.
   */
  static async getStripeCustomerId(
    supabase: SupabaseClient,
    organizationId: string
  ): Promise<string | null> {
    const providerAccount = await ProviderAccountResolver.resolveActiveAccount(supabase, 'stripe', 'test');

    let query = (supabase as any)
      .from('billing_provider_customers')
      .select('provider_customer_id')
      .eq('organization_id', organizationId)
      .eq('provider', 'stripe');

    if (providerAccount?.id) {
      query = query.eq('provider_account_id', providerAccount.id);
    }

    const { data, error } = await query.maybeSingle();

    if (error && !isExpectedLegacySchemaMissingError(error)) {
      console.error('[StripeCustomerService] Lookup error:', error.message);
      throw new Error(`StripeCustomerService lookup error: ${error.message}`);
    }

    return data ? data.provider_customer_id : null;
  }
}

