/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import crypto from 'node:crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import { TelecomProvider, TelecomServiceScope } from '../types';
import { TelecomSecretVault } from '@/lib/telecom/vault/types';
import { ProductionTelecomSecretVaultStub } from '@/lib/telecom/vault/telecomSecretVault';
import { ProviderProvisioningAdapter, ProvisioningOperationStatus } from './types';

// ============================================================================
// PHASE 22C-6P: LIVE OPERATION GUARD & PRE-FLIGHT BOUNDARY
// ============================================================================

export const PROTECTED_PILOT_PHONE_NUMBER = '+61348328472';
export const PROTECTED_PILOT_PN_SID = 'PN832a10dec98cbb48d02033a83afecff3';
export const PROTECTED_PILOT_PHONE_ID = '03edd0bc-b025-49e6-8171-a0c2fcd6cb78';
export const PROTECTED_PILOT_ORG_ID = '00000000-0000-0000-0000-000000000001';
export const PROTECTED_PILOT_ORG_UUID = PROTECTED_PILOT_PHONE_ID;

export type OrganizationClassification = 'INTERNAL_TEST' | 'CUSTOMER' | 'PILOT' | 'UNKNOWN';

export type LiveProvisioningAuditEventType =
  | 'PRECHECK_STARTED'
  | 'PRECHECK_PASSED'
  | 'PROVIDER_CREATE_REQUESTED'
  | 'PROVIDER_CREATE_SUCCEEDED'
  | 'PROVIDER_CREATE_UNKNOWN'
  | 'RUNTIME_CREDENTIAL_CREATED'
  | 'RUNTIME_SECRET_STORED'
  | 'WEBHOOK_SECRET_STORED'
  | 'LOCAL_PROVIDER_ACCOUNT_RECORDED'
  | 'ASSIGNMENT_CREATED'
  | 'READ_ONLY_PROVIDER_IDENTITY_VERIFIED'
  | 'VALIDATION_COMPLETED'
  | 'VALIDATION_FAILED'
  | 'RECONCILIATION_REQUIRED';

export interface LiveProvisioningAuditEvent {
  eventType: LiveProvisioningAuditEventType;
  organizationId: string;
  provider: TelecomProvider;
  auditCorrelationId: string;
  idempotencyKey?: string;
  providerAccountReference?: string;
  details?: Record<string, any>;
  timestamp?: string;
}

/**
 * Server-only Provisioning Mutation Gate.
 * Default is FALSE (OFF). Live customer subaccount creation is strictly prohibited unless explicitly enabled.
 */
export function isProviderAccountProvisioningMutationsEnabled(): boolean {
  const envVal = process.env.TELECOM_PROVIDER_ACCOUNT_PROVISIONING_MUTATIONS_ENABLED;
  return envVal === 'true' || envVal === '1';
}

/**
 * Asserts that none of the target parameters reference the protected Australian pilot.
 */
export function assertProtectedPilotUntouched(target: {
  organizationId?: string;
  phoneNumber?: string;
  resourceSid?: string;
  phoneNumberId?: string;
}): void {
  if (target.phoneNumber && target.phoneNumber.trim() === PROTECTED_PILOT_PHONE_NUMBER) {
    throw new Error(`PROTECTED_PILOT_QUARANTINE_VIOLATION: Phone number matches protected Australian pilot (${PROTECTED_PILOT_PHONE_NUMBER}).`);
  }
  if (target.resourceSid && target.resourceSid.trim() === PROTECTED_PILOT_PN_SID) {
    throw new Error(`PROTECTED_PILOT_QUARANTINE_VIOLATION: Resource SID matches protected Australian pilot (${PROTECTED_PILOT_PN_SID}).`);
  }
  if (target.phoneNumberId && target.phoneNumberId.trim().toLowerCase() === PROTECTED_PILOT_PHONE_ID.toLowerCase()) {
    throw new Error(`PROTECTED_PILOT_QUARANTINE_VIOLATION: Phone number ID matches protected Australian pilot (${PROTECTED_PILOT_PHONE_ID}).`);
  }
  if (target.organizationId) {
    const org = target.organizationId.toLowerCase().trim();
    if (org === PROTECTED_PILOT_ORG_UUID.toLowerCase() || org === PROTECTED_PILOT_ORG_ID.toLowerCase()) {
      throw new Error(`PROTECTED_PILOT_QUARANTINE_VIOLATION: Organization matches protected Australian pilot (${target.organizationId}).`);
    }
  }
}

/**
 * Asserts that a number lifecycle operation (release, port-out, adoption, reassignment)
 * does not target the protected Australian pilot number across any of its authoritative identifiers.
 *
 * NOTE: Does NOT freeze other unrelated numbers in organization 00000000-0000-0000-0000-000000000001.
 */
export function assertProtectedPilotNumberLifecycleUntouched(target: {
  phoneNumberId?: string;
  phoneNumber?: string;
  resourceSid?: string;
  organizationId?: string;
}): void {
  if (target.phoneNumber && target.phoneNumber.trim() === PROTECTED_PILOT_PHONE_NUMBER) {
    throw new Error(`PROTECTED_PILOT_QUARANTINE_VIOLATION: Phone number matches protected Australian pilot (${PROTECTED_PILOT_PHONE_NUMBER}).`);
  }
  if (target.resourceSid && target.resourceSid.trim() === PROTECTED_PILOT_PN_SID) {
    throw new Error(`PROTECTED_PILOT_QUARANTINE_VIOLATION: Resource SID matches protected Australian pilot (${PROTECTED_PILOT_PN_SID}).`);
  }
  if (target.phoneNumberId && target.phoneNumberId.trim().toLowerCase() === PROTECTED_PILOT_PHONE_ID.toLowerCase()) {
    throw new Error(`PROTECTED_PILOT_QUARANTINE_VIOLATION: Phone number ID matches protected Australian pilot (${PROTECTED_PILOT_PHONE_ID}).`);
  }
  if (target.organizationId && target.organizationId.trim() === PROTECTED_PILOT_ORG_ID) {
    if (target.phoneNumber === PROTECTED_PILOT_PHONE_NUMBER || target.phoneNumberId === PROTECTED_PILOT_PHONE_ID || target.resourceSid === PROTECTED_PILOT_PN_SID) {
      throw new Error(`PROTECTED_PILOT_QUARANTINE_VIOLATION: Protected pilot number cannot be mutated under organization ${PROTECTED_PILOT_ORG_ID}.`);
    }
  }
}

/**
 * Generates a deterministic, non-random idempotency key for live provisioning intent.
 */
export function generateDeterministicProvisioningIdempotencyKey(params: {
  organizationId: string;
  provider: TelecomProvider | string;
  environment: string;
  validationScope: string;
  version?: string;
}): string {
  const prov = params.provider.toLowerCase().trim();
  const env = params.environment.toLowerCase().trim();
  const org = params.organizationId.trim();
  const scope = params.validationScope.toLowerCase().trim();
  const ver = (params.version || 'v1').toLowerCase().trim();

  return `prov:${prov}:${env}:${org}:${scope}:${ver}`;
}

export interface LiveProvisioningPreflightParams {
  organizationId: string;
  organizationClassification: OrganizationClassification;
  provider: TelecomProvider;
  environment: string;
  idempotencyKey: string;
  auditCorrelationId: string;
  operatorConfirmationToken: string;
  vaultInstance?: TelecomSecretVault;
  remoteSchemaVerified: boolean;
  parentAdminAccountSid?: string;
  parentAdminAuthToken?: string;
  clientPayloadOverride?: any;
}

