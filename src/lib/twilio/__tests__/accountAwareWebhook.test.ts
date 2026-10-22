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
  validateAccountAwareTwilioWebhook,
  validateTwilioRequest,
  constructExpectedTwilioSignature,
} from '../signature';
import {
  LocalMemoryTelecomSecretVault,
  TelecomSecretVaultRegistry,
} from '@/lib/telecom/vault';

describe('Phase 22C-2: Account-Aware Webhook Authentication Boundary Test Suite', () => {
  let vault: LocalMemoryTelecomSecretVault;

  const PARENT_ACCOUNT_SID = 'AC_PARENT_PLATFORM_ACCOUNT_00001';
  const PARENT_AUTH_TOKEN = 'parent_auth_token_secret_111111111111';

  const SUBACCOUNT_A_SID = 'AC_SUBACCOUNT_A_1111111111111111';
  const SUBACCOUNT_A_WEBHOOK_TOKEN = 'subaccount_a_webhook_token_secret_aaaaa';
  const SUBACCOUNT_A_RUNTIME_KEY_SECRET = 'subaccount_a_runtime_api_key_secret_99999';

  const SUBACCOUNT_B_SID = 'AC_SUBACCOUNT_B_2222222222222222';
  const SUBACCOUNT_B_WEBHOOK_TOKEN = 'subaccount_b_webhook_token_secret_bbbbb';

  const SUBACCOUNT_REVOKED_SID = 'AC_SUBACCOUNT_REVOKED_3333333333';
  const SUBACCOUNT_REVOKED_TOKEN = 'subaccount_revoked_token_secret_rrrrr';

  const SUBACCOUNT_MISSING_SEC_SID = 'AC_SUBACCOUNT_MISSING_SEC_44444';
  const SUBACCOUNT_WRONG_PURPOSE_SID = 'AC_SUBACCOUNT_WRONG_PURPOSE_5555';
  const SUBACCOUNT_SUSPENDED_SID = 'AC_SUBACCOUNT_SUSPENDED_66666';

  const WEBHOOK_URL = 'https://voiphub.example.com/api/twilio/voice/inbound';

  // In-memory mock database tables
  let providerAccountsStore: any[] = [];
  let resourceRecordsStore: any[] = [];
  let phoneNumbersStore: any[] = [];

  const mockSupabase = {
    from: (table: string) => {
      let store: any[] = [];
      if (table === 'telecom_provider_accounts') store = providerAccountsStore;
      else if (table === 'telecom_provider_resource_records') store = resourceRecordsStore;
      else if (table === 'phone_numbers') store = phoneNumbersStore;

      let filters: Array<(row: any) => boolean> = [];
      let orFilters: Array<(row: any) => boolean> = [];

      const builder: any = {
        select: (_cols?: string) => builder,
        eq: (col: string, val: any) => {
          filters.push((row: any) => row[col] === val);
          return builder;
        },
        or: (conditionStr: string) => {
          // Parse basic comma-separated equality conditions
          const clauses = conditionStr.split(',').map((c) => c.trim());
          orFilters.push((row: any) => {
            return clauses.some((clause) => {
              const [col, op, val] = clause.split('.');
              if (op === 'eq') {
                return row[col] === val;
              }
              return false;
            });
          });
          return builder;
        },
        maybeSingle: async () => {
          const match = store.find((row) => {
            const passesFilters = filters.every((f) => f(row));
            const passesOr = orFilters.length === 0 || orFilters.some((f) => f(row));
            return passesFilters && passesOr;
          });
          return { data: match ? { ...match } : null, error: null };
        },
        single: async () => {
          const match = store.find((row) => {
            const passesFilters = filters.every((f) => f(row));
            const passesOr = orFilters.length === 0 || orFilters.some((f) => f(row));
            return passesFilters && passesOr;
          });
          if (!match) return { data: null, error: { message: 'Row not found' } };
          return { data: { ...match }, error: null };
        },
        then: (resolve: any) => {
          const filtered = store.filter((row: any) => {
            const passesFilters = filters.every((f) => f(row));
            const passesOr = orFilters.length === 0 || orFilters.some((f) => f(row));
            return passesFilters && passesOr;
          });
          resolve({ data: filtered.map((r: any) => ({ ...r })), error: null });
        },
      };

      return builder;
    },
  };

  beforeEach(async () => {
    process.env.TWILIO_ACCOUNT_SID = PARENT_ACCOUNT_SID;
    process.env.TWILIO_AUTH_TOKEN = PARENT_AUTH_TOKEN;
    process.env.TWILIO_WEBHOOK_BASE_URL = 'https://voiphub.example.com';

    vault = new LocalMemoryTelecomSecretVault();
    TelecomSecretVaultRegistry.setVault(vault);

    providerAccountsStore = [
      {
        id: '00000000-0000-0000-0000-000000000001',
        provider: 'TWILIO',
        account_type: 'SHARED_PARENT',
        account_reference: PARENT_ACCOUNT_SID,
        credential_reference: 'env:TWILIO_ACCOUNT_SID',
        status: 'active',
        metadata: { description: 'Shared Parent Twilio Account' },
      },
      {
        id: 'acc-sub-a',
        provider: 'TWILIO',
        account_type: 'CUSTOMER_SUBACCOUNT',
        account_reference: SUBACCOUNT_A_SID,
        credential_reference: 'vault:twilio:subaccount:org_a',
        status: 'active',
        metadata: {
          webhook_credential_reference: 'vault:twilio:subaccount:org_a:webhook',
        },
      },
      {
        id: 'acc-sub-b',
        provider: 'TWILIO',
        account_type: 'CUSTOMER_SUBACCOUNT',
        account_reference: SUBACCOUNT_B_SID,
        credential_reference: 'vault:twilio:subaccount:org_b',
        status: 'active',
        metadata: {
          webhook_credential_reference: 'vault:twilio:subaccount:org_b:webhook',
        },
      },
      {
        id: 'acc-sub-revoked',
        provider: 'TWILIO',
        account_type: 'CUSTOMER_SUBACCOUNT',
        account_reference: SUBACCOUNT_REVOKED_SID,
        credential_reference: 'vault:twilio:subaccount:revoked',
        status: 'active',
        metadata: {
          webhook_credential_reference: 'vault:twilio:subaccount:revoked:webhook',
        },
      },
      {
        id: 'acc-sub-missing-sec',
        provider: 'TWILIO',
        account_type: 'CUSTOMER_SUBACCOUNT',
        account_reference: SUBACCOUNT_MISSING_SEC_SID,
        credential_reference: 'vault:twilio:subaccount:missing',
        status: 'active',
        metadata: {
          webhook_credential_reference: 'vault:twilio:subaccount:missing:webhook',
        },
      },
      {
        id: 'acc-sub-wrong-purpose',
        provider: 'TWILIO',
        account_type: 'CUSTOMER_SUBACCOUNT',
        account_reference: SUBACCOUNT_WRONG_PURPOSE_SID,
        credential_reference: 'vault:twilio:subaccount:wrong_purpose',
        status: 'active',
        metadata: {
          webhook_credential_reference: 'vault:twilio:subaccount:wrong_purpose:secret',
        },
      },
      {
        id: 'acc-sub-suspended',
        provider: 'TWILIO',
        account_type: 'CUSTOMER_SUBACCOUNT',
        account_reference: SUBACCOUNT_SUSPENDED_SID,
        credential_reference: 'vault:twilio:subaccount:suspended',
        status: 'suspended',
        metadata: {},
      },
    ];

    resourceRecordsStore = [
      {
        id: 'res-parent-call-1',
        organization_id: 'org-parent-platform',
        provider_account_id: '00000000-0000-0000-0000-000000000001',
        resource_type: 'CALL',
        local_resource_id: 'local_call_parent_1',
        remote_resource_id: 'CA_PARENT_LEGIT_CALL_001',
        status: 'active',
      },
      {
        id: 'res-org-a-call-1',
        organization_id: 'org-A',
        provider_account_id: 'acc-sub-a',
        resource_type: 'CALL',
        local_resource_id: 'local_call_a_1',
        remote_resource_id: 'CA_ORG_A_CALL_123',
        status: 'active',
      },
      {
        id: 'res-org-b-call-1',
        organization_id: 'org-B',
        provider_account_id: 'acc-sub-b',
        resource_type: 'CALL',
        local_resource_id: 'local_call_b_1',
        remote_resource_id: 'CA_ORG_B_CALL_456',
        status: 'active',
      },
      {
        id: 'res-org-a-phone-1',
        organization_id: 'org-A',
        provider_account_id: 'acc-sub-a',
        resource_type: 'PHONE_NUMBER',
        local_resource_id: 'local_phone_a_1',
        remote_resource_id: '+15551112222',
        status: 'active',
      },
      {
        id: 'res-org-b-phone-1',
        organization_id: 'org-B',
        provider_account_id: 'acc-sub-b',
        resource_type: 'PHONE_NUMBER',
        local_resource_id: 'local_phone_b_1',
        remote_resource_id: '+15553334444',
        status: 'active',
      },
    ];

    phoneNumbersStore = [
      { id: 'pn-a', organization_id: 'org-A', phone_number: '+15551112222', active: true },
      { id: 'pn-b', organization_id: 'org-B', phone_number: '+15553334444', active: true },
    ];

    // Seed Vault
    // 1. Subaccount A webhook verification token
    await vault.storeSecret({
      referenceId: 'vault:twilio:subaccount:org_a:webhook',
      secret: SUBACCOUNT_A_WEBHOOK_TOKEN,
      provider: 'TWILIO',
      providerAccountId: 'acc-sub-a',
      accountReference: SUBACCOUNT_A_SID,
      purpose: 'WEBHOOK_VERIFICATION',
    });

    // 2. Subaccount A runtime API secret
    await vault.storeSecret({
      referenceId: 'vault:twilio:subaccount:org_a',
      secret: SUBACCOUNT_A_RUNTIME_KEY_SECRET,
      provider: 'TWILIO',
      providerAccountId: 'acc-sub-a',
      keyIdentifier: 'SK_SUBACCOUNT_A_KEY',
      accountReference: SUBACCOUNT_A_SID,
      purpose: 'RUNTIME_API',
    });

    // 3. Subaccount B webhook verification token
    await vault.storeSecret({
      referenceId: 'vault:twilio:subaccount:org_b:webhook',
      secret: SUBACCOUNT_B_WEBHOOK_TOKEN,
      provider: 'TWILIO',
      providerAccountId: 'acc-sub-b',
      accountReference: SUBACCOUNT_B_SID,
      purpose: 'WEBHOOK_VERIFICATION',
    });

    // 4. Subaccount Revoked token
    await vault.storeSecret({
      referenceId: 'vault:twilio:subaccount:revoked:webhook',
      secret: SUBACCOUNT_REVOKED_TOKEN,
      provider: 'TWILIO',
      providerAccountId: 'acc-sub-revoked',
      accountReference: SUBACCOUNT_REVOKED_SID,
      purpose: 'WEBHOOK_VERIFICATION',
    });
    vault.revokeSecret('vault:twilio:subaccount:revoked:webhook');

    // 5. Subaccount Wrong Purpose (stored with purpose RUNTIME_API)
    await vault.storeSecret({
      referenceId: 'vault:twilio:subaccount:wrong_purpose:secret',
      secret: 'SECRET_WRONG_PURPOSE_VALUE_123',
      provider: 'TWILIO',
      providerAccountId: 'acc-sub-wrong-purpose',
      accountReference: SUBACCOUNT_WRONG_PURPOSE_SID,
      purpose: 'RUNTIME_API',
    });
  });

  // TEST A — VALID SUBACCOUNT A
  it('TEST A — VALID SUBACCOUNT A: Accepts valid subaccount signature', async () => {
    const params = {
      AccountSid: SUBACCOUNT_A_SID,
      CallSid: 'CA_ORG_A_CALL_123',
      From: '+15559990000',
      To: '+15551112222',
    };
    const signature = constructExpectedTwilioSignature(SUBACCOUNT_A_WEBHOOK_TOKEN, WEBHOOK_URL, params);
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-twilio-signature': signature },
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, true);
    assert.equal(res.trustedProviderAccount?.id, 'acc-sub-a');
    assert.equal(res.organizationId, 'org-A');
  });

  // TEST B — SUBACCOUNT A WITH PARENT TOKEN
  it('TEST B — SUBACCOUNT A WITH PARENT TOKEN: Rejects customer subaccount claiming parent signature', async () => {
    const params = {
      AccountSid: SUBACCOUNT_A_SID,
      CallSid: 'CA_ORG_A_CALL_123',
    };
    // Signed with PARENT token instead of Subaccount A token
    const invalidSignature = constructExpectedTwilioSignature(PARENT_AUTH_TOKEN, WEBHOOK_URL, params);
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-twilio-signature': invalidSignature },
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, false);
    assert.equal(res.errorCode, 'INVALID_SIGNATURE');
  });

  // TEST C — SUBACCOUNT A WITH B TOKEN
  it('TEST C — SUBACCOUNT A WITH B TOKEN: Rejects Subaccount A signed with Subaccount B token', async () => {
    const params = {
      AccountSid: SUBACCOUNT_A_SID,
      CallSid: 'CA_ORG_A_CALL_123',
    };
    // Signed with Subaccount B token
    const invalidSignature = constructExpectedTwilioSignature(SUBACCOUNT_B_WEBHOOK_TOKEN, WEBHOOK_URL, params);
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-twilio-signature': invalidSignature },
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, false);
    assert.equal(res.errorCode, 'INVALID_SIGNATURE');
  });

  // TEST D — SPOOFED ACCOUNT SID
  it('TEST D — SPOOFED ACCOUNT SID: Rejects spoofed AccountSid parameter', async () => {
    const params = {
      AccountSid: SUBACCOUNT_A_SID, // claims A
      CallSid: 'CA_TEST_SPOOF',
    };
    // Attacker signs using their own Subaccount B token
    const signature = constructExpectedTwilioSignature(SUBACCOUNT_B_WEBHOOK_TOKEN, WEBHOOK_URL, params);
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-twilio-signature': signature },
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, false);
    assert.equal(res.errorCode, 'INVALID_SIGNATURE');
  });

  // TEST E — UNKNOWN ACCOUNT SID
  it('TEST E — UNKNOWN ACCOUNT SID: Fails closed on unknown AccountSid', async () => {
    const params = {
      AccountSid: 'AC_TOTALLY_UNKNOWN_ACCOUNT_999999',
      CallSid: 'CA_UNKNOWN_1',
    };
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-twilio-signature': 'any_signature' },
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, false);
    assert.equal(res.errorCode, 'UNKNOWN_ACCOUNT_SID');
  });

  // TEST F — MISSING ACCOUNT SID
  it('TEST F — MISSING ACCOUNT SID: Fails closed when AccountSid is missing', async () => {
    const params = {
      CallSid: 'CA_NO_ACCOUNTSID',
    };
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-twilio-signature': 'any_signature' },
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, false);
    assert.equal(res.errorCode, 'MISSING_ACCOUNT_SID');
  });

  // TEST G — KNOWN SUBACCOUNT, MISSING VAULT SECRET
  it('TEST G — KNOWN SUBACCOUNT, MISSING VAULT SECRET: Fails closed when secret is absent from vault', async () => {
    const params = {
      AccountSid: SUBACCOUNT_MISSING_SEC_SID,
      CallSid: 'CA_MISSING_SEC',
    };
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-twilio-signature': 'any_signature' },
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, false);
    assert.equal(res.errorCode, 'MISSING_VAULT_SECRET');
  });

  // TEST H — REVOKED WEBHOOK CREDENTIAL
  it('TEST H — REVOKED WEBHOOK CREDENTIAL: Fails closed when secret status is revoked', async () => {
    const params = {
      AccountSid: SUBACCOUNT_REVOKED_SID,
      CallSid: 'CA_REVOKED',
    };
    const signature = constructExpectedTwilioSignature(SUBACCOUNT_REVOKED_TOKEN, WEBHOOK_URL, params);
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-twilio-signature': signature },
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, false);
    assert.equal(res.errorCode, 'CREDENTIAL_REVOKED');
  });

  // TEST I — WRONG CREDENTIAL PURPOSE
  it('TEST I — WRONG CREDENTIAL PURPOSE: Fails closed when credential has RUNTIME_API purpose instead of WEBHOOK_VERIFICATION', async () => {
    const params = {
      AccountSid: SUBACCOUNT_WRONG_PURPOSE_SID,
      CallSid: 'CA_WRONG_PURPOSE',
    };
    const signature = constructExpectedTwilioSignature('SECRET_WRONG_PURPOSE_VALUE_123', WEBHOOK_URL, params);
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-twilio-signature': signature },
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, false);
    assert.equal(res.errorCode, 'WRONG_CREDENTIAL_PURPOSE');
  });

  // TEST J — VALID EXPLICIT PARENT RESOURCE
  it('TEST J — VALID EXPLICIT PARENT RESOURCE: Accepts legitimate explicit parent account webhook', async () => {
    const params = {
      AccountSid: PARENT_ACCOUNT_SID,
      CallSid: 'CA_PARENT_LEGIT_CALL_001',
    };
    const signature = constructExpectedTwilioSignature(PARENT_AUTH_TOKEN, WEBHOOK_URL, params);
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-twilio-signature': signature },
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, true);
    assert.equal(res.trustedProviderAccount?.account_type || res.trustedProviderAccount?.accountType, 'SHARED_PARENT');
    assert.equal(res.organizationId, 'org-parent-platform');
  });

  // TEST K — PARENT TOKEN AGAINST CUSTOMER RESOURCE
  it('TEST K — PARENT TOKEN AGAINST CUSTOMER RESOURCE: Rejects parent token attempting to access customer resource', async () => {
    const params = {
      AccountSid: PARENT_ACCOUNT_SID,
      CallSid: 'CA_ORG_A_CALL_123', // Customer Subaccount A's resource!
    };
    const signature = constructExpectedTwilioSignature(PARENT_AUTH_TOKEN, WEBHOOK_URL, params);
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-twilio-signature': signature },
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, false);
    assert.equal(res.errorCode, 'PARENT_TOKEN_AGAINST_CUSTOMER_RESOURCE');
  });

  // TEST L — CROSS-TENANT RESOURCE SID
  it('TEST L — CROSS-TENANT RESOURCE SID: Subaccount A signature rejected when referencing Subaccount B resource', async () => {
    const params = {
      AccountSid: SUBACCOUNT_A_SID,
      CallSid: 'CA_ORG_B_CALL_456', // Subaccount B's resource!
    };
    const signature = constructExpectedTwilioSignature(SUBACCOUNT_A_WEBHOOK_TOKEN, WEBHOOK_URL, params);
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-twilio-signature': signature },
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, false);
    assert.equal(res.errorCode, 'CROSS_TENANT_RESOURCE_MISMATCH');
  });

  // TEST M — NEW INBOUND RESOURCE
  it('TEST M — NEW INBOUND RESOURCE: Accepts valid new inbound call and derives Org A from destination phone number', async () => {
    const params = {
      AccountSid: SUBACCOUNT_A_SID,
      CallSid: 'CA_NEW_INBOUND_UNMAPPED_CALL_777', // New inbound, not yet mapped
      To: '+15551112222', // Mapped to Org A + Subaccount A
      From: '+15559998888',
    };
    const signature = constructExpectedTwilioSignature(SUBACCOUNT_A_WEBHOOK_TOKEN, WEBHOOK_URL, params);
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-twilio-signature': signature },
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, true);
    assert.equal(res.isNewInboundResource, true);
    assert.equal(res.organizationId, 'org-A');
  });

  // TEST N — NEW INBOUND RESOURCE WITH FOREIGN NUMBER
  it('TEST N — NEW INBOUND RESOURCE WITH FOREIGN NUMBER: Rejects new inbound call where number belongs to Org B', async () => {
    const params = {
      AccountSid: SUBACCOUNT_A_SID,
      CallSid: 'CA_NEW_INBOUND_CALL_888',
      To: '+15553334444', // Belongs to Org B / Subaccount B!
      From: '+15559998888',
    };
    const signature = constructExpectedTwilioSignature(SUBACCOUNT_A_WEBHOOK_TOKEN, WEBHOOK_URL, params);
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-twilio-signature': signature },
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, false);
    assert.equal(res.errorCode, 'CROSS_TENANT_RESOURCE_MISMATCH');
  });

  // TEST O — INVALID SIGNATURE
  it('TEST O — INVALID SIGNATURE: Rejects malformed or corrupted signature string', async () => {
    const params = {
      AccountSid: SUBACCOUNT_A_SID,
      CallSid: 'CA_ORG_A_CALL_123',
    };
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-twilio-signature': 'corrupted_signature_xyz==' },
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, false);
    assert.equal(res.errorCode, 'INVALID_SIGNATURE');
  });

  // TEST P — MISSING SIGNATURE
  it('TEST P — MISSING SIGNATURE: Rejects when x-twilio-signature header is absent', async () => {
    const params = {
      AccountSid: SUBACCOUNT_A_SID,
      CallSid: 'CA_ORG_A_CALL_123',
    };
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: {},
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, false);
    assert.equal(res.errorCode, 'MISSING_SIGNATURE');
  });

  // TEST Q — TAMPERED BODY/PARAMETERS
  it('TEST Q — TAMPERED BODY/PARAMETERS: Rejects request if body parameter is altered post-signing', async () => {
    const signedParams = {
      AccountSid: SUBACCOUNT_A_SID,
      CallSid: 'CA_ORG_A_CALL_123',
      From: '+15559990000',
    };
    const signature = constructExpectedTwilioSignature(SUBACCOUNT_A_WEBHOOK_TOKEN, WEBHOOK_URL, signedParams);

    // Attacker modifies 'From'
    const tamperedParams = {
      ...signedParams,
      From: '+15556667777',
    };

    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'x-twilio-signature': signature },
    });

    const res = await validateAccountAwareTwilioWebhook(req, tamperedParams, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: WEBHOOK_URL,
    });

    assert.equal(res.isValid, false);
    assert.equal(res.errorCode, 'INVALID_SIGNATURE');
  });

  // TEST R — URL HOST/PROTOCOL TAMPERING
  it('TEST R — URL HOST/PROTOCOL TAMPERING: Rejects attacker-controlled forwarded host manipulation', async () => {
    const attackerUrl = 'https://attacker.evil.com/api/twilio/voice/inbound';
    const params = {
      AccountSid: SUBACCOUNT_A_SID,
      CallSid: 'CA_ORG_A_CALL_123',
    };
    // Attacker signs against their own malicious domain
    const signature = constructExpectedTwilioSignature(SUBACCOUNT_A_WEBHOOK_TOKEN, attackerUrl, params);

    // Attacker sends header X-Forwarded-Host: attacker.evil.com to server
    const req = new Request(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'x-twilio-signature': signature,
        'x-forwarded-host': 'attacker.evil.com',
        'x-forwarded-proto': 'https',
      },
    });

    const res = await validateAccountAwareTwilioWebhook(req, params, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
    });

    assert.equal(res.isValid, false);
    assert.equal(res.errorCode, 'INVALID_SIGNATURE');
  });

  // TEST S — DUPLICATE PARAMETERS
  it('TEST S — DUPLICATE PARAMETERS: Preserves canonical parameter handling without bypass', async () => {
    const targetUrl = 'https://voiphub.example.com/api/twilio/voice/inbound?duplicateParam=original';
    const bodyParams = {
      AccountSid: SUBACCOUNT_A_SID,
      CallSid: 'CA_ORG_A_CALL_123',
      To: '+15551112222',
    };
    const signature = constructExpectedTwilioSignature(SUBACCOUNT_A_WEBHOOK_TOKEN, targetUrl, bodyParams);

    const mergedParams = {
      ...bodyParams,
      duplicateParam: 'original',
    };

    const req = new Request(targetUrl, {
      method: 'POST',
      headers: { 'x-twilio-signature': signature },
    });

    const res = await validateAccountAwareTwilioWebhook(req, mergedParams, {
      supabaseClient: mockSupabase as any,
      vaultOverride: vault,
      urlOverride: targetUrl,
    });

    assert.equal(res.isValid, true);
  });

  // TEST T — CONCURRENT A/B WEBHOOKS
  it('TEST T — CONCURRENT A/B WEBHOOKS: 50 concurrent mixed callbacks maintain strict tenant isolation', async () => {
    const items = Array.from({ length: 50 }, (_, i) => {
      const isOrgA = i % 2 === 0;
      const accountSid = isOrgA ? SUBACCOUNT_A_SID : SUBACCOUNT_B_SID;
      const token = isOrgA ? SUBACCOUNT_A_WEBHOOK_TOKEN : SUBACCOUNT_B_WEBHOOK_TOKEN;
      const callSid = isOrgA ? 'CA_ORG_A_CALL_123' : 'CA_ORG_B_CALL_456';
      const expectedOrg = isOrgA ? 'org-A' : 'org-B';

      const params = { AccountSid: accountSid, CallSid: callSid };
      const signature = constructExpectedTwilioSignature(token, WEBHOOK_URL, params);
      const req = new Request(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'x-twilio-signature': signature },
      });

      return { req, params, expectedOrg, isOrgA };
    });

    const results = await Promise.all(
      items.map(async (item) => {
        const res = await validateAccountAwareTwilioWebhook(item.req, item.params, {
          supabaseClient: mockSupabase as any,
          vaultOverride: vault,
          urlOverride: WEBHOOK_URL,
        });
        return { res, expectedOrg: item.expectedOrg };
      })
    );

    assert.equal(results.length, 50);
    for (const r of results) {
      assert.equal(r.res.isValid, true);
      assert.equal(r.res.organizationId, r.expectedOrg);
    }
  });
});
