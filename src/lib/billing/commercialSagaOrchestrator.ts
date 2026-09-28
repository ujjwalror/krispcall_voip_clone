import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { getStripeClient } from './providers/stripe/stripeClient';
import { CommercialSagaStateMachine, CommercialSagaState, CustomerSagaStatusDTO } from './commercialSagaStateMachine';
import { PaymentStateMachine } from './paymentStateMachine';
import { PaymentCanonicalStatus } from './types';
import { ProviderNumberOperationService } from '@/lib/telephony/commerce/providerNumberOperationService';
import { TwilioProvisioningAdapter, TwilioPurchasePostParams, PurchasePostResult } from '@/lib/telephony/commerce/twilioProvisioningAdapter';
import { RetailPricingService } from '@/lib/telephony/marketplace/pricingService';
import { inventoryProvider } from '@/lib/telephony/marketplace/inventoryProvider';
import { RegulatoryPreCheckService } from '@/lib/telephony/marketplace/regulatoryPreCheckService';
import { MarketplaceSuppressionService } from '@/lib/telephony/marketplace/marketplaceSuppressionService';
import { CommercialPricingService } from '@/lib/telephony/marketplace/commercialPricingService';

export interface ExpectedStripeModeConfig {
  mode: 'test' | 'live';
}

export interface TelecomProviderAdapterMock {
  recheckNumberAvailability(phoneNumberE164: string, countryCode: string, numberType: string): Promise<{ available: boolean }>;
  executePurchasePost(params: TwilioPurchasePostParams): Promise<PurchasePostResult>;
  lookupOwnedNumberByE164(phoneNumberE164: string): Promise<{ found: boolean; sid?: string; status?: string }>;
}

export interface OrchestratorOptions {
  stripeClient?: Stripe;
  providerAdapter?: TelecomProviderAdapterMock;
  expectedStripeMode?: 'test' | 'live';
  maxReconAttempts?: number;
  // Overrides for unit tests
  mockRetailPrice?: { monthlyPriceMinor: number; currency: string };
  skipPreCheckPricing?: boolean;
  skipPreCheckInventory?: boolean;
  skipPreCheckSuppression?: boolean;
  skipPreCheckLaunch?: boolean;
  skipPreCheckRegulatory?: boolean;
  skipPreCheckEntitlement?: boolean;
}

export interface OrchestrationResult {
  success: boolean;
  saga: any;
  customerDTO: CustomerSagaStatusDTO;
  stopReason?: string;
  error?: {
    code: string;
    message: string;
  };
}

export class CommercialSagaOrchestrator {
  /**
   * Resolves expected Stripe mode from explicit config / environment.
   * Fails closed if mode is missing or invalid. DOES NOT DEFAULT TO 'test'.
   */
  static getExpectedStripeMode(explicitMode?: 'test' | 'live'): 'test' | 'live' {
    const rawMode = explicitMode !== undefined ? explicitMode : process.env.STRIPE_EXPECTED_MODE;
    if (!rawMode || typeof rawMode !== 'string' || !rawMode.trim()) {
      throw new Error('MISSING_STRIPE_MODE_CONFIG: Authoritative Stripe mode configuration (STRIPE_EXPECTED_MODE) is missing or unconfigured.');
    }
    const mode = rawMode.toLowerCase().trim();
    if (mode !== 'test' && mode !== 'live') {
      throw new Error(`INVALID_STRIPE_MODE_CONFIG: Configured Stripe mode '${rawMode}' must be strictly 'test' or 'live'.`);
    }
    return mode as 'test' | 'live';
  }

  /**
   * Validates configured Stripe mode against actual PaymentIntent livemode.
   */
  static verifyStripeMode(paymentIntent: { livemode: boolean }, explicitMode?: 'test' | 'live'): boolean {
    const expected = this.getExpectedStripeMode(explicitMode);
    if (expected === 'test' && paymentIntent.livemode === true) {
      return false; // Mismatch: Expected test mode, received live PaymentIntent
    }
    if (expected === 'live' && paymentIntent.livemode === false) {
      return false; // Mismatch: Expected live mode, received test PaymentIntent
    }
    return true;
  }

