import 'server-only';
import {
  ProviderNumberOperationService,
  CreatePurchaseOperationParams,
} from './providerNumberOperationService';
import {
  TwilioProvisioningAdapter,
  TwilioPurchasePostParams,
} from './twilioProvisioningAdapter';
import { RegulatoryProvisioningContextResolver } from '../compliance/regulatoryProvisioningContextResolver';
import { CommercialPricingService } from '../marketplace/commercialPricingService';
import { RetailPricingService } from '../marketplace/pricingService';
import { ProviderNumberOperation, CustomerPurchaseOperationDTO } from './types';

export class ProvisioningEngine {
  /**
   * Executes the LIVE purchase workflow:
   * 1. Creates/reuses operation in 'pending' status
   * 2. Performs launch enablement refresh & commercial retail snapshot comparison
   * 3. Performs regulatory provisioning context refresh
   * 4. Performs exact E.164 availability GET BEFORE atomic claim
   * 5. Atomically claims dispatch permission to 'in_progress' with tenant predicate
   * 6. IMMEDIATELY dispatches IncomingPhoneNumbers POST to Twilio (no network calls in between)
   * 7. Handles outcome (succeeded, deterministic failed, or ambiguous reconciliation_required)
   */
  static async executeLivePurchaseWorkflow(
    params: CreatePurchaseOperationParams,
    postOptions?: Partial<TwilioPurchasePostParams>
  ): Promise<CustomerPurchaseOperationDTO> {
    // 1. Create or reuse pending operation row
    const pendingOp = await ProviderNumberOperationService.createPurchaseOperationPending(params);

    // If operation already reached terminal or active processing state, return customer DTO
    if (pendingOp.status !== 'pending') {
      return ProviderNumberOperationService.toCustomerSafeDTO(pendingOp);
    }

    // 2. Commercial Launch & Pricing Snapshot Refresh (BEFORE claim)
    const enablement = await CommercialPricingService.evaluateCommercialEnablement(
      pendingOp.countryCode,
      pendingOp.numberType
    );
    if (!enablement.launchEnabled) {
      const failedOp = await ProviderNumberOperationService.markOperationFailed(
        pendingOp.id,
        'LAUNCH_DISABLED',
        enablement.customerMessage || 'Purchases for this country/number type are currently disabled.'
      );
      return ProviderNumberOperationService.toCustomerSafeDTO(failedOp);
    }

    const currentRetail = await RetailPricingService.resolveRetailPrice(
      pendingOp.countryCode,
      pendingOp.numberType
    );
    if (
      !currentRetail.hasConfiguredPrice ||
      currentRetail.monthlyPriceMinor !== pendingOp.retailAmountMinor ||
      currentRetail.currency.toUpperCase() !== pendingOp.retailCurrency.toUpperCase()
    ) {
      const failedOp = await ProviderNumberOperationService.markOperationFailed(
        pendingOp.id,
        'RETAIL_PRICE_CHANGED',
        'Customer retail pricing changed since purchase intent creation. Review required.'
      );
      return ProviderNumberOperationService.toCustomerSafeDTO(failedOp);
    }

    // 3. Regulatory Provisioning Context Refresh (BEFORE claim)
    let regResolution: { bundleSid?: string | null; addressSid?: string | null };
    try {
      regResolution = await RegulatoryProvisioningContextResolver.resolveProvisioningContext({
        organizationId: pendingOp.organizationId,
        countryCode: pendingOp.countryCode,
        numberType: pendingOp.numberType,
        endUserType: params.endUserType,
        complianceProfileId: pendingOp.complianceProfileId,
        regulatoryBundleSid: pendingOp.regulatoryBundleSid,
        addressSid: params.addressSid,
      });
    } catch (regErr: any) {
      const failedOp = await ProviderNumberOperationService.markOperationFailed(
        pendingOp.id,
        'REGULATORY_CONTEXT_FAILED',
        regErr.message || 'Regulatory provisioning context validation failed.'
      );
      return ProviderNumberOperationService.toCustomerSafeDTO(failedOp);
    }

    // 4. Exact E.164 Provider Availability GET (BEFORE claim)
    const recheck = await TwilioProvisioningAdapter.recheckNumberAvailability(
      pendingOp.phoneNumberE164,
      pendingOp.countryCode,
      pendingOp.numberType
    );

    if (!recheck.available) {
      const failedOp = await ProviderNumberOperationService.markOperationFailed(
        pendingOp.id,
        'NUMBER_NO_LONGER_AVAILABLE',
        'Selected phone number is no longer available in live provider inventory.'
      );
      return ProviderNumberOperationService.toCustomerSafeDTO(failedOp);
    }

    // 5. Atomic Claim pending -> in_progress (Tenant predicate enforced)
    let inProgressOp: ProviderNumberOperation;
    try {
      inProgressOp = await ProviderNumberOperationService.claimOperationForDispatch(
        pendingOp.id,
        pendingOp.organizationId
      );
    } catch (claimErr: any) {
      const current = await ProviderNumberOperationService.getOperationById(
        pendingOp.id,
        pendingOp.organizationId
      );
      if (current) {
        return ProviderNumberOperationService.toCustomerSafeDTO(current);
      }
      throw claimErr;
    }

    // 6. IMMEDIATELY Dispatch Provider POST (NO avoidable network calls between claim and POST)
    const postParams: TwilioPurchasePostParams = {
      phoneNumberE164: inProgressOp.phoneNumberE164,
      bundleSid: regResolution.bundleSid || inProgressOp.regulatoryBundleSid,
      addressSid: regResolution.addressSid || postOptions?.addressSid,
      emergencyAddressSid: postOptions?.emergencyAddressSid,
      voiceUrl: postOptions?.voiceUrl,
      smsUrl: postOptions?.smsUrl,
      statusCallback: postOptions?.statusCallback,
    };

    const postResult = await TwilioProvisioningAdapter.executePurchasePost(postParams);

    // 7. Evaluate POST outcome
    if (postResult.success) {
      const succeededOp = await ProviderNumberOperationService.markOperationSucceeded(
        inProgressOp.id,
        postResult.sid,
        postResult.status,
        inProgressOp.providerCostMinor,
        inProgressOp.providerCostCurrency
      );
      return ProviderNumberOperationService.toCustomerSafeDTO(succeededOp);
    }

    if (postResult.deterministicFailure) {
      const failedOp = await ProviderNumberOperationService.markOperationFailed(
        inProgressOp.id,
        postResult.errorCode,
        postResult.errorMessage
      );
      return ProviderNumberOperationService.toCustomerSafeDTO(failedOp);
    }

    // Ambiguous failure -> fail toward reconciliation_required
    const reconOp = await ProviderNumberOperationService.markOperationReconciliationRequired(
      inProgressOp.id,
      postResult.errorCode,
      postResult.errorMessage
    );
    return ProviderNumberOperationService.toCustomerSafeDTO(reconOp);
  }

