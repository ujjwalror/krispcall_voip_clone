import 'server-only';
import { ProviderContext } from '../types';
import {
  ProviderComplianceAdapter,
  CreateAddressParams,
  CreateEndUserParams,
  CreateSupportingDocumentParams,
  CreateBundleParams,
  AssignItemParams,
  RequestEvaluationParams,
  SubmitBundleParams,
} from '@/lib/telephony/compliance/providerComplianceAdapter';
import { TwilioProviderComplianceAdapter } from '@/lib/telephony/compliance/twilioComplianceAdapter';

export interface ComplianceProviderAdapterWrapper {
  getUnderlyingAdapter(context: ProviderContext): ProviderComplianceAdapter;
}

export class DefaultComplianceProviderAdapter implements ComplianceProviderAdapterWrapper {
  getUnderlyingAdapter(context: ProviderContext): ProviderComplianceAdapter {
    if (context.provider === 'TWILIO') {
      return new TwilioProviderComplianceAdapter();
    }
    throw new Error(`COMPLIANCE_UNSUPPORTED: Compliance submissions for provider '${context.provider}' are not supported.`);
  }
}
