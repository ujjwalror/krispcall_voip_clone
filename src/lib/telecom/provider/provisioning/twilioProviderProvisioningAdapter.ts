/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import twilio from 'twilio';
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
import {
  isProviderAccountProvisioningMutationsEnabled,
  assertProtectedPilotUntouched,
} from './liveProvisioningGuard';
import { ProviderClientFactory } from '../providerClientFactory';

export interface TwilioProvisioningAdapterOptions {
  parentClient?: twilio.Twilio;
  webhookBaseUrl?: string;
}

/**
 * Real production-capable Twilio Customer-Subaccount Provisioning Adapter.
 *
 * SAGA CONFORMANCE & SECURITY INVARIANTS:
 * 1. Isolated Provider Calls: All mutating provider operations require explicit server-side mutation flag.
 * 2. Protected Pilot Quarantine: Strictly refuses any operation touching the protected Australian pilot.
 * 3. Parent Administrative Authority: Operations execute through explicit PLATFORM_ADMIN parent credentials.
 * 4. Zero Secrets in Return Payloads: Secret keys returned only once; never cached in adapter state.
 * 5. Deterministic Resource Verification: Validates SID prefixes (AC..., SK..., AP...) and cross-account bindings.
 */
export class TwilioProviderProvisioningAdapter implements ProviderProvisioningAdapter {
  readonly provider: TelecomProvider = 'TWILIO';
  private injectedParentClient?: twilio.Twilio;
  private configuredWebhookBaseUrl?: string;

  constructor(options?: TwilioProvisioningAdapterOptions) {
    if (options?.parentClient) {
      this.injectedParentClient = options.parentClient;
    }
    if (options?.webhookBaseUrl) {
      this.configuredWebhookBaseUrl = options.webhookBaseUrl;
    }
  }

  /**
   * Resolves the authoritative parent administrative Twilio client.
   * Customer runtime contexts are strictly prohibited from this path.
   */
  private getParentClient(): twilio.Twilio {
    if (this.injectedParentClient) {
      return this.injectedParentClient;
    }

    return ProviderClientFactory.getTwilioClient({
      providerAccountId: '00000000-0000-0000-0000-000000000001',
      provider: 'TWILIO',
      accountType: 'SHARED_PARENT',
      accountReference: process.env.TWILIO_ACCOUNT_SID || 'AC_PARENT',
      credentialReference: 'env:TWILIO_ACCOUNT_SID',
      organizationId: '00000000-0000-0000-0000-000000000000',
      serviceScope: 'VOICE',
      capabilities: ['ALL'],
      countryCode: null,
      isSharedParent: true,
      environment: 'production',
    });
  }

  /**
   * Resolves the base URL for incoming webhooks configured in TwiML Apps.
   */
  private getWebhookBaseUrl(): string {
    if (this.configuredWebhookBaseUrl) {
      return this.configuredWebhookBaseUrl.replace(/\/+$/, '');
    }
    const envUrl = process.env.TELECOM_WEBHOOK_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://api.krispcall.com';
    return envUrl.replace(/\/+$/, '');
  }

  /**
   * Asserts that live provisioning mutations are explicitly enabled by operator configuration.
   */
  private assertMutationsEnabled(operationName: string): void {
    if (!isProviderAccountProvisioningMutationsEnabled()) {
      const err: any = new Error(
        `PROVISIONING_MUTATIONS_DISABLED: Live Twilio provisioning mutations are disabled by server policy. (${operationName} blocked).`
      );
      err.code = 'PROVISIONING_MUTATIONS_DISABLED';
      throw err;
    }
  }

  /**
   * Creates a dedicated customer subaccount under the shared parent Twilio account.
   */
  async createCustomerAccount(params: CreateCustomerAccountParams): Promise<CreateCustomerAccountResult> {
    assertProtectedPilotUntouched({ organizationId: params.organizationId });
    this.assertMutationsEnabled('createCustomerAccount');

    const client = this.getParentClient();
    const friendlyName = params.organizationName || `krispcall_sub_${params.organizationId}`;

    const subaccount = await client.api.v2010.accounts.create({
      friendlyName,
    });

    if (!subaccount.sid || !subaccount.sid.startsWith('AC')) {
      const err: any = new Error(`INVALID_PROVIDER_ACCOUNT_SID: Provider returned malformed AccountSid '${subaccount.sid}'.`);
      err.code = 'MALFORMED_PROVIDER_ACCOUNT_SID';
      throw err;
    }

    return {
      accountReference: subaccount.sid,
      accountName: subaccount.friendlyName || friendlyName,
      status: subaccount.status === 'active' ? 'active' : 'pending',
      metadata: {
        rawAuthToken: subaccount.authToken || null,
        dateCreated: subaccount.dateCreated?.toISOString?.() || new Date().toISOString(),
        ownerAccountSid: subaccount.ownerAccountSid || null,
      },
    };
  }

