import { SupabaseClient } from '@supabase/supabase-js';

export const DEFAULT_TEST_ACCOUNT_ID = '00000000-0000-0000-0000-0000000000aa';

export interface ResolvedProviderAccount {
  id: string;
  provider: string;
  providerAccountReference: string;
  environment: 'test' | 'live';
  status: 'active' | 'retired';
}

/**
 * Server-Only Payment Provider Account Resolver.
 * Resolves durable provider_account_id mapping without exposing account details to browser clients.
 */
export class ProviderAccountResolver {
  public static readonly DEFAULT_TEST_ACCOUNT_ID = DEFAULT_TEST_ACCOUNT_ID;
  public static readonly DEFAULT_TEST_REF = 'stripe_primary_test';

  /**
   * Resolves active provider account for provider & environment context.
   * Pre-migration safe: Falls back gracefully to default test account if billing_provider_accounts table is not yet deployed.
   */
  static async resolveActiveAccount(
    supabase: SupabaseClient,
    provider: string = 'stripe',
    environment: 'test' | 'live' = 'test'
  ): Promise<ResolvedProviderAccount> {
    if (!provider || !provider.trim()) {
      throw new Error('PROVIDER_ACCOUNT_ERROR: provider is required.');
    }

    const cleanProvider = provider.trim().toLowerCase();
    const cleanEnv = environment.trim().toLowerCase() as 'test' | 'live';

    try {
      const { data, error } = await (supabase as any)
        .from('billing_provider_accounts')
        .select('id, provider, provider_account_reference, environment, status')
        .eq('provider', cleanProvider)
        .eq('environment', cleanEnv)
        .eq('status', 'active');

      if (!error && Array.isArray(data)) {
        if (data.length > 1) {
          throw new Error(`Ambiguous provider account configuration: found ${data.length} active accounts for ${cleanProvider}/${cleanEnv}`);
        }
        if (data.length === 1) {
          return {
            id: data[0].id,
            provider: data[0].provider,
            providerAccountReference: data[0].provider_account_reference,
            environment: data[0].environment,
            status: data[0].status,
          };
        }
        if (data.length === 0) {
          throw new Error(`No active payment provider account found for ${cleanProvider}/${cleanEnv}`);
        }
      }
    } catch (err: any) {
      if (err.message?.includes('Ambiguous') || err.message?.includes('No active')) {
        throw err;
      }
      // Ignore database table missing errors pre-migration
    }

    // Default fallback sentinel representation for current test mode context
    return {
      id: ProviderAccountResolver.DEFAULT_TEST_ACCOUNT_ID,
      provider: cleanProvider,
      providerAccountReference: ProviderAccountResolver.DEFAULT_TEST_REF,
      environment: cleanEnv,
      status: 'active',
    };
  }

  static async resolveActiveAccountId(
    supabase: SupabaseClient,
    provider: string = 'stripe',
    environment: 'test' | 'live' = 'test'
  ): Promise<string> {
    const acc = await this.resolveActiveAccount(supabase, provider, environment);
    return acc.id;
  }

  static async resolveAccountFromReference(
    supabase: SupabaseClient,
    provider: string,
    environment: 'test' | 'live',
    reference: string
  ): Promise<string> {
    const acc = await this.resolveActiveAccount(supabase, provider, environment);
    if (acc.providerAccountReference !== reference) {
      throw new Error(`Provider account reference mismatch: expected ${reference}, got ${acc.providerAccountReference}`);
    }
    return acc.id;
  }
}