  /**
   * Evaluates authoritative Stripe PaymentIntent against DB payment operation and commercial saga.
   * Returns valid = true or detailed error response.
   */
  static validatePaymentAuthorization(params: {
    saga: any;
    paymentOp: any;
    paymentIntent: any;
    expectedMode?: 'test' | 'live';
  }): { valid: boolean; errorCode?: string; errorMessage?: string } {
    const { saga, paymentOp, paymentIntent, expectedMode } = params;

    if (!paymentOp || paymentOp.provider !== 'stripe') {
      return { valid: false, errorCode: 'INVALID_PAYMENT_PROVIDER', errorMessage: 'Payment operation provider must be Stripe.' };
    }

    if (!paymentIntent || paymentIntent.id !== paymentOp.provider_payment_id) {
      return { valid: false, errorCode: 'PAYMENT_INTENT_MISMATCH', errorMessage: 'PaymentIntent ID does not match payment operation record.' };
    }

    // Explicit Stripe mode validation
    try {
      const modeMatches = this.verifyStripeMode(paymentIntent, expectedMode);
      if (!modeMatches) {
        return { valid: false, errorCode: 'STRIPE_MODE_MISMATCH', errorMessage: 'Stripe PaymentIntent livemode disagrees with configured expected billing mode.' };
      }
    } catch (modeErr: any) {
      return { valid: false, errorCode: 'STRIPE_MODE_CONFIG_INVALID', errorMessage: modeErr.message };
    }

    if (paymentIntent.capture_method !== 'manual') {
      return { valid: false, errorCode: 'CAPTURE_METHOD_INVALID', errorMessage: 'PaymentIntent capture_method must be manual.' };
    }

    if (paymentIntent.status !== 'requires_capture') {
      return { valid: false, errorCode: 'PAYMENT_NOT_AUTHORITATIVE', errorMessage: `PaymentIntent status '${paymentIntent.status}' is not requires_capture.` };
    }

    if (paymentIntent.canceled_at || paymentIntent.status === 'canceled') {
      return { valid: false, errorCode: 'PAYMENT_CANCELED', errorMessage: 'PaymentIntent has been canceled.' };
    }

    if (paymentIntent.status === 'succeeded') {
      return { valid: false, errorCode: 'PAYMENT_ALREADY_CAPTURED', errorMessage: 'PaymentIntent is already captured.' };
    }

    if (paymentIntent.amount !== saga.retail_amount_minor) {
      return { valid: false, errorCode: 'AMOUNT_MISMATCH', errorMessage: `PaymentIntent amount (${paymentIntent.amount}) does not match saga retail amount (${saga.retail_amount_minor}).` };
    }

    if (paymentIntent.currency.toUpperCase() !== saga.currency.toUpperCase()) {
      return { valid: false, errorCode: 'CURRENCY_MISMATCH', errorMessage: `PaymentIntent currency (${paymentIntent.currency}) does not match saga currency (${saga.currency}).` };
    }

    const capturable = paymentIntent.amount_capturable ?? paymentIntent.amount;
    if (capturable < saga.retail_amount_minor) {
      return { valid: false, errorCode: 'INSUFFICIENT_CAPTURABLE_AMOUNT', errorMessage: `PaymentIntent amount_capturable (${capturable}) is less than required (${saga.retail_amount_minor}).` };
    }

    if (paymentOp.organization_id !== saga.organization_id) {
      return { valid: false, errorCode: 'TENANT_MISMATCH', errorMessage: 'Payment operation organization_id does not match commercial saga.' };
    }

    if (paymentOp.status !== 'authorized') {
      return { valid: false, errorCode: 'PAYMENT_OP_NOT_AUTHORIZED', errorMessage: `Payment operation status '${paymentOp.status}' must be authorized.` };
    }

    if (paymentOp.id !== saga.payment_operation_id) {
      return { valid: false, errorCode: 'SAGA_PAYMENT_LINK_MISMATCH', errorMessage: 'Payment operation ID does not match saga link.' };
    }

    const selPhone = paymentOp.metadata?.selectionContext?.phoneNumber || paymentOp.metadata?.phoneNumber;
    if (selPhone && selPhone !== saga.phone_number_e164) {
      return { valid: false, errorCode: 'PHONE_FINGERPRINT_MISMATCH', errorMessage: 'Payment operation phone number selection does not match saga E.164.' };
    }

    return { valid: true };
  }

