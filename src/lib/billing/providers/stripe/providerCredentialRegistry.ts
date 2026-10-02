import { SupabaseClient } from '@supabase/supabase-js';
import { isExpectedLegacySchemaMissingError } from '../../schemaUtils';

export interface ProviderAccountCredentials {
  providerAccountId: string;
  provider: string;
  providerAccountReference: string;
  environment: 'test' | 'live';
  status: 'active' | 'retired';
  secretKey: string;
  webhookSecret?: string;
}

/**
 * Controlled Server-Side Registry for Payment Provider Credentials.
 * Maps authoritative internal provider_account_id / provider_account_reference
 * to server environment variables WITHOUT allowing arbitrary environment-variable injection.
 *
 * SERVER-ONLY. Secrets are never stored in Postgres, logged, or exposed to browsers.
 */
export class ProviderCredentialRegistry {
  /**
   * Controlled whitelist mapping of known internal provider_account_references
   * to environment variable key names.
   */
  private static readonly CONTROLLED_CREDENTIAL_MAP: Record<
    string,
    { secretKeyEnv: string; webhookSecretEnv?: string }
  > = {
    // Default primary test sentinel & reference
    stripe_primary_test: {
      secretKeyEnv: 'STRIPE_SECRET_KEY',
      webhookSecretEnv: 'STRIPE_WEBHOOK_SECRET',
    },
    // Default primary live reference
    stripe_primary_live: {
      secretKeyEnv: 'STRIPE_SECRET_KEY_LIVE',
      webhookSecretEnv: 'STRIPE_WEBHOOK_SECRET_LIVE',
    },
    // Explicit secondary / historical references for multi-account testing & future rotation
    stripe_secondary_test: {
      secretKeyEnv: 'STRIPE_SECRET_KEY_SECONDARY_TEST',
      webhookSecretEnv: 'STRIPE_WEBHOOK_SECRET_SECONDARY_TEST',
    },
    stripe_legacy_test: {
      secretKeyEnv: 'STRIPE_SECRET_KEY_LEGACY_TEST',
      webhookSecretEnv: 'STRIPE_WEBHOOK_SECRET_LEGACY_TEST',
    },
  };

  /**
   * Authoritative Server-Side Stripe Runtime Environment Resolver.
   * Derives 'test' | 'live' from private server configuration.
   * Fails closed if missing in production or invalid.
   */
  static resolveServerRuntimeEnvironment(explicitMode?: 'test' | 'live'): 'test' | 'live' {
    if (explicitMode) {
      if (explicitMode !== 'test' && explicitMode !== 'live') {
        throw new Error(`STRIPE_ENVIRONMENT_INVALID: Explicit mode '${explicitMode}' must be 'test' or 'live'.`);
      }
      return explicitMode;
    }

    const rawServerEnv = process.env.STRIPE_EXPECTED_MODE || process.env.STRIPE_RUNTIME_ENVIRONMENT;
    const rawClientEnv = process.env.NEXT_PUBLIC_STRIPE_ENVIRONMENT;

    let mode: string = (rawServerEnv || '').trim().toLowerCase();

    if (!mode) {
      if (rawClientEnv) {
        mode = rawClientEnv.trim().toLowerCase();
      } else {
        mode = 'test'; // Default safe mode when unconfigured
      }
    }

    if (rawServerEnv && rawClientEnv && rawServerEnv.trim().toLowerCase() !== rawClientEnv.trim().toLowerCase()) {
      throw new Error(`STRIPE_ENVIRONMENT_MISMATCH: Server setting '${rawServerEnv}' conflicts with NEXT_PUBLIC_STRIPE_ENVIRONMENT '${rawClientEnv}'.`);
    }

    if (mode !== 'test' && mode !== 'live') {
      throw new Error(`STRIPE_ENVIRONMENT_INVALID: Configured Stripe environment '${mode}' must be strictly 'test' or 'live'.`);
    }

    return mode as 'test' | 'live';
  }

