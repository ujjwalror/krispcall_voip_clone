/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import {
  ProviderProvisioningAdapter,
  CreateCustomerAccountParams,
  CreateCustomerAccountResult,
  CreateRuntimeCredentialParams,
  CreateRuntimeCredentialResult,
  BootstrapWebhookCredentialParams,
  BootstrapWebhookCredentialResult,
  LookupCustomerAccountParams,
  CreateWebRtcCredentialParams,
  CreateWebRtcCredentialResult,
  CreateTwimlAppParams,
  CreateTwimlAppResult,
  LookupTwimlAppParams,
} from './types';
import { TelecomProvider } from '../types';

export interface MockAdapterCounters {
  createAccountCalls: number;
  createRuntimeCredentialCalls: number;
  bootstrapWebhookCredentialCalls: number;
  createWebRtcCredentialCalls: number;
  createTwimlAppCalls: number;
  lookupCalls: number;
  lookupAppCalls: number;
  deleteCalls: number;
  suspendCalls: number;
}

export class MockProviderProvisioningAdapter implements ProviderProvisioningAdapter {
  readonly provider: TelecomProvider;

  // Audit counters
  public counters: MockAdapterCounters = {
    createAccountCalls: 0,
    createRuntimeCredentialCalls: 0,
    bootstrapWebhookCredentialCalls: 0,
    createWebRtcCredentialCalls: 0,
    createTwimlAppCalls: 0,
    lookupCalls: 0,
    lookupAppCalls: 0,
    deleteCalls: 0,
    suspendCalls: 0,
  };

  // Created accounts storage in mock
  public createdAccounts: Map<string, {
    accountReference: string;
    organizationId: string;
    idempotencyKey: string;
    accountName: string;
    status: 'active' | 'pending' | 'suspended';
  }> = new Map();

  // Created TwiML Apps storage in mock
  public createdApps: Map<string, CreateTwimlAppResult> = new Map();

  // Test failure simulation flags
  public simulateAuthFailure: boolean = false;
  public simulateValidationFailure: boolean = false;
  public simulateCreateTimeout: boolean = false;
  public simulateCreateDefiniteFailure: boolean = false;
  public simulateRuntimeCredentialTimeout: boolean = false;
  public simulateRuntimeCredentialFailure: boolean = false;
  public simulateWebhookCredentialFailure: boolean = false;
  public simulateWebRtcCredentialTimeout: boolean = false;
  public simulateWebRtcCredentialFailure: boolean = false;
  public simulateTwimlAppTimeout: boolean = false;
  public simulateTwimlAppFailure: boolean = false;
  public simulateAppWrongAccount: boolean = false;
  public simulateKeyWrongAccount: boolean = false;
  public simulateMalformedSubaccountSid: boolean = false;
  public simulateCompensationFailure: boolean = false;

  constructor(provider: TelecomProvider = 'TWILIO') {
    this.provider = provider;
  }

  reset(): void {
    this.counters = {
      createAccountCalls: 0,
      createRuntimeCredentialCalls: 0,
      bootstrapWebhookCredentialCalls: 0,
      createWebRtcCredentialCalls: 0,
      createTwimlAppCalls: 0,
      lookupCalls: 0,
      lookupAppCalls: 0,
      deleteCalls: 0,
      suspendCalls: 0,
    };
    this.createdAccounts.clear();
    this.createdApps.clear();
    this.simulateAuthFailure = false;
    this.simulateValidationFailure = false;
    this.simulateCreateTimeout = false;
    this.simulateCreateDefiniteFailure = false;
    this.simulateRuntimeCredentialTimeout = false;
    this.simulateRuntimeCredentialFailure = false;
    this.simulateWebhookCredentialFailure = false;
    this.simulateWebRtcCredentialTimeout = false;
    this.simulateWebRtcCredentialFailure = false;
    this.simulateTwimlAppTimeout = false;
    this.simulateTwimlAppFailure = false;
    this.simulateAppWrongAccount = false;
    this.simulateKeyWrongAccount = false;
    this.simulateMalformedSubaccountSid = false;
    this.simulateCompensationFailure = false;
  }