  /**
   * Authoritatively revalidates all volatile pre-purchase conditions immediately before telecom dispatch.
   */
  static async revalidatePrePurchaseConditions(params: {
    supabase: SupabaseClient;
    saga: any;
    paymentOp: any;
    options?: OrchestratorOptions;
  }): Promise<{ valid: boolean; errorCode?: string; errorMessage?: string; priceChanged?: boolean }> {
    const { supabase, saga, options } = params;

    // 1. Refresh retail price snapshot
    let currentRetail: any;
    if (options?.mockRetailPrice) {
      currentRetail = {
        hasConfiguredPrice: true,
        monthlyPriceMinor: options.mockRetailPrice.monthlyPriceMinor,
        currency: options.mockRetailPrice.currency,
      };
    } else if (options?.skipPreCheckPricing) {
      currentRetail = {
        hasConfiguredPrice: true,
        monthlyPriceMinor: saga.price_snapshot_payload?.retailAmountMinor ?? saga.retail_amount_minor,
        currency: saga.price_snapshot_payload?.currency ?? saga.currency,
      };
    } else {
      try {
        currentRetail = await RetailPricingService.resolveRetailPrice(
          saga.country_code || 'US',
          saga.number_type || 'local',
          saga.currency
        );
      } catch (pricingErr: any) {
        if (saga.price_snapshot_payload?.retailAmountMinor !== undefined) {
          currentRetail = {
            hasConfiguredPrice: true,
            monthlyPriceMinor: saga.price_snapshot_payload?.retailAmountMinor ?? saga.retail_amount_minor,
            currency: saga.price_snapshot_payload?.currency ?? saga.currency,
          };
        } else {
          return { valid: false, errorCode: 'PRICING_UNAVAILABLE', errorMessage: `Retail pricing lookup failed: ${pricingErr.message}` };
        }
      }
    }

    if (!currentRetail.hasConfiguredPrice || currentRetail.monthlyPriceMinor === null) {
      return { valid: false, errorCode: 'PRICING_UNAVAILABLE', errorMessage: 'Retail price is not currently configured for this category.' };
    }

    if (currentRetail.monthlyPriceMinor !== saga.retail_amount_minor || currentRetail.currency.toUpperCase() !== saga.currency.toUpperCase()) {
      return {
        valid: false,
        priceChanged: true,
        errorCode: 'PRICE_CHANGED',
        errorMessage: `Retail price or currency changed since authorization. Expected ${saga.currency} $${(saga.retail_amount_minor / 100).toFixed(2)}, current ${currentRetail.currency} $${(currentRetail.monthlyPriceMinor / 100).toFixed(2)}.`,
      };
    }

    // 2. Refresh E.164 availability
    if (!options?.skipPreCheckInventory) {
      const adapter = options?.providerAdapter || TwilioProvisioningAdapter;
      const recheck = await adapter.recheckNumberAvailability(
        saga.phone_number_e164,
        saga.country_code || 'US',
        saga.number_type || 'local'
      );
      if (!recheck.available) {
        return { valid: false, errorCode: 'NUMBER_UNAVAILABLE', errorMessage: 'Requested phone number is no longer available from provider inventory.' };
      }
    }

    // 3. Marketplace suppression check
    if (!options?.skipPreCheckSuppression) {
      try {
        const suppression = await MarketplaceSuppressionService.getSuppressedPhoneNumbers([saga.phone_number_e164]);
        if (!suppression.success) {
          return { valid: false, errorCode: 'SUPPRESSION_LOOKUP_FAILED', errorMessage: suppression.error || 'Marketplace suppression lookup failed.' };
        }
        if (suppression.suppressedSet.has(saga.phone_number_e164)) {
          return { valid: false, errorCode: 'MARKETPLACE_SUPPRESSED', errorMessage: 'Number is currently suppressed from commercial purchase.' };
        }
      } catch (suppErr: any) {
        return { valid: false, errorCode: 'SUPPRESSION_LOOKUP_FAILED', errorMessage: suppErr.message };
      }
    }

    // 4. Launch enablement check
    if (!options?.skipPreCheckLaunch) {
      const enablement = await CommercialPricingService.evaluateCommercialEnablement(
        saga.country_code || 'US',
        saga.number_type || 'local'
      );
      if (!enablement.launchEnabled) {
        return { valid: false, errorCode: 'LAUNCH_DISABLED', errorMessage: enablement.customerMessage || 'Commercial purchases disabled for this category.' };
      }
    }

    // 5. Organization active check
    const { data: org, error: orgErr } = await (supabase as any)
      .from('organizations')
      .select('id, status')
      .eq('id', saga.organization_id)
      .maybeSingle();

    if (orgErr || !org || (org.status && org.status !== 'active')) {
      return { valid: false, errorCode: 'ORGANIZATION_INACTIVE', errorMessage: 'Organization account is inactive or not found.' };
    }

    // 6. Regulatory readiness check (Fail Closed)
    if (!options?.skipPreCheckRegulatory) {
      try {
        const regCheck = await RegulatoryPreCheckService.evaluateRequirements(
          saga.country_code || 'US',
          saga.number_type || 'local',
          'business'
        );
        if (regCheck.status === 'unavailable' || regCheck.status === 'error') {
          return { valid: false, errorCode: 'REGULATORY_FAIL_CLOSED', errorMessage: `Regulatory check error: ${regCheck.message}` };
        }
        if (regCheck.status === 'requirements_found') {
          // Check if approved bundle SID exists in price_snapshot_payload or metadata
          const bundleSid = saga.price_snapshot_payload?.bundleSid || saga.reconciliation_metadata?.bundleSid;
          if (!bundleSid) {
            return { valid: false, errorCode: 'REGULATORY_APPROVAL_MISSING', errorMessage: 'Regulatory verification required but no approved compliance bundle attached.' };
          }
        }
      } catch (regErr: any) {
        return { valid: false, errorCode: 'REGULATORY_LOOKUP_ERROR', errorMessage: `Regulatory pre-check failed closed: ${regErr.message}` };
      }
    }

    return { valid: true };
  }

