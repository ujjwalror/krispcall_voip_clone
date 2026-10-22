/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { TelecomSecretVaultRegistry } from '@/lib/telecom/vault';
import { TelecomSecretVault } from '@/lib/telecom/vault/types';
import { TelecomProvider, TelecomServiceScope } from '../types';
import {
  ProvisionOrganizationProviderAccountParams,
  ProvisionOrganizationProviderAccountResult,
  ProvisioningOperationRecord,
  ProvisioningOperationStatus,
  ProviderProvisioningAdapter,
} from './types';
import { MockProviderProvisioningAdapter } from './mockProviderProvisioningAdapter';
import { TwilioProviderProvisioningAdapter } from './twilioProviderProvisioningAdapter';
import {
  assertProtectedPilotUntouched,
  isProviderAccountProvisioningMutationsEnabled,
} from './liveProvisioningGuard';

export type ProvisioningErrorClassification =
  | 'RETRYABLE'
  | 'NON_RETRYABLE'
  | 'UNCERTAIN_OUTCOME'
  | 'MANUAL_RECONCILIATION';

export function classifyProviderError(err: any): {
  classification: ProvisioningErrorClassification;
  code: string;
  isTimeout: boolean;
} {
  const status = Number(err?.status || err?.statusCode || 0);
  let code = String(err?.code || '');
  const msg = String(err?.message || '');

  // If code is not explicitly set or is generic, extract structured error code from message prefix (e.g. "CODE: message")
  if (!code || code === 'PROVISIONING_ERROR') {
    const prefixMatch = msg.match(/^([A-Z0-9_]{3,50}):/);
    if (prefixMatch) {
      code = prefixMatch[1];
    }
  }
  if (!code) {
    code = err?.isTimeout ? 'TIMEOUT' : 'PROVISIONING_ERROR';
  }

  const isTimeout =
    Boolean(err?.isTimeout) ||
    code === 'ETIMEDOUT' ||
    code === 'TIMEOUT' ||
    code === 'PROVIDER_CREATE_TIMEOUT' ||
    code === 'RUNTIME_CREDENTIAL_TIMEOUT' ||
    code === 'TWIML_APP_TIMEOUT' ||
    msg.toLowerCase().includes('timed out') ||
    msg.toLowerCase().includes('timeout') ||
    msg.toLowerCase().includes('connection reset') ||
    code === 'ECONNRESET';

  if (isTimeout) {
    return {
      classification: 'UNCERTAIN_OUTCOME',
      code: code === 'PROVISIONING_ERROR' ? 'TIMEOUT' : code,
      isTimeout: true,
    };
  }

  // Rate limiting (429) or transient provider upstream errors (502, 503, 504)
  if (status === 429 || status === 503 || status === 502 || status === 504 || code === '429' || code === '503') {
    return { classification: 'RETRYABLE', code: `HTTP_${status || code}`, isTimeout: false };
  }

  // Auth, permission, or explicit validation errors
  if (status === 401 || status === 403 || code === '20003' || code === 'AUTH_FAILURE') {
    return { classification: 'NON_RETRYABLE', code, isTimeout: false };
  }

  if (status === 400 || status === 422 || msg.toLowerCase().includes('validation') || msg.toLowerCase().includes('invalid')) {
    return { classification: 'NON_RETRYABLE', code, isTimeout: false };
  }

  return { classification: 'NON_RETRYABLE', code, isTimeout: false };
}

export interface ProvisioningServiceDependencies {
  supabase?: SupabaseClient;
  vault?: TelecomSecretVault;
  adapter?: ProviderProvisioningAdapter;
}

export class TelecomProviderAccountProvisioningService {
  private static adapters: Map<TelecomProvider, ProviderProvisioningAdapter> = new Map();

  static registerAdapter(provider: TelecomProvider, adapter: ProviderProvisioningAdapter): void {
    this.adapters.set(provider, adapter);
  }

  static getAdapter(provider: TelecomProvider): ProviderProvisioningAdapter {
    if (this.adapters.has(provider)) {
      return this.adapters.get(provider)!;
    }
    if (provider === 'TWILIO') {
      if (isProviderAccountProvisioningMutationsEnabled()) {
        const twilioAdapter = new TwilioProviderProvisioningAdapter();
        this.adapters.set('TWILIO', twilioAdapter);
        return twilioAdapter;
      }
      const mockAdapter = new MockProviderProvisioningAdapter('TWILIO');
      this.adapters.set('TWILIO', mockAdapter);
      return mockAdapter;
    }
    throw new Error(`NO_PROVISIONING_ADAPTER: No provisioning adapter registered for provider '${provider}'.`);
  }

  static clearAdapters(): void {
    this.adapters.clear();
  }