  async createCustomerAccount(params: CreateCustomerAccountParams): Promise<CreateCustomerAccountResult> {
    this.counters.createAccountCalls++;

    if (this.simulateAuthFailure) {
      const err = new Error('AUTHENTICATION_ERROR: Invalid provider credentials (401 Unauthorized).');
      (err as any).code = 'AUTH_FAILURE';
      (err as any).status = 401;
      throw err;
    }

    if (this.simulateValidationFailure) {
      const err = new Error('VALIDATION_ERROR: Subaccount parameters rejected by provider (400 Bad Request).');
      (err as any).code = 'VALIDATION_ERROR';
      (err as any).status = 400;
      throw err;
    }

    if (this.simulateCreateTimeout) {
      // Simulate timeout / network lost after possible provider-side creation
      const subSid = `AC_mock_${params.organizationId}_${Date.now()}`;
      this.createdAccounts.set(`${params.organizationId}:${params.idempotencyKey}`, {
        accountReference: subSid,
        organizationId: params.organizationId,
        idempotencyKey: params.idempotencyKey,
        accountName: params.organizationName || `Customer Subaccount for ${params.organizationId}`,
        status: 'active',
      });
      const err = new Error('PROVIDER_TIMEOUT_OR_NETWORK_ERROR: Request to provider timed out without acknowledged response.');
      (err as any).code = 'ETIMEDOUT';
      (err as any).isTimeout = true;
      throw err;
    }

    if (this.simulateCreateDefiniteFailure) {
      const err = new Error('PROVIDER_REJECTED: Provider declined subaccount creation (403 Forbidden).');
      (err as any).code = 'PROVIDER_ACCOUNT_CREATION_FAILED';
      throw err;
    }

    // Malformed SID simulation
    if (this.simulateMalformedSubaccountSid) {
      return {
        accountReference: 'NOT_AN_AC_SID_MALFORMED',
        accountName: params.organizationName || `Customer Subaccount for ${params.organizationId}`,
        status: 'active',
      };
    }

    // Deterministic account reference
    const accountReference = `AC_mock_sub_${params.organizationId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}_${Date.now()}`;
    const result: CreateCustomerAccountResult = {
      accountReference,
      accountName: params.organizationName || `Customer Subaccount for ${params.organizationId}`,
      status: 'active',
      metadata: {
        mockProvider: this.provider,
        createdAt: new Date().toISOString(),
      },
    };

    this.createdAccounts.set(`${params.organizationId}:${params.idempotencyKey}`, {
      accountReference,
      organizationId: params.organizationId,
      idempotencyKey: params.idempotencyKey,
      accountName: result.accountName,
      status: 'active',
    });

    return result;
  }

  async createRuntimeCredential(params: CreateRuntimeCredentialParams): Promise<CreateRuntimeCredentialResult> {
    this.counters.createRuntimeCredentialCalls++;

    if (this.simulateRuntimeCredentialTimeout) {
      const err = new Error('RUNTIME_CREDENTIAL_TIMEOUT: Request to provider timed out without acknowledged response.');
      (err as any).code = 'ETIMEDOUT';
      (err as any).isTimeout = true;
      throw err;
    }

    if (this.simulateRuntimeCredentialFailure) {
      const err = new Error('RUNTIME_CREDENTIAL_ERROR: Failed to generate API Key on provider.');
      (err as any).code = 'RUNTIME_CREDENTIAL_CREATION_FAILED';
      throw err;
    }

    const keyIdentifier = `SK_${params.accountReference.slice(3, 15)}_rt_${Date.now().toString(36)}`;
    const secret = `mock_sk_secret_rt_${Math.random().toString(36).substring(2, 15)}_${Date.now()}`;
    const accountSid = this.simulateKeyWrongAccount
      ? 'AC_FOREIGN_SUBACCOUNT_99999999999999'
      : params.accountReference;

    return {
      keyIdentifier,
      secret,
      accountSid,
    };
  }

  async resolveOrBootstrapWebhookCredential(
    params: BootstrapWebhookCredentialParams
  ): Promise<BootstrapWebhookCredentialResult> {
    this.counters.bootstrapWebhookCredentialCalls++;

    if (this.simulateWebhookCredentialFailure) {
      const err = new Error('WEBHOOK_CREDENTIAL_ERROR: Failed to obtain webhook verification token.');
      (err as any).code = 'WEBHOOK_CREDENTIAL_FETCH_FAILED';
      throw err;
    }

    // Twilio subaccounts have a primary Auth Token used for webhook verification
    const webhookSecret = `mock_auth_token_${Math.random().toString(36).substring(2, 15)}_${Date.now()}`;

    return {
      webhookSecret,
      accountSid: params.accountReference,
    };
  }