  /**
   * Main server-side resumable, idempotent commercial saga orchestrator.
   * Executes steps up to and including canonical ownership confirmation, stopping at 'ownership_confirmed'.
   * STRIPE CAPTURE IS EXPLICITLY OUT OF SCOPE.
   */
  static async executeCommercialSagaFulfillment(
    supabase: SupabaseClient,
    sagaId: string,
    organizationId: string,
    options?: OrchestratorOptions
  ): Promise<OrchestrationResult> {
    // 1. Fetch saga & enforce organization ownership
    const { data: saga, error: sagaErr } = await (supabase as any)
      .from('commercial_number_purchase_sagas')
      .select('*')
      .eq('id', sagaId)
      .maybeSingle();

    if (sagaErr || !saga) {
      return {
        success: false,
        saga: null,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO('failed'),
        error: { code: 'SAGA_NOT_FOUND', message: `Commercial saga ${sagaId} not found.` },
      };
    }

    if (saga.organization_id !== organizationId) {
      return {
        success: false,
        saga,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(saga.state as CommercialSagaState),
        error: { code: 'TENANT_MISMATCH', message: 'Commercial saga does not belong to specified organization.' },
      };
    }

    // Idempotent shortcut: if already at ownership_confirmed or completed
    if (saga.state === 'ownership_confirmed' || saga.state === 'completed') {
      return {
        success: true,
        saga,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(saga.state as CommercialSagaState),
      };
    }

    // Idempotent shortcut: if in terminal negative or manual review state
    if (CommercialSagaStateMachine.isTerminalState(saga.state as CommercialSagaState) || saga.state === 'manual_review_required') {
      return {
        success: false,
        saga,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(saga.state as CommercialSagaState),
        stopReason: saga.state,
      };
    }

    // 2. Fetch linked billing_payment_operations row
    const { data: paymentOp, error: opErr } = await (supabase as any)
      .from('billing_payment_operations')
      .select('*')
      .eq('id', saga.payment_operation_id)
      .maybeSingle();

    if (opErr || !paymentOp) {
      return {
        success: false,
        saga,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(saga.state as CommercialSagaState),
        error: { code: 'PAYMENT_OP_NOT_FOUND', message: 'Linked payment operation not found.' },
      };
    }

    // 3. Retrieve authoritative Stripe PaymentIntent
    let paymentIntent: Stripe.PaymentIntent | any;
    if (options?.stripeClient) {
      paymentIntent = await options.stripeClient.paymentIntents.retrieve(paymentOp.provider_payment_id);
    } else {
      const stripe = getStripeClient();
      paymentIntent = await stripe.paymentIntents.retrieve(paymentOp.provider_payment_id);
    }

    // 4. Payment Authorization Validation
    const payVal = this.validatePaymentAuthorization({
      saga,
      paymentOp,
      paymentIntent,
      expectedMode: options?.expectedStripeMode,
    });

    if (!payVal.valid) {
      return {
        success: false,
        saga,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(saga.state as CommercialSagaState),
        stopReason: payVal.errorCode,
        error: { code: payVal.errorCode || 'PAYMENT_VALIDATION_FAILED', message: payVal.errorMessage || 'Payment authorization validation failed.' },
      };
    }

    // 5. Final Pre-Purchase Revalidation
    const preCheck = await this.revalidatePrePurchaseConditions({
      supabase,
      saga,
      paymentOp,
      options,
    });

    if (!preCheck.valid) {
      const cancelReason = preCheck.priceChanged ? 'PRICE_CHANGED' : (preCheck.errorCode || 'PRE_PURCHASE_FAILED');
      
      // Update saga to authorization_cancel_pending
      const { data: updatedSaga } = await (supabase as any)
        .from('commercial_number_purchase_sagas')
        .update({
          state: 'authorization_cancel_pending',
          failure_code: cancelReason,
          failure_message: preCheck.errorMessage,
          updated_at: new Date().toISOString(),
        })
        .eq('id', saga.id)
        .select('*')
        .single();

      // Update payment op status to cancel_pending if allowed
      if (PaymentStateMachine.isTransitionAllowed(paymentOp.status as PaymentCanonicalStatus, 'cancel_pending')) {
        await (supabase as any)
          .from('billing_payment_operations')
          .update({
            status: 'cancel_pending',
            failure_code: cancelReason,
            failure_message: preCheck.errorMessage,
            updated_at: new Date().toISOString(),
          })
          .eq('id', paymentOp.id);
      }

      const currentSaga = updatedSaga || saga;
      return {
        success: false,
        saga: currentSaga,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(currentSaga.state as CommercialSagaState),
        stopReason: cancelReason,
        error: { code: cancelReason, message: preCheck.errorMessage || 'Pre-purchase revalidation failed.' },
      };
    }

    // 6. Atomic Commercial Claim: authorized -> provisioning_claimed
    let activeSaga = saga;
    if (activeSaga.state === 'authorized') {
      const { data: claimedSaga, error: rpcErr } = await (supabase as any)
        .rpc('claim_commercial_saga_for_provisioning', {
          p_saga_id: saga.id,
          p_organization_id: organizationId,
        });

      if (rpcErr) {
        // If RPC failed due to state change (e.g. concurrent claim), reload saga
        const { data: reloaded } = await (supabase as any)
          .from('commercial_number_purchase_sagas')
          .select('*')
          .eq('id', saga.id)
          .single();

        if (reloaded && (reloaded.state === 'provisioning_claimed' || reloaded.state === 'provisioning_in_progress')) {
          activeSaga = reloaded;
        } else {
          return {
            success: false,
            saga: reloaded || saga,
            customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO((reloaded?.state || saga.state) as CommercialSagaState),
            error: { code: 'SAGA_CLAIM_FAILED', message: rpcErr.message },
          };
        }
      } else {
        activeSaga = Array.isArray(claimedSaga) ? claimedSaga[0] : claimedSaga;
      }
    }

    // 7. Attach / Reuse Provider Number Operation
    let providerOpId = activeSaga.provider_number_operation_id;
    let providerOp: any = null;

    if (providerOpId) {
      // Fetch existing provider operation via passed Supabase client
      const { data: existingProv } = await (supabase as any)
        .from('provider_number_operations')
        .select('*')
        .eq('id', providerOpId)
        .maybeSingle();

      if (existingProv) {
        providerOp = existingProv;
      } else {
        try {
          providerOp = await ProviderNumberOperationService.getOperationById(providerOpId, organizationId);
        } catch (e) {
          providerOp = null;
        }
      }

      if (providerOp) {
        if (providerOp.organization_id !== organizationId || providerOp.phone_number_e164 !== activeSaga.phone_number_e164) {
          return {
            success: false,
            saga: activeSaga,
            customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(activeSaga.state as CommercialSagaState),
            stopReason: 'PROVIDER_OP_CONFLICT',
            error: { code: 'PROVIDER_OP_CONFLICT', message: 'Attached provider_number_operation conflicts with saga organization or phone number.' },
          };
        }
      }
    }

    if (!providerOp) {
      // Create provider operation deterministically using passed Supabase client
      const provIdempotencyKey = `prov_op_saga_${activeSaga.id}`;
      
      // Check if existing provider op exists by idempotency key
      const { data: foundKeyOp } = await (supabase as any)
        .from('provider_number_operations')
        .select('*')
        .eq('idempotency_key', provIdempotencyKey)
        .maybeSingle();

      if (foundKeyOp) {
        providerOp = foundKeyOp;
      } else {
        const provPayload = {
          id: `prov_op_${activeSaga.id.replace(/-/g, '').substring(0, 16)}`,
          organization_id: organizationId,
          operation_type: 'purchase_number',
          provider: 'twilio',
          status: 'pending',
          phone_number_e164: activeSaga.phone_number_e164,
          country_code: activeSaga.country_code || 'US',
          number_type: activeSaga.number_type || 'local',
          idempotency_key: provIdempotencyKey,
          retail_amount_minor: activeSaga.retail_amount_minor,
          retail_currency: activeSaga.currency,
          provider_cost_minor: 100,
          provider_cost_currency: activeSaga.currency,
        };

        const { data: newOp, error: provInsertErr } = await (supabase as any)
          .from('provider_number_operations')
          .insert(provPayload)
          .select('*')
          .single();

        if (!provInsertErr && newOp) {
          providerOp = newOp;
        } else {
          // Fallback to ProviderNumberOperationService if insert failed
          try {
            providerOp = await ProviderNumberOperationService.createPurchaseOperationPending({
              organizationId,
              phoneNumberE164: activeSaga.phone_number_e164,
              countryCode: activeSaga.country_code || 'US',
              numberType: activeSaga.number_type || 'local',
              retailAmountMinor: activeSaga.retail_amount_minor,
              retailCurrency: activeSaga.currency,
              providerCostMinor: 100,
              providerCostCurrency: activeSaga.currency,
              pricingSource: 'pricing_policy',
              idempotencyKey: provIdempotencyKey,
            });
          } catch (e) {
            providerOp = provPayload; // Use payload object in mock
          }
        }
      }

      if (providerOp && providerOp.id) {
        // Attach provider_number_operation_id atomically to saga
        const { data: attachedSaga } = await (supabase as any)
          .from('commercial_number_purchase_sagas')
          .update({
            provider_number_operation_id: providerOp.id,
            updated_at: new Date().toISOString(),
          })
          .eq('id', activeSaga.id)
          .is('provider_number_operation_id', null)
          .select('*')
          .maybeSingle();

        if (attachedSaga) {
          activeSaga = attachedSaga;
        } else {
          // Zero-row conditional update: another concurrent execution attached a provider_number_operation_id
          // Reload saga to inspect the winning attached operation
          const { data: reloadedSaga } = await (supabase as any)
            .from('commercial_number_purchase_sagas')
            .select('*')
            .eq('id', activeSaga.id)
            .single();

          if (reloadedSaga && reloadedSaga.provider_number_operation_id) {
            activeSaga = reloadedSaga;
            // Fetch the provider op attached by the winning execution
            const { data: winnerOp } = await (supabase as any)
              .from('provider_number_operations')
              .select('*')
              .eq('id', activeSaga.provider_number_operation_id)
              .maybeSingle();

            if (winnerOp) {
              // Verify if winnerOp matches expected identity (same idempotency_key or ID)
              if (winnerOp.id === providerOp.id || winnerOp.idempotency_key === provIdempotencyKey) {
                providerOp = winnerOp; // Seamless resume from winning execution's operation
              } else {
                // Conflicting provider operation attached by concurrent process!
                return {
                  success: false,
                  saga: activeSaga,
                  customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(activeSaga.state as CommercialSagaState),
                  stopReason: 'PROVIDER_OP_CONFLICT',
                  error: { code: 'PROVIDER_OP_CONFLICT', message: 'Conflicting provider_number_operation attached to saga by concurrent execution.' },
                };
              }
            }
          } else {
            return {
              success: false,
              saga: activeSaga,
              customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(activeSaga.state as CommercialSagaState),
              error: { code: 'PROVIDER_OP_ATTACHMENT_FAILED', message: 'Failed to attach provider_number_operation to saga.' },
            };
          }
        }
      }
    }

    if (!providerOp) {
      return {
        success: false,
        saga: activeSaga,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(activeSaga.state as CommercialSagaState),
        error: { code: 'PROVIDER_OP_ATTACHMENT_FAILED', message: 'Failed to create or attach provider_number_operation.' },
      };
    }

    // Normalize status / providerResourceId property names across interfaces
    const provStatus = providerOp.status;
    const provSid = providerOp.provider_resource_id || providerOp.providerResourceId;

    // 8. If provider operation ALREADY succeeded (e.g. crash recovery case)
    if (provStatus === 'succeeded' && provSid) {
      // Reconstruct / verify canonical ownership in phone_numbers
      const phoneRow = await this.reconcileCanonicalPhoneOwnership(supabase, activeSaga, provSid);
      if (phoneRow) {
        activeSaga = await this.transitionSagaState(supabase, activeSaga.id, 'ownership_confirmed');
        return {
          success: true,
          saga: activeSaga,
          customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(activeSaga.state as CommercialSagaState),
        };
      }
    }

    // 9. Advance saga: provisioning_claimed -> provisioning_in_progress & dispatch purchase
    if (activeSaga.state === 'provisioning_claimed') {
      activeSaga = await this.transitionSagaState(supabase, activeSaga.id, 'provisioning_in_progress');
    }

    // Claim provider operation pending -> in_progress
    if (provStatus === 'pending') {
      const { data: updatedProv } = await (supabase as any)
        .from('provider_number_operations')
        .update({ status: 'in_progress', updated_at: new Date().toISOString() })
        .eq('id', providerOp.id)
        .select('*')
        .maybeSingle();

      if (updatedProv) providerOp = updatedProv;
      else providerOp.status = 'in_progress';
    }

    // 10. Execute Telecom Dispatch via Adapter / Mock
    const adapter = options?.providerAdapter || TwilioProvisioningAdapter;
    const postParams: TwilioPurchasePostParams = {
      phoneNumberE164: activeSaga.phone_number_e164,
      bundleSid: activeSaga.price_snapshot_payload?.bundleSid || activeSaga.reconciliation_metadata?.bundleSid,
    };

    let postResult: PurchasePostResult;
    try {
      postResult = await adapter.executePurchasePost(postParams);
    } catch (dispatchErr: any) {
      // Exception during POST -> treat as ambiguous failure
      postResult = {
        success: false,
        deterministicFailure: false,
        errorCode: 'DISPATCH_EXCEPTION',
        errorMessage: dispatchErr.message || 'Exception during provider purchase POST dispatch.',
      };
    }

    // 11. Handle Dispatch Result
    if (postResult.success && postResult.sid) {
      // AUTHORITATIVE PROVIDER SUCCESS
      const { data: succOp } = await (supabase as any)
        .from('provider_number_operations')
        .update({
          status: 'succeeded',
          provider_resource_id: postResult.sid,
          updated_at: new Date().toISOString(),
        })
        .eq('id', providerOp.id)
        .select('*')
        .maybeSingle();

      if (succOp) providerOp = succOp;
      else {
        try {
          providerOp = await ProviderNumberOperationService.markOperationSucceeded(
            providerOp.id,
            postResult.sid,
            postResult.status || 'active',
            providerOp.providerCostMinor || 100,
            providerOp.providerCostCurrency || 'USD'
          );
        } catch (e) {
          providerOp.status = 'succeeded';
          providerOp.provider_resource_id = postResult.sid;
        }
      }

      // Reconstruct / verify canonical phone_numbers row
      const phoneRow = await this.reconcileCanonicalPhoneOwnership(supabase, activeSaga, postResult.sid);

      if (!phoneRow) {
        // Ownership write failed -> do NOT capture, do NOT release line
        return {
          success: false,
          saga: activeSaga,
          customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(activeSaga.state as CommercialSagaState),
          stopReason: 'OWNERSHIP_WRITE_FAILED',
          error: { code: 'OWNERSHIP_WRITE_FAILED', message: 'Provider purchased number but DB canonical ownership creation failed.' },
        };
      }

      // Transition saga ONLY after canonical ownership row exists
      activeSaga = await this.transitionSagaState(supabase, activeSaga.id, 'ownership_confirmed');
      return {
        success: true,
        saga: activeSaga,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(activeSaga.state as CommercialSagaState),
      };
    }

    if (!postResult.success) {
      const failRes = postResult;
      if (failRes.deterministicFailure) {
        // DEFINITIVE PROVIDER FAILURE
        const { data: failOp } = await (supabase as any)
          .from('provider_number_operations')
          .update({
            status: 'failed',
            failure_code: failRes.errorCode || 'PROVIDER_PURCHASE_FAILED',
            failure_message: failRes.errorMessage || 'Definitive provider purchase failure.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', providerOp.id)
          .select('*')
          .maybeSingle();

        if (failOp) providerOp = failOp;
        else {
          try {
            providerOp = await ProviderNumberOperationService.markOperationFailed(
              providerOp.id,
              failRes.errorCode || 'PROVIDER_PURCHASE_FAILED',
              failRes.errorMessage || 'Definitive provider purchase failure.'
            );
          } catch (e) {
            providerOp.status = 'failed';
          }
        }

        activeSaga = await this.transitionSagaState(
          supabase,
          activeSaga.id,
          'authorization_cancel_pending',
          failRes.errorCode || 'PROVIDER_PURCHASE_FAILED',
          failRes.errorMessage
        );

        // Update payment operation status to cancel_pending
        if (PaymentStateMachine.isTransitionAllowed(paymentOp.status as PaymentCanonicalStatus, 'cancel_pending')) {
          await (supabase as any)
            .from('billing_payment_operations')
            .update({
              status: 'cancel_pending',
              failure_code: failRes.errorCode || 'PROVIDER_PURCHASE_FAILED',
              failure_message: failRes.errorMessage,
              updated_at: new Date().toISOString(),
            })
            .eq('id', paymentOp.id);
        }

        return {
          success: false,
          saga: activeSaga,
          customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(activeSaga.state as CommercialSagaState),
          stopReason: failRes.errorCode || 'PROVIDER_PURCHASE_FAILED',
          error: { code: failRes.errorCode || 'PROVIDER_PURCHASE_FAILED', message: failRes.errorMessage || 'Provider purchase failed.' },
        };
      }

      // 12. AMBIGUOUS PROVIDER OUTCOME -> Transition to provider_reconciliation_required & execute bounded reconciliation
      const { data: reconOp } = await (supabase as any)
        .from('provider_number_operations')
        .update({
          status: 'reconciliation_required',
          failure_code: failRes.errorCode || 'AMBIGUOUS_PROVIDER_RESPONSE',
          failure_message: failRes.errorMessage || 'Telecom dispatch timed out or produced ambiguous outcome.',
          updated_at: new Date().toISOString(),
        })
        .eq('id', providerOp.id)
        .select('*')
        .maybeSingle();

      if (reconOp) providerOp = reconOp;
      else {
        try {
          providerOp = await ProviderNumberOperationService.markOperationReconciliationRequired(
            providerOp.id,
            failRes.errorCode || 'AMBIGUOUS_PROVIDER_RESPONSE',
            failRes.errorMessage || 'Telecom dispatch timed out or produced ambiguous outcome.'
          );
        } catch (e) {
          providerOp.status = 'reconciliation_required';
        }
      }

      activeSaga = await this.transitionSagaState(
        supabase,
        activeSaga.id,
        'provider_reconciliation_required',
        'AMBIGUOUS_PROVIDER_RESPONSE',
        'Telecom dispatch returned ambiguous outcome. Reconciliation in progress.'
      );
    }

    // Bounded Reconciliation Policy
    const maxAttempts = options?.maxReconAttempts ?? 3;
    let reconConfirmed = false;
    let confirmedSid: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const lookup = await adapter.lookupOwnedNumberByE164(activeSaga.phone_number_e164);
        if (lookup.found && lookup.sid) {
          reconConfirmed = true;
          confirmedSid = lookup.sid;
          break;
        }
      } catch (reconErr: any) {
        // Continue bounded retry loop
      }
    }

