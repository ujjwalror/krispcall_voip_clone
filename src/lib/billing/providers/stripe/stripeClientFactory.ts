import Stripe from 'stripe';
import { SupabaseClient } from '@supabase/supabase-js';
import { ProviderCredentialRegistry } from './providerCredentialRegistry';

/**
 * Server-Only Stripe Client Factory.
 * Resolves exact account-specific Stripe client instances by providerAccountId.
 * Caches instances in server-side memory. NEVER falls back to currently active account.
 */
export class StripeClientFactory {
  private static clientCache: Map<string, Stripe> = new Map();

  /**
   * Returns a Stripe client for an EXACT provider_account_id.
   * Fails closed with PROVIDER_CREDENTIALS_UNAVAILABLE if credentials are unconfigured or unmapped.
   */
  static async getClientForAccount(
    supabase: SupabaseClient,
    providerAccountId: string,
    options?: { environment?: 'test' | 'live' }
  ): Promise<Stripe> {
    if (!providerAccountId || !providerAccountId.trim()) {
      throw new Error('PROVIDER_CREDENTIALS_UNAVAILABLE: providerAccountId is required.');
    }

    const cleanId = providerAccountId.trim();
    const env = options?.environment || 'test';
    const cacheKey = `${cleanId}:${env}`;

    if (this.clientCache.has(cacheKey)) {
      return this.clientCache.get(cacheKey)!;
    }

    // Resolve credentials via ProviderCredentialRegistry
    const creds = await ProviderCredentialRegistry.getCredentialsForAccount(
      supabase,
      cleanId,
      env
    );

    const client = new Stripe(creds.secretKey, {
      apiVersion: '2025-02-24.acacia' as any,
      appInfo: {
        name: 'Kripscall Voip SaaS Platform',
        version: '1.0.0',
      },
    });

    this.clientCache.set(cacheKey, client);
    return client;
  }

  /**
   * Clears cached clients (useful for unit tests or config reload).
   */
  static clearCache(): void {
    this.clientCache.clear();
  }
}
