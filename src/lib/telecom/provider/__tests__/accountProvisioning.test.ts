export {};

// Mock server-only module for tsx test runner environment
const moduleObj = require('module');
try {
  const resolved = require.resolve('server-only');
  moduleObj._cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: {} };
} catch {}

import { describe, it } from 'node:test';
import assert from 'node:assert';

interface InMemoryDbStore {
  operations: any[];
  providerAccounts: any[];
  assignments: any[];
  organizations: any[];
}

function createMockSupabaseClient(store: InMemoryDbStore) {
  return {
    from: (table: string) => {
      let currentTable = table;
      let filters: { col: string; val: any }[] = [];
      let isSingle = false;
      let isMaybeSingle = false;

      const builder = {
        select: (cols: string = '*') => builder,
        eq: (col: string, val: any) => {
          filters.push({ col, val });
          return builder;
        },
        single: async () => {
          isSingle = true;
          return await executeQuery();
        },
        maybeSingle: async () => {
          isMaybeSingle = true;
          return await executeQuery();
        },
        insert: (data: any) => {
          const rows = Array.isArray(data) ? data : [data];
          let insertedList: any[] = [];

          for (const row of rows) {
            const copy = { ...row, id: row.id || `id_${Math.random().toString(36).substring(2, 10)}` };

            if (currentTable === 'telecom_account_provisioning_operations') {
              const conflict = store.operations.find(
                (op) =>
                  op.organization_id === copy.organization_id &&
                  op.provider === copy.provider &&
                  op.idempotency_key === copy.idempotency_key
              );
              if (conflict) {
                const err: any = new Error(
                  'duplicate key value violates unique constraint "uq_telecom_account_prov_org_key"'
                );
                err.code = '23505';
                return {
                  select: () => ({
                    single: async () => ({ data: null, error: err }),
                    maybeSingle: async () => ({ data: null, error: err }),
                  }),
                  single: async () => ({ data: null, error: err }),
                  then: (resolve: any) => resolve({ data: null, error: err }),
                };
              }
              store.operations.push(copy);
              insertedList.push(copy);
            } else if (currentTable === 'telecom_provider_accounts') {
              const conflict = store.providerAccounts.find(
                (a) => a.account_reference === copy.account_reference || a.id === copy.id
              );
              if (conflict) {
                const err: any = new Error(
                  'duplicate key value violates unique constraint "idx_telecom_provider_accounts_ref"'
                );
                err.code = '23505';
                return {
                  select: () => ({
                    single: async () => ({ data: null, error: err }),
                    maybeSingle: async () => ({ data: null, error: err }),
                  }),
                  single: async () => ({ data: null, error: err }),
                  then: (resolve: any) => resolve({ data: null, error: err }),
                };
              }
              store.providerAccounts.push(copy);
              insertedList.push(copy);
            } else if (currentTable === 'telecom_organization_provider_assignments') {
              const conflict = store.assignments.find(
                (a) =>
                  a.organization_id === copy.organization_id &&
                  a.provider_account_id === copy.provider_account_id &&
                  a.service_scope === copy.service_scope
              );
              if (conflict) {
                const err: any = new Error(
                  'duplicate key value violates unique constraint "uq_org_provider_assignment"'
                );
                err.code = '23505';
                return {
                  select: () => ({
                    single: async () => ({ data: null, error: err }),
                    maybeSingle: async () => ({ data: null, error: err }),
                  }),
                  single: async () => ({ data: null, error: err }),
                  then: (resolve: any) => resolve({ data: null, error: err }),
                };
              }
              store.assignments.push(copy);
              insertedList.push(copy);
            } else if (currentTable === 'organizations') {
              store.organizations.push(copy);
              insertedList.push(copy);
            }
          }

          const res = { data: isSingle || !Array.isArray(data) ? insertedList[0] : insertedList, error: null };
          return {
            select: () => ({
              single: async () => ({ data: insertedList[0], error: null }),
              maybeSingle: async () => ({ data: insertedList[0], error: null }),
            }),
            single: async () => res,
            then: (resolve: any) => resolve(res),
          };
        },
        update: (data: any) => {
          return {
            eq: (col: string, val: any) => {
              filters.push({ col, val });
              return {
                then: async (resolve: any) => {
                  let targetList: any[] = [];
                  if (currentTable === 'telecom_account_provisioning_operations') targetList = store.operations;
                  else if (currentTable === 'telecom_provider_accounts') targetList = store.providerAccounts;
                  else if (currentTable === 'telecom_organization_provider_assignments') targetList = store.assignments;

                  for (const item of targetList) {
                    const matches = filters.every((f) => item[f.col] === f.val);
                    if (matches) {
                      Object.assign(item, data);
                    }
                  }
                  resolve({ data: null, error: null });
                },
              };
            },
          };
        },
        then: async (resolve: any) => {
          resolve(await executeQuery());
        },
      };

      async function executeQuery() {
        let items: any[] = [];
        if (currentTable === 'telecom_account_provisioning_operations') items = store.operations;
        else if (currentTable === 'telecom_provider_accounts') items = store.providerAccounts;
        else if (currentTable === 'telecom_organization_provider_assignments') items = store.assignments;
        else if (currentTable === 'organizations') items = store.organizations;

        let filtered = items.filter((item) => filters.every((f) => item[f.col] === f.val));

        if (isSingle) {
          if (filtered.length === 0) {
            return { data: null, error: { message: 'Row not found', code: 'PGRST116' } };
          }
          return { data: filtered[0], error: null };
        }
        if (isMaybeSingle) {
          return { data: filtered.length > 0 ? filtered[0] : null, error: null };
        }
        return { data: filtered, error: null };
      }

      return builder;
    },
  } as any;
}

