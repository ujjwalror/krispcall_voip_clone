import 'server-only';
import { ProviderContext, TelecomProvider } from '@/lib/telecom/provider/types';
import {
  TelecomProviderPortingCapabilities,
  PortabilityResult,
  DiscoverPortRequirementsParams,
  PortRequirementSnapshotRecord,
  SubmitPortInParams,
  PortOutcomeCertainty,
  PortReconciliationStatus,
} from '../types';

export interface TelecomPortingProviderAdapter {
  readonly provider: TelecomProvider | string;
  readonly capabilities: TelecomProviderPortingCapabilities;

  checkPortability(
    phoneNumberE164: string,
    context: ProviderContext,
    targetAccountSid?: string
  ): Promise<PortabilityResult>;

  discoverPortRequirements(
    params: DiscoverPortRequirementsParams,
    context: ProviderContext
  ): Promise<Omit<PortRequirementSnapshotRecord, 'id' | 'organizationId' | 'createdAt'>>;

  submitPortInOrder(
    params: SubmitPortInParams,
    context: ProviderContext
  ): Promise<{
    providerPortId: string;
    providerStatus: string;
    outcomeCertainty: PortOutcomeCertainty;
  }>;

  cancelPortOrder(
    providerPortId: string,
    context: ProviderContext
  ): Promise<{
    success: boolean;
    outcomeCertainty: PortOutcomeCertainty;
    providerStatus: string;
  }>;

  reconcilePortStatus(
    providerPortId: string,
    context: ProviderContext
  ): Promise<{
    status: PortReconciliationStatus;
    providerStatus: string;
    confirmedFocAt?: string | null;
    actualCompletedAt?: string | null;
    outcomeCertainty: PortOutcomeCertainty;
    remoteResourceId?: string | null;
  }>;

  reconcilePortOutStatus(
    phoneNumberE164: string,
    context: ProviderContext
  ): Promise<{
    status: PortReconciliationStatus;
    providerStatus: string;
    actualCompletedAt?: string | null;
    outcomeCertainty: PortOutcomeCertainty;
  }>;
}
