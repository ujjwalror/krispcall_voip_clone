/**
 * PHASE 11.3D — WORKSPACE VERIFICATION POLICY SERVICE
 * Configurable feature restriction foundation.
 *
 * CRITICAL RULE (Requirements 12 & 13):
 * Must NOT hard-block normal customer actions merely because workspace verification is currently NOT_STARTED.
 * Preserves existing functionality by default while providing a server-authoritative policy framework
 * for future risk policy enforcement.
 */

import { WorkspaceVerificationStatus, VerificationPolicyCheckResult } from './types';
import { WorkspaceVerificationService } from './workspaceVerificationService';

export interface WorkspaceFeaturePolicyConfig {
  requireVerifiedForNumberPurchase: boolean;
  requireVerifiedForOutboundCalling: boolean;
  requireVerifiedForOutboundMessaging: boolean;
  requireVerifiedForNumberPorting: boolean;
  requireVerifiedForHighRiskFeatures: boolean;
}

/**
 * Default workspace policy configuration for Phase 11.3D.
 * Default is FALSE for all basic actions so NOT_STARTED does NOT arbitrarily break existing product features.
 */
export const DEFAULT_WORKSPACE_POLICY: WorkspaceFeaturePolicyConfig = {
  requireVerifiedForNumberPurchase: false,
  requireVerifiedForOutboundCalling: false,
  requireVerifiedForOutboundMessaging: false,
  requireVerifiedForNumberPorting: false,
  requireVerifiedForHighRiskFeatures: true, // Example protected high-risk feature
};

export class WorkspacePolicyService {
  private static policyConfig: WorkspaceFeaturePolicyConfig = { ...DEFAULT_WORKSPACE_POLICY };

  /**
   * Overrides policy configuration (e.g., for environment-specific risk tuning).
   */
  public static setPolicyConfig(config: Partial<WorkspaceFeaturePolicyConfig>): void {
    this.policyConfig = { ...this.policyConfig, ...config };
  }

  /**
   * Gets current policy configuration.
   */
  public static getPolicyConfig(): WorkspaceFeaturePolicyConfig {
    return { ...this.policyConfig };
  }

  /**
   * Checks if an organization can purchase phone numbers based on workspace verification status.
   * Default: ALLOWED even if NOT_STARTED (phone-number regulatory bundle verification handles number compliance independently).
   */
  public static async canPurchaseNumber(organizationId: string): Promise<VerificationPolicyCheckResult> {
    if (!this.policyConfig.requireVerifiedForNumberPurchase) {
      return { allowed: true };
    }

    const record = await WorkspaceVerificationService.getVerificationRecord(organizationId);
    const status: WorkspaceVerificationStatus = record?.status || 'not_started';

    if (status === 'verified') {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: 'Workspace identity verification is required before purchasing phone numbers under current risk policy.',
    };
  }

  /**
   * Checks if outbound calling is permitted.
   */
  public static async canUseOutboundCalling(organizationId: string): Promise<VerificationPolicyCheckResult> {
    if (!this.policyConfig.requireVerifiedForOutboundCalling) {
      return { allowed: true };
    }
    const record = await WorkspaceVerificationService.getVerificationRecord(organizationId);
    const status = record?.status || 'not_started';
    return status === 'verified'
      ? { allowed: true }
      : { allowed: false, reason: 'Workspace identity verification required for outbound calling.' };
  }

  /**
   * Checks if outbound messaging is permitted.
   */
  public static async canUseOutboundMessaging(organizationId: string): Promise<VerificationPolicyCheckResult> {
    if (!this.policyConfig.requireVerifiedForOutboundMessaging) {
      return { allowed: true };
    }
    const record = await WorkspaceVerificationService.getVerificationRecord(organizationId);
    const status = record?.status || 'not_started';
    return status === 'verified'
      ? { allowed: true }
      : { allowed: false, reason: 'Workspace identity verification required for outbound messaging.' };
  }

  /**
   * Checks if number porting is permitted.
   */
  public static async canPortNumber(organizationId: string): Promise<VerificationPolicyCheckResult> {
    if (!this.policyConfig.requireVerifiedForNumberPorting) {
      return { allowed: true };
    }
    const record = await WorkspaceVerificationService.getVerificationRecord(organizationId);
    const status = record?.status || 'not_started';
    return status === 'verified'
      ? { allowed: true }
      : { allowed: false, reason: 'Workspace identity verification required to port numbers.' };
  }

  /**
   * Checks if high risk features (e.g. bulk outbound, high-cost international destinations) are permitted.
   */
  public static async canUseHighRiskFeature(organizationId: string): Promise<VerificationPolicyCheckResult> {
    if (!this.policyConfig.requireVerifiedForHighRiskFeatures) {
      return { allowed: true };
    }
    const record = await WorkspaceVerificationService.getVerificationRecord(organizationId);
    const status = record?.status || 'not_started';
    return status === 'verified'
      ? { allowed: true }
      : { allowed: false, reason: 'Workspace identity verification required for protected high-risk features.' };
  }
}