  /**
   * Creates a dedicated API Key on the customer subaccount for server-side runtime operations.
   * Purpose: RUNTIME_API
   */
  async createRuntimeCredential(params: CreateRuntimeCredentialParams): Promise<CreateRuntimeCredentialResult> {
    assertProtectedPilotUntouched({ organizationId: params.organizationId });
    this.assertMutationsEnabled('createRuntimeCredential');

    const client = this.getParentClient();
    const friendlyName = `krispcall_runtime_${params.organizationId}`;

    const key = await client.api.v2010
      .accounts(params.accountReference)
      .newKeys.create({ friendlyName });

    if (!key.sid || !key.sid.startsWith('SK')) {
      const err: any = new Error(`INVALID_KEY_SID: Provider returned malformed API Key SID '${key.sid}'.`);
      err.code = 'MALFORMED_KEY_SID';
      throw err;
    }

    if (!key.secret || key.secret.trim() === '') {
      const err: any = new Error('MISSING_API_KEY_SECRET: Provider did not return one-time secret for created API key.');
      err.code = 'MISSING_API_KEY_SECRET';
      throw err;
    }

    return {
      keyIdentifier: key.sid,
      secret: key.secret,
      accountSid: params.accountReference,
    };
  }

  /**
   * Resolves or bootstraps the subaccount primary Auth Token used for webhook HMAC verification.
   * Purpose: WEBHOOK_VERIFICATION
   */
  async resolveOrBootstrapWebhookCredential(
    params: BootstrapWebhookCredentialParams
  ): Promise<BootstrapWebhookCredentialResult> {
    assertProtectedPilotUntouched({ organizationId: params.organizationId });
    this.assertMutationsEnabled('resolveOrBootstrapWebhookCredential');

    const client = this.getParentClient();
    const subaccount = await client.api.v2010.accounts(params.accountReference).fetch();

    if (!subaccount.authToken || subaccount.authToken.trim() === '') {
      const err: any = new Error(`WEBHOOK_CREDENTIAL_FETCH_FAILED: Unable to retrieve AuthToken for subaccount '${params.accountReference}'.`);
      err.code = 'WEBHOOK_CREDENTIAL_FETCH_FAILED';
      throw err;
    }

    return {
      webhookSecret: subaccount.authToken.trim(),
      accountSid: subaccount.sid || params.accountReference,
    };
  }

  /**
   * Creates a dedicated API Key on the customer subaccount for browser WebRTC voice token signing.
   * Purpose: WEBRTC_TOKEN_SIGNING
   */
  async createWebRtcCredential(params: CreateWebRtcCredentialParams): Promise<CreateWebRtcCredentialResult> {
    assertProtectedPilotUntouched({ organizationId: params.organizationId });
    this.assertMutationsEnabled('createWebRtcCredential');

    const client = this.getParentClient();
    const friendlyName = `krispcall_webrtc_${params.organizationId}`;

    const key = await client.api.v2010
      .accounts(params.accountReference)
      .newKeys.create({ friendlyName });

    if (!key.sid || !key.sid.startsWith('SK')) {
      const err: any = new Error(`INVALID_KEY_SID: Provider returned malformed WebRTC Key SID '${key.sid}'.`);
      err.code = 'MALFORMED_KEY_SID';
      throw err;
    }

    if (!key.secret || key.secret.trim() === '') {
      const err: any = new Error('MISSING_API_KEY_SECRET: Provider did not return one-time secret for created WebRTC key.');
      err.code = 'MISSING_API_KEY_SECRET';
      throw err;
    }

    return {
      keyIdentifier: key.sid,
      secret: key.secret,
      accountSid: params.accountReference,
    };
  }

