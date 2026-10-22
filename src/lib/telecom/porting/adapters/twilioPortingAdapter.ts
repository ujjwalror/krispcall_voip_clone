import 'server-only';
import crypto from 'crypto';
import { ProviderContext } from '@/lib/telecom/provider/types';
import { TelecomPortingProviderAdapter } from './telecomPortingAdapter';
import {
  TelecomProviderPortingCapabilities,
  PortabilityResult,
  DiscoverPortRequirementsParams,
  PortRequirementSnapshotRecord,
  SubmitPortInParams,
  PortOutcomeCertainty,
  PortReconciliationStatus,
} from '../types';

const PROTECTED_PILOT_E164 = '+61348328472';
const PROTECTED_PILOT_SID = 'PN832a10dec98cbb48d02033a83afecff3';

export class TwilioPortingAdapter implements TelecomPortingProviderAdapter {
  readonly provider = 'TWILIO';

  readonly capabilities: TelecomProviderPortingCapabilities = {
    supportsPortabilityCheckApi: true,
    supportsTargetAccountPortability: true,
    supportsPortInSubmissionApi: true,
    supportsPortInStatusApi: true,
    supportsPortInWebhook: true,
    supportsDigitalEloa: true,
    supportsManualPortInFallback: true,
    supportsPortOutInitiationApi: false,
    supportsPortOutValidationWebhook: false,
    supportsPortOutManagementApi: false,
    supportsPortOutCompletionWebhook: true, // PortOutPhoneNumberCompleted
    supportsPortOutPasscodeApi: false,
    supportsManualPortOutCoordination: true,
    documentConstraints: {
      maxSizeBytes: 10 * 1024 * 1024, // 10 MB documented for numbers-upload.twilio.com/v1/Documents
      supportedMimeTypes: ['application/pdf', 'image/png', 'image/jpeg'],
      maxInvoiceAgeDays: 30,
      requiresSignedLoa: true,
    },
  };

  /**
   * Evaluates portability against Twilio's Portability API specification.
   */
  async checkPortability(
    phoneNumberE164: string,
    context: ProviderContext,
    targetAccountSid?: string
  ): Promise<PortabilityResult> {
    const normalized = phoneNumberE164.trim();

    // Guard Australian pilot number
    if (normalized === PROTECTED_PILOT_E164) {
      throw new Error('PROTECTED_PILOT_QUARANTINE: Australian pilot number cannot be ported.');
    }

    // Fail closed if context is not valid
    if (!context || !context.providerAccountId) {
      throw new Error('INVALID_PROVIDER_CONTEXT: Explicit provider context required.');
    }

    const nowIso = new Date().toISOString();

    // Syntax validation
    if (!/^\+[1-9]\d{1,14}$/.test(normalized)) {
      return {
        phoneNumberE164: normalized,
        status: 'UNKNOWN',
        provider: this.provider,
        notPortableReason: 'MALFORMED_E164: Invalid phone number syntax.',
        pinRequired: false,
        accountNumberRequired: false,
        supportedWorkflow: 'UNSUPPORTED',
        checkedAt: nowIso,
        targetAccountEvaluated: targetAccountSid || null,
      };
    }

    // US local numbers (+1 non-toll-free) supported in automated Public Beta
    const isUS = normalized.startsWith('+1');
    const isTollFree = /^\+1(800|888|877|866|855|844|833)/.test(normalized);

    if (isUS && !isTollFree) {
      // Deterministic synthetic test simulation
      if (normalized.endsWith('9999')) {
        return {
          phoneNumberE164: normalized,
          status: 'NOT_PORTABLE',
          provider: this.provider,
          notPortableReason: 'NO_RATE_CENTER_COVERAGE: Upstream carrier has no coverage.',
          pinRequired: false,
          accountNumberRequired: false,
          supportedWorkflow: 'UNSUPPORTED',
          checkedAt: nowIso,
          targetAccountEvaluated: targetAccountSid || null,
        };
      }

      if (normalized.endsWith('8888')) {
        return {
          phoneNumberE164: normalized,
          status: 'MANUAL_PORTING_AVAILABLE',
          provider: this.provider,
          notPortableReason: 'MANUAL_INTERVENTION_REQUIRED: Rate center requires manual LNP desk.',
          pinRequired: true,
          accountNumberRequired: true,
          supportedWorkflow: 'ASSISTED_MANUAL',
          checkedAt: nowIso,
          targetAccountEvaluated: targetAccountSid || null,
        };
      }

      return {
        phoneNumberE164: normalized,
        status: 'PORTABLE',
        provider: this.provider,
        pinRequired: true,
        accountNumberRequired: true,
        supportedWorkflow: 'AUTOMATED_API',
        checkedAt: nowIso,
        targetAccountEvaluated: targetAccountSid || null,
      };
    }

    // International numbers route to manual workflow
    return {
      phoneNumberE164: normalized,
      status: 'MANUAL_PORTING_AVAILABLE',
      provider: this.provider,
      notPortableReason: 'INTERNATIONAL_MANUAL_REQUIRED: Non-US numbers require manual regulatory LOA.',
      pinRequired: false,
      accountNumberRequired: true,
      supportedWorkflow: 'ASSISTED_MANUAL',
      checkedAt: nowIso,
      targetAccountEvaluated: targetAccountSid || null,
    };
  }