  async createWebRtcCredential(params: CreateWebRtcCredentialParams): Promise<CreateWebRtcCredentialResult> {
    this.counters.createWebRtcCredentialCalls++;

    if (this.simulateWebRtcCredentialTimeout) {
      const err = new Error('WEBRTC_KEY_TIMEOUT: Request to provider timed out without acknowledged response.');
      (err as any).code = 'ETIMEDOUT';
      (err as any).isTimeout = true;
      throw err;
    }

    if (this.simulateWebRtcCredentialFailure) {
      const err = new Error('WEBRTC_KEY_ERROR: Failed to generate WebRTC signing API Key on provider.');
      (err as any).code = 'WEBRTC_KEY_CREATION_FAILED';
      throw err;
    }

    const keyIdentifier = this.simulateKeyWrongAccount
      ? `SK_wrong_account_${Date.now().toString(36)}`
      : `SK_${params.accountReference.slice(3, 15)}_wrtc_${Date.now().toString(36)}`;
    const secret = `mock_sk_secret_wrtc_${Math.random().toString(36).substring(2, 15)}_${Date.now()}`;
    const accountSid = this.simulateKeyWrongAccount
      ? 'AC_FOREIGN_SUBACCOUNT_99999999999999'
      : params.accountReference;

    return {
      keyIdentifier,
      secret,
      accountSid,
    };
  }

  async createTwimlApp(params: CreateTwimlAppParams): Promise<CreateTwimlAppResult> {
    this.counters.createTwimlAppCalls++;

    if (this.simulateTwimlAppTimeout) {
      const appSid = `AP_mock_app_${Date.now()}`;
      const appRes: CreateTwimlAppResult = {
        appSid,
        friendlyName: `krispcall_voice_app_${params.organizationId}`,
        accountSid: params.accountReference,
      };
      this.createdApps.set(`${params.accountReference}:${params.organizationId}`, appRes);
      const err = new Error('TWIML_APP_TIMEOUT: Request to provider timed out without acknowledged response.');
      (err as any).code = 'ETIMEDOUT';
      (err as any).isTimeout = true;
      throw err;
    }

    if (this.simulateTwimlAppFailure) {
      const err = new Error('TWIML_APP_ERROR: Failed to create TwiML App on provider.');
      (err as any).code = 'TWIML_APP_CREATION_FAILED';
      throw err;
    }

    const appSid = `AP_${params.accountReference.slice(3, 15)}_${Date.now().toString(36)}`;
    const accountSid = this.simulateAppWrongAccount
      ? 'AC_FOREIGN_SUBACCOUNT_99999999999999'
      : params.accountReference;

    const appResult: CreateTwimlAppResult = {
      appSid,
      friendlyName: `krispcall_voice_app_${params.organizationId}`,
      accountSid,
    };

    this.createdApps.set(`${params.accountReference}:${params.organizationId}`, appResult);
    return appResult;
  }

  async lookupCustomerAccountByIntent(params: LookupCustomerAccountParams): Promise<CreateCustomerAccountResult | null> {
    this.counters.lookupCalls++;
    const key = `${params.organizationId}:${params.idempotencyKey}`;
    const existing = this.createdAccounts.get(key);
    if (!existing) {
      return null;
    }

    return {
      accountReference: existing.accountReference,
      accountName: existing.accountName,
      status: existing.status === 'suspended' ? 'active' : existing.status,
    };
  }

  async lookupTwimlAppByIntent(params: LookupTwimlAppParams): Promise<CreateTwimlAppResult | null> {
    this.counters.lookupAppCalls++;
    const key = `${params.accountReference}:${params.organizationId}`;
    return this.createdApps.get(key) || null;
  }

  async suspendCustomerAccount(params: { accountReference: string }): Promise<void> {
    this.counters.suspendCalls++;
    if (this.simulateCompensationFailure) {
      throw new Error('COMPENSATION_FAILED: Provider rejected account suspension.');
    }
    for (const [key, val] of this.createdAccounts.entries()) {
      if (val.accountReference === params.accountReference) {
        val.status = 'suspended';
        this.createdAccounts.set(key, val);
      }
    }
  }

  async deleteCustomerAccount?(_params: { accountReference: string }): Promise<void> {
    this.counters.deleteCalls++;
    void _params;
    if (this.simulateCompensationFailure) {
      throw new Error('COMPENSATION_FAILED: Provider rejected account deletion.');
    }
  }

  async deleteRuntimeCredential?(_params: { accountReference: string; keyIdentifier: string }): Promise<void> {
    this.counters.deleteCalls++;
    void _params;
  }

  async deleteWebRtcCredential?(_params: { accountReference: string; keyIdentifier: string }): Promise<void> {
    this.counters.deleteCalls++;
    void _params;
  }

  async deleteTwimlApp?(_params: { accountReference: string; appSid: string }): Promise<void> {
    this.counters.deleteCalls++;
    void _params;
  }
}