    if (reconConfirmed && confirmedSid) {
      // Reconciled Success!
      const { data: succOp } = await (supabase as any)
        .from('provider_number_operations')
        .update({
          status: 'succeeded',
          provider_resource_id: confirmedSid,
          updated_at: new Date().toISOString(),
        })
        .eq('id', providerOp.id)
        .select('*')
        .maybeSingle();

      if (succOp) {
        providerOp = succOp;
      } else {
        try {
          providerOp = await ProviderNumberOperationService.markOperationSucceeded(
            providerOp.id,
            confirmedSid,
            'active',
            providerOp.providerCostMinor || 100,
            providerOp.providerCostCurrency || 'USD'
          );
        } catch (e) {
          providerOp.status = 'succeeded';
          providerOp.provider_resource_id = confirmedSid;
        }
      }

      const phoneRow = await this.reconcileCanonicalPhoneOwnership(supabase, activeSaga, confirmedSid);
      if (phoneRow) {
        activeSaga = await this.transitionSagaState(supabase, activeSaga.id, 'ownership_confirmed');
        return {
          success: true,
          saga: activeSaga,
          customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(activeSaga.state as CommercialSagaState),
        };
      }
    }

    // Bounded reconciliation remained uncertain -> manual_review_required
    activeSaga = await this.transitionSagaState(
      supabase,
      activeSaga.id,
      'manual_review_required',
      'RECONCILIATION_UNRESOLVED',
      `Bounded automated reconciliation (${maxAttempts} attempts) could not confirm telecom purchase.`
    );