async function getServices() {
  const {
    LocalMemoryTelecomSecretVault,
    TelecomSecretVaultRegistry,
  } = await import('../../vault/telecomSecretVault');
  const {
    TelecomProviderAccountProvisioningService,
    MockProviderProvisioningAdapter,
  } = await import('../provisioning');
  const { ProviderAccountResolver } = await import('../providerAccountResolver');

  return {
    LocalMemoryTelecomSecretVault,
    TelecomSecretVaultRegistry,
    TelecomProviderAccountProvisioningService,
    MockProviderProvisioningAdapter,
    ProviderAccountResolver,
  };
}

async function createFreshEnv() {
  const {
    LocalMemoryTelecomSecretVault,
    TelecomSecretVaultRegistry,
    MockProviderProvisioningAdapter,
  } = await getServices();

  const store: InMemoryDbStore = {
    operations: [],
    providerAccounts: [],
    assignments: [],
    organizations: [
      { id: 'org_A', name: 'Acme Global Corp' },
      { id: 'org_B', name: 'Beta Logistics' },
    ],
  };
  const supabase = createMockSupabaseClient(store);
  const vault = new LocalMemoryTelecomSecretVault();
  TelecomSecretVaultRegistry.setVault(vault);
  const adapter = new MockProviderProvisioningAdapter('TWILIO');
  return { store, supabase, vault, adapter };
}

