import { SupabaseClient } from '@supabase/supabase-js';
import { isExpectedLegacySchemaMissingError } from '../schemaUtils';

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
   * Fail closed: Live environments must NEVER use legacy sentinel fallback.
   * Pre-migration safe: Falls back gracefully to default test account ONLY in test mode when billing_provider_accounts table is missing.
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

      if (error) {
        throw error;
      }

      if (Array.isArray(data)) {
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

      // Live environment MUST NEVER fall back to legacy sentinel
      if (cleanEnv === 'live') {
        throw new Error(`LIVE_PROVIDER_ACCOUNT_UNAVAILABLE: Provider account lookup failed for live environment: ${err.message}`);
      }

      // In test mode, fail closed if error is NOT an expected missing legacy schema error
      if (!isExpectedLegacySchemaMissingError(err)) {
        throw err;
      }
    }

    // Prohibit sentinel fallback for live environment
    if (cleanEnv === 'live') {
      throw new Error(`LIVE_PROVIDER_ACCOUNT_UNAVAILABLE: No active payment provider account found for ${cleanProvider}/live`);
    }

    // Default fallback sentinel representation for test mode pre-migration ONLY
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