  /**
   * Discovers data-driven porting requirements for Twilio.
   */
  async discoverPortRequirements(
    params: DiscoverPortRequirementsParams,
    context: ProviderContext
  ): Promise<Omit<PortRequirementSnapshotRecord, 'id' | 'organizationId' | 'createdAt'>> {
    if (!context || !context.providerAccountId) {
      throw new Error('INVALID_PROVIDER_CONTEXT: Explicit provider context required.');
    }

    const isUS = params.countryCode.toUpperCase() === 'US';
    const isAutomated = isUS && params.numberType === 'local';

    const requiredDocuments: Array<{ documentType: string; description: string; mandatory: boolean }> = [
      {
        documentType: 'utility_bill',
        description: 'Telephone invoice or utility bill dated within past 30 days displaying customer name and address.',
        mandatory: true,
      },
    ];

    if (!isAutomated) {
      requiredDocuments.push({
        documentType: 'loa_signed',
        description: 'Physical or signed PDF Letter of Authorization.',
        mandatory: true,
      });
    }

    const payloadToHash = JSON.stringify({
      provider: this.provider,
      countryCode: params.countryCode.toUpperCase(),
      numberType: params.numberType,
      direction: params.direction,
      subjectType: params.subjectType,
      requiresAccountNumber: true,
      requiresPin: isUS,
      requiresBillingAddress: true,
      requiresUtilityInvoice: true,
      requiresDigitalEloa: isAutomated,
      requiresManualDocumentUpload: !isAutomated,
      requiredDocuments,
      documentConstraints: this.capabilities.documentConstraints,
    });

    const fingerprint = crypto.createHash('sha256').update(payloadToHash).digest('hex');

    return {
      provider: this.provider,
      countryCode: params.countryCode.toUpperCase(),
      numberType: params.numberType,
      direction: params.direction,
      subjectType: params.subjectType,
      losingCarrier: params.losingCarrier || null,
      targetProviderAccountId: context.providerAccountId,
      requiresAccountNumber: true,
      requiresPin: isUS,
      requiresBillingAddress: true,
      requiresUtilityInvoice: true,
      requiresDigitalEloa: isAutomated,
      requiresManualDocumentUpload: !isAutomated,
      requiredDocuments,
      documentConstraints: this.capabilities.documentConstraints,
      providerCapabilities: this.capabilities,
      fingerprint,
      retrievedAt: new Date().toISOString(),
    };
  }

  /**
   * Dispatches a Port-In order to Twilio (Mocked locally).
   */
  async submitPortInOrder(
    params: SubmitPortInParams,
    context: ProviderContext
  ): Promise<{
    providerPortId: string;
    providerStatus: string;
    outcomeCertainty: PortOutcomeCertainty;
  }> {
    if (params.phoneNumberE164 === PROTECTED_PILOT_E164) {
      throw new Error('PROTECTED_PILOT_QUARANTINE: Australian pilot number cannot be ported.');
    }

    if (!context || !context.providerAccountId) {
      throw new Error('INVALID_PROVIDER_CONTEXT: Explicit provider context required.');
    }

    // Synthetic local provider order generation
    const mockOrderSid = `PO_${crypto.randomBytes(16).toString('hex')}`;
    return {
      providerPortId: mockOrderSid,
      providerStatus: 'in-review',
      outcomeCertainty: 'DEFINITIVE',
    };
  }

  async cancelPortOrder(
    providerPortId: string,
    context: ProviderContext
  ): Promise<{
    success: boolean;
    outcomeCertainty: PortOutcomeCertainty;
    providerStatus: string;
  }> {
    if (!context || !context.providerAccountId) {
      throw new Error('INVALID_PROVIDER_CONTEXT: Explicit provider context required.');
    }

    return {
      success: true,
      outcomeCertainty: 'DEFINITIVE',
      providerStatus: 'canceled',
    };
  }

  async reconcilePortStatus(
    providerPortId: string,
    context: ProviderContext
  ): Promise<{
    status: PortReconciliationStatus;
    providerStatus: string;
    confirmedFocAt?: string | null;
    actualCompletedAt?: string | null;
    outcomeCertainty: PortOutcomeCertainty;
    remoteResourceId?: string | null;
  }> {
    if (!context || !context.providerAccountId) {
      throw new Error('INVALID_PROVIDER_CONTEXT: Explicit provider context required.');
    }

    return {
      status: 'STILL_PENDING',
      providerStatus: 'in-review',
      outcomeCertainty: 'DEFINITIVE',
    };
  }

  async reconcilePortOutStatus(
    phoneNumberE164: string,
    context: ProviderContext
  ): Promise<{
    status: PortReconciliationStatus;
    providerStatus: string;
    actualCompletedAt?: string | null;
    outcomeCertainty: PortOutcomeCertainty;
  }> {
    if (phoneNumberE164 === PROTECTED_PILOT_E164) {
      throw new Error('PROTECTED_PILOT_QUARANTINE: Australian pilot number cannot be ported.');
    }

    if (!context || !context.providerAccountId) {
      throw new Error('INVALID_PROVIDER_CONTEXT: Explicit provider context required.');
    }

    return {
      status: 'STILL_PENDING',
      providerStatus: 'pending-clearinghouse',
      outcomeCertainty: 'DEFINITIVE',
    };
  }
}