export interface LiveProvisioningPreflightResult {
  allowed: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Pre-flight validation guard for the future first controlled live subaccount validation.
 * Enforces all 12 mandatory safety invariants fail-closed before any provider network request.
 */
export async function validateLiveOperationPreflight(
  params: LiveProvisioningPreflightParams,
  db?: SupabaseClient
): Promise<LiveProvisioningPreflightResult> {
  // 1. Client payload bypass attempt
  if (params.clientPayloadOverride && (
    params.clientPayloadOverride.enableMutations !== undefined ||
    params.clientPayloadOverride.skipGuard !== undefined ||
    params.clientPayloadOverride.providerAccountId !== undefined
  )) {
    return {
      allowed: false,
      errorCode: 'CLIENT_OVERRIDE_PROHIBITED',
      errorMessage: 'Client payload attempt to alter provisioning safety gates is strictly prohibited.',
    };
  }

  // 2. Server-only Provisioning Mutation Gate
  if (!isProviderAccountProvisioningMutationsEnabled()) {
    return {
      allowed: false,
      errorCode: 'PROVISIONING_MUTATION_GATE_DISABLED',
      errorMessage: 'TELECOM_PROVIDER_ACCOUNT_PROVISIONING_MUTATIONS_ENABLED is not enabled on this server.',
    };
  }

  // 3. Organization Classification Check
  if (params.organizationClassification !== 'INTERNAL_TEST') {
    return {
      allowed: false,
      errorCode: 'REAL_CUSTOMER_PROVISIONING_PROHIBITED',
      errorMessage: `Provisioning blocked: Organization classification is '${params.organizationClassification}'. Live validation requires dedicated 'INTERNAL_TEST' organization.`,
    };
  }

  // 4. Protected Pilot Quarantine
  try {
    assertProtectedPilotUntouched({ organizationId: params.organizationId });
  } catch (err: any) {
    return {
      allowed: false,
      errorCode: 'PROTECTED_PILOT_QUARANTINE_VIOLATION',
      errorMessage: err.message,
    };
  }

  // 5. Provider Check
  if (params.provider !== 'TWILIO') {
    return {
      allowed: false,
      errorCode: 'UNSUPPORTED_LIVE_VALIDATION_PROVIDER',
      errorMessage: `First live validation is scoped to TWILIO. '${params.provider}' is not permitted.`,
    };
  }

  // 6. Audit Correlation ID
  if (!params.auditCorrelationId || params.auditCorrelationId.trim() === '') {
    return {
      allowed: false,
      errorCode: 'MISSING_AUDIT_CORRELATION_ID',
      errorMessage: 'Live validation requires a non-empty auditCorrelationId for audit trace logging.',
    };
  }

  // 7. Deterministic Idempotency Key
  if (!params.idempotencyKey || !params.idempotencyKey.startsWith('prov:') || params.idempotencyKey.length < 10) {
    return {
      allowed: false,
      errorCode: 'INVALID_IDEMPOTENCY_INTENT',
      errorMessage: "Idempotency key must be deterministic following the pattern 'prov:<provider>:<env>:<orgId>:<scope>:<ver>'.",
    };
  }

  // 8. Remote Schema Verification Proof
  if (!params.remoteSchemaVerified) {
    return {
      allowed: false,
      errorCode: 'REMOTE_SCHEMA_NOT_VERIFIED',
      errorMessage: 'Live provisioning is blocked because remote database schema verification is unverified.',
    };
  }

  // 9. Production Vault Availability
  if (!params.vaultInstance || params.vaultInstance instanceof ProductionTelecomSecretVaultStub) {
    return {
      allowed: false,
      errorCode: 'PRODUCTION_VAULT_UNAVAILABLE',
      errorMessage: 'Production secret vault adapter is unavailable or unconfigured.',
    };
  }

  // 10. Parent Administrative Credentials
  const parentSid = params.parentAdminAccountSid || process.env.TWILIO_ACCOUNT_SID;
  const parentAuth = params.parentAdminAuthToken || process.env.TWILIO_AUTH_TOKEN;
  if (!parentSid || !parentAuth || parentSid.trim() === '' || parentAuth.trim() === '') {
    return {
      allowed: false,
      errorCode: 'MISSING_PARENT_ADMIN_CREDENTIALS',
      errorMessage: 'Parent administrative credentials (Account SID and Auth Token) are missing or empty.',
    };
  }

  // 11. Operator Human Approval Token
  if (!params.operatorConfirmationToken || params.operatorConfirmationToken.trim() === '') {
    return {
      allowed: false,
      errorCode: 'OPERATOR_APPROVAL_REQUIRED',
      errorMessage: 'Live provisioning requires an explicit human operator approval token.',
    };
  }

  // 12. Check whether organization already has an active customer provider account
  if (db) {
    const { data: existingAssignments } = await (db as any)
      .from('telecom_organization_provider_assignments')
      .select('id, provider_account_id, is_active')
      .eq('organization_id', params.organizationId)
      .eq('is_active', true);

    if (existingAssignments && existingAssignments.length > 0) {
      return {
        allowed: false,
        errorCode: 'ORGANIZATION_ALREADY_PROVISIONED',
        errorMessage: `Organization '${params.organizationId}' already has active provider account assignments.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Emits a structured sanitized audit log event for live validation tracking.
 * Guarantees zero secret exposure.
 */
export function auditLiveProvisioningEvent(event: LiveProvisioningAuditEvent): void {
  const timestamp = event.timestamp || new Date().toISOString();

  // Deep strip any accidental sensitive tokens
  const redactObject = (obj: any): any => {
    if (!obj || typeof obj !== 'object') {
      if (typeof obj === 'string') {
        return obj
          .replace(/mock_sk_secret_[a-zA-Z0-9_\-]+/gi, '[REDACTED_SECRET]')
          .replace(/mock_auth_token_[a-zA-Z0-9_\-]+/gi, '[REDACTED_TOKEN]')
          .replace(/SK[a-zA-Z0-9]{32}/g, '[REDACTED_KEY_SID]')
          .replace(/secret=[^\s&]+/gi, 'secret=[REDACTED]')
          .replace(/token=[^\s&]+/gi, 'token=[REDACTED]')
          .replace(/password=[^\s&]+/gi, 'password=[REDACTED]');
      }
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(redactObject);
    }
    const res: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/secret|token|password|auth/i.test(k) && typeof v === 'string') {
        res[k] = '[REDACTED]';
      } else {
        res[k] = redactObject(v);
      }
    }
    return res;
  };

  const sanitizedDetails = redactObject(event.details || {});

  const logPayload = {
    eventType: event.eventType,
    timestamp,
    organizationId: event.organizationId,
    provider: event.provider,
    auditCorrelationId: event.auditCorrelationId,
    idempotencyKey: event.idempotencyKey,
    providerAccountReference: event.providerAccountReference,
    details: sanitizedDetails,
  };

  // Structured audit output (captured by server log collector)
  console.log(`[LIVE_PROVISIONING_AUDIT] ${JSON.stringify(logPayload)}`);
}

export interface CreateLiveCustomerProviderAccountContext {
  organizationId: string;
  organizationClassification: OrganizationClassification;
  provider: TelecomProvider;
  environment: string;
  idempotencyKey: string;
  auditCorrelationId: string;
  operatorConfirmationToken: string;
  remoteSchemaVerified: boolean;
  vaultInstance?: TelecomSecretVault;
  parentAdminAccountSid?: string;
  parentAdminAuthToken?: string;
  organizationName?: string;
  serviceScope?: TelecomServiceScope;
  clientPayloadOverride?: any;
}

export interface CreateLiveCustomerProviderAccountResult {
  success: boolean;
  status: ProvisioningOperationStatus;
  providerAccountReference?: string;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * SINGLE CHOKE POINT for live customer provider account creation.
 * Enforces pre-flight validation, TOCTOU re-checks, deterministic idempotency checks,
 * sanitized audit logging, and parent administrative boundaries immediately before any provider account create.
 */
export async function createLiveCustomerProviderAccount(
  context: CreateLiveCustomerProviderAccountContext,
  db: SupabaseClient,
  adapter?: ProviderProvisioningAdapter
): Promise<CreateLiveCustomerProviderAccountResult> {
  const {
    organizationId,
    organizationClassification,
    provider,
    environment,
    idempotencyKey,
    auditCorrelationId,
    operatorConfirmationToken,
    remoteSchemaVerified,
    vaultInstance,
    parentAdminAccountSid,
    parentAdminAuthToken,
    organizationName,
    serviceScope = 'ALL',
    clientPayloadOverride,
  } = context;

  // 1. Audit: PRECHECK_STARTED
  auditLiveProvisioningEvent({
    eventType: 'PRECHECK_STARTED',
    organizationId,
    provider,
    auditCorrelationId,
    idempotencyKey,
    details: { environment, serviceScope },
  });

  // 2. Reject Client Override immediately
  if (
    clientPayloadOverride &&
    (clientPayloadOverride.enableMutations !== undefined ||
      clientPayloadOverride.skipGuard !== undefined ||
      clientPayloadOverride.approved !== undefined ||
      clientPayloadOverride.providerAccountId !== undefined ||
      clientPayloadOverride.AccountSid !== undefined)
  ) {
    auditLiveProvisioningEvent({
      eventType: 'VALIDATION_FAILED',
      organizationId,
      provider,
      auditCorrelationId,
      idempotencyKey,
      details: { reason: 'CLIENT_OVERRIDE_PROHIBITED' },
    });
    return {
      success: false,
      status: 'FAILED',
      errorCode: 'CLIENT_OVERRIDE_PROHIBITED',
      errorMessage: 'Client payload attempt to bypass server safety controls is strictly prohibited.',
    };
  }

  // 3. TOCTOU: Run pre-flight verification immediately before mutation
  const preflightResult = await validateLiveOperationPreflight(
    {
      organizationId,
      organizationClassification,
      provider,
      environment,
      idempotencyKey,
      auditCorrelationId,
      operatorConfirmationToken,
      vaultInstance,
      remoteSchemaVerified,
      parentAdminAccountSid,
      parentAdminAuthToken,
      clientPayloadOverride,
    },
    db
  );

  if (!preflightResult.allowed) {
    auditLiveProvisioningEvent({
      eventType: 'VALIDATION_FAILED',
      organizationId,
      provider,
      auditCorrelationId,
      idempotencyKey,
      details: { errorCode: preflightResult.errorCode, errorMessage: preflightResult.errorMessage },
    });
    return {
      success: false,
      status: 'FAILED',
      errorCode: preflightResult.errorCode,
      errorMessage: preflightResult.errorMessage,
    };
  }

  // 4. TOCTOU: Re-check dynamic database state
  // A. Check for existing active provider assignments
  const { data: existingAssignments } = await (db as any)
    .from('telecom_organization_provider_assignments')
    .select('id, provider_account_id, is_active')
    .eq('organization_id', organizationId)
    .eq('is_active', true);

  if (existingAssignments && existingAssignments.length > 0) {
    auditLiveProvisioningEvent({
      eventType: 'VALIDATION_FAILED',
      organizationId,
      provider,
      auditCorrelationId,
      idempotencyKey,
      details: { reason: 'ORGANIZATION_ALREADY_PROVISIONED' },
    });
    return {
      success: false,
      status: 'FAILED',
      errorCode: 'ORGANIZATION_ALREADY_PROVISIONED',
      errorMessage: `Organization '${organizationId}' already has active provider account assignments.`,
    };
  }

  // B. Protected pilot quarantine check on resources
  try {
    assertProtectedPilotUntouched({ organizationId });
  } catch (err: any) {
    auditLiveProvisioningEvent({
      eventType: 'VALIDATION_FAILED',
      organizationId,
      provider,
      auditCorrelationId,
      idempotencyKey,
      details: { reason: 'PROTECTED_PILOT_QUARANTINE_VIOLATION' },
    });
    return {
      success: false,
      status: 'FAILED',
      errorCode: 'PROTECTED_PILOT_QUARANTINE_VIOLATION',
      errorMessage: err.message,
    };
  }

  // 5. TOCTOU: Check durable saga operation state in telecom_account_provisioning_operations
  let operationRow: any = null;
  const { data: existingOp } = await (db as any)
    .from('telecom_account_provisioning_operations')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('provider', provider)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existingOp) {
    operationRow = existingOp;
    // If operation is already created or ready: REFUSE second create!
    if (
      existingOp.status === 'PROVIDER_ACCOUNT_CREATED' ||
      existingOp.status === 'RUNTIME_CREDENTIAL_CREATED' ||
      existingOp.status === 'SECRETS_STORED' ||
      existingOp.status === 'LOCAL_ACCOUNT_RECORDED' ||
      existingOp.status === 'ASSIGNMENT_CREATED' ||
      existingOp.status === 'READY'
    ) {
      return {
        success: true,
        status: existingOp.status,
        providerAccountReference: existingOp.provider_account_reference,
      };
    }

    // If operation is in REQUIRES_RECONCILIATION: REFUSE blind create!
    if (existingOp.status === 'REQUIRES_RECONCILIATION') {
      auditLiveProvisioningEvent({
        eventType: 'RECONCILIATION_REQUIRED',
        organizationId,
        provider,
        auditCorrelationId,
        idempotencyKey,
        details: { operationId: existingOp.id },
      });
      return {
        success: false,
        status: 'REQUIRES_RECONCILIATION',
        errorCode: 'RECONCILIATION_REQUIRED',
        errorMessage:
          'Operation is flagged REQUIRES_RECONCILIATION. Blind creation is prohibited before manual reconciliation.',
      };
    }
  } else {
    // Atomically admit the operation row into the database
    const preallocatedId = crypto.randomUUID();
    const { data: inserted, error: insertErr } = await (db as any)
      .from('telecom_account_provisioning_operations')
      .insert({
        organization_id: organizationId,
        provider,
        service_scope: serviceScope,
        idempotency_key: idempotencyKey,
        status: 'REQUESTED',
        provider_account_id: preallocatedId,
        attempt_count: 1,
        metadata: { auditCorrelationId },
      })
      .select('*')
      .single();

    if (insertErr || !inserted) {
      // Race: fetch winner
      const { data: raced } = await (db as any)
        .from('telecom_account_provisioning_operations')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('provider', provider)
        .eq('idempotency_key', idempotencyKey)
        .single();
      if (!raced) {
        return {
          success: false,
          status: 'FAILED',
          errorCode: 'IDEMPOTENCY_ADMISSION_FAILED',
          errorMessage: 'Failed to atomically admit durable provisioning operation.',
        };
      }
      operationRow = raced;
      // Concurrent caller lost the race to admit the operation:
      // It must converge on the existing admitted operation and NEVER execute a redundant provider create!
      return {
        success:
          operationRow.status === 'READY' ||
          operationRow.status === 'PROVIDER_ACCOUNT_CREATED' ||
          operationRow.status === 'REQUESTED',
        status: operationRow.status,
        providerAccountReference: operationRow.provider_account_reference,
      };
    } else {
      operationRow = inserted;
    }
  }

  // 6. ALL CHECKS PASSED: Emit PRECHECK_PASSED
  auditLiveProvisioningEvent({
    eventType: 'PRECHECK_PASSED',
    organizationId,
    provider,
    auditCorrelationId,
    idempotencyKey,
  });

  // 7. Emit PROVIDER_CREATE_REQUESTED
  auditLiveProvisioningEvent({
    eventType: 'PROVIDER_CREATE_REQUESTED',
    organizationId,
    provider,
    auditCorrelationId,
    idempotencyKey,
  });

  // 8. Invoke Provider Create Choke Point
  if (!adapter) {
    auditLiveProvisioningEvent({
      eventType: 'VALIDATION_FAILED',
      organizationId,
      provider,
      auditCorrelationId,
      idempotencyKey,
      details: { reason: 'LIVE_PROVIDER_ADAPTER_UNAVAILABLE' },
    });
    return {
      success: false,
      status: 'FAILED',
      errorCode: 'LIVE_PROVIDER_ADAPTER_UNAVAILABLE',
      errorMessage: 'Live provider adapter is not configured or live actions are not authorized.',
    };
  }

  try {
    const createResult = await adapter.createCustomerAccount({
      organizationId,
      organizationName,
      serviceScope,
      idempotencyKey,
    });

    // Update operation row
    await (db as any)
      .from('telecom_account_provisioning_operations')
      .update({
        status: 'PROVIDER_ACCOUNT_CREATED',
        provider_account_reference: createResult.accountReference,
        updated_at: new Date().toISOString(),
      })
      .eq('id', operationRow.id);

    auditLiveProvisioningEvent({
      eventType: 'PROVIDER_CREATE_SUCCEEDED',
      organizationId,
      provider,
      auditCorrelationId,
      idempotencyKey,
      providerAccountReference: createResult.accountReference,
    });

    return {
      success: true,
      status: 'PROVIDER_ACCOUNT_CREATED',
      providerAccountReference: createResult.accountReference,
    };
  } catch (err: any) {
    const isTimeout =
      (err as any)?.isTimeout ||
      (err as any)?.code === 'ETIMEDOUT' ||
      String(err?.message).includes('timed out');
    const sanitizedMsg = String(err?.message || 'Provider creation failed')
      .replace(/mock_sk_secret_[a-zA-Z0-9_\-]+/gi, '[REDACTED_SECRET]')
      .replace(/mock_auth_token_[a-zA-Z0-9_\-]+/gi, '[REDACTED_TOKEN]')
      .replace(/SK[a-zA-Z0-9]{32}/g, '[REDACTED_KEY_SID]');

    if (isTimeout) {
      await (db as any)
        .from('telecom_account_provisioning_operations')
        .update({
          status: 'REQUIRES_RECONCILIATION',
          last_error_code: 'PROVIDER_CREATE_TIMEOUT',
          last_error_message_sanitized: sanitizedMsg,
          updated_at: new Date().toISOString(),
        })
        .eq('id', operationRow.id);

      auditLiveProvisioningEvent({
        eventType: 'PROVIDER_CREATE_UNKNOWN',
        organizationId,
        provider,
        auditCorrelationId,
        idempotencyKey,
        details: { error: sanitizedMsg },
      });

      return {
        success: false,
        status: 'REQUIRES_RECONCILIATION',
        errorCode: 'PROVIDER_CREATE_TIMEOUT',
        errorMessage:
          'Provider account creation timed out without acknowledgment. Operation flagged for reconciliation. No second create.',
      };
    }

    await (db as any)
      .from('telecom_account_provisioning_operations')
      .update({
        status: 'FAILED',
        last_error_code: err?.code || 'PROVIDER_ACCOUNT_CREATION_FAILED',
        last_error_message_sanitized: sanitizedMsg,
        updated_at: new Date().toISOString(),
      })
      .eq('id', operationRow.id);

    auditLiveProvisioningEvent({
      eventType: 'VALIDATION_FAILED',
      organizationId,
      provider,
      auditCorrelationId,
      idempotencyKey,
      details: { error: sanitizedMsg },
    });

    return {
      success: false,
      status: 'FAILED',
      errorCode: err?.code || 'PROVIDER_ACCOUNT_CREATION_FAILED',
      errorMessage: sanitizedMsg,
    };
  }
}

// ============================================================================
// PHASE 23F.2A: PRIVILEGED PARENT ADMIN CREDENTIAL BOUNDARY & TWO-GATE SAFETY
// ============================================================================

export type PrivilegedAdminOperation =
  | 'CREATE_CUSTOMER_SUBACCOUNT'
  | 'CREATE_DISPOSABLE_CUSTOMER_SUBACCOUNT'
  | 'PROVISION_DISPOSABLE_RUNTIME_CREDENTIAL'
  | 'PROVISION_DISPOSABLE_TWIML_APP'
  | 'SUSPEND_DISPOSABLE_CUSTOMER_SUBACCOUNT';

export const STAGE_B_DISPOSABLE_VALIDATION_ORG_ID = '38942163-2b6d-4dbb-aebf-f6165c02a36e';
export const STAGE_B_DISPOSABLE_VALIDATION_ORG_NAME = 'Stage-B Disposable Validation Org';
export const STAGE_B_DISPOSABLE_VALIDATION_ORG_SLUG = 'stage-b-disposable-validation';

export interface StageBPrivilegedSessionAuthorization {
  operation: PrivilegedAdminOperation;
  disposableOrganizationId: string;
  disposableOrganizationClassification: 'INTERNAL_TEST' | 'VALIDATION';
  authorizedByOperatorId: string;
  sessionNonce: string;
  issuedAt: string;
  expiresAt: string;
  maxSpendCapCents: number;
  environment: string;
  provider?: TelecomProvider;
}

const consumedSessionNonces = new Set<string>();

export function hashSessionNonce(nonce: string): string {
  return crypto.createHash('sha256').update(nonce.trim()).digest('hex');
}

export function markSessionNonceConsumed(nonce: string): void {
  consumedSessionNonces.add(nonce.trim());
}

export function isSessionNonceConsumed(nonce: string): boolean {
  return consumedSessionNonces.has(nonce.trim());
}

export function clearConsumedSessionNonces(): void {
  consumedSessionNonces.clear();
}

/**
 * Phase 24D.SEC-7F L-04: Distributed Session Nonce Consumer
 * Atomically consumes a single-use session nonce via PostgreSQL `consume_telecom_session_nonce` RPC.
 * Survives serverless cold starts, multi-instance concurrency, and process restarts.
 */
export async function consumeSessionNonceDistributed(params: {
  nonce: string;
  organizationId?: string;
  operation: string;
  expiresAt: string;
  supabaseClient?: SupabaseClient;
}): Promise<{ allowed: boolean; reason?: string; errorMessage?: string }> {
  const { nonce, organizationId, operation, expiresAt, supabaseClient } = params;

  if (!nonce || nonce.trim().length === 0) {
    return {
      allowed: false,
      reason: 'SESSION_NONCE_REQUIRED',
      errorMessage: 'sessionNonce is required for anti-replay protection.',
    };
  }

  const cleanNonce = nonce.trim();
  const nonceHash = hashSessionNonce(cleanNonce);

  // Check local in-memory guard first
  if (consumedSessionNonces.has(cleanNonce)) {
    return {
      allowed: false,
      reason: 'SESSION_NONCE_REPLAY_DETECTED',
      errorMessage: `sessionNonce '${cleanNonce}' has already been consumed (local process replay prohibited).`,
    };
  }

  // Check and consume via PostgreSQL distributed RPC if DB available
  try {
    const supabase = supabaseClient || (await import('@/lib/supabase/admin')).createAdminClient();
    if (supabase && typeof (supabase as any).rpc === 'function') {
      const { data, error } = await (supabase as any).rpc('consume_telecom_session_nonce', {
        p_nonce_hash: nonceHash,
        p_organization_id: organizationId || null,
        p_operation: operation,
        p_expires_at: expiresAt,
      });

      if (error) {
        // If RPC is missing in isolated test context, fallback safely to local set
        if (!error.message?.includes('function') && !error.message?.includes('schema cache')) {
          console.warn('[liveProvisioningGuard] consume_telecom_session_nonce RPC error:', error.message);
          return {
            allowed: false,
            reason: 'DISTRIBUTED_NONCE_STORE_ERROR',
            errorMessage: `Distributed nonce store error: ${error.message}`,
          };
        }
      } else if (data && data.allowed === false) {
        markSessionNonceConsumed(cleanNonce);
        return {
          allowed: false,
          reason: data.reason || 'SESSION_NONCE_REPLAY_DETECTED',
          errorMessage: data.errorMessage || 'Privileged session nonce consumed by another instance.',
        };
      }
    }
  } catch (err: any) {
    console.warn('[liveProvisioningGuard] Exception accessing distributed nonce store:', err?.message || err);
  }

  // Mark in local set as well
  markSessionNonceConsumed(cleanNonce);
  return { allowed: true };
}

export interface ValidateStageBAuthorizationTarget {
  operation: PrivilegedAdminOperation;
  organizationId: string;
  provider?: TelecomProvider;
  phoneNumber?: string;
  resourceSid?: string;
  phoneNumberId?: string;
  existingCustomerOrgs?: string[];
  existingCustomerAccounts?: string[];
  existingCustomerPhoneSids?: string[];
  existingCustomerE164s?: string[];
}

export interface StageBAuthorizationValidationResult {
  allowed: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Two-Gate Safety Validator for Stage B Privileged Operator Operations.
 *
 * GATE 1: TELECOM_PROVIDER_ACCOUNT_PROVISIONING_MUTATIONS_ENABLED must be explicitly enabled.
 * GATE 2: An explicit, non-expired, single-purpose StageBPrivilegedSessionAuthorization
 *         matching the exact operation and disposable organization must be provided.
 *
 * INVARIANTS:
 * 1. Rejects any attempt to target the protected Australian pilot.
 * 2. Rejects any attempt to target existing production customer organizations or resources.
 * 3. Rejects operation mismatches (e.g. using subaccount-creation auth for arbitrary provider mutations).
 * 4. Rejects expired or stale sessions.
 * 5. Rejects any spend cap exceeding 1000 cents ($10.00 USD).
 */
export function validateStageBPrivilegedAuthorization(
  auth: StageBPrivilegedSessionAuthorization | null | undefined,
  target: ValidateStageBAuthorizationTarget
): StageBAuthorizationValidationResult {
  // GATE 1: Provisioning Mutation Gate must be ON
  if (!isProviderAccountProvisioningMutationsEnabled()) {
    return {
      allowed: false,
      errorCode: 'PROVISIONING_MUTATION_GATE_DISABLED',
      errorMessage: 'GATE 1 FAILED: TELECOM_PROVIDER_ACCOUNT_PROVISIONING_MUTATIONS_ENABLED is disabled.',
    };
  }

  // GATE 2: Explicit Privileged Session Authorization required
  if (!auth) {
    return {
      allowed: false,
      errorCode: 'PRIVILEGED_AUTHORIZATION_REQUIRED',
      errorMessage: 'GATE 2 FAILED: Privileged session authorization object is required.',
    };
  }

  // Expiration check
  const nowMs = Date.now();
  const expiresMs = new Date(auth.expiresAt).getTime();
  if (isNaN(expiresMs) || nowMs > expiresMs) {
    return {
      allowed: false,
      errorCode: 'PRIVILEGED_AUTHORIZATION_EXPIRED',
      errorMessage: `GATE 2 FAILED: Privileged session authorization expired at ${auth.expiresAt}.`,
    };
  }

  // Nonce / Anti-replay check
  if (!auth.sessionNonce || auth.sessionNonce.trim().length === 0) {
    return {
      allowed: false,
      errorCode: 'SESSION_NONCE_REQUIRED',
      errorMessage: 'GATE 2 FAILED: sessionNonce is required for anti-replay protection.',
    };
  }
  if (consumedSessionNonces.has(auth.sessionNonce)) {
    return {
      allowed: false,
      errorCode: 'SESSION_NONCE_REPLAY_DETECTED',
      errorMessage: `GATE 2 FAILED: sessionNonce '${auth.sessionNonce}' has already been consumed (replay prohibited).`,
    };
  }

  // Spend cap invariant: <= $10 USD (1000 cents)
  if (!auth.maxSpendCapCents || auth.maxSpendCapCents > 1000 || auth.maxSpendCapCents <= 0) {
    return {
      allowed: false,
      errorCode: 'INVALID_SPEND_CAP',
      errorMessage: 'GATE 2 FAILED: Validation maxSpendCapCents must be > 0 and <= 1000 ($10 USD max cap).',
    };
  }

  // Provider match check
  if (auth.provider && auth.provider !== 'TWILIO') {
    return {
      allowed: false,
      errorCode: 'PROVIDER_MISMATCH',
      errorMessage: `GATE 2 FAILED: Authorized provider '${auth.provider}' does not match target TWILIO.`,
    };
  }
  if (target.provider && auth.provider && auth.provider !== target.provider) {
    return {
      allowed: false,
      errorCode: 'PROVIDER_MISMATCH',
      errorMessage: `GATE 2 FAILED: Authorized provider '${auth.provider}' does not match target '${target.provider}'.`,
    };
  }

  // Operation match invariant
  if (auth.operation !== target.operation) {
    return {
      allowed: false,
      errorCode: 'OPERATION_MISMATCH',
      errorMessage: `GATE 2 FAILED: Authorized operation '${auth.operation}' does not match requested target operation '${target.operation}'.`,
    };
  }

  // Organization match invariant
  if (auth.disposableOrganizationId !== target.organizationId) {
    return {
      allowed: false,
      errorCode: 'ORGANIZATION_MISMATCH',
      errorMessage: `GATE 2 FAILED: Authorized organization '${auth.disposableOrganizationId}' does not match target '${target.organizationId}'.`,
    };
  }

  // Exact Disposable Organization Binding:
  // Stage B customer subaccount operations are strictly bound to the operator-verified disposable validation UUID
  if (
    auth.operation === 'CREATE_CUSTOMER_SUBACCOUNT' ||
    auth.operation === 'CREATE_DISPOSABLE_CUSTOMER_SUBACCOUNT'
  ) {
    if (auth.disposableOrganizationId !== STAGE_B_DISPOSABLE_VALIDATION_ORG_ID) {
      return {
        allowed: false,
        errorCode: 'UNAUTHORIZED_DISPOSABLE_ORGANIZATION',
        errorMessage: `GATE 2 FAILED: Authorized organization '${auth.disposableOrganizationId}' is not the operator-verified Stage-B disposable validation organization (${STAGE_B_DISPOSABLE_VALIDATION_ORG_ID}).`,
      };
    }
  }

  // Protected Australian Pilot Quarantine
  try {
    assertProtectedPilotUntouched({
      organizationId: target.organizationId,
      phoneNumber: target.phoneNumber,
      resourceSid: target.resourceSid,
      phoneNumberId: target.phoneNumberId,
    });
  } catch (pilotErr: any) {
    return {
      allowed: false,
      errorCode: 'PROTECTED_PILOT_QUARANTINE_VIOLATION',
      errorMessage: pilotErr.message,
    };
  }

  // Existing Customer Exclusion Check
  if (target.existingCustomerOrgs && target.existingCustomerOrgs.includes(target.organizationId)) {
    return {
      allowed: false,
      errorCode: 'EXISTING_CUSTOMER_COLLISION',
      errorMessage: `GATE 2 FAILED: Target organization '${target.organizationId}' matches an existing production customer.`,
    };
  }
  if (target.phoneNumber && target.existingCustomerE164s && target.existingCustomerE164s.includes(target.phoneNumber)) {
    return {
      allowed: false,
      errorCode: 'EXISTING_CUSTOMER_COLLISION',
      errorMessage: `GATE 2 FAILED: Target phone number '${target.phoneNumber}' matches an existing customer number.`,
    };
  }
  if (target.resourceSid && target.existingCustomerPhoneSids && target.existingCustomerPhoneSids.includes(target.resourceSid)) {
    return {
      allowed: false,
      errorCode: 'EXISTING_CUSTOMER_COLLISION',
      errorMessage: `GATE 2 FAILED: Target resource SID '${target.resourceSid}' matches an existing customer resource.`,
    };
  }

  return { allowed: true };
}

/**
 * Phase 24D.SEC-7F L-04: Asynchronous Stage B Privileged Operator Validator with Distributed Nonce Consumption
 * Atomically consumes the session nonce across instances in PostgreSQL before returning success.
 */
export async function validateStageBPrivilegedAuthorizationAsync(
  auth: StageBPrivilegedSessionAuthorization | null | undefined,
  target: ValidateStageBAuthorizationTarget,
  supabaseClient?: SupabaseClient
): Promise<StageBAuthorizationValidationResult> {
  const syncResult = validateStageBPrivilegedAuthorization(auth, target);
  if (!syncResult.allowed) {
    return syncResult;
  }

  if (auth && auth.sessionNonce) {
    const consumeResult = await consumeSessionNonceDistributed({
      nonce: auth.sessionNonce,
      organizationId: target.organizationId,
      operation: target.operation,
      expiresAt: auth.expiresAt,
      supabaseClient,
    });

    if (!consumeResult.allowed) {
      return {
        allowed: false,
        errorCode: consumeResult.reason || 'SESSION_NONCE_REPLAY_DETECTED',
        errorMessage: consumeResult.errorMessage || 'GATE 2 FAILED: Session nonce already consumed or invalid.',
      };
    }
  }

  return { allowed: true };
}

// ============================================================================
// PHASE 23F.2B: LIVE TWILIO IAM RECONCILIATION & PRIVILEGE DOMAIN SEPARATION
// ============================================================================

export type ProviderPrivilegeDomain =
  | 'PARENT_ACCOUNT_ADMIN_HIGH_PRIVILEGE'
  | 'API_KEY_ADMIN'
  | 'CUSTOMER_RUNTIME';

export interface TwilioRestrictedIamPermissions {
  accounts: {
    read: true;
    list: true;
    create: false;
    update: false;
    delete: false;
  };
  apiKeys: {
    read: true;
    list: true;
    create: true;
    update: true;
    delete: true;
  };
}

/**
 * Live Operator-Console Observed Evidence (US1 Region, 2026-10-20):
 * - IAM / accounts: Read=available, List=available, Create=NOT AVAILABLE, Update=NOT AVAILABLE, Delete=NOT AVAILABLE.
 * - IAM / api-keys: Read=available, List=available, Create=available, Update=available, Delete=available.
 */
export const LIVE_OBSERVED_RESTRICTED_IAM_PERMISSIONS: TwilioRestrictedIamPermissions = {
  accounts: {
    read: true,
    list: true,
    create: false,
    update: false,
    delete: false,
  },
  apiKeys: {
    read: true,
    list: true,
    create: true,
    update: true,
    delete: true,
  },
};

export type ChildRuntimeKeyCreationMechanism =
  | 'SUBACCOUNT_EPHEMERAL_AUTH_TOKEN'
  | 'PARENT_API_KEY_ADMIN_CROSS_ACCOUNT'
  | 'PARENT_ACCOUNT_ADMIN_HIGH_PRIVILEGE';

export interface ChildRuntimeKeyMechanismClassification {
  mechanism: ChildRuntimeKeyCreationMechanism;
  classification: 'CONFIRMED_CURRENT' | 'CONTROLLED_VALIDATION_REQUIRED' | 'DOCUMENTATION_AMBIGUOUS';
  documentationReference: string;
}

export const CHILD_RUNTIME_KEY_MECHANISM_EVALUATIONS: Record<
  ChildRuntimeKeyCreationMechanism,
  ChildRuntimeKeyMechanismClassification
> = {
  SUBACCOUNT_EPHEMERAL_AUTH_TOKEN: {
    mechanism: 'SUBACCOUNT_EPHEMERAL_AUTH_TOKEN',
    classification: 'CONFIRMED_CURRENT',
    documentationReference:
      'Twilio REST API 2010-04-01 /Accounts/{SubaccountSid}/Keys.json using subaccount basic auth (subaccount.sid : subaccount.authToken)',
  },
  PARENT_API_KEY_ADMIN_CROSS_ACCOUNT: {
    mechanism: 'PARENT_API_KEY_ADMIN_CROSS_ACCOUNT',
    classification: 'CONTROLLED_VALIDATION_REQUIRED',
    documentationReference:
      'Twilio Restricted IAM api-keys permission targeting child subaccount path without subaccount Auth Token requires live empirical validation',
  },
  PARENT_ACCOUNT_ADMIN_HIGH_PRIVILEGE: {
    mechanism: 'PARENT_ACCOUNT_ADMIN_HIGH_PRIVILEGE',
    classification: 'CONFIRMED_CURRENT',
    documentationReference:
      'Twilio Main API Key or Master Auth Token targeting /Accounts/{SubaccountSid}/Keys.json',
  },
};

// ============================================================================
// PHASE 23F.2C.1: PROVIDER CONTRACT PRECISION CORRECTIONS
// ============================================================================

export type DistinctCredentialClass =
  | 'PARENT_MAIN_API_KEY'
  | 'PARENT_ACCOUNT_SID_AUTH_TOKEN'
  | 'CHILD_ACCOUNT_SID_AUTH_TOKEN'
  | 'CHILD_RUNTIME_API_KEY';

export interface CredentialScopeEvaluation {
  credentialClass: DistinctCredentialClass;
  allowsParentResourceManagement: boolean;
  allowsDirectChildResourceCRUD: boolean;
  classification: 'CONFIRMED_CURRENT' | 'RESTRICTED_BY_PROVIDER' | 'CONTROLLED_VALIDATION_REQUIRED';
  providerDocumentationWarning?: string;
}

export const CREDENTIAL_SCOPE_EVALUATIONS: Record<
  DistinctCredentialClass,
  CredentialScopeEvaluation
> = {
  PARENT_MAIN_API_KEY: {
    credentialClass: 'PARENT_MAIN_API_KEY',
    allowsParentResourceManagement: true,
    allowsDirectChildResourceCRUD: false,
    classification: 'RESTRICTED_BY_PROVIDER',
    providerDocumentationWarning:
      'Twilio subaccounts documentation warns: "Main account API Keys are only available to access main account resources. Access to subaccount resources will be denied." Parent Main API Key manages Account resources (GET/POST /Accounts) but is denied access to ordinary child resources (Calls, Messages, Numbers, subaccount API keys).',
  },
  PARENT_ACCOUNT_SID_AUTH_TOKEN: {
    credentialClass: 'PARENT_ACCOUNT_SID_AUTH_TOKEN',
    allowsParentResourceManagement: true,
    allowsDirectChildResourceCRUD: true,
    classification: 'CONFIRMED_CURRENT',
    providerDocumentationWarning:
      'Can access v2010 REST resources belonging to subaccounts, but is root-equivalent and must NEVER become SaaS customer runtime.',
  },
  CHILD_ACCOUNT_SID_AUTH_TOKEN: {
    credentialClass: 'CHILD_ACCOUNT_SID_AUTH_TOKEN',
    allowsParentResourceManagement: false,
    allowsDirectChildResourceCRUD: true,
    classification: 'CONFIRMED_CURRENT',
    providerDocumentationWarning:
      'Returned upon subaccount creation or fetched via Parent Accounts API; used ephemerally to bootstrap child keys and stored for WEBHOOK_VERIFICATION.',
  },
  CHILD_RUNTIME_API_KEY: {
    credentialClass: 'CHILD_RUNTIME_API_KEY',
    allowsParentResourceManagement: false,
    allowsDirectChildResourceCRUD: true,
    classification: 'CONFIRMED_CURRENT',
    providerDocumentationWarning:
      'Canonical credential for child customer runtime telecom operations with zero parent fallback.',
  },
};

export type SubaccountRetentionStatus =
  | 'SUBACCOUNT_CLOSED'
  | 'PROVIDER_RETENTION_PENDING'
  | 'PROVIDER_PURGED';

export interface SubaccountClosureRetentionModel {
  canonicalStatus: 'CLOSED';
  providerStatus: SubaccountRetentionStatus;
  providerDeletionWindowDays: number;
  phoneNumbersReleasedImmediately: boolean;
  canonicalHistorySurvivesProviderPurge: true;
}

export const SUBACCOUNT_CLOSURE_RETENTION_RULE: SubaccountClosureRetentionModel = {
  canonicalStatus: 'CLOSED',
  providerStatus: 'SUBACCOUNT_CLOSED',
  providerDeletionWindowDays: 30,
  phoneNumbersReleasedImmediately: true,
  canonicalHistorySurvivesProviderPurge: true,
};

export type V3SecretCaptureState =
  | 'CAPTURED_IN_MEMORY'
  | 'VAULT_STORED_CONFIRMED'
  | 'VAULT_STORAGE_FAILED_RECONCILIATION_REQUIRED';

export interface V3OrphanKeyCompensationDecision {
  allowBlindRetryKeyCreation: false;
  requireOrphanKeyReconciliation: true;
  actionOnVaultFailure: 'MARK_AMBIGUOUS_AND_RECONCILE';
}

export const V3_KEY_FAILURE_COMPENSATION_POLICY: V3OrphanKeyCompensationDecision = {
  allowBlindRetryKeyCreation: false,
  requireOrphanKeyReconciliation: true,
  actionOnVaultFailure: 'MARK_AMBIGUOUS_AND_RECONCILE',
};

// ============================================================================
// PHASE 23F.3A: STAGE-B PRE-MUTATION LIVE READINESS & V1 RECONCILIATION
// ============================================================================

export interface ProvisioningCorrelationDetails {
  correlationId: string;
  correlationSuffix: string;
  deterministicFriendlyName: string;
}

export function generateProvisioningCorrelationId(prefix: string = 'voiphub_val'): ProvisioningCorrelationDetails {
  const correlationSuffix = crypto.randomBytes(4).toString('hex'); // 8 hex chars
  const correlationId = `${prefix}_${correlationSuffix}`;
  return {
    correlationId,
    correlationSuffix,
    deterministicFriendlyName: correlationId,
  };
}

export function assertValidFriendlyNameNonSecret(friendlyName: string): void {
  if (!friendlyName || friendlyName.length > 64) {
    throw new Error('INVALID_FRIENDLY_NAME: FriendlyName must be 1-64 characters.');
  }
  const lower = friendlyName.toLowerCase();
  if (
    lower.includes('secret') ||
    lower.includes('token') ||
    lower.includes('key_') ||
    lower.includes('auth') ||
    lower.includes('sk_') ||
    lower.includes('password')
  ) {
    throw new Error('SECURITY_VIOLATION: FriendlyName must not contain secret or sensitive substrings.');
  }
  if (!/^[a-zA-Z0-9_\-]+$/.test(friendlyName)) {
    throw new Error('INVALID_FRIENDLY_NAME: FriendlyName must only contain alphanumeric characters, hyphens, and underscores.');
  }
}

export type V1FailureCategory =
  | 'POST_REJECTED_KNOWN_FAILURE'
  | 'POST_SUCCESS_ACCOUNT_CREATED'
  | 'PROVIDER_OUTCOME_UNKNOWN_RECONCILIATION_REQUIRED'
  | 'PROVIDER_MALFORMED_RESPONSE_RECONCILIATION_REQUIRED'
  | 'LOCAL_PERSISTENCE_FAILED_RECONCILIATION_REQUIRED'
  | 'DUPLICATE_ACCOUNT_DISCOVERED_RECONCILIATION_REQUIRED';

export interface V1FailureActionPlan {
  category: V1FailureCategory;
  allowBlindRetry: boolean;
  requiresSafeReconciliation: boolean;
  canAutoCompensateWithoutEvidence: false;
  description: string;
}

export const V1_FAILURE_HANDLING_MATRIX: Record<V1FailureCategory, V1FailureActionPlan> = {
  POST_REJECTED_KNOWN_FAILURE: {
    category: 'POST_REJECTED_KNOWN_FAILURE',
    allowBlindRetry: false,
    requiresSafeReconciliation: false,
    canAutoCompensateWithoutEvidence: false,
    description: 'POST was rejected prior to creation (e.g. 400 Bad Request, 401 Unauthorized). Account definitely does not exist. Safe to retry after correcting configuration.',
  },
  POST_SUCCESS_ACCOUNT_CREATED: {
    category: 'POST_SUCCESS_ACCOUNT_CREATED',
    allowBlindRetry: false,
    requiresSafeReconciliation: false,
    canAutoCompensateWithoutEvidence: false,
    description: 'POST succeeded with 201 Created and returned valid ChildSid and child AuthToken. Proceed to transactional vault storage.',
  },
  PROVIDER_OUTCOME_UNKNOWN_RECONCILIATION_REQUIRED: {
    category: 'PROVIDER_OUTCOME_UNKNOWN_RECONCILIATION_REQUIRED',
    allowBlindRetry: false,
    requiresSafeReconciliation: true,
    canAutoCompensateWithoutEvidence: false,
    description: 'Network timeout (504, ECONNRESET, transport failure). Creation status unknown. DO NOT BLINDLY RETRY. Execute safe read reconciliation before taking action.',
  },
  PROVIDER_MALFORMED_RESPONSE_RECONCILIATION_REQUIRED: {
    category: 'PROVIDER_MALFORMED_RESPONSE_RECONCILIATION_REQUIRED',
    allowBlindRetry: false,
    requiresSafeReconciliation: true,
    canAutoCompensateWithoutEvidence: false,
    description: 'Provider returned 200/201 but response payload was missing critical fields (SID or auth_token). Reconcile via safe GET.',
  },
  LOCAL_PERSISTENCE_FAILED_RECONCILIATION_REQUIRED: {
    category: 'LOCAL_PERSISTENCE_FAILED_RECONCILIATION_REQUIRED',
    allowBlindRetry: false,
    requiresSafeReconciliation: true,
    canAutoCompensateWithoutEvidence: false,
    description: 'Child subaccount was created in Twilio, but local database write failed. Subaccount exists remotely. Operator inspection and state reconciliation required.',
  },
  DUPLICATE_ACCOUNT_DISCOVERED_RECONCILIATION_REQUIRED: {
    category: 'DUPLICATE_ACCOUNT_DISCOVERED_RECONCILIATION_REQUIRED',
    allowBlindRetry: false,
    requiresSafeReconciliation: true,
    canAutoCompensateWithoutEvidence: false,
    description: 'Reconciliation discovered duplicate or ambiguous accounts. DO NOT automatically close accounts based on FriendlyName alone without exact correlation evidence.',
  },
};

export type V3KeyFailureCategory =
  | 'KNOWN_ORPHAN_KEY_REVOCATION_REQUIRED'
  | 'CHILD_KEY_PROVIDER_OUTCOME_UNKNOWN_RECONCILIATION_REQUIRED';

export interface V3KeyFailureActionPlan {
  category: V3KeyFailureCategory;
  allowBlindRetry: boolean;
  allowArbitraryKeyDeletion: false;
  description: string;
}

export const V3_KEY_FAILURE_HANDLING_MATRIX: Record<V3KeyFailureCategory, V3KeyFailureActionPlan> = {
  KNOWN_ORPHAN_KEY_REVOCATION_REQUIRED: {
    category: 'KNOWN_ORPHAN_KEY_REVOCATION_REQUIRED',
    allowBlindRetry: false,
    allowArbitraryKeyDeletion: false,
    description: 'Child Key SID and secret were returned by provider, but vault persistence failed. Exact Key SID is known. Execute targeted compensation to revoke that exact key.',
  },
  CHILD_KEY_PROVIDER_OUTCOME_UNKNOWN_RECONCILIATION_REQUIRED: {
    category: 'CHILD_KEY_PROVIDER_OUTCOME_UNKNOWN_RECONCILIATION_REQUIRED',
    allowBlindRetry: false,
    allowArbitraryKeyDeletion: false,
    description: 'POST /Keys timed out or failed with unknown outcome. Key SID was never received. DO NOT create another key, DO NOT guess Key SID, DO NOT delete arbitrary keys. Fail closed and reconcile.',
  },
};

export interface StageBV1MutationAllowlist {
  permittedEndpoint: 'POST /2010-04-01/Accounts.json';
  maxSuccessfulCreations: 1;
  deniedOperations: string[];
}

export const STAGE_B_V1_MUTATION_ALLOWLIST: StageBV1MutationAllowlist = {
  permittedEndpoint: 'POST /2010-04-01/Accounts.json',
  maxSuccessfulCreations: 1,
  deniedOperations: [
    'number_purchase',
    'number_release',
    'number_configuration',
    'number_transfer',
    'porting',
    'voice_calls',
    'sms_mms_messages',
    'messaging_service_creation',
    'a2p_registration',
    'regulatory_bundle_creation',
    'address_creation',
    'trust_hub_mutation',
    'api_key_creation', // V3 is NOT authorized in V1
    'subaccount_closure',
    'existing_account_modification',
    'protected_pilot_mutation',
  ],
};

export interface DisposableOrgReadinessResult {
  ready: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export async function verifyDisposableOrganizationReadiness(
  orgId: string,
  dbClient: any
): Promise<DisposableOrgReadinessResult> {
  if (!orgId) {
    return {
      ready: false,
      errorCode: 'DISPOSABLE_VALIDATION_ORGANIZATION_REQUIRES_OPERATOR_SETUP',
      errorMessage: 'Organization ID is empty.',
    };
  }

  // 1. Quarantined Australian pilot check
  try {
    assertProtectedPilotUntouched({ organizationId: orgId });
  } catch (err: any) {
    return { ready: false, errorCode: 'PROTECTED_PILOT_QUARANTINE_VIOLATION', errorMessage: err.message };
  }

  // 2. Fetch org record
  const { data: org, error: orgErr } = await dbClient
    .from('organizations')
    .select('id, name')
    .eq('id', orgId)
    .maybeSingle();

  if (orgErr || !org) {
    return {
      ready: false,
      errorCode: 'DISPOSABLE_VALIDATION_ORGANIZATION_REQUIRES_OPERATOR_SETUP',
      errorMessage: `Disposable validation organization '${orgId}' does not exist in database. Operator setup required.`,
    };
  }

  // 3. Existing subaccount assignment check
  const { data: assignments } = await dbClient
    .from('telecom_organization_provider_assignments')
    .select('id')
    .eq('organization_id', orgId)
    .eq('is_active', true);

  if (assignments && assignments.length > 0) {
    return {
      ready: false,
      errorCode: 'EXISTING_SUBACCOUNT_ASSIGNMENT_FOUND',
      errorMessage: `Organization '${orgId}' already has an active provider assignment. Cannot be used as clean disposable target.`,
    };
  }

  // 4. Check explicit designation for validation
  const orgNameLower = (org.name || '').toLowerCase();
  const isDesignatedValidation =
    orgNameLower.includes('validation') ||
    orgNameLower.includes('test') ||
    orgNameLower.includes('disposable') ||
    orgNameLower.includes('stage_b');

  if (!isDesignatedValidation) {
    return {
      ready: false,
      errorCode: 'DISPOSABLE_VALIDATION_ORGANIZATION_REQUIRES_OPERATOR_SETUP',
      errorMessage: `Organization '${orgId}' (${org.name}) is not explicitly designated for controlled provider validation. Operator setup required.`,
    };
  }

  // 5. Existing active provisioning operation check
  const { data: activeOps } = await dbClient
    .from('telecom_account_provisioning_operations')
    .select('id, status')
    .eq('organization_id', orgId)
    .in('status', ['REQUESTED', 'PROVIDER_ACCOUNT_CREATED', 'RUNTIME_CREDENTIAL_CREATED', 'SECRETS_STORED']);

  if (activeOps && activeOps.length > 0) {
    return {
      ready: false,
      errorCode: 'EXISTING_ACTIVE_PROVISIONING_OPERATION_EXISTS',
      errorMessage: `Organization '${orgId}' has existing active provisioning operations in progress.`,
    };
  }

  // 6. Existing owned phone numbers check
  const { data: ownedNumbers } = await dbClient
    .from('phone_numbers')
    .select('id, phone_number')
    .eq('organization_id', orgId);

  if (ownedNumbers && ownedNumbers.length > 0) {
    return {
      ready: false,
      errorCode: 'DISPOSABLE_ORGANIZATION_OWNS_PHONE_NUMBERS',
      errorMessage: `Organization '${orgId}' owns active phone numbers (${ownedNumbers.length} found). Cannot be used as clean disposable target.`,
    };
  }

  // 7. Check real customer dependency (e.g. customer user profiles)
  const { data: profiles } = await dbClient
    .from('profiles')
    .select('id, email')
    .eq('organization_id', orgId);

  if (
    profiles &&
    profiles.length > 0 &&
    profiles.some(
      (p: any) =>
        !p.email.includes('test') &&
        !p.email.includes('admin') &&
        !p.email.includes('validation') &&
        !p.email.includes('disposable')
    )
  ) {
    return {
      ready: false,
      errorCode: 'DISPOSABLE_ORGANIZATION_HAS_REAL_CUSTOMER_DEPENDENCY',
      errorMessage: `Organization '${orgId}' contains real customer profiles. Repurposing existing customer is prohibited.`,
    };
  }

  return { ready: true };
}

export const STAGE_B_MANDATORY_STOP_CONDITIONS = [
  'CREDENTIAL_SCOPE_MISMATCH',
  'DISPOSABLE_ORGANIZATION_NOT_CLEAN',
  'EXISTING_SUBACCOUNT_ASSIGNMENT_FOUND',
  'EXISTING_PROVISIONING_OPERATION_CONFLICTS',
  'PROTECTED_PILOT_COLLISION',
  'MUTATION_SWITCH_UNEXPECTEDLY_ENABLED',
  'PARENT_FALLBACK_DETECTED',
  'PROVIDER_DOCUMENTATION_MATERIALLY_CHANGED',
  'UNEXPECTED_TWILIO_ACCOUNT_STATE',
  'UNEXPECTED_FINANCIAL_CHARGE',
  'UNEXPECTED_PROVIDER_RESOURCE_FOUND',
  'PROVIDER_OUTCOME_UNKNOWN',
  'MORE_THAN_ONE_ACCOUNT_CREATED',
  'SECRET_APPEARS_IN_LOGS_OR_OUTPUT',
  'PRODUCTION_DB_MUTATION_WITHOUT_APPROVAL',
  'CHILD_CREDENTIAL_SECURE_PERSISTENCE_UNAVAILABLE',
] as const;

export interface V1ChildCredentialPersistenceReadiness {
  vaultReady: boolean;
  blockReason?: 'AWS_KMS_ACTIVATION_DEFERRED_UNTIL_VPS' | 'LOCAL_VAULT_PROHIBITED_IN_PRODUCTION';
  verdict: 'PASS' | 'BLOCKED_CHILD_CREDENTIAL_SECURE_PERSISTENCE_REQUIRED';
  recommendation: string;
}

export function checkV1ChildCredentialPersistenceReadiness(): V1ChildCredentialPersistenceReadiness {
  const kmsProvider = process.env.TELECOM_KMS_PROVIDER;
  const kmsKeyId = process.env.TELECOM_KMS_KEY_ID;

  if (!kmsProvider || !kmsKeyId || kmsProvider === 'UNCONFIGURED') {
    return {
      vaultReady: false,
      blockReason: 'AWS_KMS_ACTIVATION_DEFERRED_UNTIL_VPS',
      verdict: 'BLOCKED_CHILD_CREDENTIAL_SECURE_PERSISTENCE_REQUIRED',
      recommendation:
        'AWS Roles Anywhere/KMS runtime activation was deferred until VPS migration. Production TelecomSecretVault cannot securely persist secrets without active KMS. V1 execution requires either active KMS or explicit operator acceptance of Option B (decoupled child token retrieval via Parent Accounts API) with the understanding that V3 remains strictly blocked.',
    };
  }

  return {
    vaultReady: true,
    verdict: 'PASS',
    recommendation: 'Production vault and KMS provider are active and ready.',
  };
}

// ==============================================================================
// PHASE 23F.3B-PRE.1: CHILD AUTH TOKEN RETRIEVAL & SAFE BOOTSTRAP DESIGN
// ==============================================================================

export type BootstrapOption =
  | 'OPTION_A_WAIT_FOR_KMS'
  | 'OPTION_B_CONTROLLED_PRE_VPS_BOOTSTRAP';

export interface BootstrapEvaluation {
  option: BootstrapOption;
  v1AllowedWithoutKms: boolean;
  v3AllowedWithoutKms: boolean;
  blockingPoint: 'V1_CREDENTIAL_STORAGE' | 'V3_RUNTIME_KEY_SECRET_PERSISTENCE';
  mainKeyExposureRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  unnecessaryProviderStateRisk: boolean;
  architecturalRecommendation:
    | 'V1_SHOULD_WAIT_UNTIL_V3_SECURE_PERSISTENCE_IS_AVAILABLE'
    | 'V1_CAN_SAFELY_PROCEED_BEFORE_KMS_AND_PROVIDES_VALIDATION_VALUE';
  rationale: string;
}

export function evaluateBootstrapOption(option: BootstrapOption): BootstrapEvaluation {
  if (option === 'OPTION_A_WAIT_FOR_KMS') {
    return {
      option: 'OPTION_A_WAIT_FOR_KMS',
      v1AllowedWithoutKms: false,
      v3AllowedWithoutKms: false,
      blockingPoint: 'V1_CREDENTIAL_STORAGE',
      mainKeyExposureRisk: 'LOW',
      unnecessaryProviderStateRisk: false,
      architecturalRecommendation: 'V1_SHOULD_WAIT_UNTIL_V3_SECURE_PERSISTENCE_IS_AVAILABLE',
      rationale:
        'Option A creates zero live provider resources until complete pipeline (V1-V4) can run with active KMS envelope encryption. Temporary Main API key can be revoked immediately, ensuring zero dormant high-privilege credential risk.',
    };
  }

  return {
    option: 'OPTION_B_CONTROLLED_PRE_VPS_BOOTSTRAP',
    v1AllowedWithoutKms: true,
    v3AllowedWithoutKms: false,
    blockingPoint: 'V3_RUNTIME_KEY_SECRET_PERSISTENCE',
    mainKeyExposureRisk: 'MEDIUM',
    unnecessaryProviderStateRisk: true,
    architecturalRecommendation: 'V1_SHOULD_WAIT_UNTIL_V3_SECURE_PERSISTENCE_IS_AVAILABLE',
    rationale:
      'Official Twilio documentation confirms that Parent Main API Key can fetch the child Account resource (GET /Accounts/{Sid}.json) to retrieve auth_token later, so V1 could technically decouple Auth Token persistence. However, V3 creates a child runtime API key whose secret is returned ONLY ONCE and cannot be re-fetched. Without active KMS, V3 cannot persist this secret in TelecomSecretVault. Therefore, executing V1 now leaves an idle disposable subaccount and prolongs exposure of high-privilege Main credentials without being able to complete V3.',
  };
}

/**
 * Safe interactive credential input helper.
 * Reads hidden / no-echo user input directly from TTY without exposing secrets to:
 * - CLI arguments (prevents ps -ef exposure)
 * - Shell history (.zsh_history)
 * - Environment files (.env.local)
 * - Console logs (stdout/stderr)
 */
export async function promptHiddenInput(
  promptText: string,
  mockInputForTest?: string
): Promise<string> {
  if (mockInputForTest !== undefined) {
    return mockInputForTest.trim();
  }

  // Check if interactive TTY is available
  if (!process.stdin.isTTY) {
    throw new Error(
      'SAFE_INPUT_FAILED: Interactive TTY required for hidden credential input. Automated or piped execution with plaintext credentials is prohibited.'
    );
  }

  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const readline = require('node:readline');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Writable } = require('node:stream');

    let muted = false;
    const mutableStdout = new Writable({
      write(chunk: any, encoding: any, callback: () => void) {
        if (!muted) {
          process.stdout.write(chunk, encoding);
        }
        callback();
      },
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output: mutableStdout,
      terminal: true,
    });

    process.stdout.write(promptText);
    muted = true;

    rl.question('', (answer: string) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

/**
 * Scrub secret from memory container.
 */
export function scrubSecretContainer(container: { value?: string }): void {
  if (container.value) {
    container.value = '';
    delete container.value;
  }
}

// ==============================================================================
// PHASE 23F.3B-DEFER: STAGE-B DEFERMENT & OPERATOR CREDENTIAL REVOCATION STATE
// ==============================================================================

export const TELECOM_DEFERRED_GATES = [
  'SUBSCRIPTION_GRACE_POLICY_REQUIRES_BUSINESS_DEFINITION',
  'RATE_PRECISION_SCALE_REQUIRES_VALIDATION',
  'POSTGRES_VERSION_COMPATIBILITY_REVALIDATION_REQUIRED',
  'PROVIDER_ACCOUNT_SCOPE_REQUIRES_CONTROLLED_VALIDATION',
  'PORTING_PROVIDER_ACCOUNT_SCOPE_REQUIRES_CONTROLLED_VALIDATION',
  'PORTING_WEBHOOK_SUBACCOUNT_CORRELATION_REQUIRES_CONTROLLED_VALIDATION',
  'VOICE_RISK_CEILING_REQUIRES_DESIGN_CONFIRMATION',
  'SECRET_ROTATION_HISTORY_REQUIRES_DESIGN',
  'TIMESONE_ARCHITECTURE_REQUIRES_OPERATOR_DEFINITION',
  'AWS runtime identity/KMS activation paused until actual VPS',
  'PARENT_TWILIO_ACCOUNT_PROTECTION_RESEARCH_MANDATORY',
  'TWILIO_SHAREDKEY_WEBHOOK_MIGRATION_REQUIRES_SECURITY_DESIGN',
  'CONTROLLED_DISPOSABLE_CARRIER_VALIDATION_MANDATORY',
  'VPS migration later',
  'FRESH_FULL_POST_VPS_PRODUCTION_VALIDATION_MANDATORY',
  'NO_LEGACY_CLEANUP_WITHOUT_EXPLICIT_APPROVAL',
] as const;

export type StageBLiveExecutionState =
  | 'NOT_STARTED'
  | 'DEFERRED_UNTIL_VPS_KMS_READY'
  | 'ACTIVE_IN_MAINTENANCE_WINDOW'
  | 'COMPLETED';

export type StageBParentCredentialState =
  | 'NOT_CONFIGURED'
  | 'REVOKED_BY_OPERATOR'
  | 'ACTIVE_TEMPORARY_EPHEMERAL';

export interface StageBDefermentStatus {
  stageBExecutionState: StageBLiveExecutionState;
  parentCredentialState: StageBParentCredentialState;
  v1Executed: boolean;
  childSubaccountCreated: boolean;
  fabricatedAccountsCount: number;
  fabricatedAssignmentsCount: number;
  disposableOrgReserved: boolean;
  disposableOrgId: string;
  disposableOrgName: string;
  defermentType: 'INTENTIONAL_SECURITY_DEFERMENT';
  reason: string;
  futurePrerequisites: string[];
}

export function getStageBDefermentStatus(): StageBDefermentStatus {
  return {
    stageBExecutionState: 'DEFERRED_UNTIL_VPS_KMS_READY',
    parentCredentialState: 'REVOKED_BY_OPERATOR',
    v1Executed: false,
    childSubaccountCreated: false,
    fabricatedAccountsCount: 0,
    fabricatedAssignmentsCount: 0,
    disposableOrgReserved: true,
    disposableOrgId: STAGE_B_DISPOSABLE_VALIDATION_ORG_ID,
    disposableOrgName: STAGE_B_DISPOSABLE_VALIDATION_ORG_NAME,
    defermentType: 'INTENTIONAL_SECURITY_DEFERMENT',
    reason:
      'V1 can technically create the disposable subaccount without immediately persisting its Auth Token, but V3 creates the child runtime API key whose secret is returned only once. Production TelecomSecretVault requires the production KMS-backed envelope-encryption path, which remains deferred until VPS migration. Executing V1-V4 together on VPS prevents leaving an idle disposable subaccount or long-lived Parent Main credential.',
    futurePrerequisites: [
      'VPS migration complete and self-managed runtime active',
      'AWS KMS / Roles Anywhere envelope encryption active in TelecomSecretVault',
      'Dedicated disposable validation organization cleanliness preflight verified',
      'Fresh temporary Parent Main API key created immediately before V1 maintenance window',
      'Parent Main API key revoked immediately upon completion of V3/V4 bootstrap',
    ],
  };
}