describe('Phase 22C-3: Customer Subaccount Provisioning Orchestration', () => {
  it('TEST A: Happy Path provisioning', async () => {
    const { store, supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    const res = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      {
        organizationId: 'org_A',
        provider: 'TWILIO',
        serviceScope: 'ALL',
        idempotencyKey: 'idem_a',
      },
      { supabase, vault, adapter }
    );

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'READY');
    assert.strictEqual(adapter.counters.createAccountCalls, 1);
    const runtimeSecret = await vault.getSecretByPurpose(res.providerAccountId!, 'RUNTIME_API');
    const webhookSecret = await vault.getSecretByPurpose(res.providerAccountId!, 'WEBHOOK_VERIFICATION');
    assert.ok(runtimeSecret);
    assert.ok(webhookSecret);
  });

  it('TEST B: Idempotent Retry', async () => {
    const { supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    const res1 = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      {
        organizationId: 'org_A',
        provider: 'TWILIO',
        serviceScope: 'ALL',
        idempotencyKey: 'idem_b',
      },
      { supabase, vault, adapter }
    );

    const res2 = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      {
        organizationId: 'org_A',
        provider: 'TWILIO',
        serviceScope: 'ALL',
        idempotencyKey: 'idem_b',
      },
      { supabase, vault, adapter }
    );

    assert.strictEqual(res1.providerAccountId, res2.providerAccountId);
    assert.strictEqual(res2.isExistingAccountReused, true);
    assert.strictEqual(adapter.counters.createAccountCalls, 1);
  });

  it('TEST C: Concurrent duplicate requests (20 concurrent)', async () => {
    const { store, supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    const promises = Array.from({ length: 20 }).map(() =>
      TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
        {
          organizationId: 'org_A',
          provider: 'TWILIO',
          serviceScope: 'ALL',
          idempotencyKey: 'idem_c',
        },
        { supabase, vault, adapter }
      )
    );

    const results = await Promise.all(promises);
    assert.ok(results.every((r) => r.success && r.status === 'READY'));
    assert.strictEqual(adapter.counters.createAccountCalls, 1);
    assert.strictEqual(store.operations.length, 1);
    assert.strictEqual(store.providerAccounts.length, 1);
  });

  it('TEST D: Two independent application instances', async () => {
    const { store, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    const client1 = createMockSupabaseClient(store);
    const client2 = createMockSupabaseClient(store);

    const [res1, res2] = await Promise.all([
      TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
        { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_d' },
        { supabase: client1, vault, adapter }
      ),
      TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
        { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_d' },
        { supabase: client2, vault, adapter }
      ),
    ]);

    assert.strictEqual(res1.providerAccountId, res2.providerAccountId);
    assert.strictEqual(adapter.counters.createAccountCalls, 1);
    assert.strictEqual(store.providerAccounts.length, 1);
  });

  it('TEST E: Provider create timeout / unknown result', async () => {
    const { supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    adapter.simulateCreateTimeout = true;

    const res1 = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_e' },
      { supabase, vault, adapter }
    );

    assert.strictEqual(res1.status, 'REQUIRES_RECONCILIATION');
    assert.strictEqual(adapter.counters.createAccountCalls, 1);

    // Reconcile and recover
    adapter.simulateCreateTimeout = false;
    const res2 = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_e' },
      { supabase, vault, adapter }
    );

    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.status, 'READY');
    assert.strictEqual(adapter.counters.createAccountCalls, 1);
  });

  it('TEST F: Provider create definite failure', async () => {
    const { store, supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    adapter.simulateCreateDefiniteFailure = true;

    const res = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_f' },
      { supabase, vault, adapter }
    );

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(store.providerAccounts.length, 0);
  });

  it('TEST G: Runtime credential creation failure', async () => {
    const { store, supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    adapter.simulateRuntimeCredentialFailure = true;

    const res = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_g' },
      { supabase, vault, adapter }
    );

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.status, 'PROVIDER_ACCOUNT_CREATED');
    assert.strictEqual(store.providerAccounts.filter((a) => a.status === 'active').length, 0);
    assert.ok(adapter.createdAccounts.size > 0);
  });

  it('TEST H: Vault store failure', async () => {
    const { store, supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    vault.storeSecret = async () => {
      throw new Error('ENCLAVE_OFFLINE');
    };

    const res = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_h' },
      { supabase, vault, adapter }
    );

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.errorCode, 'VAULT_STORAGE_FAILED');
    const op = store.operations.find((o) => o.idempotency_key === 'idem_h');
    assert.strictEqual(JSON.stringify(op).includes('mock_sk_secret_'), false);
  });

  it('TEST I: Webhook credential failure', async () => {
    const { store, supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    adapter.simulateWebhookCredentialFailure = true;

    const res = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_i' },
      { supabase, vault, adapter }
    );

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.status, 'RUNTIME_CREDENTIAL_CREATED');
    assert.strictEqual(store.assignments.filter((a) => a.is_active).length, 0);
  });

  it('TEST J: Local DB record failure and recovery', async () => {
    const { supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    const origFrom = supabase.from;
    supabase.from = (tbl: string) => {
      if (tbl === 'telecom_provider_accounts') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          insert: async () => ({ data: null, error: new Error('DB_DOWN') }),
        } as any;
      }
      return origFrom(tbl);
    };

    const res1 = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_j' },
      { supabase, vault, adapter }
    );
    assert.strictEqual(res1.success, false);

    supabase.from = origFrom;
    const res2 = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_j' },
      { supabase, vault, adapter }
    );
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.status, 'READY');
    assert.strictEqual(adapter.counters.createAccountCalls, 1);
  });

  it('TEST K: Assignment failure and recovery', async () => {
    const { supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    let fail = true;
    const origFrom = supabase.from;
    supabase.from = (tbl: string) => {
      if (tbl === 'telecom_organization_provider_assignments' && fail) {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
          insert: () => ({ select: () => ({ single: async () => ({ data: null, error: new Error('ASSIGN_ERR') }) }) }),
        } as any;
      }
      return origFrom(tbl);
    };

    const res1 = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_k' },
      { supabase, vault, adapter }
    );
    assert.strictEqual(res1.success, false);

    fail = false;
    const res2 = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_k' },
      { supabase, vault, adapter }
    );
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.status, 'READY');
    assert.strictEqual(adapter.counters.createAccountCalls, 1);
  });

  it('TEST L: Existing active account safety', async () => {
    const { supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    const res1 = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_l_1' },
      { supabase, vault, adapter }
    );

    const res2 = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_l_2' },
      { supabase, vault, adapter }
    );

    assert.strictEqual(res2.isExistingAccountReused, true);
    assert.strictEqual(res2.providerAccountId, res1.providerAccountId);
    assert.strictEqual(adapter.counters.createAccountCalls, 1);
  });

  it('TEST M: Cross-tenant attachment rejection', async () => {
    const { supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    const res = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      {
        organizationId: 'org_A',
        provider: 'TWILIO',
        serviceScope: 'ALL',
        idempotencyKey: 'idem_m',
        foreignProviderAccountIdOverride: 'evil_override',
      },
      { supabase, vault, adapter }
    );

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.errorCode, 'CROSS_TENANT_ATTACHMENT_PROHIBITED');
  });

  it('TEST N: Wrong credential ownership fails activation gate', async () => {
    const { store, supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    const origStoreSecret = vault.storeSecret.bind(vault);
    vault.storeSecret = async (p) => origStoreSecret({ ...p, providerAccountId: 'wrong_id' });

    const res = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_n' },
      { supabase, vault, adapter }
    );

    assert.strictEqual(res.success, false);
    assert.notStrictEqual(res.status, 'READY');
    assert.strictEqual(store.providerAccounts.filter((a) => a.status === 'active').length, 0);
  });

  it('TEST O: Wrong credential purpose fails activation gate', async () => {
    const { store, supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    const origStoreSecret = vault.storeSecret.bind(vault);
    vault.storeSecret = async (p) =>
      origStoreSecret({
        ...p,
        purpose: p.purpose === 'RUNTIME_API' ? ('WEBHOOK_VERIFICATION' as const) : ('RUNTIME_API' as const),
      });

    const res = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_o' },
      { supabase, vault, adapter }
    );

    assert.strictEqual(res.success, false);
    assert.notStrictEqual(res.status, 'READY');
    assert.strictEqual(store.providerAccounts.filter((a) => a.status === 'active').length, 0);
  });

  it('TEST P: Ready activation gate prevents incomplete selection', async () => {
    const { store, supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService, ProviderAccountResolver } = await getServices();
    const res = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_p' },
      { supabase, vault, adapter }
    );

    const activeResolve = await ProviderAccountResolver.resolveProviderAccount(
      { organizationId: 'org_A', service: 'VOICE', strictMode: true },
      supabase
    );
    assert.strictEqual(activeResolve.success, true);

    const assign = store.assignments.find((a) => a.provider_account_id === res.providerAccountId);
    if (assign) assign.is_active = false;

    const inactiveResolve = await ProviderAccountResolver.resolveProviderAccount(
      { organizationId: 'org_A', service: 'VOICE', strictMode: true },
      supabase
    );
    assert.strictEqual(inactiveResolve.success, false);
  });

  it('TEST Q: Multi-stage retry after crash', async () => {
    const { supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    adapter.simulateRuntimeCredentialFailure = true;
    const res1 = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_q' },
      { supabase, vault, adapter }
    );
    assert.strictEqual(res1.status, 'PROVIDER_ACCOUNT_CREATED');

    adapter.simulateRuntimeCredentialFailure = false;
    adapter.simulateWebhookCredentialFailure = true;
    const res2 = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_q' },
      { supabase, vault, adapter }
    );
    assert.strictEqual(res2.status, 'RUNTIME_CREDENTIAL_CREATED');

    adapter.simulateWebhookCredentialFailure = false;
    const res3 = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_q' },
      { supabase, vault, adapter }
    );
    assert.strictEqual(res3.status, 'READY');
    assert.strictEqual(adapter.counters.createAccountCalls, 1);
  });

  it('TEST R: Secret redaction in errors and storage', async () => {
    const { store, supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    const rawSecret = 'mock_sk_secret_99999999_critical';
    adapter.createRuntimeCredential = async () => {
      const err = new Error(`Secret ${rawSecret} failed`);
      (err as any).code = 'ERR';
      throw err;
    };

    const res = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_r' },
      { supabase, vault, adapter }
    );

    const op = store.operations.find((o) => o.idempotency_key === 'idem_r');
    assert.strictEqual(JSON.stringify(op).includes(rawSecret), false);
    assert.strictEqual(JSON.stringify(res).includes(rawSecret), false);
  });

  it('TEST S: Different organizations concurrent provisioning', async () => {
    const { supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    const [resA, resB] = await Promise.all([
      TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
        { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_s_a' },
        { supabase, vault, adapter }
      ),
      TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
        { organizationId: 'org_B', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_s_b' },
        { supabase, vault, adapter }
      ),
    ]);

    assert.strictEqual(resA.success, true);
    assert.strictEqual(resB.success, true);
    assert.notStrictEqual(resA.providerAccountId, resB.providerAccountId);
    assert.strictEqual(adapter.counters.createAccountCalls, 2);
  });

  it('TEST T: Different idempotency key same organization', async () => {
    const { supabase, vault, adapter } = await createFreshEnv();
    const { TelecomProviderAccountProvisioningService } = await getServices();
    const res1 = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_t_1' },
      { supabase, vault, adapter }
    );

    const res2 = await TelecomProviderAccountProvisioningService.provisionOrganizationProviderAccount(
      { organizationId: 'org_A', provider: 'TWILIO', serviceScope: 'ALL', idempotencyKey: 'idem_t_2' },
      { supabase, vault, adapter }
    );

    assert.strictEqual(res2.isExistingAccountReused, true);
    assert.strictEqual(res1.providerAccountId, res2.providerAccountId);
    assert.strictEqual(adapter.counters.createAccountCalls, 1);
  });
});