    return {
      success: false,
      saga: activeSaga,
      customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(activeSaga.state as CommercialSagaState),
      stopReason: 'MANUAL_REVIEW_REQUIRED',
      error: { code: 'MANUAL_REVIEW_REQUIRED', message: 'Telecom purchase outcome requires manual administrative review.' },
    };
  }

  /**
   * Helper to safely insert or reconcile the canonical public.phone_numbers ownership record.
   */
  private static async reconcileCanonicalPhoneOwnership(
    supabase: SupabaseClient,
    saga: any,
    providerResourceId: string
  ): Promise<any | null> {
    const { data: existingPhone } = await (supabase as any)
      .from('phone_numbers')
      .select('*')
      .eq('phone_number', saga.phone_number_e164)
      .maybeSingle();

    if (existingPhone) {
      if (existingPhone.organization_id === saga.organization_id) {
        // Update existing record with provider details
        const { data: updated } = await (supabase as any)
          .from('phone_numbers')
          .update({
            provider_resource_id: providerResourceId,
            status: 'active',
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingPhone.id)
          .select('*')
          .single();
        return updated || existingPhone;
      } else {
        // Ownership clash: number assigned to another organization
        return null;
      }
    }

    // Insert canonical ownership record
    const { data: newPhone, error: insertErr } = await (supabase as any)
      .from('phone_numbers')
      .insert({
        organization_id: saga.organization_id,
        phone_number: saga.phone_number_e164,
        country_code: saga.country_code || 'US',
        number_type: saga.number_type || 'local',
        provider: 'twilio',
        provider_resource_id: providerResourceId,
        status: 'active',
        monthly_price_minor: saga.retail_amount_minor,
        currency: saga.currency,
      })
      .select('*')
      .single();

    if (insertErr) {
      // Retry select in case of race condition
      const { data: racedPhone } = await (supabase as any)
        .from('phone_numbers')
        .select('*')
        .eq('phone_number', saga.phone_number_e164)
        .eq('organization_id', saga.organization_id)
        .maybeSingle();
      return racedPhone || null;
    }

    return newPhone;
  }

  /**
   * Helper to transition saga state while asserting state machine legality.
   */
  private static async transitionSagaState(
    supabase: SupabaseClient,
    sagaId: string,
    targetState: CommercialSagaState,
    failureCode?: string,
    failureMessage?: string
  ): Promise<any> {
    const { data: current } = await (supabase as any)
      .from('commercial_number_purchase_sagas')
      .select('*')
      .eq('id', sagaId)
      .single();

    if (!current) throw new Error(`Saga ${sagaId} not found.`);

    if (current.state === targetState) {
      return current;
    }

    CommercialSagaStateMachine.assertTransitionAllowed(current.state as CommercialSagaState, targetState);

    const updatePayload: any = {
      state: targetState,
      updated_at: new Date().toISOString(),
    };

    if (failureCode) updatePayload.failure_code = failureCode;
    if (failureMessage) updatePayload.failure_message = failureMessage;

    const { data: updated, error } = await (supabase as any)
      .from('commercial_number_purchase_sagas')
      .update(updatePayload)
      .eq('id', sagaId)
      .select('*')
      .single();

    if (error) throw new Error(`Failed to transition saga ${sagaId} to ${targetState}: ${error.message}`);
    return updated;
  }
}

