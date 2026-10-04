import 'server-only';
import { PortabilityCheckResult, ProviderWorkflowMode } from './types';
import { PortabilityAdapter, TwilioPortabilityAdapter } from './portabilityAdapter';

export interface EvaluatePortabilityInput {
  phoneNumberE164: string;
  countryCode?: string;
  numberType?: 'local' | 'mobile' | 'toll_free' | 'unknown';
  adapter?: PortabilityAdapter;
  providerMockResponse?: {
    portable?: boolean | null;
    workflowMode?: ProviderWorkflowMode;
    accountNumberRequired?: boolean;
    pinRequired?: boolean;
    providerReasonCodeInternal?: string;
    customerReason?: string;
    isTimeoutOr5xx?: boolean;
    isMalformed?: boolean;
  };
}

export class PortabilityService {
  /**
   * Evaluates portability eligibility dynamically via provider adapter.
   * STRICT INVARIANT: NO static country tiers! Workflow mode is derived dynamically.
   * Fail closed: Timeout, 5xx, or malformed response -> 'requires_recheck' or 'unknown', NOT portable=true.
   */
  static async evaluatePortability(
    input: EvaluatePortabilityInput
  ): Promise<PortabilityCheckResult> {
    const rawE164 = input.phoneNumberE164 ? String(input.phoneNumberE164).replace(/[\s\(\)\-\.]/g, '') : '';
    const isE164Valid = /^\+[1-9]\d{1,14}$/.test(rawE164);
    const countryCode = (input.countryCode || 'US').toUpperCase();
    const rawNumberType = (input.numberType || 'local').toLowerCase();
    const numberType = ['local', 'mobile', 'toll_free'].includes(rawNumberType)
      ? (rawNumberType as 'local' | 'mobile' | 'toll_free')
      : 'unknown';

    const nowIso = new Date().toISOString();
    const expiresAtIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    if (!isE164Valid) {
      return {
        portable: false,
        workflowMode: 'unsupported',
        countryCode,
        numberType,
        accountNumberRequired: false,
        pinRequired: false,
        providerReasonCodeInternal: 'INVALID_E164_FORMAT',
        customerReason: 'Invalid phone number format. Valid E.164 number is required.',
        checkedAt: nowIso,
        expiresAt: expiresAtIso,
      };
    }

    // Optional test mock override for unit testing edge cases
    if (input.providerMockResponse) {
      const mock = input.providerMockResponse;

      // FAIL CLOSED on provider timeout, 5xx, or malformed response
      if (mock.isTimeoutOr5xx || mock.isMalformed) {
        return {
          portable: null,
          workflowMode: 'requires_recheck',
          countryCode,
          numberType,
          accountNumberRequired: false,
          pinRequired: false,
          providerReasonCodeInternal: mock.isTimeoutOr5xx ? 'PROVIDER_TIMEOUT_5XX' : 'PROVIDER_MALFORMED_RESPONSE',
          customerReason: 'Portability check is temporarily unavailable. Please retry later or contact support.',
          checkedAt: nowIso,
          expiresAt: expiresAtIso,
        };
      }

      return {
        portable: mock.portable ?? true,
        workflowMode: mock.workflowMode || 'automated_api',
        countryCode,
        numberType,
        accountNumberRequired: mock.accountNumberRequired ?? true,
        pinRequired: mock.pinRequired ?? false,
        providerReasonCodeInternal: mock.providerReasonCodeInternal || 'TWILIO_PORTABILITY_VERIFIED',
        customerReason: mock.customerReason || 'Phone number is eligible for port-in to VoIP Hub.',
        checkedAt: nowIso,
        expiresAt: expiresAtIso,
      };
    }

    const adapter = input.adapter || new TwilioPortabilityAdapter();

    try {
      return await adapter.checkPortability({
        phoneNumberE164: rawE164,
        countryCode,
        numberType,
      });
    } catch (err: any) {
      // FAIL CLOSED on adapter exception
      return {
        portable: null,
        workflowMode: 'unknown',
        countryCode,
        numberType,
        accountNumberRequired: false,
        pinRequired: false,
        providerReasonCodeInternal: 'ADAPTER_EXCEPTION_FAIL_CLOSED',
        customerReason: 'Portability check could not be completed. Please retry later.',
        checkedAt: nowIso,
        expiresAt: expiresAtIso,
      };
    }
  }
}
