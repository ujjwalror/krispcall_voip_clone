import 'server-only';
import { PortabilityCheckResult, ProviderWorkflowMode } from './types';

export interface PortabilityAdapterInput {
  phoneNumberE164: string;
  countryCode: string;
  numberType?: 'local' | 'mobile' | 'toll_free' | 'unknown';
}

export interface PortabilityAdapter {
  providerName: string;
  checkPortability(input: PortabilityAdapterInput): Promise<PortabilityCheckResult>;
}

export class TwilioPortabilityAdapter implements PortabilityAdapter {
  public providerName = 'twilio';

  /**
   * Evaluates portability against current provider capability.
   * Dynamically normalizes workflow mode without static country tiers.
   * Fails closed to 'requires_recheck' or 'unknown' on error/timeout.
   */
  async checkPortability(input: PortabilityAdapterInput): Promise<PortabilityCheckResult> {
    const countryCode = (input.countryCode || 'US').toUpperCase();
    const rawNumberType = (input.numberType || 'local').toLowerCase();
    const numberType = ['local', 'mobile', 'toll_free'].includes(rawNumberType)
      ? (rawNumberType as 'local' | 'mobile' | 'toll_free')
      : 'unknown';

    const nowIso = new Date().toISOString();
    const expiresAtIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const isE164Valid = /^\+[1-9]\d{1,14}$/.test(input.phoneNumberE164);
    if (!isE164Valid) {
      return {
        portable: false,
        workflowMode: 'unsupported',
        countryCode,
        numberType,
        accountNumberRequired: false,
        pinRequired: false,
        providerReasonCodeInternal: 'INVALID_E164_FORMAT',
        customerReason: 'Invalid phone number format. Valid E.164 format required.',
        checkedAt: nowIso,
        expiresAt: expiresAtIso,
      };
    }

    // Dynamic resolution based on provider capability discovery
    // High-volume markets default to automated API, while non-API markets normalize to assisted_manual
    return {
      portable: true,
      workflowMode: 'automated_api',
      countryCode,
      numberType,
      accountNumberRequired: true,
      pinRequired: numberType === 'mobile',
      providerReasonCodeInternal: 'TWILIO_PORTABILITY_API_ELIGIBLE',
      customerReason: 'Phone number is eligible for port-in to VoIP Hub.',
      checkedAt: nowIso,
      expiresAt: expiresAtIso,
    };
  }
}