  /**
   * Executes the RECOVERY workflow for a stale in_progress or reconciliation_required operation.
   * STRICT INVARIANT: NEVER dispatches a purchase POST request.
   */
  static async recoverStaleOperation(
    operationId: string,
    organizationId: string
  ): Promise<ProviderNumberOperation> {
    const op = await ProviderNumberOperationService.getOperationById(operationId, organizationId);
    if (!op) throw new Error('OPERATION_NOT_FOUND');

    // Terminal operations do not require recovery
    if (op.status === 'succeeded' || op.status === 'failed') {
      return op;
    }

    // If stale in_progress, transition to reconciliation_required (no POST)
    if (op.status === 'in_progress') {
      await ProviderNumberOperationService.markOperationReconciliationRequired(
        op.id,
        'STALE_IN_PROGRESS_RECOVERED',
        'Process recovered stale in_progress operation. Provider status ambiguous.'
      );
    }

    // Reconcile via authoritative provider account inventory lookup
    return await ProviderNumberOperationService.reconcileOperation(
      op.id,
      async (phoneNumberE164: string) => {
        const lookup = await TwilioProvisioningAdapter.lookupOwnedNumberByE164(phoneNumberE164);
        if (lookup.found && lookup.sid) {
          return {
            found: true,
            resourceId: lookup.sid,
            status: lookup.status || 'active',
          };
        }
        return {
          found: false,
        };
      }
    );
  }
}
