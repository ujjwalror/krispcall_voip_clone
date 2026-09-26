/**
 * PHASE 11.3D — ACCOUNT / WORKSPACE VERIFICATION FOUNDATION
 * Domain types for platform trust & account verification (completely separate from phone-number regulatory compliance).
 */

export type WorkspaceVerificationType = 'business' | 'individual';

export type WorkspaceVerificationStatus =
  | 'not_started'
  | 'verification_required'
  | 'under_review'
  | 'verified'
  | 'action_required'
  | 'rejected';

export interface WorkspaceVerificationRecord {
  id: string;
  organization_id: string;
  verification_type: WorkspaceVerificationType;
  status: WorkspaceVerificationStatus;
  vendor_provider: string | null;
  vendor_session_id: string | null;
  vendor_reference_id: string | null;
  submitted_at: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerWorkspaceVerificationStatus {
  status: WorkspaceVerificationStatus;
  verification_type: WorkspaceVerificationType;
  submitted_at: string | null;
  verified_at: string | null;
  headline: string;
  description: string;
  can_initiate: boolean;
}

export interface VerificationSessionRequest {
  verification_type: WorkspaceVerificationType;
}

export interface VerificationSessionResult {
  vendor_provider: string;
  vendor_session_id: string;
  vendor_reference_id: string;
  redirect_url?: string;
  status: WorkspaceVerificationStatus;
}

export interface VerificationPolicyCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Valid state transitions for the workspace verification state machine.
 * Direct mutation from client to 'verified' is NEVER allowed.
 * Status 'verified' can only be set via server-side vendor processing/mock completion.
 */
export const ALLOWED_VERIFICATION_TRANSITIONS: Record<WorkspaceVerificationStatus, WorkspaceVerificationStatus[]> = {
  not_started: ['verification_required', 'under_review'],
  verification_required: ['under_review'],
  under_review: ['verified', 'action_required', 'rejected'],
  action_required: ['under_review'],
  rejected: ['under_review'],
  verified: ['under_review'], // Allows re-verification if explicit reset
};
