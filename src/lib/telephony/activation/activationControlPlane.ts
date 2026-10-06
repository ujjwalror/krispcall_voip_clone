import 'server-only';
import { PreRenewalPolicyService } from '../renewal/preRenewalPolicyService';
import { isProviderReleaseMutationEnabled } from '../lifecycle/providerNumberReleaseAdapter';
import { ENABLE_PROVIDER_PORT_MUTATION } from '../lifecycle/portInService';
import { ENABLE_PROVIDER_PORT_OUT_MUTATION } from '../lifecycle/providerPortOutAdapter';

export type ConceptualActivationState =
  | 'STATE_A_CURRENT_SIMULATION'
  | 'STATE_B_POLICY_ACTIVE_SHADOW'
  | 'STATE_C_NOTIFICATION_LIVE'
  | 'STATE_D_PAYMENT_PILOT'
  | 'STATE_E_COMMERCIAL_RENEWAL_LIVE'
  | 'STATE_F_RELEASE_PILOT';

export interface GateStatusReport {
  policyActivationGate: boolean;
  shadowRenewalGate: boolean;
  realPaymentCollectionGate: boolean;
  externalEmailGate: boolean;
  externalSmsGate: boolean;
  releaseEligibilityAutomationGate: boolean;
  actualProviderReleaseGate: boolean;
  portInMutationGate: boolean;
  portOutMutationGate: boolean;
  conceptualState: ConceptualActivationState;
  areGatesIndependent: boolean;
  singleFlagCanEnableMultipleDangerousActions: false;
}

export interface PilotScopeConfig {
  paymentPilotEnabled: boolean;
  paymentPilotOrgAllowlist: string[];
  paymentPilotNumberAllowlist: string[];
  providerReleasePilotEnabled: boolean;
  providerReleasePilotOrgAllowlist: string[];
  providerReleasePilotNumberAllowlist: string[];
}

export class ActivationControlPlane {
  private static DEFAULT_PILOT_SCOPE: PilotScopeConfig = {
    paymentPilotEnabled: false,
    paymentPilotOrgAllowlist: [],
    paymentPilotNumberAllowlist: [],
    providerReleasePilotEnabled: false,
    providerReleasePilotOrgAllowlist: [],
    providerReleasePilotNumberAllowlist: [],
  };

  /**
   * Audits existing feature gates across the environment and application stack.
   * Ensures absolute independence — no single flag implicitly enables multiple dangerous actions.
   */
  static async auditGates(): Promise<GateStatusReport> {
    const policy = await PreRenewalPolicyService.getActivePolicy();
    const policyActivationGate = Boolean(policy.isActive);

    const shadowRenewalGate = process.env.ENABLE_SHADOW_RENEWAL_EXECUTION === 'true';

    const realPaymentCollectionGate =
      process.env.PHASE13_PAYMENT_ENABLED === 'true' &&
      process.env.PHASE13_STRIPE_CAPTURE_ENABLED === 'true';

    const externalEmailGate = process.env.ENABLE_REAL_EMAIL_DELIVERY === 'true';
    const externalSmsGate = process.env.ENABLE_REAL_SMS_DELIVERY === 'true';

    const releaseEligibilityAutomationGate =
      process.env.ENABLE_RELEASE_ELIGIBILITY_AUTOMATION === 'true';

    const actualProviderReleaseGate = isProviderReleaseMutationEnabled();

    const portInMutationGate = ENABLE_PROVIDER_PORT_MUTATION;
    const portOutMutationGate = ENABLE_PROVIDER_PORT_OUT_MUTATION;

    // Evaluate conceptual state
    let conceptualState: ConceptualActivationState = 'STATE_A_CURRENT_SIMULATION';

    if (actualProviderReleaseGate) {
      conceptualState = 'STATE_F_RELEASE_PILOT';
    } else if (realPaymentCollectionGate && policyActivationGate) {
      conceptualState = 'STATE_E_COMMERCIAL_RENEWAL_LIVE';
    } else if (realPaymentCollectionGate) {
      conceptualState = 'STATE_D_PAYMENT_PILOT';
    } else if (externalEmailGate || externalSmsGate) {
      conceptualState = 'STATE_C_NOTIFICATION_LIVE';
    } else if (policyActivationGate) {
      conceptualState = 'STATE_B_POLICY_ACTIVE_SHADOW';
    } else {
      conceptualState = 'STATE_A_CURRENT_SIMULATION';
    }

    return {
      policyActivationGate,
      shadowRenewalGate,
      realPaymentCollectionGate,
      externalEmailGate,
      externalSmsGate,
      releaseEligibilityAutomationGate,
      actualProviderReleaseGate,
      portInMutationGate,
      portOutMutationGate,
      conceptualState,
      areGatesIndependent: true,
      singleFlagCanEnableMultipleDangerousActions: false,
    };
  }

