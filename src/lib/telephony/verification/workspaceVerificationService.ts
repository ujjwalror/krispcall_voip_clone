/**
 * PHASE 11.3D — WORKSPACE VERIFICATION SERVICE
 * Server-only service managing workspace/account verification state machine,
 * RBAC enforcement, tenant security, and vendor orchestration.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import {
  WorkspaceVerificationRecord,
  WorkspaceVerificationStatus,
  WorkspaceVerificationType,
  CustomerWorkspaceVerificationStatus,
  ALLOWED_VERIFICATION_TRANSITIONS,
} from './types';
import { getWorkspaceVerificationProvider, isMockVerificationEnabled } from './vendorProvider';

export class WorkspaceVerificationService {
  /**
   * Asserts user has Owner or Admin role.
   */
  private static assertOwnerOrAdmin(role: string | null | undefined): void {
    const normalizedRole = (role || '').toLowerCase();
    if (normalizedRole !== 'owner' && normalizedRole !== 'admin') {
      throw new Error('UNAUTHORIZED_ROLE: Workspace verification management requires Owner or Admin role.');
    }
  }

  /**
   * Validates if state transition from currentStatus -> targetStatus is allowed.
   */
  public static isValidTransition(
    currentStatus: WorkspaceVerificationStatus,
    targetStatus: WorkspaceVerificationStatus
  ): boolean {
    if (currentStatus === targetStatus) return true;
    const allowed = ALLOWED_VERIFICATION_TRANSITIONS[currentStatus] || [];
    return allowed.includes(targetStatus);
  }

  /**
   * Retrieves raw DB verification record for an organization (service-role only).
   * Gracefully returns null if table is unmigrated or database is unconfigured.
   */
  public static async getVerificationRecord(
    organizationId: string
  ): Promise<WorkspaceVerificationRecord | null> {
    if (!organizationId) {
      throw new Error('INVALID_ORGANIZATION_ID: Organization ID is required.');
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    if (!supabaseUrl || supabaseUrl.includes('placeholder.supabase.co')) {
      // Unconfigured or placeholder environment (e.g. offline testing before remote SQL application)
      return null;
    }

    try {
      const supabase = createAdminClient();
      const { data, error } = await (supabase as any)
        .from('organization_workspace_verifications')
        .select('*')
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (error) {
        console.warn('[WorkspaceVerificationService] DB query notice (unmigrated table or offline):', error.message || error);
        return null;
      }

      return data as unknown as WorkspaceVerificationRecord | null;
    } catch (err: any) {
      console.warn('[WorkspaceVerificationService] DB connection notice:', err.message || err);
      return null;
    }
  }

  /**
   * Gets customer-safe status representation for UI display.
   * Strips vendor session metadata and sensitive references.
   * Restricts initiate permissions to Owner/Admin roles.
   */
  public static async getCustomerStatus(
    organizationId: string,
    role: string
  ): Promise<CustomerWorkspaceVerificationStatus> {
    const record = await this.getVerificationRecord(organizationId);
    const status: WorkspaceVerificationStatus = record?.status || 'not_started';
    const verificationType: WorkspaceVerificationType = record?.verification_type || 'business';
    const normalizedRole = (role || '').toLowerCase();
    const isOwnerOrAdmin = normalizedRole === 'owner' || normalizedRole === 'admin';

    let headline = 'Account verification';
    let description = 'Verification has not been started.';

    switch (status) {
      case 'not_started':
        headline = 'Account verification';
        description = 'Verification has not been started.';
        break;
      case 'verification_required':
        headline = 'Verify your account';
        description = 'Complete account verification when required to unlock protected features.';
        break;
      case 'under_review':
        headline = 'Verification under review';
        description = 'You can continue using available workspace features while verification is being reviewed.';
        break;
      case 'verified':
        headline = 'Account verified';
        description = 'Your workspace account identity verification is active and complete.';
        break;
      case 'action_required':
        headline = 'Verification needs attention';
        description = 'Additional action is required to complete account verification.';
        break;
      case 'rejected':
        headline = 'Verification unsuccessful';
        description = 'Please review the verification details or contact support.';
        break;
    }

    return {
      status,
      verification_type: verificationType,
      submitted_at: record?.submitted_at || null,
      verified_at: record?.verified_at || null,
      headline,
      description,
      can_initiate: isOwnerOrAdmin && (status === 'not_started' || status === 'verification_required' || status === 'action_required' || status === 'rejected'),
    };
  }

  /**
   * Starts a workspace verification session.
   * Requires Owner or Admin role.
   */
  public static async startVerificationSession(
    organizationId: string,
    verificationType: WorkspaceVerificationType,
    userRole: string
  ): Promise<{ record: WorkspaceVerificationRecord | null; redirect_url?: string }> {
    this.assertOwnerOrAdmin(userRole);

    const existing = await this.getVerificationRecord(organizationId);
    const currentStatus: WorkspaceVerificationStatus = existing?.status || 'not_started';
    const targetStatus: WorkspaceVerificationStatus = 'under_review';

    if (!this.isValidTransition(currentStatus, targetStatus)) {
      throw new Error(`INVALID_TRANSITION: Cannot transition workspace verification from ${currentStatus} to ${targetStatus}.`);
    }

    const now = new Date().toISOString();

    let vendorResult = {
      vendor_provider: 'manual_review',
      vendor_session_id: `sess_${Date.now()}_${organizationId.slice(0, 8)}`,
      vendor_reference_id: `ref_${Date.now()}`,
      redirect_url: undefined as string | undefined,
    };

    if (isMockVerificationEnabled()) {
      const provider = getWorkspaceVerificationProvider();
      const sessionRes = await provider.createSession(organizationId, verificationType);
      vendorResult = {
        vendor_provider: sessionRes.vendor_provider,
        vendor_session_id: sessionRes.vendor_session_id,
        vendor_reference_id: sessionRes.vendor_reference_id,
        redirect_url: sessionRes.redirect_url,
      };
    }

    const upsertPayload = {
      organization_id: organizationId,
      verification_type: verificationType,
      status: targetStatus,
      vendor_provider: vendorResult.vendor_provider,
      vendor_session_id: vendorResult.vendor_session_id,
      vendor_reference_id: vendorResult.vendor_reference_id,
      submitted_at: now,
      updated_at: now,
    };

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    if (!supabaseUrl || supabaseUrl.includes('placeholder.supabase.co')) {
      console.log(`[AUDIT_EVENT] WORKSPACE_VERIFICATION_STARTED org=${organizationId} type=${verificationType} vendor=${vendorResult.vendor_provider}`);
      return {
        record: null,
        redirect_url: vendorResult.redirect_url,
      };
    }

    try {
      const supabase = createAdminClient();
      const { data, error } = await (supabase as any)
        .from('organization_workspace_verifications')
        .upsert(upsertPayload, { onConflict: 'organization_id' })
        .select('*')
        .single();

      if (error) {
        console.warn('[WorkspaceVerificationService] Unapplied migration or offline DB notice on startSession:', error.message);
      }

      console.log(`[AUDIT_EVENT] WORKSPACE_VERIFICATION_STARTED org=${organizationId} type=${verificationType} vendor=${vendorResult.vendor_provider}`);

      return {
        record: (data as unknown as WorkspaceVerificationRecord) || null,
        redirect_url: vendorResult.redirect_url,
      };
    } catch (err: any) {
      console.warn('[WorkspaceVerificationService] Unapplied migration or offline DB notice on startSession:', err.message);
      return {
        record: null,
        redirect_url: vendorResult.redirect_url,
      };
    }
  }

  /**
   * Evaluates or applies vendor verification result server-side.
   * Direct mutation from browser client to 'verified' is forbidden.
   */
  public static async applyVerificationResult(
    organizationId: string,
    targetStatus: WorkspaceVerificationStatus,
    userRole: string,
    vendorDetails?: { provider?: string; sessionId?: string; referenceId?: string }
  ): Promise<WorkspaceVerificationRecord | null> {
    this.assertOwnerOrAdmin(userRole);

    const existing = await this.getVerificationRecord(organizationId);
    const currentStatus: WorkspaceVerificationStatus = existing?.status || 'not_started';

    if (!this.isValidTransition(currentStatus, targetStatus)) {
      throw new Error(`INVALID_TRANSITION: Cannot transition workspace verification from ${currentStatus} to ${targetStatus}.`);
    }

    const now = new Date().toISOString();

    const updatePayload: Record<string, any> = {
      status: targetStatus,
      updated_at: now,
    };

    if (targetStatus === 'verified') {
      updatePayload.verified_at = now;
    }

    if (vendorDetails?.provider) updatePayload.vendor_provider = vendorDetails.provider;
    if (vendorDetails?.sessionId) updatePayload.vendor_session_id = vendorDetails.sessionId;
    if (vendorDetails?.referenceId) updatePayload.vendor_reference_id = vendorDetails.referenceId;

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    if (!supabaseUrl || supabaseUrl.includes('placeholder.supabase.co')) {
      console.log(`[AUDIT_EVENT] WORKSPACE_VERIFICATION_${targetStatus.toUpperCase()} org=${organizationId}`);
      return null;
    }

    try {
      const supabase = createAdminClient();
      if (existing) {
        const { data, error } = await (supabase as any)
          .from('organization_workspace_verifications')
          .update(updatePayload)
          .eq('organization_id', organizationId)
          .select('*')
          .single();

        if (error) {
          console.warn('[WorkspaceVerificationService] DB update notice:', error.message);
        }

        console.log(`[AUDIT_EVENT] WORKSPACE_VERIFICATION_${targetStatus.toUpperCase()} org=${organizationId}`);
        return (data as unknown as WorkspaceVerificationRecord) || null;
      } else {
        const { data, error } = await (supabase as any)
          .from('organization_workspace_verifications')
          .insert({
            organization_id: organizationId,
            verification_type: 'business',
            ...updatePayload,
          })
          .select('*')
          .single();

        if (error) {
          console.warn('[WorkspaceVerificationService] DB insert notice:', error.message);
        }

        console.log(`[AUDIT_EVENT] WORKSPACE_VERIFICATION_${targetStatus.toUpperCase()} org=${organizationId}`);
        return (data as unknown as WorkspaceVerificationRecord) || null;
      }
    } catch (err: any) {
      console.warn('[WorkspaceVerificationService] DB notice:', err.message);
      return null;
    }
  }

  /**
   * Safe mock completion helper for development testing when WORKSPACE_VERIFICATION_MOCK_ENABLED=true.
   */
  public static async applyMockCompletion(
    organizationId: string,
    userRole: string,
    targetStatus: 'verified' | 'rejected' | 'action_required'
  ): Promise<WorkspaceVerificationRecord | null> {
    if (!isMockVerificationEnabled()) {
      throw new Error(
        'MOCK_DISABLED: Mock verification completion requires non-production environment AND WORKSPACE_VERIFICATION_MOCK_ENABLED=true.'
      );
    }
    return this.applyVerificationResult(organizationId, targetStatus, userRole, {
      provider: 'mock_identity_vendor',
      sessionId: `mock_sess_complete_${Date.now()}`,
      referenceId: `mock_ref_complete_${Date.now()}`,
    });
  }
}
