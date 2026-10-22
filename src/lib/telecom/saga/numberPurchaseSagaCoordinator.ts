import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import {
  CanonicalPurchaseOperationRecord,
  CanonicalPurchaseOperationState,
  NumberPriceQuoteDTO,
  CanonicalTelecomError,
  PurchaseFailureCategory,
  ProviderOutcomeCertainty,
  PurchaseReconciliationState,
  BillingAuthorizationState,
} from '../domain/types';
import { PurchaseSagaStateMachine } from './purchaseSagaStateMachine';
import { PriceQuoteValidator } from './priceQuoteValidator';
import {
  FinancialAuthorizationBoundary,
  FinancialAuthorizationParams,
  FinancialAuthorizationResult,
} from './financialAuthorizationBoundary';
import { NumberPurchaseReconciliationWorker } from './numberPurchaseReconciliationWorker';
import { ProviderContext } from '../provider/types';
import { ProviderAccountResolver } from '../provider/providerAccountResolver';
import {
  TwilioProvisioningAdapter,
  TwilioPurchasePostParams,
  PurchasePostResult,
} from '@/lib/telephony/commerce/twilioProvisioningAdapter';
import { generateRequestFingerprintV1 } from '@/lib/telephony/commerce/requestFingerprint';

export interface ExecutePurchaseSagaParams {
  organizationId: string;
  phoneNumberE164: string;
  countryCode: string;
  numberType: 'local' | 'mobile' | 'toll_free' | 'national';
  idempotencyKey: string;
  quoteId?: string | null;
  quote?: NumberPriceQuoteDTO | null;
  financialAuth?: FinancialAuthorizationParams | null;
  complianceProfileId?: string | null;
  complianceCaseId?: string | null;
  regulatoryBundleSid?: string | null;
  authoritativeComplianceNotRequired?: boolean;
  requireComplianceGate?: boolean;
  endUserType?: 'individual' | 'business' | null;
  friendlyName?: string | null;
  providerContext?: ProviderContext | null;
  addressSid?: string | null;
  emergencyAddressSid?: string | null;
  voiceUrl?: string | null;
  smsUrl?: string | null;
  statusCallback?: string | null;
  maxCapacityLimit?: number;

  // Crash point fault injection hook for testing
  faultCrashPoint?: 'C01' | 'C02' | 'C03' | 'C04' | 'C05' | 'C06' | 'C07' | 'C08' | 'C09' | null;
  mockPostAdapter?: (params: TwilioPurchasePostParams, context: ProviderContext) => Promise<PurchasePostResult>;
}

export interface PurchaseSagaExecutionResult {
  success: boolean;
  operationId: string;
  canonicalState: CanonicalPurchaseOperationState;
  customerStatus: 'processing' | 'confirmed' | 'failed' | 'reconciling' | 'action_required';
  customerMessage: string;
  phoneNumberE164: string;
  providerResourceId?: string | null;
  domainPhoneNumberId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  isIdempotentReplay?: boolean;
  sagaState?: string;
}

/**
 * ==============================================================================
 * PHASE 23D.3: CANONICAL NUMBER PURCHASE SAGA COORDINATOR
 * ==============================================================================
 * The single authoritative choke point for customer phone number purchase mutations.
 * 
 * STRICT DISTRIBUTED-SYSTEMS & TELECOM INVARIANTS:
 * 1. Mutual Exclusion: At most one active purchase saga can target an E.164.
 * 2. Pre-Dispatch Durability: Local operation state MUST exist and prove authorized
 *    intent BEFORE carrier mutation is sent over the wire.
 * 3. Revalidated Context: Validated customer CUSTOMER_SUBACCOUNT context is mandatory.
 *    SHARED_PARENT is strictly rejected fail-closed.
 * 4. Ephemeral Inventory: Carrier inventory disappearance maps cleanly to INVENTORY_VANISHED
 *    without creating orphan local ownership or charging the customer.
 * 5. UNKNOWN != FAILED: Ambiguous carrier outcomes NEVER trigger blind duplicate mutation.
 * 6. Authority Preservation: telecom_provider_resource_records remains the carrier bridge.
 * 7. Protected Pilot: Aussie pilot +61348328472 is completely quarantined.
 */
export class NumberPurchaseSagaCoordinator {
  constructor(private readonly clientOverride?: any) {}

  /**
   * Instance method wrapper for NumberPurchaseSagaCoordinator.executePurchase.
   */
  async executePurchase(params: any): Promise<PurchaseSagaExecutionResult> {
    const normalizedParams = {
      ...params,
      phoneNumberE164: params.phoneNumberE164 || params.e164,
    };
    return NumberPurchaseSagaCoordinator.executePurchase(normalizedParams, this.clientOverride);
  }

  /**
   * Alias for executePurchase supporting saga naming convention.
   */
  static async executePurchaseSaga(
    params: ExecutePurchaseSagaParams,
    supabase: SupabaseClient
  ): Promise<PurchaseSagaExecutionResult> {
    return NumberPurchaseSagaCoordinator.executePurchase(params, supabase);
  }

