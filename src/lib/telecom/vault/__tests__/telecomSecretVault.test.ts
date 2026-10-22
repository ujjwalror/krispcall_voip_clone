// Mock server-only before any other imports
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'server-only') return {};
  return originalRequire.apply(this, arguments);
};

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  LocalMemoryTelecomSecretVault,
  TelecomSecretVaultRegistry,
  ProductionTelecomSecretVaultStub,
} from '../telecomSecretVault';
import { ProviderClientFactory } from '../../provider/providerClientFactory';
import { ProviderAccountResolver } from '../../provider/providerAccountResolver';
import { ProviderContext } from '../../provider/types';

describe('Phase 22C-1B: Type 1 Credential Foundation & Secret Vault Test Suite', () => {
  let vault: LocalMemoryTelecomSecretVault;
  let capturedClients: any[] = [];

  // Mock database stores
  let organizationsStore: any[] = [];
  let providerAccountsStore: any[] = [];
  let assignmentsStore: any[] = [];

  const mockSupabase = {
    from: (table: string) => {
      let store: any[] = [];
      if (table === 'organizations') store = organizationsStore;
      else if (table === 'telecom_provider_accounts') store = providerAccountsStore;
      else if (table === 'telecom_organization_provider_assignments') store = assignmentsStore;

      let filters: Array<(row: any) => boolean> = [];

      const builder: any = {
        select: (_cols?: string) => builder,
        eq: (col: string, val: any) => {
          filters.push((row: any) => row[col] === val);
          return builder;
        },
        maybeSingle: async () => {
          const match = store.find((row) => filters.every((f) => f(row)));
          return { data: match ? { ...match } : null, error: null };
        },
        single: async () => {
          const match = store.find((row) => filters.every((f) => f(row)));
          if (!match) return { data: null, error: { message: 'Row not found' } };
          return { data: { ...match }, error: null };
        },
        then: (resolve: any) => {
          const filtered = store.filter((row: any) => filters.every((f) => f(row)));
          resolve({ data: filtered.map((r: any) => ({ ...r })), error: null });
        },
      };

      return builder;
    },
  };

  beforeEach(() => {
    vault = new LocalMemoryTelecomSecretVault();
    TelecomSecretVaultRegistry.setVault(vault);

    capturedClients = [];
    ProviderClientFactory.twilioClientConstructor = (apiKeySidOrAccountSid: string, secret: string, opts?: any) => {
      const client = {
        apiKeySid: apiKeySidOrAccountSid,
        secret,
        accountSid: opts?.accountSid || apiKeySidOrAccountSid,
        opts,
      };
      capturedClients.push(client);
      return client;
    };

    // Reset stores
    organizationsStore = [
      { id: 'org-A', name: 'Tenant A Enterprise' },
      { id: 'org-B', name: 'Tenant B Logistics' },
    ];

    providerAccountsStore = [
      {
        id: 'acc-sub-a',
        provider: 'TWILIO',
        account_type: 'CUSTOMER_SUBACCOUNT',
        account_reference: 'AC_SUBACCOUNT_A_1111111111111111',
        credential_reference: 'vault:twilio:subaccount:org_a',
        status: 'active',
        capabilities: ['ALL'],
        environment: 'production',
        metadata: { subaccount_name: 'Tenant A Subaccount' },
      },
      {
        id: 'acc-sub-b',
        provider: 'TWILIO',
        account_type: 'CUSTOMER_SUBACCOUNT',
        account_reference: 'AC_SUBACCOUNT_B_2222222222222222',
        credential_reference: 'vault:twilio:subaccount:org_b',
        status: 'active',
        capabilities: ['ALL'],
        environment: 'production',
        metadata: { subaccount_name: 'Tenant B Subaccount' },
      },
    ];

    assignmentsStore = [
      {
        id: 'assign-a',
        organization_id: 'org-A',
        provider_account_id: 'acc-sub-a',
        service_scope: 'ALL',
        country_code: null,
        priority: 100,
        is_active: true,
      },
      {
        id: 'assign-b',
        organization_id: 'org-B',
        provider_account_id: 'acc-sub-b',
        service_scope: 'ALL',
        country_code: null,
        priority: 100,
        is_active: true,
      },
    ];

    // Seed test vault secrets
    vault.storeSecret({
      referenceId: 'vault:twilio:subaccount:org_a',
      secret: 'SECRET_KEY_A_AAA_99999',
      provider: 'TWILIO',
      providerAccountId: 'acc-sub-a',
      keyIdentifier: 'SK_KEY_A_11111111111111111111',
      accountReference: 'AC_SUBACCOUNT_A_1111111111111111',
    });

    vault.storeSecret({
      referenceId: 'vault:twilio:subaccount:org_b',
      secret: 'SECRET_KEY_B_BBB_88888',
      provider: 'TWILIO',
      providerAccountId: 'acc-sub-b',
      keyIdentifier: 'SK_KEY_B_22222222222222222222',
      accountReference: 'AC_SUBACCOUNT_B_2222222222222222',
    });
  });

  // TEST A — ORG A CLIENT RESOLUTION
  it('TEST A — ORG A CLIENT RESOLUTION: Resolves dedicated Subaccount A client', async () => {
    const res = await ProviderAccountResolver.resolveAccount({ organizationId: 'org-A', service: 'VOICE' }, mockSupabase as any);
    assert.equal(res.success, true);
    assert.equal(res.context?.accountReference, 'AC_SUBACCOUNT_A_1111111111111111');

    const client = ProviderClientFactory.getProviderClient(res.context!);
    assert.equal(client.accountSid, 'AC_SUBACCOUNT_A_1111111111111111');
    assert.equal(client.apiKeySid, 'SK_KEY_A_11111111111111111111');
    assert.equal(client.secret, 'SECRET_KEY_A_AAA_99999');
  });

  // TEST B — ORG B CLIENT RESOLUTION
  it('TEST B — ORG B CLIENT RESOLUTION: Resolves dedicated Subaccount B client', async () => {
    const res = await ProviderAccountResolver.resolveAccount({ organizationId: 'org-B', service: 'VOICE' }, mockSupabase as any);
    assert.equal(res.success, true);
    assert.equal(res.context?.accountReference, 'AC_SUBACCOUNT_B_2222222222222222');

    const client = ProviderClientFactory.getProviderClient(res.context!);
    assert.equal(client.accountSid, 'AC_SUBACCOUNT_B_2222222222222222');
    assert.equal(client.apiKeySid, 'SK_KEY_B_22222222222222222222');
    assert.equal(client.secret, 'SECRET_KEY_B_BBB_88888');
  });

  // TEST C — CROSS-TENANT FORGED ACCOUNT SID
  it('TEST C — CROSS-TENANT FORGED ACCOUNT SID: Rejected fail closed', async () => {
    // 1. Client payload override attempt
    const resOverride = await ProviderAccountResolver.resolveAccount(
      {
        organizationId: 'org-A',
        service: 'VOICE',
        clientPayloadProviderOverride: 'AC_SUBACCOUNT_B_2222222222222222',
      },
      mockSupabase as any
    );
    assert.equal(resOverride.success, false);
    assert.equal(resOverride.errorCode, 'CLIENT_OVERRIDE_PROHIBITED');

    // 2. Forged context attempt
    const forgedContext: ProviderContext = {
      providerAccountId: 'acc-sub-a',
      provider: 'TWILIO',
      accountType: 'CUSTOMER_SUBACCOUNT',
      accountReference: 'AC_SUBACCOUNT_B_2222222222222222', // Forged Org B SID
      credentialReference: 'vault:twilio:subaccount:org_a', // Org A credential
      organizationId: 'org-A',
      serviceScope: 'VOICE',
      environment: 'production',
      capabilities: ['VOICE'],
      isSharedParent: false,
    };

    // Must resolve the authoritative accountReference from vault metadata, never Org B
    const client = ProviderClientFactory.getProviderClient(forgedContext);
    assert.equal(client.accountSid, 'AC_SUBACCOUNT_A_1111111111111111', 'Must strictly bind to Org A subaccount from vault metadata');
  });

  // TEST D — CROSS-TENANT FORGED PROVIDER ACCOUNT ID
  it('TEST D — CROSS-TENANT FORGED PROVIDER ACCOUNT ID: Rejected fail closed', async () => {
    // Org A attempts to use Org B's providerAccountId with Org A's credential
    const forgedContext: ProviderContext = {
      providerAccountId: 'acc-sub-b', // Org B's account ID
      provider: 'TWILIO',
      accountType: 'CUSTOMER_SUBACCOUNT',
      accountReference: 'AC_SUBACCOUNT_A_1111111111111111',
      credentialReference: 'vault:twilio:subaccount:org_a', // Org A's credential
      organizationId: 'org-A',
      serviceScope: 'VOICE',
      environment: 'production',
      capabilities: ['VOICE'],
      isSharedParent: false,
    };

    assert.throws(
      () => ProviderClientFactory.getProviderClient(forgedContext),
      /CREDENTIAL_ACCOUNT_MISMATCH/,
      'Must reject mismatched providerAccountId'
    );
  });

  // TEST E — MISSING CREDENTIAL REFERENCE
  it('TEST E — MISSING CREDENTIAL REFERENCE: Fails closed with no parent fallback', () => {
    const invalidContext: ProviderContext = {
      providerAccountId: 'acc-sub-missing-ref',
      provider: 'TWILIO',
      accountType: 'CUSTOMER_SUBACCOUNT',
      accountReference: 'AC_SUB_MISSING_123',
      credentialReference: '', // Missing reference
      organizationId: 'org-A',
      serviceScope: 'VOICE',
      environment: 'production',
      capabilities: ['VOICE'],
      isSharedParent: false,
    };

    assert.throws(
      () => ProviderClientFactory.getProviderClient(invalidContext),
      /MISSING_CREDENTIAL_REFERENCE/,
      'Missing credential reference must fail closed'
    );
  });

  // TEST F — MISSING VAULT SECRET
  it('TEST F — MISSING VAULT SECRET: Fails closed when secret not in vault', () => {
    const invalidContext: ProviderContext = {
      providerAccountId: 'acc-sub-no-secret',
      provider: 'TWILIO',
      accountType: 'CUSTOMER_SUBACCOUNT',
      accountReference: 'AC_SUB_NO_SECRET_123',
      credentialReference: 'vault:twilio:subaccount:not_found',
      organizationId: 'org-A',
      serviceScope: 'VOICE',
      environment: 'production',
      capabilities: ['VOICE'],
      isSharedParent: false,
    };

    assert.throws(
      () => ProviderClientFactory.getProviderClient(invalidContext),
      /SECRET_NOT_FOUND/,
      'Missing vault secret must fail closed'
    );
  });

  // TEST G — REVOKED CREDENTIAL
  it('TEST G — REVOKED CREDENTIAL: Fails closed when secret status is revoked', async () => {
    await vault.storeSecret({
      referenceId: 'vault:twilio:subaccount:revoked',
      secret: 'SECRET_REVOKED_123',
      provider: 'TWILIO',
      providerAccountId: 'acc-sub-revoked',
      keyIdentifier: 'SK_REVOKED_1234567890',
      accountReference: 'AC_SUB_REVOKED_12345678',
    });

    // Mark revoked in vault
    vault.revokeSecret('vault:twilio:subaccount:revoked');

    const context: ProviderContext = {
      providerAccountId: 'acc-sub-revoked',
      provider: 'TWILIO',
      accountType: 'CUSTOMER_SUBACCOUNT',
      accountReference: 'AC_SUB_REVOKED_12345678',
      credentialReference: 'vault:twilio:subaccount:revoked',
      organizationId: 'org-A',
      serviceScope: 'VOICE',
      environment: 'production',
      capabilities: ['VOICE'],
      isSharedParent: false,
    };

    assert.throws(
      () => ProviderClientFactory.getProviderClient(context),
      /CREDENTIAL_REVOKED/,
      'Revoked credential must fail closed'
    );
  });

  // TEST H — WRONG ACCOUNT CREDENTIAL
  it('TEST H — WRONG ACCOUNT CREDENTIAL: Fails closed when secret belongs to another provider account', async () => {
    // Org A context attempts to use Org B's credential reference
    const context: ProviderContext = {
      providerAccountId: 'acc-sub-a',
      provider: 'TWILIO',
      accountType: 'CUSTOMER_SUBACCOUNT',
      accountReference: 'AC_SUBACCOUNT_A_1111111111111111',
      credentialReference: 'vault:twilio:subaccount:org_b', // Org B's reference
      organizationId: 'org-A',
      serviceScope: 'VOICE',
      environment: 'production',
      capabilities: ['VOICE'],
      isSharedParent: false,
    };

    assert.throws(
      () => ProviderClientFactory.getProviderClient(context),
      /CREDENTIAL_ACCOUNT_MISMATCH/,
      'Must reject credential belonging to another provider account'
    );
  });

  // TEST I — PARENT FALLBACK PROHIBITION
  it('TEST I — PARENT FALLBACK PROHIBITION: Subaccount failure MUST NOT fall back to parent credentials', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC_PARENT_ACCOUNT_SID_99999';
    process.env.TWILIO_AUTH_TOKEN = 'PARENT_AUTH_TOKEN_SECRET_999';

    const context: ProviderContext = {
      providerAccountId: 'acc-sub-unfunded',
      provider: 'TWILIO',
      accountType: 'CUSTOMER_SUBACCOUNT',
      accountReference: 'AC_SUB_UNFUNDED_123',
      credentialReference: 'vault:twilio:subaccount:missing',
      organizationId: 'org-A',
      serviceScope: 'VOICE',
      environment: 'production',
      capabilities: ['VOICE'],
      isSharedParent: false,
    };

    assert.throws(
      () => ProviderClientFactory.getProviderClient(context),
      /SECRET_NOT_FOUND/,
      'Must fail closed with SECRET_NOT_FOUND'
    );

    // Assert parent credentials were NOT instantiated
    const parentUsed = capturedClients.some((c) => c.accountSid === 'AC_PARENT_ACCOUNT_SID_99999');
    assert.equal(parentUsed, false, 'Parent credentials must NEVER be used as tenant fallback');
  });

  // TEST J — ROTATION
  it('TEST J — ROTATION: Rotates secret to v2 and updates runtime client', async () => {
    const meta = await vault.rotateSecret({
      referenceId: 'vault:twilio:subaccount:org_a',
      newSecret: 'SECRET_KEY_A_V2_ROTATED_77777',
      newKeyIdentifier: 'SK_KEY_A_V2_ROTATED_KEY_777',
    });

    assert.equal(meta.version, 2, 'Version must be incremented to 2');
    assert.equal(meta.status, 'active', 'Status must be active');
    assert.equal(meta.keyIdentifier, 'SK_KEY_A_V2_ROTATED_KEY_777');

    const res = await ProviderAccountResolver.resolveAccount({ organizationId: 'org-A', service: 'VOICE' }, mockSupabase as any);
    const client = ProviderClientFactory.getProviderClient(res.context!);

    assert.equal(client.apiKeySid, 'SK_KEY_A_V2_ROTATED_KEY_777');
    assert.equal(client.secret, 'SECRET_KEY_A_V2_ROTATED_77777');
  });

  // TEST K — SECRET REDACTION
  it('TEST K — SECRET REDACTION: Thrown errors and metadata never contain plaintext secrets', async () => {
    const testSecret = 'CONFIDENTIAL_PLAINTEXT_SECRET_DO_NOT_LEAK_333';
    await vault.storeSecret({
      referenceId: 'vault:test:redaction',
      secret: testSecret,
      provider: 'TWILIO',
      providerAccountId: 'acc-redact',
      keyIdentifier: 'SK_REDACT_1',
      accountReference: 'AC_REDACT_1',
    });

    // 1. Check getMetadata
    const metadata = await vault.getMetadata('vault:test:redaction');
    assert.equal('secret' in (metadata as any), false, 'Metadata must not contain secret property');
    assert.equal(JSON.stringify(metadata).includes(testSecret), false, 'Serialized metadata must not contain secret');

    // 2. Check errors
    try {
      await vault.storeSecret({
        referenceId: '',
        secret: testSecret,
        provider: 'TWILIO',
        providerAccountId: 'acc-1',
      });
      assert.fail('Should have thrown');
    } catch (err: any) {
      assert.equal(err.message.includes(testSecret), false, 'Error message must not contain secret string');
    }
  });

  // TEST L — PROVIDER-NEUTRAL CONTRACT
  it('TEST L — PROVIDER-NEUTRAL CONTRACT: Supports non-Twilio provider credentials seamlessly', async () => {
    const telnyxSecret = 'KEY0184b901a_telnyx_live_api_key_secret';
    const stored = await vault.storeSecret({
      referenceId: 'vault:telnyx:tenant_x',
      secret: telnyxSecret,
      provider: 'TELNYX',
      providerAccountId: 'acc-telnyx-x',
      keyIdentifier: 'telnyx_key_id_1',
      metadata: { billing_group: 'bg_123' },
    });

    assert.equal(stored.provider, 'TELNYX');
    assert.equal(stored.providerAccountId, 'acc-telnyx-x');

    const retrieved = await vault.getSecret('vault:telnyx:tenant_x');
    assert.equal(retrieved?.secret, telnyxSecret);
    assert.equal(retrieved?.metadata.provider, 'TELNYX');

    const rotated = await vault.rotateSecret({
      referenceId: 'vault:telnyx:tenant_x',
      newSecret: 'KEY0184b901a_telnyx_v2_rotated_secret',
    });
    assert.equal(rotated.version, 2);

    const deleted = await vault.deleteSecret('vault:telnyx:tenant_x');
    assert.equal(deleted, true);
    assert.equal(await vault.getSecret('vault:telnyx:tenant_x'), null);
  });

  // TEST M — AMBIGUOUS ASSIGNMENT
  it('TEST M — AMBIGUOUS ASSIGNMENT: Multiple equal priority assignments fail closed', async () => {
    // Add conflicting assignment for Org A with identical priority 100
    assignmentsStore.push({
      id: 'assign-a-conflict',
      organization_id: 'org-A',
      provider_account_id: 'acc-sub-b', // Different account!
      service_scope: 'ALL',
      country_code: null,
      priority: 100, // Identical priority!
      is_active: true,
    });

    const res = await ProviderAccountResolver.resolveAccount({ organizationId: 'org-A', service: 'VOICE' }, mockSupabase as any);
    assert.equal(res.success, false);
    assert.equal(res.errorCode, 'AMBIGUOUS_PROVIDER_ASSIGNMENT');
  });

  // TEST N — INACTIVE/SUSPENDED PROVIDER ACCOUNT
  it('TEST N — INACTIVE/SUSPENDED PROVIDER ACCOUNT: Fails closed before secret retrieval', async () => {
    // Suspend provider account A
    providerAccountsStore.find((a) => a.id === 'acc-sub-a').status = 'suspended';

    const res = await ProviderAccountResolver.resolveAccount({ organizationId: 'org-A', service: 'VOICE' }, mockSupabase as any);
    assert.equal(res.success, false);
    assert.equal(res.errorCode, 'UNKNOWN_OR_INACTIVE_PROVIDER');
  });

  // TEST O — CONCURRENT RESOLUTION
  it('TEST O — CONCURRENT RESOLUTION: 50 concurrent mixed resolutions maintain strict tenant isolation', async () => {
    const orgs = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 'org-A' : 'org-B'));

    const results = await Promise.all(
      orgs.map(async (orgId) => {
        const res = await ProviderAccountResolver.resolveAccount({ organizationId: orgId, service: 'VOICE' }, mockSupabase as any);
        const client = ProviderClientFactory.getProviderClient(res.context!);
        return { orgId, client };
      })
    );

    assert.equal(results.length, 50);
    for (const r of results) {
      if (r.orgId === 'org-A') {
        assert.equal(r.client.accountSid, 'AC_SUBACCOUNT_A_1111111111111111');
        assert.equal(r.client.apiKeySid, 'SK_KEY_A_11111111111111111111');
        assert.equal(r.client.secret, 'SECRET_KEY_A_AAA_99999');
      } else {
        assert.equal(r.client.accountSid, 'AC_SUBACCOUNT_B_2222222222222222');
        assert.equal(r.client.apiKeySid, 'SK_KEY_B_22222222222222222222');
        assert.equal(r.client.secret, 'SECRET_KEY_B_BBB_88888');
      }
    }
  });

  // EXTRA TEST — PRODUCTION STUB ENFORCEMENT
  it('EXTRA — Production stub enforces fail-closed behavior if unconfigured', async () => {
    const stub = new ProductionTelecomSecretVaultStub();
    await assert.rejects(
      () => stub.getSecret('any_ref'),
      /PRODUCTION_VAULT_NOT_CONFIGURED/
    );
  });

  // EXTRA TEST — PARENT ADMINISTRATIVE CLIENT SEPARATION
  it('EXTRA — Parent administrative client is strictly isolated from tenant runtime', () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC_PARENT_ADMIN_SID_12345';
    process.env.TWILIO_AUTH_TOKEN = 'PARENT_ADMIN_AUTH_TOKEN_SECRET';

    const adminClient: any = ProviderClientFactory.getParentAdministrativeClient();
    assert.equal(adminClient.accountSid, 'AC_PARENT_ADMIN_SID_12345');
    assert.equal(adminClient.secret, 'PARENT_ADMIN_AUTH_TOKEN_SECRET');
  });
});
