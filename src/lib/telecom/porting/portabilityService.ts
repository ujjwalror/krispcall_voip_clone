import 'server-only';
import { ProviderContext } from '@/lib/telecom/provider/types';
import { TelecomPortingProviderAdapter } from './adapters/telecomPortingAdapter';
import { PortabilityResult } from './types';

const PROTECTED_PILOT_E164 = '+61348328472';

export class PortabilityService {
  /**
   * Checks whether a phone number can be ported to VoIP Hub via the specified provider.
   * STRICT FAIL-CLOSED INVARIANTS:
   * - Timeouts, 5xx errors, malformed responses, or unsupported APIs fail closed to UNKNOWN, NEVER PORTABLE.
   * - Portability indicates network/rate-center coverage, NOT proof of ownership.
   * - MANUAL_PORTING_AVAILABLE routes to assisted manual LNP rather than permanent rejection.
   * - Quarantined Australian pilot number is permanently shielded.
   */
  static async checkPortability(
    phoneNumberE164: string,
    adapter: TelecomPortingProviderAdapter,
    context: ProviderContext,
    targetAccountSid?: string
  ): Promise<PortabilityResult> {
    const normalized = phoneNumberE164 ? String(phoneNumberE164).replace(/[\s\(\)\-\.]/g, '') : '';

    if (normalized === PROTECTED_PILOT_E164) {
      throw new Error('PROTECTED_PILOT_QUARANTINE: Australian pilot number cannot be ported.');
    }

    if (!context || !context.providerAccountId) {
      throw new Error('INVALID_PROVIDER_CONTEXT: ProviderContext is required for portability evaluation.');
    }

    if (!adapter.capabilities?.supportsPortabilityCheckApi) {
      return {
        phoneNumberE164: normalized,
        status: adapter.capabilities?.supportsManualPortInFallback ? 'MANUAL_PORTING_AVAILABLE' : 'NOT_PORTABLE',
        provider: adapter.provider,
        supportedWorkflow: adapter.capabilities?.supportsManualPortInFallback ? 'ASSISTED_MANUAL' : 'UNSUPPORTED',
        notPortableReason: 'PORTABILITY_CHECK_API_UNSUPPORTED: Automated portability check not supported by provider adapter.',
        pinRequired: false,
        accountNumberRequired: false,
        checkedAt: new Date().toISOString(),
        targetAccountEvaluated: targetAccountSid || null,
      };
    }

    try {
      const result = await adapter.checkPortability(normalized, context, targetAccountSid);

      // Defensively ensure UNKNOWN does not become PORTABLE
      if (
        result.status !== 'PORTABLE' &&
        result.status !== 'NOT_PORTABLE' &&
        result.status !== 'MANUAL_PORTING_AVAILABLE'
      ) {
        return {
          ...result,
          status: 'UNKNOWN',
          supportedWorkflow: 'UNSUPPORTED',
        };
      }

      return result;
    } catch (err: any) {
      if (err.message && err.message.includes('PROTECTED_PILOT_QUARANTINE')) {
        throw err;
      }

      // Any network error, timeout, or unexpected exception fails closed to UNKNOWN
      return {
        phoneNumberE164: normalized,
        status: 'UNKNOWN',
        provider: adapter.provider,
        notPortableReason: `PORTABILITY_CHECK_FAILED: ${err.message || 'Carrier gateway failure'}`,
        pinRequired: false,
        accountNumberRequired: false,
        supportedWorkflow: 'UNSUPPORTED',
        checkedAt: new Date().toISOString(),
        targetAccountEvaluated: targetAccountSid || null,
      };
    }
  }
}