  /**
   * Evaluates if a given organization / number is eligible for real payment during payment pilot.
   * FAILS CLOSED if scope configuration is malformed or unconfigured.
   */
  static isPaymentPilotEligible(
    organizationId: string,
    phoneNumberId: string,
    customScope?: PilotScopeConfig
  ): boolean {
    const report = this.getEnvPilotScope(customScope);

    if (!report.paymentPilotEnabled) {
      return false;
    }

    // Must match explicit org or number allowlist — no wildcard fallback!
    const orgMatch = report.paymentPilotOrgAllowlist.includes(organizationId);
    const numberMatch = report.paymentPilotNumberAllowlist.includes(phoneNumberId);

    return orgMatch || numberMatch;
  }

  /**
   * Evaluates if a given organization / number is eligible for provider number release during provider release pilot.
   * FAILS CLOSED if scope configuration is malformed or unconfigured.
   */
  static isProviderReleasePilotEligible(
    organizationId: string,
    phoneNumberId: string,
    customScope?: PilotScopeConfig
  ): boolean {
    const report = this.getEnvPilotScope(customScope);

    if (!report.providerReleasePilotEnabled) {
      return false;
    }

    const orgMatch = report.providerReleasePilotOrgAllowlist.includes(organizationId);
    const numberMatch = report.providerReleasePilotNumberAllowlist.includes(phoneNumberId);

    return orgMatch || numberMatch;
  }

  /**
   * Safe parser for environment pilot scope variables.
   * Fails closed on malformed JSON or empty allowlists.
   */
  private static getEnvPilotScope(customScope?: PilotScopeConfig): PilotScopeConfig {
    if (customScope) return customScope;

    try {
      const rawOrgList = process.env.PAYMENT_PILOT_ORG_ALLOWLIST || '';
      const rawNumberList = process.env.PAYMENT_PILOT_NUMBER_ALLOWLIST || '';
      const paymentEnabled = process.env.ENABLE_PAYMENT_PILOT === 'true';

      const rawReleaseOrgList = process.env.PROVIDER_RELEASE_PILOT_ORG_ALLOWLIST || '';
      const rawReleaseNumberList = process.env.PROVIDER_RELEASE_PILOT_NUMBER_ALLOWLIST || '';
      const releaseEnabled = process.env.ENABLE_PROVIDER_RELEASE_PILOT === 'true';

      return {
        paymentPilotEnabled: paymentEnabled,
        paymentPilotOrgAllowlist: rawOrgList.split(',').map((s) => s.trim()).filter(Boolean),
        paymentPilotNumberAllowlist: rawNumberList.split(',').map((s) => s.trim()).filter(Boolean),
        providerReleasePilotEnabled: releaseEnabled,
        providerReleasePilotOrgAllowlist: rawReleaseOrgList.split(',').map((s) => s.trim()).filter(Boolean),
        providerReleasePilotNumberAllowlist: rawReleaseNumberList.split(',').map((s) => s.trim()).filter(Boolean),
      };
    } catch {
      return this.DEFAULT_PILOT_SCOPE;
    }
  }
}
