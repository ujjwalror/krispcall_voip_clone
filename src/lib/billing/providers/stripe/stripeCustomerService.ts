import { SupabaseClient } from '@supabase/supabase-js';
import { getStripeClient } from './stripeClient';

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
    email?: string
  ): Promise<string> {
    if (!organizationId) {
      throw new Error('StripeCustomerService: organizationId is required.');
    }

    // 1. Check existing mapping in public.billing_provider_customers
    const { data: existing, error: selectErr } = await (supabase as any)
      .from('billing_provider_customers')
      .select('provider_customer_id')
      .eq('organization_id', organizationId)
      .eq('provider', 'stripe')
      .maybeSingle();

    if (selectErr) {
      console.error('[StripeCustomerService] Select error:', selectErr.message);
      throw new Error(`StripeCustomerService database error: ${selectErr.message}`);
    }

    if (existing?.provider_customer_id) {
      return existing.provider_customer_id;
    }

    // 2. Lazily create customer in Stripe API with deterministic idempotency key
    const stripe = getStripeClient();
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
    const { error: insertErr } = await (supabase as any)
      .from('billing_provider_customers')
      .insert({
        organization_id: organizationId,
        provider: 'stripe',
        provider_customer_id: customer.id,
      });

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
    const { data, error } = await (supabase as any)
      .from('billing_provider_customers')
      .select('provider_customer_id')
      .eq('organization_id', organizationId)
      .eq('provider', 'stripe')
      .maybeSingle();

    if (error) {
      console.error('[StripeCustomerService] Lookup error:', error.message);
      throw new Error(`StripeCustomerService lookup error: ${error.message}`);
    }

    return data ? data.provider_customer_id : null;
  }
}