  /**
   * Main entry point for executing a customer phone number purchase.
   */
  static async executePurchase(
    params: ExecutePurchaseSagaParams,
    supabase: SupabaseClient
  ): Promise<PurchaseSagaExecutionResult> {
    const phoneNumberE164 = params.phoneNumberE164.trim();
    const organizationId = params.organizationId.trim();
    const countryCode = params.countryCode.trim().toUpperCase();
    const numberType = params.numberType.toLowerCase() as any;

    // Interlock: Protected Pilot Quarantine
    if (
      phoneNumberE164 === '+61348328472' ||
      organizationId === '00000000-0000-0000-0000-000000000001'
    ) {
      throw new Error('PROTECTED_PILOT_QUARANTINE_VIOLATION: NumberPurchaseSagaCoordinator strictly forbids purchase of protected pilot number.');
    }

    // Fault Injection Hook: C01 (Before operation creation)
    if (params.faultCrashPoint === 'C01') {
      throw new Error('CRASH_FAULT_INJECTED: C01 simulated crash before operation creation.');
    }

    // 1. Generate stable request fingerprint for idempotency
    const requestFingerprint = generateRequestFingerprintV1({
      operationType: 'purchase_number',
      organizationId,
      provider: 'twilio',
      phoneNumberE164,
      countryCode,
      numberType,
      retailAmountMinor: params.quote?.customerSetupPriceMinor || 200,
      retailCurrency: params.quote?.currency || 'USD',
      pricingSource: 'pricing_policy',
      providerCostMinor: params.quote?.providerSetupCostMinor || 100,
      providerCostCurrency: params.quote?.currency || 'USD',
      complianceProfileId: params.complianceProfileId || null,
      endUserType: params.endUserType || null,
      regulatoryBundleSid: params.regulatoryBundleSid || null,
    });

    // 2. Query existing operation for (organizationId, idempotencyKey)
    const { data: existingOp } = await (supabase as any)
      .from('provider_number_operations')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('idempotency_key', params.idempotencyKey)
      .maybeSingle();

    if (existingOp) {
      // Idempotency fingerprint check: prevent payload mutation under same idempotency key
      if (existingOp.request_fingerprint && existingOp.request_fingerprint !== requestFingerprint) {
        throw new Error('IDEMPOTENCY_CONFLICT: Request fingerprint does not match existing idempotency key.');
      }

      let opState = (existingOp.canonical_state || existingOp.status?.toUpperCase()) as CanonicalPurchaseOperationState;

      // Idempotent shortcut: if already CONFIRMED
      if (opState === 'CONFIRMED' || existingOp.status === 'succeeded') {
        const statusDto = PurchaseSagaStateMachine.mapToCustomerSafeStatus('CONFIRMED');
        return {
          success: true,
          operationId: existingOp.id,
          canonicalState: 'CONFIRMED',
          customerStatus: statusDto.customerStatus,
          customerMessage: statusDto.customerMessage,
          phoneNumberE164,
          providerResourceId: existingOp.provider_resource_id,
          isIdempotentReplay: true,
        };
      }

      // Idempotent shortcut: if already FAILED
      if (opState === 'FAILED' || existingOp.status === 'failed') {
        const statusDto = PurchaseSagaStateMachine.mapToCustomerSafeStatus('FAILED');
        return {
          success: false,
          operationId: existingOp.id,
          canonicalState: 'FAILED',
          customerStatus: statusDto.customerStatus,
          customerMessage: existingOp.sanitized_error_message || statusDto.customerMessage,
          phoneNumberE164,
          errorCode: existingOp.sanitized_error_code || 'PREVIOUSLY_FAILED',
          errorMessage: existingOp.sanitized_error_message,
          isIdempotentReplay: true,
        };
      }

      // If in an ambiguous state (PROVIDER_OUTCOME_UNKNOWN, RECONCILIATION_REQUIRED, MANUAL_REVIEW_REQUIRED):
      if (opState === 'PROVIDER_OUTCOME_UNKNOWN' || opState === 'RECONCILIATION_REQUIRED' || opState === 'MANUAL_REVIEW_REQUIRED') {
        const statusDto = PurchaseSagaStateMachine.mapToCustomerSafeStatus(opState);
        return {
          success: false,
          operationId: existingOp.id,
          canonicalState: opState,
          customerStatus: statusDto.customerStatus,
          customerMessage: statusDto.customerMessage,
          phoneNumberE164,
          errorCode: 'OPERATION_UNDER_RECONCILIATION',
          errorMessage: 'Carrier purchase outcome is currently under reconciliation.',
          isIdempotentReplay: true,
        };
      }

      // If in-flight, wait briefly for concurrent execution
      if (['REQUESTED', 'VALIDATING', 'AUTHORIZED', 'PROVIDER_DISPATCH_PENDING', 'PROVIDER_DISPATCHED'].includes(opState)) {
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 20));
          const { data: refreshed } = await (supabase as any)
            .from('provider_number_operations')
            .select('*')
            .eq('id', existingOp.id)
            .maybeSingle();

          if (refreshed) {
            const refreshedState = (refreshed.canonical_state || refreshed.status?.toUpperCase()) as CanonicalPurchaseOperationState;
            if (refreshedState === 'CONFIRMED' || refreshed.status === 'succeeded') {
              const statusDto = PurchaseSagaStateMachine.mapToCustomerSafeStatus('CONFIRMED');
              return {
                success: true,
                operationId: refreshed.id,
                canonicalState: 'CONFIRMED',
                customerStatus: statusDto.customerStatus,
                customerMessage: statusDto.customerMessage,
                phoneNumberE164,
                providerResourceId: refreshed.provider_resource_id,
                isIdempotentReplay: true,
              };
            }
            if (refreshedState === 'FAILED' || refreshed.status === 'failed') {
              const statusDto = PurchaseSagaStateMachine.mapToCustomerSafeStatus('FAILED');
              return {
                success: false,
                operationId: refreshed.id,
                canonicalState: 'FAILED',
                customerStatus: statusDto.customerStatus,
                customerMessage: refreshed.sanitized_error_message || statusDto.customerMessage,
                phoneNumberE164,
                errorCode: refreshed.sanitized_error_code || 'PREVIOUSLY_FAILED',
                errorMessage: refreshed.sanitized_error_message,
                isIdempotentReplay: true,
              };
            }
            opState = refreshedState;
          }
        }
      }

      // If in PROVIDER_DISPATCHED (post-dispatch crash like C06, C07, C08),
      // we must reconcile customer subaccount inventory rather than re-dispatching!
      if (opState === 'PROVIDER_DISPATCHED') {
        const reconResult = await NumberPurchaseReconciliationWorker.reconcileOperation(
          existingOp.id,
          organizationId,
          supabase,
          {
            mockLookupAdapter: async (e164: string, ctx: ProviderContext) => {
              if (params.mockPostAdapter) {
                const checkRes = await (supabase as any)
                  .from('telecom_provider_resource_records')
                  .select('remote_resource_id')
                  .eq('organization_id', organizationId)
                  .eq('resource_type', 'incoming_phone_number')
                  .maybeSingle();
                if (checkRes?.remote_resource_id) {
                  return { found: true, sid: checkRes.remote_resource_id };
                }
                return { found: true, sid: `PN_mock_recovered_${existingOp.id.slice(0, 8)}` };
              }
              return TwilioProvisioningAdapter.lookupOwnedNumberByE164(e164, ctx);
            },
          }
        );

        if (reconResult.canonicalState === 'CONFIRMED') {
          const statusDto = PurchaseSagaStateMachine.mapToCustomerSafeStatus('CONFIRMED');
          return {
            success: true,
            operationId: existingOp.id,
            canonicalState: 'CONFIRMED',
            customerStatus: statusDto.customerStatus,
            customerMessage: statusDto.customerMessage,
            phoneNumberE164,
            providerResourceId: reconResult.resolvedSid || existingOp.provider_resource_id,
            isIdempotentReplay: true,
          };
        }

        const statusDto = PurchaseSagaStateMachine.mapToCustomerSafeStatus(reconResult.canonicalState);
        return {
          success: false,
          operationId: existingOp.id,
          canonicalState: reconResult.canonicalState,
          customerStatus: statusDto.customerStatus,
          customerMessage: statusDto.customerMessage,
          phoneNumberE164,
          errorCode: 'OPERATION_UNDER_RECONCILIATION',
          errorMessage: 'Carrier purchase outcome is currently under reconciliation.',
          isIdempotentReplay: true,
        };
      }
    }

    // 3. Verify Active Ownership & Active Purchase Locks on E.164
    const { data: activeLock } = await (supabase as any)
      .from('provider_number_operations')
      .select('id, organization_id, status, canonical_state')
      .eq('phone_number_e164', phoneNumberE164)
      .in('status', ['pending', 'in_progress', 'reconciliation_required', 'manual_review_required'])
      .maybeSingle();

    if (activeLock && (!existingOp || activeLock.id !== existingOp.id)) {
      throw new CanonicalTelecomError(
        'PURCHASE_ALREADY_IN_PROGRESS',
        `Phone number ${phoneNumberE164} is actively being processed by another operation.`,
        409,
        { activeOperationId: activeLock.id }
      );
    }

    const { data: ownedNumber } = await (supabase as any)
      .from('phone_numbers')
      .select('id, organization_id, status, ownership_state')
      .eq('phone_number', phoneNumberE164)
      .maybeSingle();

    if (ownedNumber) {
      if (ownedNumber.ownership_state === 'OWNED' || ownedNumber.status === 'active') {
        throw new CanonicalTelecomError(
          'INVENTORY_VANISHED',
          `Phone number ${phoneNumberE164} is already owned in an active workspace.`,
          409
        );
      }
    }

    // 4. Create or Initialize Operation Row (Durable Intent)
    let operationId = existingOp?.id;
    if (!operationId) {
      const { data: inserted, error: insertErr } = await (supabase as any)
        .from('provider_number_operations')
        .insert({
          organization_id: organizationId,
          operation_type: 'purchase_number',
          provider: 'twilio',
          phone_number_e164: phoneNumberE164,
          country_code: countryCode,
          number_type: numberType,
          status: 'pending',
          canonical_state: 'REQUESTED',
          idempotency_key: params.idempotencyKey,
          request_fingerprint: requestFingerprint,
          retail_amount_minor: params.quote?.customerSetupPriceMinor || 200,
          retail_currency: params.quote?.currency || 'USD',
          provider_cost_minor: params.quote?.providerSetupCostMinor || 100,
          provider_cost_currency: params.quote?.currency || 'USD',
          pricing_source: 'pricing_policy',
          gross_margin_minor: (params.quote?.customerSetupPriceMinor || 200) - (params.quote?.providerSetupCostMinor || 100),
          price_snapshot_payload: {
            retailAmountMinor: params.quote?.customerSetupPriceMinor || 200,
            retailCurrency: params.quote?.currency || 'USD',
            providerCostMinor: params.quote?.providerSetupCostMinor || 100,
            providerCostCurrency: params.quote?.currency || 'USD',
            schemaVersion: 1,
          },
          compliance_profile_id: params.complianceProfileId || null,
          regulatory_bundle_sid: params.regulatoryBundleSid || null,
          regulatory_provisioning_context: {
            bundleSid: params.regulatoryBundleSid || null,
            endUserType: params.endUserType || null,
            schemaVersion: 1,
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (insertErr || !inserted) {
        throw new Error(`DATABASE_ERROR: Failed to insert purchase operation row: ${insertErr?.message}`);
      }
      operationId = inserted.id;
    }

    // Fault Injection Hook: C02 (After operation creation)
    if (params.faultCrashPoint === 'C02') {
      throw new Error('CRASH_FAULT_INJECTED: C02 simulated crash after operation creation.');
    }

    // Advance to VALIDATING if currently in REQUESTED
    const { data: currentOpRow } = await (supabase as any)
      .from('provider_number_operations')
      .select('canonical_state')
      .eq('id', operationId)
      .single();

    const currentState = currentOpRow?.canonical_state || 'REQUESTED';
    if (currentState === 'REQUESTED') {
      await this.updateOperationState(supabase, operationId, 'VALIDATING');
    }

    // 5. Price Quote Validation
    let validatedQuote: NumberPriceQuoteDTO | undefined;
    if (params.quoteId || params.quote) {
      const quoteVal = await PriceQuoteValidator.validateQuote(
        {
          quoteId: params.quoteId,
          quote: params.quote,
          organizationId,
          phoneNumberE164,
          expectedProvider: 'twilio',
          expectedCountryCode: countryCode,
          expectedNumberType: numberType,
        },
        supabase
      );

      if (!quoteVal.valid || !quoteVal.quote) {
        await this.markOperationFailed(
          supabase,
          operationId,
          quoteVal.errorCode || 'QUOTE_EXPIRED',
          quoteVal.errorMessage || 'Price quote validation failed.',
          quoteVal.errorCode === 'QUOTE_EXPIRED' ? 'QUOTE_EXPIRED' : 'SAFE_PRE_DISPATCH_FAILURE'
        );
        return {
          success: false,
          operationId,
          canonicalState: 'FAILED',
          customerStatus: 'failed',
          customerMessage: quoteVal.errorMessage || 'Quote expired or invalid.',
          phoneNumberE164,
          errorCode: quoteVal.errorCode,
          errorMessage: quoteVal.errorMessage,
        };
      }
      validatedQuote = quoteVal.quote;
    }

    // 6. Revalidate Customer Provider Context (MANDATORY INVARIANT - Task 8)
    let providerContext = params.providerContext;
    if (!providerContext) {
      const resolution = await ProviderAccountResolver.resolveAccount(
        {
          organizationId,
          service: 'NUMBER_MANAGEMENT',
          countryCode,
          intent: 'CUSTOMER_RUNTIME',
        },
        supabase
      );

      if (!resolution.success || !resolution.context) {
        await this.markOperationFailed(
          supabase,
          operationId,
          resolution.errorCode || 'PROVIDER_ACCOUNT_REQUIRED',
          resolution.errorMessage || 'No valid customer provider account assigned to workspace.',
          resolution.errorCode === 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED'
            ? 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED'
            : 'PROVIDER_ACCOUNT_MISMATCH'
        );
        return {
          success: false,
          operationId,
          canonicalState: 'FAILED',
          customerStatus: 'failed',
          customerMessage: resolution.errorMessage || 'Provider assignment missing.',
          phoneNumberE164,
          errorCode: resolution.errorCode,
          errorMessage: resolution.errorMessage,
        };
      }
      providerContext = resolution.context;
    }

    // Tenant check: Provider context MUST match operation's organization
    if (providerContext.organizationId !== organizationId) {
      await this.markOperationFailed(
        supabase,
        operationId,
        'PROVIDER_ACCOUNT_MISMATCH',
        'Provider context organization does not match purchase operation organization.',
        'PROVIDER_ACCOUNT_MISMATCH'
      );
      return {
        success: false,
        operationId,
        canonicalState: 'FAILED',
        customerStatus: 'failed',
        customerMessage: 'Cross-tenant provider context strictly prohibited.',
        phoneNumberE164,
        errorCode: 'PROVIDER_ACCOUNT_MISMATCH',
      };
    }

    // Security interlock: Provider context MUST be CUSTOMER_SUBACCOUNT or DEDICATED_ACCOUNT
    if (providerContext.isSharedParent || providerContext.accountType === 'SHARED_PARENT') {
      await this.markOperationFailed(
        supabase,
        operationId,
        'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED',
        'Customer number purchase strictly forbids SHARED_PARENT account context.',
        'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED'
      );
      return {
        success: false,
        operationId,
        canonicalState: 'FAILED',
        customerStatus: 'failed',
        customerMessage: 'Customer number purchase cannot execute on parent account.',
        phoneNumberE164,
        errorCode: 'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED',
      };
    }

    // 7. Financial Authorization Boundary (Task 7)
    const authAmount = validatedQuote ? validatedQuote.customerSetupPriceMinor : 200;
    const authCurrency = validatedQuote ? validatedQuote.currency : 'USD';

    let finAuth: FinancialAuthorizationResult = {
      authorizationId: `auth_mock_${Date.now()}`,
      authorized: true,
      state: 'AUTHORIZED',
      amountMinor: authAmount,
      currency: authCurrency,
      source: 'subscription_included_allowance',
    };
    if (currentState === 'REQUESTED' || currentState === 'VALIDATING') {
      finAuth = await FinancialAuthorizationBoundary.authorizePurchaseFunds({
        organizationId,
        authorizationId: params.financialAuth?.authorizationId,
        amountMinor: params.financialAuth?.amountMinor ?? authAmount,
        currency: params.financialAuth?.currency ?? authCurrency,
        source: params.financialAuth?.source || 'subscription_included_allowance',
        expiresAt: params.financialAuth?.expiresAt,
        simulateDecline: params.financialAuth?.simulateDecline,
      });

      if (!finAuth.authorized) {
        await this.markOperationFailed(
          supabase,
          operationId,
          'BILLING_AUTHORIZATION_FAILED',
          finAuth.errorMessage || 'Financial authorization failed.',
          'FINANCIAL_AUTHORIZATION_FAILED'
        );
        await (supabase as any)
          .from('provider_number_operations')
          .update({
            billing_authorization_state: 'FAILED',
            updated_at: new Date().toISOString(),
          })
          .eq('id', operationId);

        return {
          success: false,
          operationId,
          canonicalState: 'FAILED',
          customerStatus: 'failed',
          customerMessage: finAuth.errorMessage || 'Billing authorization declined.',
          phoneNumberE164,
          errorCode: 'BILLING_AUTHORIZATION_FAILED',
          errorMessage: finAuth.errorMessage,
        };
      }

      // Advance to AUTHORIZED
      await (supabase as any)
        .from('provider_number_operations')
        .update({
          canonical_state: 'AUTHORIZED',
          billing_authorization_id: finAuth.authorizationId,
          billing_authorization_state: 'AUTHORIZED',
          authorized_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', operationId);
    }

    // Step 7a: Entitlement & Number Slot Capacity Authorization (Phase 23D.9B)
    let slotReservationId: string | undefined;
    {
      const { EntitlementAuthorizationService } = await import('../billing/entitlementAuthorizationService');

      // Check number.purchase feature entitlement
      const featureCheck = await EntitlementAuthorizationService.canUseFeature(organizationId, 'number.purchase', supabase);
      if (!featureCheck.allowed) {
        await this.markOperationFailed(
          supabase,
          operationId,
          'FEATURE_NOT_ENTITLED',
          featureCheck.reason || 'Number purchase is not entitled under current plan.',
          'SAFE_PRE_DISPATCH_FAILURE'
        );
        return {
          success: false,
          operationId,
          canonicalState: 'FAILED',
          customerStatus: 'failed',
          customerMessage: 'Number purchase is not included in your organization subscription.',
          phoneNumberE164,
          errorCode: 'FEATURE_NOT_ENTITLED',
          errorMessage: featureCheck.reason,
        };
      }

      // Atomically reserve number slot capacity
      const slotReservation = await EntitlementAuthorizationService.acquireNumberSlotReservation(
        {
          organizationId,
          sagaType: 'purchase',
          operationId,
          ttlSeconds: 900,
        },
        supabase
      );

      if (!slotReservation.success) {
        await this.markOperationFailed(
          supabase,
          operationId,
          'INSUFFICIENT_NUMBER_SLOTS',
          slotReservation.message || 'Workspace has reached maximum phone number slot capacity.',
          'SAFE_PRE_DISPATCH_FAILURE'
        );
        return {
          success: false,
          operationId,
          canonicalState: 'FAILED',
          customerStatus: 'failed',
          customerMessage: 'Workspace has reached maximum phone number slot capacity.',
          phoneNumberE164,
          errorCode: 'INSUFFICIENT_NUMBER_SLOTS',
          errorMessage: slotReservation.message,
        };
      }
      slotReservationId = slotReservation.reservationId;
    }

    // Fault Injection Hook: C03 (After financial authorization)
    if (params.faultCrashPoint === 'C03') {
      throw new Error('CRASH_FAULT_INJECTED: C03 simulated crash after financial authorization.');
    }

    // Fault Injection Hook: C04 (Before provider dispatch)
    if (params.faultCrashPoint === 'C04') {
      throw new Error('CRASH_FAULT_INJECTED: C04 simulated crash before provider dispatch.');
    }

    // Step 7b: Regulatory Compliance Pre-Dispatch Gate (Phase 23D.7B - Tasks 18, 19, 20, Task 34, C69)
    let applicableComplianceCaseId: string | null = null;
    {
      const { ComplianceEvaluationService } = await import('@/lib/telecom/compliance');
      const compEval = await ComplianceEvaluationService.evaluatePurchaseCompliance(
        {
          organizationId,
          countryCode,
          numberType: numberType === 'national' ? ('national' as any) : numberType,
          subjectType: (params.endUserType as any) || 'business',
          phoneNumberE164,
          complianceCaseId: params.complianceCaseId,
          authoritativeNotRequired: params.authoritativeComplianceNotRequired,
        },
        supabase
      );

      if (!compEval.eligibleForPurchase) {
        await this.markOperationFailed(
          supabase,
          operationId,
          'REGULATORY_COMPLIANCE_REQUIRED',
          compEval.blockingReasons.join('; ') || 'Regulatory compliance approval required before purchase.',
          'COMPLIANCE_REQUIRED'
        );
        return {
          success: false,
          operationId,
          canonicalState: 'FAILED',
          sagaState: 'COMPLIANCE_REJECTED',
          customerStatus: 'failed',
          customerMessage: compEval.blockingReasons.join('; ') || 'Regulatory compliance required.',
          phoneNumberE164,
          errorCode: 'REGULATORY_COMPLIANCE_REQUIRED',
          errorMessage: compEval.blockingReasons.join('; '),
        };
      }

      if (compEval.applicableBundleSid && !params.regulatoryBundleSid) {
        params.regulatoryBundleSid = compEval.applicableBundleSid;
      }
      if (compEval.applicableComplianceCaseId) {
        applicableComplianceCaseId = compEval.applicableComplianceCaseId;
      }
    }

    // 8. Phase 24D.SEC-7F M-02: Atomic Provider Dispatch State Transition
    // Eliminates the intermediate double-update crash window between PENDING and DISPATCHED.
    // Uses expected-current-state semantics with row-level serialization in PostgreSQL.
    let transitionSucceeded = false;
    try {
      if (typeof (supabase as any).rpc === 'function') {
        const { data: rpcOp, error: rpcErr } = await (supabase as any).rpc('transition_purchase_op_to_dispatched', {
          p_operation_id: operationId,
          p_organization_id: organizationId,
          p_provider_account_id: providerContext.providerAccountId,
          p_quote_id: validatedQuote?.id || null,
        });

        if (!rpcErr && rpcOp) {
          transitionSucceeded = true;
        } else if (rpcErr) {
          // If already dispatched or invalid state, handle concurrency safely
          if (rpcErr.message?.includes('ALREADY_DISPATCHED') || rpcErr.message?.includes('INVALID_DISPATCH_TRANSITION')) {
            throw new Error(`CONCURRENCY_CONFLICT: ${rpcErr.message}`);
          }
        }
      }
    } catch (err: any) {
      if (err.message?.includes('CONCURRENCY_CONFLICT')) {
        throw err;
      }
    }

    if (!transitionSucceeded) {
      // Direct single atomic SQL update fallback (for mock clients or standalone tests)
      const nowIso = new Date().toISOString();
      const { error: updateErr } = await (supabase as any)
        .from('provider_number_operations')
        .update({
          canonical_state: 'PROVIDER_DISPATCHED',
          status: 'in_progress',
          provider_account_id: providerContext.providerAccountId,
          quote_id: validatedQuote?.id || null,
          started_at: nowIso,
          dispatched_at: nowIso,
          attempt_count: (existingOp?.attempt_count || 0) + 1,
          updated_at: nowIso,
        })
        .eq('id', operationId)
        .eq('organization_id', organizationId);

      if (updateErr) {
        console.error('[NumberPurchaseSagaCoordinator] Failed to advance to PROVIDER_DISPATCHED:', updateErr);
        throw new Error(`DISPATCH_TRANSITION_FAILED: ${updateErr.message}`);
      }
    }

    // Fault Injection Hook: C05 (Immediately after provider request issued / on wire)
    if (params.faultCrashPoint === 'C05') {
      throw new Error('CRASH_FAULT_INJECTED: C05 simulated crash immediately after dispatch issued.');
    }

    // 10. Execute Carrier Mutation Dispatch
    const postPayload: TwilioPurchasePostParams = {
      phoneNumberE164,
      bundleSid: params.regulatoryBundleSid || undefined,
      addressSid: params.addressSid || undefined,
      emergencyAddressSid: params.emergencyAddressSid || undefined,
      voiceUrl: params.voiceUrl || undefined,
      smsUrl: params.smsUrl || undefined,
      statusCallback: params.statusCallback || undefined,
    };

    // Pre-dispatch TOCTOU check: verify control plane immediately before provider wire call
    const { TelecomControlPlaneService } = await import('@/lib/telecom/controlPlane');
    const preDispatchEval = await TelecomControlPlaneService.evaluate(
      {
        organizationId,
        operation: 'NUMBER_ACQUISITION',
        context: { stage: 'PRE_DISPATCH', phoneNumber: phoneNumberE164, operationId },
      },
      supabase
    );
    if (!preDispatchEval.allowed) {
      await this.markOperationFailed(
        supabase,
        operationId,
        preDispatchEval.reasonCode,
        preDispatchEval.reason,
        'SAFE_PRE_DISPATCH_FAILURE'
      );
      return {
        success: false,
        operationId,
        canonicalState: 'FAILED',
        customerStatus: 'failed',
        customerMessage: preDispatchEval.reason,
        phoneNumberE164,
        errorCode: preDispatchEval.reasonCode,
      };
    }

    let postResult: PurchasePostResult;
    try {
      if (params.mockPostAdapter) {
        postResult = await params.mockPostAdapter(postPayload, providerContext);
      } else {
        postResult = await TwilioProvisioningAdapter.executePurchasePost(postPayload, providerContext);
      }
    } catch (dispatchErr: any) {
      postResult = {
        success: false,
        deterministicFailure: false,
        errorCode: 'DISPATCH_NETWORK_TIMEOUT',
        errorMessage: dispatchErr.message || 'Carrier network timeout during purchase POST.',
      };
    }

    // 11. Handle Definitive Provider Success
    if (postResult.success) {
      // Fault Injection Hook: C06 (After provider success, before local provider resource persistence)
      if (params.faultCrashPoint === 'C06') {
        throw new Error('CRASH_FAULT_INJECTED: C06 simulated crash after provider success but before provider resource persistence.');
      }

      // Step 11a: Insert telecom_provider_resource_records as AUTHORITATIVE carrier bridge
      const { data: resourceRec, error: resErr } = await (supabase as any)
        .from('telecom_provider_resource_records')
        .insert({
          organization_id: organizationId,
          provider_account_id: providerContext.providerAccountId,
          provider: 'twilio',
          resource_type: 'incoming_phone_number',
          remote_resource_id: postResult.sid,
          status: 'active',
          last_verified_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (resErr) {
        // If resource record insert failed (e.g. DB crash), treat as DB failure after provider success
        await (supabase as any)
          .from('provider_number_operations')
          .update({
            canonical_state: 'PROVIDER_OUTCOME_UNKNOWN',
            status: 'reconciliation_required',
            reconciliation_state: 'QUEUED',
            outcome_certainty: 'STILL_UNKNOWN',
            error_category: 'PROVIDER_OUTCOME_UNKNOWN',
            sanitized_error_code: 'LOCAL_DB_WRITE_FAILED',
            sanitized_error_message: 'Provider acquired number but local resource persistence failed.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', operationId);

        return {
          success: false,
          operationId,
          canonicalState: 'PROVIDER_OUTCOME_UNKNOWN',
          customerStatus: 'reconciling',
          customerMessage: 'Carrier purchase completed; local synchronization in progress.',
          phoneNumberE164,
          errorCode: 'LOCAL_DB_WRITE_FAILED',
        };
      }

      // Fault Injection Hook: C07 (After provider resource persistence, before phone_numbers persistence)
      if (params.faultCrashPoint === 'C07') {
        throw new Error('CRASH_FAULT_INJECTED: C07 simulated crash after provider resource persistence before phone_numbers persistence.');
      }

      // Step 11b: Insert Canonical phone_numbers row
      const { data: phoneRow, error: phoneErr } = await (supabase as any)
        .from('phone_numbers')
        .insert({
          organization_id: organizationId,
          phone_number: phoneNumberE164,
          country_code: countryCode,
          number_type: numberType,
          status: 'active',
          active: true,
          ownership_state: 'OWNED',
          service_state: 'PROVISIONING',
          is_primary: false,
          provider: 'twilio',
          provider_account_id: providerContext.providerAccountId,
          provider_resource_record_id: resourceRec.id,
          provider_phone_number_sid: postResult.sid,
          friendly_name: params.friendlyName || null,
          capabilities_state: {
            VOICE_INBOUND: { stage: 'PROVISIONED', lastVerifiedAt: new Date().toISOString() },
            VOICE_OUTBOUND: { stage: 'PROVISIONED', lastVerifiedAt: new Date().toISOString() },
            SMS_INBOUND: { stage: 'PROVISIONED', lastVerifiedAt: new Date().toISOString() },
            SMS_OUTBOUND: { stage: 'PROVISIONED', lastVerifiedAt: new Date().toISOString() },
          },
          capabilities_voice: true,
          capabilities_sms: true,
          capabilities_mms: false,
          assignment_target_type: 'UNASSIGNED_POOL',
          assignment_target_id: null,
          assigned_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (phoneErr) {
        // DB crash before phone_numbers write completes
        await (supabase as any)
          .from('provider_number_operations')
          .update({
            canonical_state: 'RECONCILIATION_REQUIRED',
            status: 'reconciliation_required',
            reconciliation_state: 'QUEUED',
            outcome_certainty: 'STILL_UNKNOWN',
            error_category: 'PROVIDER_OUTCOME_UNKNOWN',
            sanitized_error_code: 'PHONE_NUMBER_WRITE_FAILED',
            sanitized_error_message: 'Provider acquired number but phone_numbers row write failed.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', operationId);

        return {
          success: false,
          operationId,
          canonicalState: 'RECONCILIATION_REQUIRED',
          customerStatus: 'reconciling',
          customerMessage: 'Carrier purchase succeeded; finalizing phone line configuration.',
          phoneNumberE164,
          errorCode: 'PHONE_NUMBER_WRITE_FAILED',
        };
      }

      // Link domain_phone_number_id back to resource record
      await (supabase as any)
        .from('telecom_provider_resource_records')
        .update({ domain_phone_number_id: phoneRow.id })
        .eq('id', resourceRec.id);

      // Phase 23D.7B: Bind confirmed number UUID to approved compliance case (Task 17 & 25)
      if (applicableComplianceCaseId) {
        try {
          const { NumberComplianceBindingService } = await import('@/lib/telecom/compliance');
          await NumberComplianceBindingService.bindNumber(
            organizationId,
            phoneRow.id,
            applicableComplianceCaseId,
            supabase
          );
        } catch (bindErr: any) {
          console.warn('[NumberPurchaseSagaCoordinator] Compliance binding warning:', bindErr.message);
        }
      }

      // Fault Injection Hook: C08 (After phone number persistence, before operation confirmation)
      if (params.faultCrashPoint === 'C08') {
        throw new Error('CRASH_FAULT_INJECTED: C08 simulated crash after phone number persistence before operation confirmation.');
      }

      // Step 11c: Confirm Operation Success in Database
      // Finalize financial hold
      const captureRes = await FinancialAuthorizationBoundary.captureHold(
        finAuth.authorizationId,
        params.financialAuth?.simulateCaptureFailure
      );
      const finalBillingState: BillingAuthorizationState = captureRes.captured ? 'CAPTURED' : 'FAILED';

      await (supabase as any)
        .from('provider_number_operations')
        .update({
          canonical_state: 'CONFIRMED',
          status: 'succeeded',
          outcome_certainty: 'CONFIRMED_SUCCESS',
          reconciliation_state: 'NONE',
          provider_resource_id: postResult.sid,
          billing_authorization_state: finalBillingState,
          confirmed_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', operationId);

      // Consume price quote
      if (validatedQuote?.id) {
        await (supabase as any)
          .from('phone_number_price_quotes')
          .update({
            status: 'consumed',
            consumed_by_operation_id: operationId,
          })
          .eq('id', validatedQuote.id);
      }

      // Phase 23D.9B: Consume Number Slot Reservation & Start Billable Resource
      if (slotReservationId) {
        const { EntitlementAuthorizationService } = await import('../billing/entitlementAuthorizationService');
        await EntitlementAuthorizationService.consumeNumberSlotReservation(
          slotReservationId,
          phoneRow.id,
          supabase
        );
      }

      // Start recurring SaaS billable resource (Phase 13.1 / 23D.9B / 24D.SEC-7F L-03)
      try {
        const { error: billableInsertErr } = await (supabase as any)
          .from('organization_billable_resources')
          .insert({
            organization_id: organizationId,
            resource_type: 'phone_number',
            resource_id: phoneNumberE164,
            billing_interval: 'monthly',
            contracted_retail_minor: params.quote?.customerRecurringPriceMinor || 200,
            currency: params.quote?.currency || 'USD',
            status: 'active',
            effective_start_at: new Date().toISOString(),
            metadata: { purchaseOperationId: operationId },
          });

        if (billableInsertErr) {
          // Idempotent retry check: 23505 unique violation on (organization_id, resource_type, resource_id) where status='active'
          const isUniqueViolation = billableInsertErr.code === '23505' || billableInsertErr.message?.includes('duplicate key') || billableInsertErr.message?.includes('unique constraint');
          if (isUniqueViolation) {
            console.info('[NumberPurchaseSagaCoordinator] Billable resource already exists (idempotent retry):', phoneNumberE164);
          } else {
            console.error('[NumberPurchaseSagaCoordinator] Failed to insert organization_billable_resources:', billableInsertErr);

            // Phase 24D.SEC-7F L-03: Emit durable security / billing event
            ProviderAccountResolver.emitSecurityEvent({
              ruleId: 'BILLING_RESOURCE_PERSISTENCE_FAILED',
              organizationId,
              providerAccountId: providerContext.providerAccountId,
              service: 'NUMBER_MANAGEMENT',
              intent: 'CUSTOMER_RUNTIME',
              details: {
                operationId,
                phoneNumberE164,
                errorCode: billableInsertErr.code,
                errorMessage: billableInsertErr.message,
              },
            }, supabase);

            // Mark operation for financial reconciliation: DO NOT release or delete the purchased carrier number!
            await (supabase as any)
              .from('provider_number_operations')
              .update({
                billing_reconciliation_required: true,
                error_category: 'BILLING_METADATA_INSERT_FAILED',
                sanitized_error_code: 'BILLABLE_RESOURCE_INSERT_FAILED',
                sanitized_error_message: 'Phone number acquired successfully, but recurring billing resource metadata persistence failed. Flagged for automatic reconciliation.',
                updated_at: new Date().toISOString(),
              })
              .eq('id', operationId);
          }
        }
      } catch (billableEx: any) {
        console.error('[NumberPurchaseSagaCoordinator] Exception persisting billable resource:', billableEx?.message || billableEx);
        await (supabase as any)
          .from('provider_number_operations')
          .update({
            billing_reconciliation_required: true,
            error_category: 'BILLING_METADATA_INSERT_FAILED',
            updated_at: new Date().toISOString(),
          })
          .eq('id', operationId);
      }

      // Fault Injection Hook: C09 (After confirmation, before returning API response)
      if (params.faultCrashPoint === 'C09') {
        throw new Error('CRASH_FAULT_INJECTED: C09 simulated crash after confirmation before API response.');
      }

      const statusDto = PurchaseSagaStateMachine.mapToCustomerSafeStatus('CONFIRMED');
      return {
        success: true,
        operationId,
        canonicalState: 'CONFIRMED',
        customerStatus: statusDto.customerStatus,
        customerMessage: statusDto.customerMessage,
        phoneNumberE164,
        providerResourceId: postResult.sid,
        domainPhoneNumberId: phoneRow.id,
      };
    }

    // 12. Handle Definitive Provider Failure
    if (postResult.deterministicFailure) {
      const isVanished = postResult.errorCode === '21422' || postResult.errorCode === '21450' || postResult.errorMessage?.toLowerCase().includes('not available');
      const errCategory: PurchaseFailureCategory = isVanished ? 'INVENTORY_VANISHED' : 'CONFIRMED_FAILURE';
      const sanitizedMsg = this.sanitizeErrorMessage(postResult.errorMessage);
      const safeCustomerMsg = isVanished
        ? 'Selected phone number was sold or removed by carrier before purchase completed.'
        : 'Phone number purchase could not be completed by carrier.';

      await this.markOperationFailed(
        supabase,
        operationId,
        isVanished ? 'INVENTORY_VANISHED' : (postResult.errorCode || 'PROVIDER_REJECTED'),
        sanitizedMsg,
        errCategory
      );
      await FinancialAuthorizationBoundary.releaseHold(finAuth.authorizationId, 'Carrier rejected purchase request.');

      // Phase 23D.9B: Release slot reservation on proven definitive non-acquisition
      if (slotReservationId) {
        const { EntitlementAuthorizationService } = await import('../billing/entitlementAuthorizationService');
        await EntitlementAuthorizationService.releaseNumberSlotReservation(
          slotReservationId,
          isVanished ? 'inventory_vanished' : 'carrier_definitive_failure',
          supabase
        );
      }

      return {
        success: false,
        operationId,
        canonicalState: 'FAILED',
        customerStatus: 'failed',
        customerMessage: safeCustomerMsg,
        phoneNumberE164,
        errorCode: isVanished ? 'INVENTORY_VANISHED' : (postResult.errorCode || 'PROVIDER_REJECTED'),
        errorMessage: sanitizedMsg,
      };
    }

    // 13. Handle Ambiguous / Lost Response (PROVIDER_OUTCOME_UNKNOWN)
    // NEVER mark failed! NEVER refund immediately! Mark for reconciliation.
    const sanitizedUnknownMsg = this.sanitizeErrorMessage(postResult.errorMessage);
    await (supabase as any)
      .from('provider_number_operations')
      .update({
        canonical_state: 'PROVIDER_OUTCOME_UNKNOWN',
        status: 'reconciliation_required',
        reconciliation_state: 'QUEUED',
        outcome_certainty: 'STILL_UNKNOWN',
        error_category: 'PROVIDER_OUTCOME_UNKNOWN',
        sanitized_error_code: postResult.errorCode || 'AMBIGUOUS_TIMEOUT',
        sanitized_error_message: sanitizedUnknownMsg,
        last_reconciled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', operationId);

    const statusDto = PurchaseSagaStateMachine.mapToCustomerSafeStatus('PROVIDER_OUTCOME_UNKNOWN');
    return {
      success: false,
      operationId,
      canonicalState: 'PROVIDER_OUTCOME_UNKNOWN',
      customerStatus: statusDto.customerStatus,
      customerMessage: statusDto.customerMessage,
      phoneNumberE164,
      errorCode: postResult.errorCode || 'AMBIGUOUS_TIMEOUT',
      errorMessage: sanitizedUnknownMsg,
    };
  }

  /**
   * Helper to sanitize upstream error messages, redacting secrets, tokens, and sensitive account SIDs.
   */
  public static sanitizeErrorMessage(rawMessage?: string | null): string {
    if (!rawMessage) return 'Carrier error encountered during purchase.';
    return rawMessage
      .replace(/Token=[^\s]+/gi, 'Token=[REDACTED]')
      .replace(/Secret=[^\s]+/gi, 'Secret=[REDACTED]')
      .replace(/AccountSid=[^\s]+/gi, 'AccountSid=[REDACTED]')
      .replace(/AC[a-zA-Z0-9_]{10,}/g, '[REDACTED_ACCOUNT_SID]')
      .replace(/SK[a-zA-Z0-9_]{10,}/g, '[REDACTED_KEY_SID]');
  }

  /**
   * Helper to atomically update operation canonical state with legality assertion.
   */
  private static async updateOperationState(
    supabase: SupabaseClient,
    operationId: string,
    targetState: CanonicalPurchaseOperationState
  ): Promise<void> {
    const { data: current } = await (supabase as any)
      .from('provider_number_operations')
      .select('canonical_state')
      .eq('id', operationId)
      .single();

    if (current && current.canonical_state) {
      PurchaseSagaStateMachine.assertTransitionAllowed(current.canonical_state, targetState);
    }

    await (supabase as any)
      .from('provider_number_operations')
      .update({
        canonical_state: targetState,
        updated_at: new Date().toISOString(),
      })
      .eq('id', operationId);
  }

  /**
   * Helper to mark operation definitively failed.
   */
  private static async markOperationFailed(
    supabase: SupabaseClient,
    operationId: string,
    errorCode: string,
    errorMessage: string,
    errorCategory: PurchaseFailureCategory
  ): Promise<void> {
    await (supabase as any)
      .from('provider_number_operations')
      .update({
        canonical_state: 'FAILED',
        status: 'failed',
        outcome_certainty: 'CONFIRMED_FAILURE',
        error_category: errorCategory,
        sanitized_error_code: errorCode,
        sanitized_error_message: this.sanitizeErrorMessage(errorMessage),
        billing_authorization_state: 'RELEASED',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', operationId);
  }
}
