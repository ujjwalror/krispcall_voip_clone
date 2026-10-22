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

export interface MockPortingAdapterOptions {
  providerName?: string;
  supportsPortabilityCheckApi?: boolean;
  supportsPortInSubmissionApi?: boolean;
  capabilityOverrides?: Partial<TelecomProviderPortingCapabilities>;
  simulateTimeoutOnSubmit?: boolean;
  simulateServerErrorOnPortability?: boolean;
  simulateMalformedPortability?: boolean;
  simulateManualOnly?: boolean;
  simulateCancellationTimeout?: boolean;
  forcedReconciliationStatus?: PortReconciliationStatus;
  mockStatusResponse?: {
    status?: string;
    outcomeCertainty?: PortOutcomeCertainty;
    providerRawStatus?: string;
  };
  forcedConfirmedFocAt?: string | null;
  forcedCompletedAt?: string | null;
  forcedRemoteResourceId?: string | null;
  onPortInSubmission?: () => void;
}

export class MockPortingAdapter implements TelecomPortingProviderAdapter {
  readonly provider: string;
  private options: MockPortingAdapterOptions;

  readonly capabilities: TelecomProviderPortingCapabilities;

  constructor(options: MockPortingAdapterOptions = {}) {
    this.options = options;
    this.provider = options.providerName || 'TELNYX';

    this.capabilities = {
      supportsPortabilityCheckApi: options.supportsPortabilityCheckApi !== undefined ? options.supportsPortabilityCheckApi : true,
      supportsTargetAccountPortability: false,
      supportsPortInSubmissionApi: options.supportsPortInSubmissionApi !== undefined ? options.supportsPortInSubmissionApi : true,
      supportsPortInStatusApi: true,
      supportsPortInWebhook: true,
      supportsDigitalEloa: false,
      supportsManualPortInFallback: true,
      supportsPortOutInitiationApi: true,
      supportsPortOutValidationWebhook: true,
      supportsPortOutManagementApi: true,
      supportsPortOutCompletionWebhook: true,
      supportsPortOutPasscodeApi: true,
      supportsManualPortOutCoordination: true,
      documentConstraints: {
        maxSizeBytes: 50 * 1024 * 1024, // 50 MB
        supportedMimeTypes: ['application/pdf', 'image/png'],
        maxInvoiceAgeDays: 30,
        requiresSignedLoa: true,
      },
      ...options.capabilityOverrides,
    };
  }

  setOptions(options: Partial<MockPortingAdapterOptions>) {
    this.options = { ...this.options, ...options };
  }

  async checkPortability(
    phoneNumberE164: string,
    context: ProviderContext,
    targetAccountSid?: string
  ): Promise<PortabilityResult> {
    const normalized = phoneNumberE164.trim();
    const nowIso = new Date().toISOString();

    if (this.options.simulateServerErrorOnPortability) {
      return {
        phoneNumberE164: normalized,
        status: 'UNKNOWN',
        provider: this.provider,
        notPortableReason: 'PROVIDER_HTTP_500: Internal carrier gateway failure.',
        pinRequired: false,
        accountNumberRequired: false,
        supportedWorkflow: 'UNSUPPORTED',
        checkedAt: nowIso,
        targetAccountEvaluated: targetAccountSid || null,
      };
    }

    if (this.options.simulateMalformedPortability) {
      return {
        phoneNumberE164: normalized,
        status: 'UNKNOWN',
        provider: this.provider,
        notPortableReason: 'MALFORMED_RESPONSE: Gateway returned invalid schema.',
        pinRequired: false,
        accountNumberRequired: false,
        supportedWorkflow: 'UNSUPPORTED',
        checkedAt: nowIso,
        targetAccountEvaluated: targetAccountSid || null,
      };
    }

    if (this.options.simulateManualOnly) {
      return {
        phoneNumberE164: normalized,
        status: 'MANUAL_PORTING_AVAILABLE',
        provider: this.provider,
        notPortableReason: 'MANUAL_PORT_ONLY: Carrier requires manual service desk.',
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

  async discoverPortRequirements(
    params: DiscoverPortRequirementsParams,
    context: ProviderContext
  ): Promise<Omit<PortRequirementSnapshotRecord, 'id' | 'organizationId' | 'createdAt'>> {
    const payloadToHash = JSON.stringify({
      provider: this.provider,
      countryCode: params.countryCode.toUpperCase(),
      numberType: params.numberType,
      direction: params.direction,
      subjectType: params.subjectType,
      requiresAccountNumber: true,
      requiresPin: true,
      requiresBillingAddress: true,
      requiresUtilityInvoice: true,
      requiresDigitalEloa: false,
      requiresManualDocumentUpload: true,
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
      requiresPin: true,
      requiresBillingAddress: true,
      requiresUtilityInvoice: true,
      requiresDigitalEloa: false,
      requiresManualDocumentUpload: true,
      requiredDocuments: [
        {
          documentType: 'utility_bill',
          description: 'Telephone invoice or utility bill.',
          mandatory: true,
        },
        {
          documentType: 'loa_signed',
          description: 'Signed Letter of Authorization PDF.',
          mandatory: true,
        },
      ],
      documentConstraints: this.capabilities.documentConstraints,
      providerCapabilities: this.capabilities,
      fingerprint,
      retrievedAt: new Date().toISOString(),
    };
  }

  async submitPortInOrder(
    params: SubmitPortInParams,
    context: ProviderContext
  ): Promise<{
    providerPortId: string;
    providerStatus: string;
    outcomeCertainty: PortOutcomeCertainty;
  }> {
    if (this.options.onPortInSubmission) {
      this.options.onPortInSubmission();
    }

    if (this.options.simulateTimeoutOnSubmit) {
      return {
        providerPortId: '',
        providerStatus: 'timeout_or_network_error',
        outcomeCertainty: 'UNCERTAIN',
      };
    }

    const mockOrderSid = `mock_order_${crypto.randomBytes(12).toString('hex')}`;
    return {
      providerPortId: mockOrderSid,
      providerStatus: 'submitted',
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
    if (this.options.simulateCancellationTimeout) {
      return {
        success: false,
        outcomeCertainty: 'UNCERTAIN',
        providerStatus: 'unknown_cancel_timeout',
      };
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
    const status =
      (this.options.mockStatusResponse?.status as any) ||
      this.options.forcedReconciliationStatus ||
      'STILL_PENDING';
    const providerStatus =
      this.options.mockStatusResponse?.providerRawStatus || status.toLowerCase();
    const outcomeCertainty =
      this.options.mockStatusResponse?.outcomeCertainty || 'DEFINITIVE';
    return {
      status,
      providerStatus,
      confirmedFocAt: this.options.forcedConfirmedFocAt || null,
      actualCompletedAt: this.options.forcedCompletedAt || null,
      outcomeCertainty,
      remoteResourceId: this.options.forcedRemoteResourceId || null,
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
    const status = this.options.forcedReconciliationStatus || 'STILL_PENDING';
    return {
      status,
      providerStatus: status.toLowerCase(),
      actualCompletedAt: this.options.forcedCompletedAt || null,
      outcomeCertainty: 'DEFINITIVE',
    };
  }
}
