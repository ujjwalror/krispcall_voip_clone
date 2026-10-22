import 'server-only';
import {
  CreatePurchaseOperationParams,
  ProviderNumberOperationService,
  getServiceSupabase,
} from './providerNumberOperationService';
import {
  TwilioPurchasePostParams,
} from './twilioProvisioningAdapter';
import { ProviderNumberOperation, CustomerPurchaseOperationDTO } from './types';
import { ProviderContext } from '@/lib/telecom/provider/types';
import { NumberPurchaseSagaCoordinator } from '@/lib/telecom/saga/numberPurchaseSagaCoordinator';
import { NumberPurchaseReconciliationWorker } from '@/lib/telecom/saga/numberPurchaseReconciliationWorker';

export class ProvisioningEngine {
  /**
   * CANONICAL CHOKE-POINT DELEGATION (Phase 23D.3)
   * All customer phone-number purchases MUST flow through NumberPurchaseSagaCoordinator.
   * Enforces pre-dispatch durability, customer subaccount context, financial authorization,
   * quote validation, and provider outcome reconciliation.
   */
  static async executeLivePurchaseWorkflow(
    params: CreatePurchaseOperationParams,
    postOptions?: Partial<TwilioPurchasePostParams> & { providerContext?: ProviderContext; supabaseClient?: any }
  ): Promise<CustomerPurchaseOperationDTO> {
    const supabase = postOptions?.supabaseClient || getServiceSupabase();
    const result = await NumberPurchaseSagaCoordinator.executePurchase({
      organizationId: params.organizationId,
      phoneNumberE164: params.phoneNumberE164,
      countryCode: params.countryCode,
      numberType: params.numberType,
      idempotencyKey: params.idempotencyKey,
      quoteId: params.quoteId,
      complianceProfileId: params.complianceProfileId,
      regulatoryBundleSid: params.regulatoryBundleSid,
      endUserType: params.endUserType,
      friendlyName: params.friendlyName,
      providerContext: postOptions?.providerContext,
      addressSid: postOptions?.addressSid,
      emergencyAddressSid: postOptions?.emergencyAddressSid,
      voiceUrl: postOptions?.voiceUrl,
      smsUrl: postOptions?.smsUrl,
      statusCallback: postOptions?.statusCallback,
      maxCapacityLimit: params.maxCapacityLimit ?? undefined,
    }, supabase);

    const op = await ProviderNumberOperationService.getOperationById(result.operationId, params.organizationId, supabase);
    if (op) {
      return ProviderNumberOperationService.toCustomerSafeDTO(op);
    }

    return {
      operationId: result.operationId,
      phoneNumberE164: result.phoneNumberE164,
      countryCode: params.countryCode,
      numberType: params.numberType,
      status: result.canonicalState === 'CONFIRMED' ? 'succeeded' : result.canonicalState === 'FAILED' ? 'failed' : 'reconciliation_required',
      retailAmountFormatted: `${params.retailCurrency} ${(params.retailAmountMinor / 100).toFixed(2)}`,
      retailCurrency: params.retailCurrency,
      createdAt: new Date().toISOString(),
      customerMessage: result.customerMessage,
    };
  }

  /**
   * CANONICAL RECOVERY DELEGATION (Phase 23D.3)
   * Recovers stale in_progress, dispatched, or unknown operations via customer subaccount inventory audit.
   * STRICT INVARIANT: NEVER dispatches a purchase POST request.
   */
  static async recoverStaleOperation(
    operationId: string,
    organizationId: string,
    contextOverride?: ProviderContext,
    supabaseClient?: any
  ): Promise<ProviderNumberOperation> {
    const supabase = supabaseClient || getServiceSupabase();
    await NumberPurchaseReconciliationWorker.reconcileOperation(
      operationId,
      organizationId,
      supabase,
      { contextOverride }
    );
    const op = await ProviderNumberOperationService.getOperationById(operationId, organizationId, supabase);
    if (!op) {
      throw new Error(`OPERATION_NOT_FOUND_AFTER_RECONCILIATION: ${operationId}`);
    }
    return op;
  }
}