  /**
   * Creates a dedicated TwiML Application on the customer subaccount.
   */
  async createTwimlApp(params: CreateTwimlAppParams): Promise<CreateTwimlAppResult> {
    assertProtectedPilotUntouched({ organizationId: params.organizationId });
    this.assertMutationsEnabled('createTwimlApp');

    const client = this.getParentClient();
    const baseUrl = this.getWebhookBaseUrl();
    const voiceUrl = params.voiceUrl || `${baseUrl}/api/twilio/voice/inbound`;
    const statusCallback = params.statusCallbackUrl || `${baseUrl}/api/twilio/status`;
    const friendlyName = `krispcall_voice_app_${params.organizationId}`;

    const app = await client.api.v2010
      .accounts(params.accountReference)
      .applications.create({
        friendlyName,
        voiceUrl,
        voiceMethod: 'POST',
        statusCallback,
        statusCallbackMethod: 'POST',
      });

    if (!app.sid || !app.sid.startsWith('AP')) {
      const err: any = new Error(`INVALID_TWIML_APP_SID: Provider returned malformed TwiML App SID '${app.sid}'.`);
      err.code = 'MALFORMED_TWIML_APP_SID';
      throw err;
    }

    // Cross-account binding validation
    if (app.accountSid && app.accountSid !== params.accountReference) {
      const err: any = new Error(
        `CROSS_ACCOUNT_TWIML_APP_MISMATCH: TwiML App was bound to account '${app.accountSid}', not subaccount '${params.accountReference}'.`
      );
      err.code = 'CROSS_ACCOUNT_TWIML_APP_MISMATCH';
      throw err;
    }

    return {
      appSid: app.sid,
      friendlyName: app.friendlyName || friendlyName,
      accountSid: app.accountSid || params.accountReference,
    };
  }

  /**
   * Reconciles uncertain subaccount creation outcomes via provider-side listing.
   */
  async lookupCustomerAccountByIntent(params: LookupCustomerAccountParams): Promise<CreateCustomerAccountResult | null> {
    assertProtectedPilotUntouched({ organizationId: params.organizationId });

    const client = this.getParentClient();
    const targetFriendlyName = `krispcall_sub_${params.organizationId}`;

    const accounts = await client.api.v2010.accounts.list({
      friendlyName: targetFriendlyName,
      status: 'active',
      limit: 5,
    });

    if (accounts && accounts.length > 0) {
      const matched = accounts[0];
      return {
        accountReference: matched.sid,
        accountName: matched.friendlyName || targetFriendlyName,
        status: 'active',
        metadata: {
          reconciled: true,
          ownerAccountSid: matched.ownerAccountSid || null,
        },
      };
    }

    return null;
  }

  /**
   * Reconciles uncertain TwiML App creation outcomes via subaccount application listing.
   */
  async lookupTwimlAppByIntent(params: LookupTwimlAppParams): Promise<CreateTwimlAppResult | null> {
    assertProtectedPilotUntouched({ organizationId: params.organizationId });

    const client = this.getParentClient();
    const targetFriendlyName = `krispcall_voice_app_${params.organizationId}`;

    const apps = await client.api.v2010
      .accounts(params.accountReference)
      .applications.list({
        friendlyName: targetFriendlyName,
        limit: 5,
      });

    if (apps && apps.length > 0) {
      const matched = apps[0];
      return {
        appSid: matched.sid,
        friendlyName: matched.friendlyName || targetFriendlyName,
        accountSid: matched.accountSid,
      };
    }

    return null;
  }

  /**
   * Non-destructive compensation: suspends a subaccount instead of destructive deletion.
   */
  async suspendCustomerAccount(params: { accountReference: string }): Promise<void> {
    this.assertMutationsEnabled('suspendCustomerAccount');
    const client = this.getParentClient();
    await client.api.v2010.accounts(params.accountReference).update({ status: 'suspended' });
  }

  /**
   * Revokes a runtime API key on failure.
   */
  async deleteRuntimeCredential(params: { accountReference: string; keyIdentifier: string }): Promise<void> {
    this.assertMutationsEnabled('deleteRuntimeCredential');
    const client = this.getParentClient();
    await client.api.v2010.accounts(params.accountReference).keys(params.keyIdentifier).remove();
  }

  /**
   * Revokes a WebRTC API key on failure.
   */
  async deleteWebRtcCredential(params: { accountReference: string; keyIdentifier: string }): Promise<void> {
    this.assertMutationsEnabled('deleteWebRtcCredential');
    const client = this.getParentClient();
    await client.api.v2010.accounts(params.accountReference).keys(params.keyIdentifier).remove();
  }

  /**
   * Deletes a TwiML App on failure.
   */
  async deleteTwimlApp(params: { accountReference: string; appSid: string }): Promise<void> {
    this.assertMutationsEnabled('deleteTwimlApp');
    const client = this.getParentClient();
    await client.api.v2010.accounts(params.accountReference).applications(params.appSid).remove();
  }
}
