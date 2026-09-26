import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  ComplianceOperationStatus,
  ComplianceOperationType,
  ComplianceResourceType,
  ProviderComplianceOperation,
} from './types';
import { ComplianceFingerprintService, FingerprintPayload } from './complianceFingerprint';

const ALLOWED_ROLES = ['owner', 'admin'];

export class ProviderOperationService {
  /**
   * Verifies that the given user has owner or admin role within the organization.
   */
  static async verifyUserRole(organizationId: string, userId: string | null, userRole?: string, clientOverride?: any): Promise<void> {
    if (!userId && !userRole) {
      throw new Error('UNAUTHORIZED: Authentication required.');
    }

    if (userRole) {
      if (!ALLOWED_ROLES.includes(userRole.toLowerCase())) {
        throw new Error(`UNAUTHORIZED_ROLE: Provider compliance operations require owner or admin role access.`);
      }
      return;
    }

    const supabase = clientOverride || (createAdminClient() as any);
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('role, organization_id')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      throw new Error('UNAUTHORIZED: User profile not found.');
    }

    if (profile.organization_id !== organizationId) {
      throw new Error('FORBIDDEN: Cross-tenant access denied.');
    }

    if (!ALLOWED_ROLES.includes((profile.role || '').toLowerCase())) {
      throw new Error('UNAUTHORIZED_ROLE: Provider compliance operations require owner or admin role access.');
    }
  }

  /**
   * Creates a durable operation record BEFORE executing external provider mutation.
   * Fails closed if database table or connection is unavailable.
   */
  static async getOrCreateOperation(
    organizationId: string,
    complianceProfileId: string,
    operationType: ComplianceOperationType,
    idempotencyKey: string,
    fingerprintPayload: FingerprintPayload,
    userRole?: string,
    userId?: string | null,
    clientOverride?: any
  ): Promise<{ operation: ProviderComplianceOperation; isExisting: boolean }> {
    if (userId !== undefined || userRole !== undefined) {
      await this.verifyUserRole(organizationId, userId || null, userRole, clientOverride);
    }

    const supabase = clientOverride || (createAdminClient() as any);
    const requestFingerprint = ComplianceFingerprintService.generateRequestFingerprint(fingerprintPayload);

    // 1. Query existing operation record from database
    const { data: existing, error: selectErr } = await supabase
      .from('provider_compliance_operations')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();

    if (selectErr) {
      throw new Error(`DB_FAIL_CLOSED: Database operation query failed: ${selectErr.message}`);
    }

    if (existing) {
      return {
        operation: this.mapRowToOperation(existing),
        isExisting: true,
      };
    }

    // 2. Insert new pending operation record into database
    const { data: created, error: insertErr } = await supabase
      .from('provider_compliance_operations')
      .insert({
        organization_id: organizationId,
        compliance_profile_id: complianceProfileId,
        provider: 'twilio',
        operation_type: operationType,
        idempotency_key: idempotencyKey,
        status: 'pending',
        attempt_count: 0,
        request_fingerprint: requestFingerprint,
      })
      .select()
      .single();

    if (insertErr) {
      // Handle database unique constraint race condition
      if (insertErr.code === '23505') {
        const { data: raced, error: raceErr } = await supabase
          .from('provider_compliance_operations')
          .select('*')
          .eq('organization_id', organizationId)
          .eq('idempotency_key', idempotencyKey)
          .single();
        if (raceErr || !raced) {
          throw new Error(`DB_FAIL_CLOSED: Idempotency race resolution failed: ${raceErr?.message}`);
        }
        return { operation: this.mapRowToOperation(raced), isExisting: true };
      }
      throw new Error(`DB_FAIL_CLOSED: Failed to insert durable operation record: ${insertErr.message}`);
    }

    return { operation: this.mapRowToOperation(created), isExisting: false };
  }

  /**
   * Transitions operation from 'pending' or 'failed' to 'in_progress' using an ATOMIC
   * single-query database update. Exactly ONE worker acquires execution ownership.
   */
  static async startOperation(
    organizationId: string,
    operationId: string,
    clientOverride?: any
  ): Promise<ProviderComplianceOperation> {
    const supabase = clientOverride || (createAdminClient() as any);

    // 1. Fetch current operation state to determine attempt count & existing status
    const { data: current, error: fetchErr } = await supabase
      .from('provider_compliance_operations')
      .select('*')
      .eq('id', operationId)
      .eq('organization_id', organizationId)
      .single();

    if (fetchErr || !current) {
      throw new Error(`DB_FAIL_CLOSED: Operation '${operationId}' not found.`);
    }

    if (current.status === 'succeeded') {
      throw new Error(`INVALID_STATE: Operation '${operationId}' already succeeded.`);
    }
    if (current.status === 'in_progress') {
      throw new Error(`CONCURRENT_EXECUTION: Operation '${operationId}' is currently in progress.`);
    }
    if (current.status === 'reconciliation_required') {
      throw new Error(`RECONCILIATION_REQUIRED: Operation '${operationId}' requires provider status reconciliation before retry.`);
    }

    const nextAttemptCount = (current.attempt_count || 0) + 1;

    // 2. Atomic SQL Conditional Update
    const { data: updated, error: updateErr } = await supabase
      .from('provider_compliance_operations')
      .update({
        status: 'in_progress',
        attempt_count: nextAttemptCount,
        started_at: new Date().toISOString(),
      })
      .eq('id', operationId)
      .eq('organization_id', organizationId)
      .in('status', ['pending', 'failed'])
      .select()
      .single();

    if (updateErr || !updated) {
      throw new Error(`CONCURRENT_EXECUTION: Failed to acquire execution lock on operation '${operationId}'. Another worker started execution.`);
    }

    return this.mapRowToOperation(updated);
  }

  /**
   * Completes an operation successfully and records provider resource metadata in database.
   */
  static async completeOperation(
    organizationId: string,
    operationId: string,
    resourceType: ComplianceResourceType,
    resourceId: string,
    clientOverride?: any
  ): Promise<ProviderComplianceOperation> {
    const supabase = clientOverride || (createAdminClient() as any);

    const { data: updated, error } = await supabase
      .from('provider_compliance_operations')
      .update({
        status: 'succeeded',
        provider_resource_type: resourceType,
        provider_resource_id: resourceId,
        completed_at: new Date().toISOString(),
      })
      .eq('id', operationId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !updated) {
      throw new Error(`DB_FAIL_CLOSED: Failed to complete operation: ${error?.message}`);
    }

    return this.mapRowToOperation(updated);
  }

  /**
   * Marks an operation as failed for known pre-provider or safe rejections.
   */
  static async failOperation(
    organizationId: string,
    operationId: string,
    errorCode: string,
    rawErrorMessage: string,
    clientOverride?: any
  ): Promise<ProviderComplianceOperation> {
    const supabase = clientOverride || (createAdminClient() as any);
    const sanitizedMsg = ComplianceFingerprintService.sanitizeErrorMessage(errorCode, rawErrorMessage);

    const { data: updated, error } = await supabase
      .from('provider_compliance_operations')
      .update({
        status: 'failed',
        last_error_code: errorCode,
        last_error_message_sanitized: sanitizedMsg,
      })
      .eq('id', operationId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !updated) {
      throw new Error(`DB_FAIL_CLOSED: Failed to update operation failure: ${error?.message}`);
    }

    return this.mapRowToOperation(updated);
  }

  /**
   * Marks an operation as 'reconciliation_required' when network timeouts occur.
   */
  static async markReconciliationRequired(
    organizationId: string,
    operationId: string,
    errorCode: string,
    rawErrorMessage: string,
    clientOverride?: any
  ): Promise<ProviderComplianceOperation> {
    const supabase = clientOverride || (createAdminClient() as any);
    const sanitizedMsg = ComplianceFingerprintService.sanitizeErrorMessage(errorCode, rawErrorMessage);

    const { data: updated, error } = await supabase
      .from('provider_compliance_operations')
      .update({
        status: 'reconciliation_required',
        last_error_code: errorCode,
        last_error_message_sanitized: sanitizedMsg,
      })
      .eq('id', operationId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !updated) {
      throw new Error(`DB_FAIL_CLOSED: Failed to mark operation as reconciliation_required: ${error?.message}`);
    }

    return this.mapRowToOperation(updated);
  }

  /**
   * Fetches operation by idempotency key with strict tenant boundary.
   */
  static async getOperationByIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
    clientOverride?: any
  ): Promise<ProviderComplianceOperation | null> {
    const supabase = clientOverride || (createAdminClient() as any);

    const { data, error } = await supabase
      .from('provider_compliance_operations')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();

    if (error) {
      throw new Error(`DB_FAIL_CLOSED: Operation query failed: ${error.message}`);
    }

    return data ? this.mapRowToOperation(data) : null;
  }

  private static mapRowToOperation(row: any): ProviderComplianceOperation {
    return {
      id: row.id,
      organizationId: row.organization_id,
      complianceProfileId: row.compliance_profile_id,
      provider: row.provider,
      operationType: row.operation_type,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      attemptCount: row.attempt_count || 0,
      providerResourceType: row.provider_resource_type,
      providerResourceId: row.provider_resource_id,
      requestFingerprint: row.request_fingerprint,
      lastErrorCode: row.last_error_code,
      lastErrorMessageSanitized: row.last_error_message_sanitized,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      lastReconciledAt: row.last_reconciled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
