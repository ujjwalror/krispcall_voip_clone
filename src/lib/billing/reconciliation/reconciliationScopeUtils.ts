import { SupabaseClient } from '@supabase/supabase-js';
import {
  ReconciliationRunType,
  TargetEntityType,
} from './reconciliationTypes';

export interface ScopeKeyInput {
  runType: ReconciliationRunType;
  organizationId?: string | null;
  providerAccountId?: string | null;
  targetedEntityType?: TargetEntityType | string | null;
  targetedEntityId?: string | null;
}

/**
 * Deterministic Canonical Scope Key Generator.
 * Guarantees distinct, non-ambiguous lock keys for every run scope.
 */
export function generateCanonicalScopeKey(input: ScopeKeyInput): string {
  const runType = (input.runType || '').trim().toLowerCase();
  const orgId = (input.organizationId || 'none').trim();
  const provAccId = (input.providerAccountId || 'none').trim();
  const entityType = (input.targetedEntityType || 'none').trim();
  const entityId = (input.targetedEntityId || 'none').trim();

  return `${runType}:${orgId}:${provAccId}:${entityType}:${entityId}`.toLowerCase();
}

/**
 * Scope-Based Lease TTL Configuration (in seconds).
 */
export function getScopeLeaseTtlSeconds(runType: ReconciliationRunType): number {
  switch (runType) {
    case 'targeted':
      return 60; // 60s lease TTL
    case 'organization':
      return 120; // 2m lease TTL
    case 'provider_account':
      return 180; // 3m lease TTL
    case 'full_system':
      return 300; // 5m lease TTL
    default:
      return 120;
  }
}

/**
 * Scope-Based Lease Heartbeat Interval (in milliseconds).
 */
export function getScopeHeartbeatIntervalMs(runType: ReconciliationRunType): number {
  switch (runType) {
    case 'targeted':
      return 15000; // 15s heartbeat
    case 'organization':
      return 30000; // 30s heartbeat
    case 'provider_account':
      return 45000; // 45s heartbeat
    case 'full_system':
      return 60000; // 60s heartbeat
    default:
      return 30000;
  }
}

/**
 * Authoritative Financial Organization Discovery.
 * Queries the UNION of ALL financial storage tables to discover all financially active & dormant organizations.
 */
export async function discoverAuthoritativeOrganizations(supabase: SupabaseClient): Promise<string[]> {
  const orgSet = new Set<string>();

  const tables = [
    'billing_wallets',
    'billing_payment_operations',
    'billing_refund_requests',
    'billing_payment_refunds',
    'billing_payment_disputes',
    'billing_financial_holds',
    'billing_account_debts',
    'billing_credit_ledger',
  ];

  for (const t of tables) {
    try {
      const { data, error } = await (supabase as any)
        .from(t)
        .select('organization_id');

      if (!error && data) {
        for (const row of data) {
          if (row.organization_id) {
            orgSet.add(row.organization_id);
          }
        }
      }
    } catch (err: any) {
      console.warn(`[ScopeUtils] Org discovery query error on ${t}:`, err.message);
    }
  }

  return Array.from(orgSet).sort();
}

/**
 * Authoritative Provider Account Discovery.
 * Discovers active provider accounts plus retired accounts with unresolved findings or active payment operations.
 */
export async function discoverAuthoritativeProviderAccounts(supabase: SupabaseClient): Promise<Array<{
  id: string;
  provider: string;
  environment: 'test' | 'live';
  status: 'active' | 'retired';
}>> {
  const accountMap = new Map<string, any>();

  // Fetch active accounts
  const { data: accounts, error } = await (supabase as any)
    .from('billing_provider_accounts')
    .select('id, provider, environment, status');

  if (!error && accounts) {
    for (const acc of accounts) {
      accountMap.set(acc.id, acc);
    }
  }

  return Array.from(accountMap.values());
}