  /**
   * Resolves credentials for an explicit provider_account_id.
   * Retired accounts remain resolvable for historical operations as long as credentials exist.
   */
  static async getCredentialsForAccount(
    supabase: SupabaseClient,
    providerAccountId: string,
    runtimeEnv?: 'test' | 'live'
  ): Promise<ProviderAccountCredentials> {
    if (!providerAccountId || !providerAccountId.trim()) {
      throw new Error('PROVIDER_CREDENTIALS_UNAVAILABLE: providerAccountId is required.');
    }

    const env = runtimeEnv ? this.resolveServerRuntimeEnvironment(runtimeEnv) : this.resolveServerRuntimeEnvironment();
    const cleanId = providerAccountId.trim();

    // 1. Fetch provider account record from public.billing_provider_accounts
    let accountRecord: any = null;
    try {
      const { data, error } = await (supabase as any)
        .from('billing_provider_accounts')
        .select('id, provider, provider_account_reference, environment, status')
        .eq('id', cleanId)
        .maybeSingle();

      if (error && !isExpectedLegacySchemaMissingError(error)) {
        throw error;
      }
      accountRecord = data;
    } catch (err: any) {
      if (!isExpectedLegacySchemaMissingError(err)) {
        throw new Error(`PROVIDER_CREDENTIALS_UNAVAILABLE: DB error reading provider account ${cleanId}: ${err.message}`);
      }
    }

    // 2. Pre-migration sentinel fallback (ONLY for sentinel ID in test mode)
    if (!accountRecord) {
      if (cleanId === '00000000-0000-0000-0000-0000000000aa' && env === 'test') {
        accountRecord = {
          id: '00000000-0000-0000-0000-0000000000aa',
          provider: 'stripe',
          provider_account_reference: 'stripe_primary_test',
          environment: 'test',
          status: 'active',
        };
      } else {
        throw new Error(`PROVIDER_CREDENTIALS_UNAVAILABLE: Unknown provider account ID ${cleanId}.`);
      }
    }

    // 3. Strict Provider & Environment Validation
    if (accountRecord.provider !== 'stripe') {
      throw new Error(`PROVIDER_CREDENTIALS_UNAVAILABLE: Unsupported provider ${accountRecord.provider} for account ${cleanId}.`);
    }

    if (accountRecord.environment !== env) {
      throw new Error(`PROVIDER_CREDENTIALS_UNAVAILABLE: Account ${cleanId} environment (${accountRecord.environment}) does not match runtime environment (${env}).`);
    }

    // 4. Resolve credentials via Controlled Whitelist Map
    const ref = accountRecord.provider_account_reference;
    const mapping = this.CONTROLLED_CREDENTIAL_MAP[ref];

    if (!mapping) {
      throw new Error(`PROVIDER_CREDENTIALS_UNAVAILABLE: No controlled secret mapping configured for account reference "${ref}".`);
    }

    const secretKey = process.env[mapping.secretKeyEnv];
    if (!secretKey || secretKey.trim().length === 0) {
      throw new Error(`PROVIDER_CREDENTIALS_UNAVAILABLE: Secret key env "${mapping.secretKeyEnv}" is not configured for account ${cleanId} (${ref}).`);
    }

    const webhookSecret = mapping.webhookSecretEnv ? process.env[mapping.webhookSecretEnv] : undefined;

    return {
      providerAccountId: accountRecord.id,
      provider: accountRecord.provider,
      providerAccountReference: accountRecord.provider_account_reference,
      environment: accountRecord.environment,
      status: accountRecord.status,
      secretKey: secretKey.trim(),
      webhookSecret: webhookSecret?.trim(),
    };
  }

  /**
   * Returns all configured webhook secrets for bounded multi-account signature matching.
   * Prevents unbounded database table scans on every webhook delivery.
   */
  static getAllConfiguredWebhookSecrets(runtimeEnv?: 'test' | 'live'): Array<{
    providerAccountReference: string;
    webhookSecret: string;
  }> {
    const env = runtimeEnv ? this.resolveServerRuntimeEnvironment(runtimeEnv) : this.resolveServerRuntimeEnvironment();
    const results: Array<{ providerAccountReference: string; webhookSecret: string }> = [];

    for (const [ref, mapping] of Object.entries(this.CONTROLLED_CREDENTIAL_MAP)) {
      if (ref.includes(env)) {
        if (mapping.webhookSecretEnv) {
          const val = process.env[mapping.webhookSecretEnv];
          if (val && val.trim().length > 0) {
            results.push({
              providerAccountReference: ref,
              webhookSecret: val.trim(),
            });
          }
        }
      }
    }

    // Default fallback if explicit env matching produces empty list in test mode
    if (results.length === 0 && env === 'test' && process.env.STRIPE_WEBHOOK_SECRET) {
      results.push({
        providerAccountReference: 'stripe_primary_test',
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET.trim(),
      });
    }

    return results;
  }
}