  /**
   * Sanitizes any error message to strictly strip potential raw secrets, tokens, or SIDs.
   */
  private static sanitizeErrorMessage(err: any): {
    code: string;
    message: string;
    classification: ProvisioningErrorClassification;
  } {
    const errorClassification = classifyProviderError(err);
    const code = err?.code || errorClassification.code || 'PROVISIONING_ERROR';
    const rawMsg = String(err?.message || err || 'Unknown error');

    // Redact any patterns resembling API keys, auth tokens, passwords, JWTs, or secrets
    const sanitized = rawMsg
      .replace(/mock_sk_secret_[a-zA-Z0-9_\-]+/gi, '[REDACTED_SECRET]')
      .replace(/mock_auth_token_[a-zA-Z0-9_\-]+/gi, '[REDACTED_TOKEN]')
      .replace(/SK[a-zA-Z0-9]{32}/g, '[REDACTED_KEY_SID]')
      .replace(/ey[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, '[REDACTED_JWT]')
      .replace(/secret=[^\s&]+/gi, 'secret=[REDACTED]')
      .replace(/token=[^\s&]+/gi, 'token=[REDACTED]')
      .replace(/password=[^\s&]+/gi, 'password=[REDACTED]')
      .replace(/bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
      .replace(/authorization:\s*[^\s&]+/gi, 'Authorization: [REDACTED]');

    return { code, message: sanitized, classification: errorClassification.classification };
  }

  /**
   * Safe non-destructive compensation policy (Step 14):
   * SAFE_DISABLE_ONLY: We suspend subaccounts on failure rather than destructively deleting them,
   * avoiding destruction of customer telephone inventory or uncertain remote state.
   */
  private static async compensatePartialFailure(
    adapter: ProviderProvisioningAdapter,
    subaccountSid?: string | null
  ): Promise<boolean> {
    if (!subaccountSid || !adapter.suspendCustomerAccount) {
      return true;
    }
    try {
      await adapter.suspendCustomerAccount({ accountReference: subaccountSid });
      return true;
    } catch (compErr: any) {
      console.warn('[TelecomProviderAccountProvisioningService] Compensation failed:', compErr?.message);
      return false;
    }
  }

  /**
   * Orchestrates dedicated customer provider account provisioning.
   *
   * SAGA INVARIANTS:
   * 1. Idempotency: (organizationId, provider, idempotencyKey) creates exactly one operation.
   * 2. Non-idempotent provider create: Timeouts transition to REQUIRES_RECONCILIATION, never blind retry.
   * 3. Secret Vault Isolation: RUNTIME_API, WEBHOOK_VERIFICATION, and WEBRTC_TOKEN_SIGNING secrets
   *    stored separately in vault; no plaintext in DB or logs.
   * 4. Activation Gate: Account not selectable by ProviderAccountResolver until ALL requirements are verified.
   * 5. Compensation Policy: Non-destructive suspension only; safe state preserved for reconciliation.
   * 6. Protected Pilot Guard: Australian pilot resource quarantined with code-level assertion.
   */
  static async provisionOrganizationProviderAccount(
    params: ProvisionOrganizationProviderAccountParams,
    deps?: ProvisioningServiceDependencies
  ): Promise<ProvisionOrganizationProviderAccountResult> {
    const { organizationId, provider, idempotencyKey, organizationName } = params;
    const serviceScope: TelecomServiceScope = params.serviceScope || 'ALL';

    // Step 21: Protected Resource Guard (Pilot Phone Number & Org Quarantine)
    try {
      assertProtectedPilotUntouched({
        organizationId,
      });
    } catch (pilotErr: any) {
      return {
        success: false,
        operationId: '',
        status: 'FAILED',
        errorCode: pilotErr.code || 'PROTECTED_PILOT_QUARANTINE_VIOLATION',
        errorMessage: pilotErr.message,
      };
    }

    // Cross-tenant security check: Reject caller-supplied foreign provider account IDs
    if (params.foreignProviderAccountIdOverride) {
      return {
        success: false,
        operationId: '',
        status: 'FAILED',
        errorCode: 'CROSS_TENANT_ATTACHMENT_PROHIBITED',
        errorMessage: 'Security Error: Callers cannot supply foreign provider account IDs or override provider bindings.',
      };
    }

    if (!organizationId || typeof organizationId !== 'string') {
      return {
        success: false,
        operationId: '',
        status: 'FAILED',
        errorCode: 'INVALID_ORGANIZATION_ID',
        errorMessage: 'Valid organizationId is required.',
      };
    }

    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
      return {
        success: false,
        operationId: '',
        status: 'FAILED',
        errorCode: 'INVALID_IDEMPOTENCY_KEY',
        errorMessage: 'Valid idempotencyKey is required.',
      };
    }

    const db = deps?.supabase || createAdminClient();
    const vault = deps?.vault || TelecomSecretVaultRegistry.getVault();
    const adapter = deps?.adapter || this.getAdapter(provider);

    // Phase 24B: Local Parent-Protection Control Plane & Provider Account Provisioning Circuit Breaker
    const { TelecomControlPlaneService } = await import('@/lib/telecom/controlPlane');
    const controlEval = await TelecomControlPlaneService.evaluate(
      {
        organizationId,
        operation: 'PROVIDER_ACCOUNT_PROVISIONING',
        context: { provider, serviceScope },
      },
      db
    );
    if (!controlEval.allowed) {
      return {
        success: false,
        operationId: '',
        status: 'FAILED',
        errorCode: controlEval.reasonCode,
        errorMessage: controlEval.reason,
      };
    }

    // 1. Existing Active Account Check (Section 15: Existing Account Safety)
    // If the organization already has an active customer subaccount assignment for this provider/scope, reuse it.
    try {
      const { data: existingAssignments } = await (db as any)
        .from('telecom_organization_provider_assignments')
        .select('id, provider_account_id, is_active, service_scope')
        .eq('organization_id', organizationId)
        .eq('is_active', true);

      if (existingAssignments && existingAssignments.length > 0) {
        for (const assign of existingAssignments) {
          if (assign.service_scope === 'ALL' || assign.service_scope === serviceScope) {
            // Verify assigned provider account is a customer subaccount for the same provider
            const { data: assignedAccount } = await (db as any)
              .from('telecom_provider_accounts')
              .select('*')
              .eq('id', assign.provider_account_id)
              .maybeSingle();

            if (
              assignedAccount &&
              assignedAccount.provider === provider &&
              assignedAccount.account_type === 'CUSTOMER_SUBACCOUNT' &&
              assignedAccount.status === 'active'
            ) {
              return {
                success: true,
                operationId: 'existing_active_assignment',
                status: 'READY',
                providerAccountId: assignedAccount.id,
                accountReference: assignedAccount.account_reference,
                assignmentId: assign.id,
                isExistingAccountReused: true,
              };
            }
          }
        }
      }
    } catch (err: any) {
      console.warn('[TelecomProviderAccountProvisioningService] Error checking existing assignments:', err?.message);
    }

    // 2. Durable Saga Operation Admission / Recovery
    let operation: ProvisioningOperationRecord;

    try {
      const { data: existingOp } = await (db as any)
        .from('telecom_account_provisioning_operations')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('provider', provider)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();

      if (existingOp) {
        operation = this.mapOperationRecord(existingOp);
      } else {
        // Insert new operation in REQUESTED state with preallocated provider_account_id
        const preallocatedAccountId = crypto.randomUUID();
        const newOpRow = {
          organization_id: organizationId,
          provider,
          service_scope: serviceScope,
          idempotency_key: idempotencyKey,
          status: 'REQUESTED' as ProvisioningOperationStatus,
          provider_account_id: preallocatedAccountId,
          attempt_count: 1,
          metadata: {
            organizationName: organizationName || null,
          },
        };

        const { data: inserted, error: insertErr } = await (db as any)
          .from('telecom_account_provisioning_operations')
          .insert(newOpRow)
          .select('*')
          .single();

        if (insertErr || !inserted) {
          // If concurrent insert race occurred, fetch the winning row
          const { data: racedOp } = await (db as any)
            .from('telecom_account_provisioning_operations')
            .select('*')
            .eq('organization_id', organizationId)
            .eq('provider', provider)
            .eq('idempotency_key', idempotencyKey)
            .single();

          if (racedOp) {
            operation = this.mapOperationRecord(racedOp);
          } else {
            const err = new Error(`FAILED_ADMISSION: Unable to record provisioning operation: ${insertErr?.message}`);
            (err as any).code = 'FAILED_ADMISSION';
            throw err;
          }
        } else {
          operation = this.mapOperationRecord(inserted);
        }
      }
    } catch (err: any) {
      const sanitized = this.sanitizeErrorMessage(err);
      return {
        success: false,
        operationId: '',
        status: 'FAILED',
        errorCode: sanitized.code,
        errorMessage: sanitized.message,
      };
    }

    // 3. Handle Already Ready Operations (Idempotent success)
    if (operation.status === 'READY') {
      return {
        success: true,
        operationId: operation.id,
        status: 'READY',
        providerAccountId: operation.providerAccountId || undefined,
        accountReference: operation.providerAccountReference || undefined,
        assignmentId: operation.assignmentId || undefined,
        isExistingAccountReused: true,
      };
    }

    // 4. Execute Saga State Transitions
    try {
      // Step A: Reconciliation if in REQUIRES_RECONCILIATION
      if (operation.status === 'REQUIRES_RECONCILIATION') {
        if (
          operation.lastErrorCode === 'LOST_API_KEY_SECRET' ||
          operation.lastErrorCode === 'LOST_WEBRTC_KEY_SECRET' ||
          operation.lastErrorCode === 'VAULT_STORAGE_FAILED' ||
          operation.lastErrorCode === 'RUNTIME_CREDENTIAL_TIMEOUT' ||
          operation.lastErrorCode === 'WEBRTC_CREDENTIAL_TIMEOUT'
        ) {
          return {
            success: false,
            operationId: operation.id,
            status: 'REQUIRES_RECONCILIATION',
            errorCode: operation.lastErrorCode,
            errorMessage: 'API Key outcome requires manual operator reconciliation. Automatic key recreation or deletion is strictly prohibited.',
          };
        }

        if (adapter.lookupCustomerAccountByIntent) {
          const reconciled = await adapter.lookupCustomerAccountByIntent({
            organizationId,
            idempotencyKey,
          });

          if (reconciled) {
            operation.providerAccountReference = reconciled.accountReference;
            operation.status = 'PROVIDER_ACCOUNT_CREATED';
            await this.updateOperationState(db, operation.id, {
              status: 'PROVIDER_ACCOUNT_CREATED',
              provider_account_reference: reconciled.accountReference,
              last_error_code: null,
              last_error_message_sanitized: null,
            });
          } else {
            return {
              success: false,
              operationId: operation.id,
              status: 'REQUIRES_RECONCILIATION',
              errorCode: 'RECONCILIATION_REQUIRED',
              errorMessage: 'Operation outcome with provider remains unverified. Manual reconciliation required before re-attempting.',
            };
          }
        } else {
          return {
            success: false,
            operationId: operation.id,
            status: 'REQUIRES_RECONCILIATION',
            errorCode: 'RECONCILIATION_REQUIRED',
            errorMessage: 'Operation requires reconciliation before retry.',
          };
        }
      }

      // Step B: Create Provider Customer Subaccount (Non-Idempotent Call)
      if (operation.status === 'REQUESTED') {
        // Pre-dispatch TOCTOU check: verify control plane immediately before account creation wire call
        const { TelecomControlPlaneService } = await import('@/lib/telecom/controlPlane');
        const preDispatchEval = await TelecomControlPlaneService.evaluate(
          {
            organizationId,
            operation: 'PROVIDER_ACCOUNT_PROVISIONING',
            context: { stage: 'PRE_DISPATCH', provider, serviceScope, operationId: operation.id },
          },
          db
        );
        if (!preDispatchEval.allowed) {
          operation.status = 'FAILED';
          await this.updateOperationState(db, operation.id, {
            status: 'FAILED',
            last_error_code: preDispatchEval.reasonCode,
            last_error_message_sanitized: preDispatchEval.reason,
          });
          return {
            success: false,
            operationId: operation.id,
            status: 'FAILED',
            errorCode: preDispatchEval.reasonCode,
            errorMessage: `Pre-dispatch provisioning aborted by control plane: ${preDispatchEval.reason}`,
          };
        }

        try {
          const createResult = await adapter.createCustomerAccount({
            organizationId,
            organizationName,
            serviceScope,
            idempotencyKey,
          });

          // Invariant: Account SID must be a valid Twilio Subaccount SID starting with AC
          if (!createResult.accountReference || !createResult.accountReference.startsWith('AC')) {
            const err = new Error(`MALFORMED_SUBACCOUNT_SID: Subaccount reference '${createResult.accountReference}' must begin with AC.`);
            (err as any).code = 'MALFORMED_SUBACCOUNT_SID';
            throw err;
          }

          operation.providerAccountReference = createResult.accountReference;
          operation.status = 'PROVIDER_ACCOUNT_CREATED';
          await this.updateOperationState(db, operation.id, {
            status: 'PROVIDER_ACCOUNT_CREATED',
            provider_account_reference: createResult.accountReference,
          });
        } catch (provErr: any) {
          const errorInfo = classifyProviderError(provErr);
          const sanitized = this.sanitizeErrorMessage(provErr);

          if (errorInfo.isTimeout) {
            // CRITICAL INVARIANT: Never blindly retry create. Must enter REQUIRES_RECONCILIATION.
            operation.status = 'REQUIRES_RECONCILIATION';
            await this.updateOperationState(db, operation.id, {
              status: 'REQUIRES_RECONCILIATION',
              last_error_code: 'PROVIDER_CREATE_TIMEOUT',
              last_error_message_sanitized: sanitized.message,
            });

            return {
              success: false,
              operationId: operation.id,
              status: 'REQUIRES_RECONCILIATION',
              errorCode: 'PROVIDER_CREATE_TIMEOUT',
              errorMessage: 'Provider account creation timed out without acknowledgment. Operation flagged for reconciliation.',
            };
          } else {
            // Definite provider failure
            operation.status = 'FAILED';
            await this.updateOperationState(db, operation.id, {
              status: 'FAILED',
              last_error_code: sanitized.code,
              last_error_message_sanitized: sanitized.message,
            });

            return {
              success: false,
              operationId: operation.id,
              status: 'FAILED',
              errorCode: sanitized.code,
              errorMessage: sanitized.message,
            };
          }
        }
      }

      // Generate a deterministic provider account UUID for this operation if not set
      const providerAccountId = operation.providerAccountId || crypto.randomUUID();
      operation.providerAccountId = providerAccountId;

      // Step C: Create Runtime API Credential and Store in Vault (Purpose: RUNTIME_API)
      if (operation.status === 'PROVIDER_ACCOUNT_CREATED') {
        const runtimeCredRef = `vault:runtime:${providerAccountId}`;
        let runtimeResult;
        try {
          runtimeResult = await adapter.createRuntimeCredential({
            accountReference: operation.providerAccountReference!,
            organizationId,
          });

          // Invariant: Resource Account Binding check
          if (runtimeResult.accountSid && runtimeResult.accountSid !== operation.providerAccountReference) {
            const err = new Error(
              `CROSS_ACCOUNT_RESOURCE_MISMATCH: API Key belongs to account '${runtimeResult.accountSid}', expected '${operation.providerAccountReference}'.`
            );
            (err as any).code = 'CROSS_ACCOUNT_RESOURCE_MISMATCH';
            throw err;
          }
        } catch (credErr: any) {
          const errorInfo = classifyProviderError(credErr);
          const sanitized = this.sanitizeErrorMessage(credErr);

          if (errorInfo.isTimeout) {
            // CRITICAL: Unknown provider outcome -> REQUIRES_RECONCILIATION. Zero delete, zero recreate.
            operation.status = 'REQUIRES_RECONCILIATION';
            operation.lastErrorCode = 'RUNTIME_CREDENTIAL_TIMEOUT';
            await this.updateOperationState(db, operation.id, {
              status: 'REQUIRES_RECONCILIATION',
              last_error_code: 'RUNTIME_CREDENTIAL_TIMEOUT',
              last_error_message_sanitized: sanitized.message,
            });
            return {
              success: false,
              operationId: operation.id,
              status: 'REQUIRES_RECONCILIATION',
              errorCode: 'RUNTIME_CREDENTIAL_TIMEOUT',
              errorMessage: 'Runtime credential creation timed out with unknown provider outcome. Operation marked for reconciliation. No second key create or automatic deletion.',
            };
          }

          await this.updateOperationState(db, operation.id, {
            last_error_code: sanitized.code,
            last_error_message_sanitized: sanitized.message,
          });
          return {
            success: false,
            operationId: operation.id,
            status: operation.status,
            errorCode: sanitized.code,
            errorMessage: sanitized.message,
          };
        }

        // Store secret immediately in TelecomSecretVault
        try {
          await vault.storeSecret({
            referenceId: runtimeCredRef,
            secret: runtimeResult.secret,
            provider,
            providerAccountId,
            purpose: 'RUNTIME_API',
            keyIdentifier: runtimeResult.keyIdentifier,
            accountReference: operation.providerAccountReference!,
            metadata: {
              organizationId,
              operationId: operation.id,
            },
          });
        } catch (vaultErr: any) {
          // Vault storage failed after provider credential was created.
          // CRITICAL RECOVERY POLICY:
          // NO AUTOMATIC KEY DELETION. NO AUTOMATIC KEY RECREATION.
          // Save safe known key identifier only (NO secret) and mark REQUIRES_RECONCILIATION.
          const sanitized = this.sanitizeErrorMessage(vaultErr);
          operation.status = 'REQUIRES_RECONCILIATION';
          operation.runtimeKeyIdentifier = runtimeResult.keyIdentifier;
          operation.lastErrorCode = 'VAULT_STORAGE_FAILED';
          await this.updateOperationState(db, operation.id, {
            status: 'REQUIRES_RECONCILIATION',
            runtime_key_identifier: runtimeResult.keyIdentifier,
            last_error_code: 'VAULT_STORAGE_FAILED',
            last_error_message_sanitized: sanitized.message,
          });
          return {
            success: false,
            operationId: operation.id,
            status: 'REQUIRES_RECONCILIATION',
            errorCode: 'VAULT_STORAGE_FAILED',
            errorMessage: 'API Key created on provider but secret lost before vault storage. Marked for manual reconciliation. No automatic key deletion or recreation.',
          };
        }

        operation.runtimeCredentialReference = runtimeCredRef;
        operation.runtimeKeyIdentifier = runtimeResult.keyIdentifier;
        operation.status = 'RUNTIME_CREDENTIAL_CREATED';
        await this.updateOperationState(db, operation.id, {
          status: 'RUNTIME_CREDENTIAL_CREATED',
          runtime_credential_reference: runtimeCredRef,
          runtime_key_identifier: runtimeResult.keyIdentifier,
          provider_account_id: providerAccountId,
        });
      }

      // Step D: Capture Webhook Verification Credential and Store in Vault (Purpose: WEBHOOK_VERIFICATION)
      if (operation.status === 'RUNTIME_CREDENTIAL_CREATED') {
        const webhookCredRef = `vault:webhook:${providerAccountId}`;
        let webhookResult;
        try {
          webhookResult = await adapter.resolveOrBootstrapWebhookCredential({
            accountReference: operation.providerAccountReference!,
            organizationId,
          });

          // Invariant: Resource Account Binding check
          if (webhookResult.accountSid && webhookResult.accountSid !== operation.providerAccountReference) {
            throw new Error(
              `CROSS_ACCOUNT_RESOURCE_MISMATCH: Webhook credential belongs to account '${webhookResult.accountSid}', expected '${operation.providerAccountReference}'.`
            );
          }
        } catch (whErr: any) {
          const sanitized = this.sanitizeErrorMessage(whErr);
          await this.updateOperationState(db, operation.id, {
            last_error_code: sanitized.code,
            last_error_message_sanitized: sanitized.message,
          });
          return {
            success: false,
            operationId: operation.id,
            status: operation.status,
            errorCode: sanitized.code,
            errorMessage: sanitized.message,
          };
        }

        // Store webhook secret in TelecomSecretVault
        try {
          await vault.storeSecret({
            referenceId: webhookCredRef,
            secret: webhookResult.webhookSecret,
            provider,
            providerAccountId,
            purpose: 'WEBHOOK_VERIFICATION',
            accountReference: operation.providerAccountReference!,
            metadata: {
              organizationId,
              operationId: operation.id,
            },
          });
        } catch (vaultErr: any) {
          const sanitized = this.sanitizeErrorMessage(vaultErr);
          await this.updateOperationState(db, operation.id, {
            last_error_code: 'VAULT_STORAGE_FAILED',
            last_error_message_sanitized: sanitized.message,
          });
          return {
            success: false,
            operationId: operation.id,
            status: operation.status,
            errorCode: 'VAULT_STORAGE_FAILED',
            errorMessage: 'Failed to store webhook verification secret in vault.',
          };
        }

        operation.webhookCredentialReference = webhookCredRef;
        operation.status = 'WEBHOOK_CREDENTIAL_CAPTURED';
        await this.updateOperationState(db, operation.id, {
          status: 'WEBHOOK_CREDENTIAL_CAPTURED',
          webhook_credential_reference: webhookCredRef,
        });
      }

      // Step E: Create Dedicated WebRTC Key + Dedicated TwiML App and Store Material
      if (operation.status === 'WEBHOOK_CREDENTIAL_CAPTURED') {
        const webrtcCredRef = `vault:webrtc:${providerAccountId}`;
        let webrtcResult;

        // 1. WebRTC Token Signing Credential
        try {
          if (!adapter.createWebRtcCredential) {
            throw new Error('CAPABILITY_UNSUPPORTED: Adapter does not support WebRTC credential creation.');
          }

          webrtcResult = await adapter.createWebRtcCredential({
            accountReference: operation.providerAccountReference!,
            organizationId,
          });

          // Invariant: Resource Account Binding check
          if (webrtcResult.accountSid && webrtcResult.accountSid !== operation.providerAccountReference) {
            throw new Error(
              `CROSS_ACCOUNT_RESOURCE_MISMATCH: WebRTC Key belongs to account '${webrtcResult.accountSid}', expected '${operation.providerAccountReference}'.`
            );
          }
        } catch (webrtcErr: any) {
          const errorInfo = classifyProviderError(webrtcErr);
          const sanitized = this.sanitizeErrorMessage(webrtcErr);

          if (errorInfo.isTimeout) {
            operation.status = 'REQUIRES_RECONCILIATION';
            operation.lastErrorCode = 'WEBRTC_CREDENTIAL_TIMEOUT';
            await this.updateOperationState(db, operation.id, {
              status: 'REQUIRES_RECONCILIATION',
              last_error_code: 'WEBRTC_CREDENTIAL_TIMEOUT',
              last_error_message_sanitized: sanitized.message,
            });
            return {
              success: false,
              operationId: operation.id,
              status: 'REQUIRES_RECONCILIATION',
              errorCode: 'WEBRTC_CREDENTIAL_TIMEOUT',
              errorMessage: 'WebRTC credential creation timed out with unknown provider outcome. Operation marked for reconciliation.',
            };
          }

          await this.updateOperationState(db, operation.id, {
            last_error_code: sanitized.code,
            last_error_message_sanitized: sanitized.message,
          });
          return {
            success: false,
            operationId: operation.id,
            status: operation.status,
            errorCode: sanitized.code,
            errorMessage: sanitized.message,
          };
        }

        // Store WebRTC signing secret in vault (Purpose: WEBRTC_TOKEN_SIGNING)
        try {
          await vault.storeSecret({
            referenceId: webrtcCredRef,
            secret: webrtcResult.secret,
            provider,
            providerAccountId,
            purpose: 'WEBRTC_TOKEN_SIGNING',
            keyIdentifier: webrtcResult.keyIdentifier,
            accountReference: operation.providerAccountReference!,
            metadata: {
              organizationId,
              operationId: operation.id,
            },
          });
        } catch (vaultErr: any) {
          const sanitized = this.sanitizeErrorMessage(vaultErr);
          operation.status = 'REQUIRES_RECONCILIATION';
          operation.lastErrorCode = 'VAULT_STORAGE_FAILED';
          await this.updateOperationState(db, operation.id, {
            status: 'REQUIRES_RECONCILIATION',
            last_error_code: 'VAULT_STORAGE_FAILED',
            last_error_message_sanitized: sanitized.message,
            metadata: {
              ...(operation.metadata || {}),
              webrtcKeyIdentifier: webrtcResult.keyIdentifier,
            },
          });
          return {
            success: false,
            operationId: operation.id,
            status: 'REQUIRES_RECONCILIATION',
            errorCode: 'VAULT_STORAGE_FAILED',
            errorMessage: 'WebRTC API Key created on provider but secret lost before vault storage. Marked for manual reconciliation. No automatic key deletion or recreation.',
          };
        }

        // 2. Dedicated TwiML App
        let twimlResult;
        try {
          if (!adapter.createTwimlApp) {
            throw new Error('CAPABILITY_UNSUPPORTED: Adapter does not support TwiML App creation.');
          }

          twimlResult = await adapter.createTwimlApp({
            accountReference: operation.providerAccountReference!,
            organizationId,
          });

          // Invariant: Resource Account Binding check
          if (twimlResult.accountSid && twimlResult.accountSid !== operation.providerAccountReference) {
            const err = new Error(
              `CROSS_ACCOUNT_RESOURCE_MISMATCH: TwiML App belongs to account '${twimlResult.accountSid}', expected '${operation.providerAccountReference}'.`
            );
            (err as any).code = 'CROSS_ACCOUNT_RESOURCE_MISMATCH';
            throw err;
          }

          if (!twimlResult.appSid || !twimlResult.appSid.startsWith('AP')) {
            const err = new Error(`MALFORMED_TWIML_APP_SID: TwiML App SID '${twimlResult.appSid}' must begin with AP.`);
            (err as any).code = 'MALFORMED_TWIML_APP_SID';
            throw err;
          }
        } catch (twimlErr: any) {
          const errorInfo = classifyProviderError(twimlErr);
          const sanitized = this.sanitizeErrorMessage(twimlErr);

          if (errorInfo.isTimeout) {
            operation.status = 'REQUIRES_RECONCILIATION';
            operation.lastErrorCode = 'TWIML_APP_TIMEOUT';
            await this.updateOperationState(db, operation.id, {
              status: 'REQUIRES_RECONCILIATION',
              last_error_code: 'TWIML_APP_TIMEOUT',
              last_error_message_sanitized: sanitized.message,
            });
            return {
              success: false,
              operationId: operation.id,
              status: 'REQUIRES_RECONCILIATION',
              errorCode: 'TWIML_APP_TIMEOUT',
              errorMessage: 'TwiML App creation timed out with unknown provider outcome. Operation marked for reconciliation.',
            };
          }

          // Compensation check: if compensation fails, flag reconciliation
          await this.compensatePartialFailure(adapter, operation.providerAccountReference);

          await this.updateOperationState(db, operation.id, {
            last_error_code: sanitized.code,
            last_error_message_sanitized: sanitized.message,
          });
          return {
            success: false,
            operationId: operation.id,
            status: operation.status,
            errorCode: sanitized.code,
            errorMessage: sanitized.message,
          };
        }

        // Store all material in operation metadata and advance to SECRETS_STORED
        operation.metadata = {
          ...(operation.metadata || {}),
          webrtcCredentialReference: webrtcCredRef,
          webrtcKeyIdentifier: webrtcResult.keyIdentifier,
          twimlAppSid: twimlResult.appSid,
          twimlAppAccountSid: twimlResult.accountSid,
        };
        operation.status = 'SECRETS_STORED';
        await this.updateOperationState(db, operation.id, {
          status: 'SECRETS_STORED',
          metadata: operation.metadata,
        });
      }

      // Step F: Persist Local Provider Account in telecom_provider_accounts (Initially 'suspended')
      if (operation.status === 'SECRETS_STORED') {
        const { data: existingAcct } = await (db as any)
          .from('telecom_provider_accounts')
          .select('id')
          .eq('account_reference', operation.providerAccountReference!)
          .maybeSingle();

        if (!existingAcct) {
          const newAccountRow = {
            id: providerAccountId,
            provider,
            account_type: 'CUSTOMER_SUBACCOUNT',
            account_reference: operation.providerAccountReference!,
            credential_reference: operation.runtimeCredentialReference!,
            status: 'suspended', // Suspended until final activation gate passes!
            capabilities: [serviceScope],
            environment: 'production',
            metadata: {
              organizationId,
              webhookCredentialReference: operation.webhookCredentialReference,
              webrtcCredentialReference: operation.metadata?.webrtcCredentialReference,
              webrtcKeyIdentifier: operation.metadata?.webrtcKeyIdentifier,
              twimlAppSid: operation.metadata?.twimlAppSid,
              twiml_app_sid: operation.metadata?.twimlAppSid,
              twiml_app_account_sid: operation.metadata?.twimlAppAccountSid,
              provisioningOperationId: operation.id,
            },
          };

          const { error: acctErr } = await (db as any)
            .from('telecom_provider_accounts')
            .insert(newAccountRow);

          if (acctErr) {
            const { data: racedAcct } = await (db as any)
              .from('telecom_provider_accounts')
              .select('id')
              .eq('account_reference', operation.providerAccountReference!)
              .maybeSingle();

            if (!racedAcct) {
              const sanitized = this.sanitizeErrorMessage(acctErr);
              await this.updateOperationState(db, operation.id, {
                last_error_code: 'DB_ACCOUNT_INSERT_FAILED',
                last_error_message_sanitized: sanitized.message,
              });
              return {
                success: false,
                operationId: operation.id,
                status: operation.status,
                errorCode: 'DB_ACCOUNT_INSERT_FAILED',
                errorMessage: sanitized.message,
              };
            }
          }
        }

        operation.status = 'LOCAL_ACCOUNT_RECORDED';
        await this.updateOperationState(db, operation.id, {
          status: 'LOCAL_ACCOUNT_RECORDED',
          provider_account_id: providerAccountId,
        });
      }

      // Step G: Create Organization Provider Assignment (Initially is_active: false)
      if (operation.status === 'LOCAL_ACCOUNT_RECORDED') {
        let assignmentId = operation.assignmentId;

        if (!assignmentId) {
          const { data: existingAssign } = await (db as any)
            .from('telecom_organization_provider_assignments')
            .select('id')
            .eq('organization_id', organizationId)
            .eq('provider_account_id', providerAccountId)
            .maybeSingle();

          if (existingAssign) {
            assignmentId = existingAssign.id;
          } else {
            const newAssignmentRow = {
              organization_id: organizationId,
              provider_account_id: providerAccountId,
              service_scope: serviceScope,
              priority: 10,
              is_active: false, // Inactive until activation gate passes!
              metadata: {
                provisioningOperationId: operation.id,
              },
            };

            const { data: insertedAssign, error: assignErr } = await (db as any)
              .from('telecom_organization_provider_assignments')
              .insert(newAssignmentRow)
              .select('id')
              .single();

            if (assignErr) {
              const { data: racedAssign } = await (db as any)
                .from('telecom_organization_provider_assignments')
                .select('id')
                .eq('organization_id', organizationId)
                .eq('provider_account_id', providerAccountId)
                .maybeSingle();

              if (!racedAssign) {
                const sanitized = this.sanitizeErrorMessage(assignErr);
                await this.updateOperationState(db, operation.id, {
                  last_error_code: 'DB_ASSIGNMENT_INSERT_FAILED',
                  last_error_message_sanitized: sanitized.message,
                });
                return {
                  success: false,
                  operationId: operation.id,
                  status: operation.status,
                  errorCode: 'DB_ASSIGNMENT_INSERT_FAILED',
                  errorMessage: sanitized.message,
                };
              }
              assignmentId = racedAssign.id;
            } else {
              assignmentId = insertedAssign.id;
            }
          }
        }

        operation.assignmentId = assignmentId;
        operation.status = 'ASSIGNMENT_CREATED';
        await this.updateOperationState(db, operation.id, {
          status: 'ASSIGNMENT_CREATED',
          assignment_id: assignmentId,
        });
      }

      // Step H: Final 6-Point Activation Gate (Section 12: Activation Rule)
      if (operation.status === 'ASSIGNMENT_CREATED') {
        // 1. Verify provider account row exists in DB
        const { data: checkAccount } = await (db as any)
          .from('telecom_provider_accounts')
          .select('*')
          .eq('id', providerAccountId)
          .maybeSingle();

        if (!checkAccount) {
          throw new Error('ACTIVATION_GATE_FAILED: Provider account DB record missing.');
        }

        // 2. Verify Runtime Credential exists in vault with purpose RUNTIME_API
        const runtimeSecret = await vault.getSecret(operation.runtimeCredentialReference!);
        if (!runtimeSecret) {
          throw new Error('ACTIVATION_GATE_FAILED: Runtime API credential missing from secret vault.');
        }
        if (runtimeSecret.metadata.purpose !== 'RUNTIME_API') {
          throw new Error(`ACTIVATION_GATE_FAILED: Runtime credential has invalid purpose '${runtimeSecret.metadata.purpose}'.`);
        }
        if (runtimeSecret.metadata.providerAccountId !== providerAccountId) {
          throw new Error('ACTIVATION_GATE_FAILED: Runtime credential ownership mismatch.');
        }

        // 3. Verify Webhook Verification Credential exists in vault with purpose WEBHOOK_VERIFICATION
        const webhookSecret = await vault.getSecret(operation.webhookCredentialReference!);
        if (!webhookSecret) {
          throw new Error('ACTIVATION_GATE_FAILED: Webhook verification credential missing from secret vault.');
        }
        if (webhookSecret.metadata.purpose !== 'WEBHOOK_VERIFICATION') {
          throw new Error(`ACTIVATION_GATE_FAILED: Webhook credential has invalid purpose '${webhookSecret.metadata.purpose}'.`);
        }
        if (webhookSecret.metadata.providerAccountId !== providerAccountId) {
          throw new Error('ACTIVATION_GATE_FAILED: Webhook credential ownership mismatch.');
        }

        // 4. Verify WebRTC Credential exists in vault with purpose WEBRTC_TOKEN_SIGNING
        const webrtcRef = operation.metadata?.webrtcCredentialReference as string | undefined;
        if (!webrtcRef) {
          throw new Error('ACTIVATION_GATE_FAILED: WebRTC credential reference missing from operation metadata.');
        }
        const webrtcSecret = await vault.getSecret(webrtcRef);
        if (!webrtcSecret) {
          throw new Error('ACTIVATION_GATE_FAILED: WebRTC signing credential missing from secret vault.');
        }
        if (webrtcSecret.metadata.purpose !== 'WEBRTC_TOKEN_SIGNING') {
          throw new Error(`ACTIVATION_GATE_FAILED: WebRTC credential has invalid purpose '${webrtcSecret.metadata.purpose}'.`);
        }
        if (webrtcSecret.metadata.providerAccountId !== providerAccountId) {
          throw new Error('ACTIVATION_GATE_FAILED: WebRTC credential ownership mismatch.');
        }

        // 5. Verify TwiML App Metadata
        const twimlAppSid = operation.metadata?.twimlAppSid as string | undefined;
        if (!twimlAppSid || !twimlAppSid.startsWith('AP')) {
          throw new Error(`ACTIVATION_GATE_FAILED: Invalid or missing TwiML App SID '${twimlAppSid}'.`);
        }
        const twimlAppAccountSid = operation.metadata?.twimlAppAccountSid as string | undefined;
        if (twimlAppAccountSid && twimlAppAccountSid !== operation.providerAccountReference) {
          throw new Error('ACTIVATION_GATE_FAILED: TwiML App account SID mismatch.');
        }

        // 6. Verify organization assignment exists
        const { data: checkAssign } = await (db as any)
          .from('telecom_organization_provider_assignments')
          .select('*')
          .eq('id', operation.assignmentId!)
          .maybeSingle();

        if (!checkAssign || checkAssign.organization_id !== organizationId) {
          throw new Error('ACTIVATION_GATE_FAILED: Organization assignment missing or organization mismatch.');
        }

        // ALL CHECKS PASSED: ACTIVATE!
        await (db as any)
          .from('telecom_provider_accounts')
          .update({ status: 'active', updated_at: new Date().toISOString() })
          .eq('id', providerAccountId);

        await (db as any)
          .from('telecom_organization_provider_assignments')
          .update({ is_active: true, updated_at: new Date().toISOString() })
          .eq('id', operation.assignmentId!);

        operation.status = 'READY';
        await this.updateOperationState(db, operation.id, {
          status: 'READY',
          last_error_code: null,
          last_error_message_sanitized: null,
        });

        return {
          success: true,
          operationId: operation.id,
          status: 'READY',
          providerAccountId,
          accountReference: operation.providerAccountReference!,
          assignmentId: operation.assignmentId!,
          isExistingAccountReused: false,
        };
      }

      return {
        success: false,
        operationId: operation.id,
        status: operation.status,
        errorCode: 'UNHANDLED_STATE',
        errorMessage: `Operation remains in unhandled state ${operation.status}.`,
      };
    } catch (sagaErr: any) {
      const sanitized = this.sanitizeErrorMessage(sagaErr);
      await this.updateOperationState(db, operation.id, {
        last_error_code: sanitized.code,
        last_error_message_sanitized: sanitized.message,
      });

      return {
        success: false,
        operationId: operation.id,
        status: operation.status,
        errorCode: sanitized.code,
        errorMessage: sanitized.message,
      };
    }
  }

  private static mapOperationRecord(row: any): ProvisioningOperationRecord {
    return {
      id: row.id,
      organizationId: row.organization_id,
      provider: row.provider,
      serviceScope: row.service_scope,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      providerAccountReference: row.provider_account_reference,
      runtimeCredentialReference: row.runtime_credential_reference,
      runtimeKeyIdentifier: row.runtime_key_identifier,
      webhookCredentialReference: row.webhook_credential_reference,
      providerAccountId: row.provider_account_id,
      assignmentId: row.assignment_id,
      attemptCount: row.attempt_count || 1,
      lastErrorCode: row.last_error_code,
      lastErrorMessageSanitized: row.last_error_message_sanitized,
      metadata: row.metadata || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private static async updateOperationState(
    db: any,
    operationId: string,
    updates: Record<string, any>
  ): Promise<void> {
    try {
      await db
        .from('telecom_account_provisioning_operations')
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq('id', operationId);
    } catch (err: any) {
      console.warn('[TelecomProviderAccountProvisioningService] Error updating operation record:', err?.message);
    }
  }
}
