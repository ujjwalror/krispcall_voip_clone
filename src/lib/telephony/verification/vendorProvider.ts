/**
 * PHASE 11.3D — WORKSPACE VERIFICATION VENDOR PROVIDER ABSTRACTION
 * Minimal provider abstraction for future identity/KYC vendor integration (e.g. Persona, Stripe Identity).
 *
 * MOCK PROVIDER SAFETY RULES:
 * 1. Must NOT enable mock verification merely because NODE_ENV !== 'production'.
 * 2. Requires BOTH NODE_ENV !== 'production' AND WORKSPACE_VERIFICATION_MOCK_ENABLED === 'true'.
 * 3. Default: disabled / fails closed.
 */

import { WorkspaceVerificationStatus, WorkspaceVerificationType, VerificationSessionResult } from './types';

export interface WorkspaceVerificationVendorProvider {
  providerId: string;
  createSession(
    organizationId: string,
    verificationType: WorkspaceVerificationType
  ): Promise<VerificationSessionResult>;
  getStatus(sessionId: string): Promise<WorkspaceVerificationStatus>;
  verifyWebhookSignature(payload: string, signature: string, secret: string): Promise<boolean>;
}

/**
 * Checks whether mock verification is safely allowed in current environment.
 * Strict dual-gate enforcement:
 * - NODE_ENV !== 'production'
 * - process.env.WORKSPACE_VERIFICATION_MOCK_ENABLED === 'true'
 */
export function isMockVerificationEnabled(): boolean {
  const isNonProd = process.env.NODE_ENV !== 'production';
  const isMockExplicitlyEnabled = process.env.WORKSPACE_VERIFICATION_MOCK_ENABLED === 'true';
  return isNonProd && isMockExplicitlyEnabled;
}

export class MockWorkspaceVerificationVendor implements WorkspaceVerificationVendorProvider {
  readonly providerId = 'mock_identity_vendor';

  async createSession(
    organizationId: string,
    verificationType: WorkspaceVerificationType
  ): Promise<VerificationSessionResult> {
    if (!isMockVerificationEnabled()) {
      throw new Error(
        'Mock workspace verification is disabled. Requires non-production environment AND WORKSPACE_VERIFICATION_MOCK_ENABLED=true.'
      );
    }

    const sessionId = `mock_sess_${Date.now()}_${organizationId.slice(0, 8)}`;
    const referenceId = `mock_ref_${Date.now()}`;

    return {
      vendor_provider: this.providerId,
      vendor_session_id: sessionId,
      vendor_reference_id: referenceId,
      redirect_url: `/settings/verification?mock_session_id=${sessionId}`,
      status: 'under_review',
    };
  }

  async getStatus(sessionId: string): Promise<WorkspaceVerificationStatus> {
    if (!isMockVerificationEnabled()) {
      throw new Error('Mock workspace verification is disabled.');
    }
    // Mock vendor defaults session evaluation to 'under_review' or 'verified' when tested
    return 'verified';
  }

  async verifyWebhookSignature(payload: string, signature: string, secret: string): Promise<boolean> {
    if (!isMockVerificationEnabled()) {
      return false;
    }
    return signature === `mock_sig_${secret}`;
  }
}

/**
 * Factory to get active provider.
 * Currently defaults to Mock provider if enabled, otherwise throws fail-closed error.
 */
export function getWorkspaceVerificationProvider(): WorkspaceVerificationVendorProvider {
  if (isMockVerificationEnabled()) {
    return new MockWorkspaceVerificationVendor();
  }
  throw new Error('No live identity verification vendor configured and mock verification is disabled.');
}