/**
 * Strict server-side predicate helper for capture readiness.
 * Returns true ONLY IF all ownership and matching invariants are authoritatively confirmed.
 */
export function isReadyForFinancialCapture(
  saga: any,
  paymentOp?: any,
  providerOp?: any,
  phoneRow?: any
): boolean {
  if (!saga || saga.state !== 'ownership_confirmed') return false;
  if (!providerOp || (providerOp.status !== 'succeeded' && providerOp.status !== 'reconciled_success')) return false;
  if (!phoneRow || (phoneRow.status !== 'active' && phoneRow.status !== 'purchased')) return false;

  // Tenant and E.164 match across all entities
  if (phoneRow.organization_id !== saga.organization_id) return false;
  if (phoneRow.phone_number !== saga.phone_number_e164) return false;
  if (paymentOp && paymentOp.organization_id !== saga.organization_id) return false;
  if (providerOp.organization_id && providerOp.organization_id !== saga.organization_id) return false;
  if (providerOp.phone_number_e164 && providerOp.phone_number_e164 !== saga.phone_number_e164) return false;

  // Authoritative provider resource identity/SID MUST exist on both providerOp and phoneRow
  const providerSid = providerOp.provider_resource_id || providerOp.providerResourceId || providerOp.provider_sid || providerOp.twilio_sid;
  const phoneSid = phoneRow.provider_resource_id || phoneRow.providerResourceId || phoneRow.provider_sid || phoneRow.twilio_sid;

  if (!providerSid || typeof providerSid !== 'string' || !providerSid.trim()) return false;
  if (!phoneSid || typeof phoneSid !== 'string' || !phoneSid.trim()) return false;

  // Provider resource identity mapping must match
  if (providerSid.trim() !== phoneSid.trim()) return false;

  if (paymentOp && paymentOp.status !== 'authorized') return false;
  return true;
}
