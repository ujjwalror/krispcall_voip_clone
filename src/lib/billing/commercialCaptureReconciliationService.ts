import Stripe from 'stripe';
import { SupabaseClient } from '@supabase/supabase-js';
import {
  CommercialCaptureService,
  CaptureReconciliationClassification,
  CommercialSagaRecord,
  BillingPaymentOperationRecord,
  ProviderNumberOperationRecord,
  PhoneNumberRecord,
} from './commercialCaptureService';
import { CommercialSagaStateMachine, CommercialSagaState, CustomerSagaStatusDTO } from './commercialSagaStateMachine';
import { getStripeClient } from './providers/stripe/stripeClient';

/**
 * Extended classification enum including un-claimed dispatch anomaly state.
 */
export type ExtendedReconciliationClassification =
  | CaptureReconciliationClassification
  | 'DISPATCH_NOT_CLAIMED_RECONCILIATION_REQUIRED'
  | 'SAGA_NOT_FOUND'
  | 'PAYMENT_OP_NOT_FOUND'
  | 'STRIPE_RETRIEVAL_FAILED';

export interface ReconciliationParams {
  sagaId?: string;
  paymentOpId?: string;
  providerPaymentId?: string;
  expectedMode: 'test' | 'live';
  stripeOverride?: Stripe;
}

export interface ReconciliationResult {
  success: boolean;
  classification: ExtendedReconciliationClassification;
  saga?: CommercialSagaRecord | null;
  paymentOp?: BillingPaymentOperationRecord | null;
  customerDTO: CustomerSagaStatusDTO;
  message?: string;
  error?: {
    code: string;
    message: string;
  };
}

export class CommercialCaptureReconciliationService {
  /**
   * Authoritative Shared Reconciliation Pathway.
   * Used by BOTH HTTP fulfillment routes and Stripe Webhook handlers.
   * 
   * MANDATORY INVARIANTS:
   * 1. Direct authoritative stripe.paymentIntents.retrieve() (never trusts event.data.object alone).
   * 2. Pure predicate classification via CommercialCaptureService.classifyCaptureReconciliation().
   * 3. MANDATORY PREREQUISITE: Requires capture_dispatch_claimed_at IS NOT NULL before calling confirm_payment_captured().
   * 4. Fresh DB reads of saga, paymentOp, providerNumberOp, and phone_numbers before saga completion.
   * 5. Dual commercial completion predicate check before complete_commercial_saga_after_capture().
   * 6. Customer-safe DTO mapping — zero provider secrets or internal IDs exposed.
   * 7. ZERO executable stripe.paymentIntents.capture() calls.
   */
  static async reconcilePaymentStateAndCompleteSaga(
    supabase: SupabaseClient,
    params: ReconciliationParams
  ): Promise<ReconciliationResult> {
    const { sagaId, paymentOpId, providerPaymentId, expectedMode, stripeOverride } = params;

    // 1. Resolve fresh Saga and Payment Operation from DB
    let saga: CommercialSagaRecord | null = null;
    let paymentOp: BillingPaymentOperationRecord | null = null;

    if (sagaId) {
      const { data: sagaData } = await (supabase as any)
        .from('commercial_number_purchase_sagas')
        .select('*')
        .eq('id', sagaId)
        .maybeSingle();
      saga = sagaData || null;
    }

    if (!saga && paymentOpId) {
      const { data: sagaData } = await (supabase as any)
        .from('commercial_number_purchase_sagas')
        .select('*')
        .eq('payment_operation_id', paymentOpId)
        .maybeSingle();
      saga = sagaData || null;
    }

    const targetOpId = paymentOpId || (saga ? (saga.payment_operation_id || saga.paymentOperationId) : null);

    if (targetOpId) {
      const { data: opData } = await (supabase as any)
        .from('billing_payment_operations')
        .select('*')
        .eq('id', targetOpId)
        .maybeSingle();
      paymentOp = opData || null;
    } else if (providerPaymentId) {
      const { data: opData } = await (supabase as any)
        .from('billing_payment_operations')
        .select('*')
        .eq('provider', 'stripe')
        .eq('provider_payment_id', providerPaymentId)
        .maybeSingle();
      paymentOp = opData || null;

      if (!saga && paymentOp && (paymentOp.commercial_saga_id || paymentOp.commercialSagaId)) {
        const { data: sagaData } = await (supabase as any)
          .from('commercial_number_purchase_sagas')
          .select('*')
          .eq('id', paymentOp.commercial_saga_id || paymentOp.commercialSagaId)
          .maybeSingle();
        saga = sagaData || null;
      }
    }

    if (!saga) {
      return {
        success: false,
        classification: 'SAGA_NOT_FOUND',
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO('failed'),
        error: { code: 'SAGA_NOT_FOUND', message: 'Linked commercial purchase saga not found.' },
      };
    }

    if (!paymentOp) {
      return {
        success: false,
        classification: 'PAYMENT_OP_NOT_FOUND',
        saga,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(saga.state as CommercialSagaState),
        error: { code: 'PAYMENT_OP_NOT_FOUND', message: 'Linked billing payment operation not found.' },
      };
    }

    const opProviderPaymentId = paymentOp.provider_payment_id || paymentOp.providerPaymentId || providerPaymentId;
    if (!opProviderPaymentId) {
      return {
        success: false,
        classification: 'PROVIDER_ID_MISMATCH',
        saga,
        paymentOp,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(saga.state as CommercialSagaState),
        error: { code: 'MISSING_PROVIDER_PAYMENT_ID', message: 'Payment operation lacks provider_payment_id.' },
      };
    }

    // 2. Direct Authoritative Stripe Retrieval
    let paymentIntent: Stripe.PaymentIntent;
    try {
      let stripeClient: Stripe;
      if (stripeOverride) {
        stripeClient = stripeOverride;
      } else if (paymentOp.provider_account_id) {
        const { StripeClientFactory } = await import('./providers/stripe/stripeClientFactory');
        stripeClient = await StripeClientFactory.getClientForAccount(supabase, paymentOp.provider_account_id, { environment: params.expectedMode });
      } else {
        stripeClient = getStripeClient();
      }
      paymentIntent = await stripeClient.paymentIntents.retrieve(opProviderPaymentId);
    } catch (retrieveErr: any) {
      console.error('[CommercialCaptureReconciliationService] Authoritative Stripe retrieve failed:', retrieveErr.message || retrieveErr);
      return {
        success: false,
        classification: 'STRIPE_RETRIEVAL_FAILED',
        saga,
        paymentOp,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(saga.state as CommercialSagaState),
        error: { code: 'STRIPE_RETRIEVAL_FAILED', message: 'Authoritative Stripe PaymentIntent retrieval failed.' },
      };
    }

    // 3. Evaluate Pure Capture Reconciliation Classifier
    const classification = CommercialCaptureService.classifyCaptureReconciliation({
      paymentOp,
      paymentIntent,
      expectedMode,
    });

    // Handle non-captured classifications safely
    if (classification !== 'CAPTURE_CONFIRMED') {
      let updatedSaga = saga;

      if (classification === 'DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED' ||
          classification === 'PAYMENT_PROCESSING' ||
          classification === 'PAYMENT_FAILED') {
        // Safe durable transition to financial_reconciliation_required
        if (saga.state === 'capture_pending') {
          try {
            const { data: recSaga } = await (supabase as any).rpc('mark_commercial_saga_financial_reconciliation', {
              p_saga_id: saga.id,
              p_organization_id: saga.organization_id || saga.organizationId,
              p_reason: `Classification: ${classification}`,
            });
            if (recSaga) updatedSaga = recSaga;
          } catch (e) {}
        }

        // Sync payment operation status if payment failed/canceled
        if (paymentIntent.status === 'canceled' || paymentIntent.status === 'requires_payment_method') {
          const targetStatus = paymentIntent.status === 'canceled' ? 'canceled' : 'failed';
          try {
            await (supabase as any)
              .from('billing_payment_operations')
              .update({ status: targetStatus, updated_at: new Date().toISOString() })
              .eq('id', paymentOp.id);
          } catch (e) {}
        }
      } else if (classification === 'AMOUNT_MISMATCH' ||
                 classification === 'CURRENCY_MISMATCH' ||
                 classification === 'MODE_MISMATCH' ||
                 classification === 'PROVIDER_ID_MISMATCH' ||
                 classification === 'MANUAL_REVIEW_REQUIRED') {
        // Safe durable transition to manual_review_required
        if (saga.state === 'capture_pending' || saga.state === 'financial_reconciliation_required') {
          try {
            const { data: revSaga } = await (supabase as any).rpc('mark_commercial_saga_manual_review', {
              p_saga_id: saga.id,
              p_organization_id: saga.organization_id || saga.organizationId,
              p_reason: `Classification: ${classification}`,
            });
            if (revSaga) updatedSaga = revSaga;
          } catch (e) {}
        }
      }

      return {
        success: false,
        classification,
        saga: updatedSaga,
        paymentOp,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(updatedSaga.state as CommercialSagaState),
        message: `Payment status classified as ${classification}. Canonical capture skipped.`,
      };
    }

    // 4. MANDATORY DURABLE DISPATCH PREREQUISITE CHECK
    // If Stripe says succeeded BUT capture_dispatch_claimed_at IS NULL:
    // DO NOT call confirm_payment_captured(). Fail closed to manual review.
    const dispatchClaimedAt = paymentOp.capture_dispatch_claimed_at ?? paymentOp.captureDispatchClaimedAt;
    const dispatchIdempotencyKey = paymentOp.capture_idempotency_key ?? paymentOp.captureIdempotencyKey;

    if (dispatchClaimedAt === null || dispatchClaimedAt === undefined ||
        dispatchIdempotencyKey === null || dispatchIdempotencyKey === undefined) {
      console.warn(`[CommercialCaptureReconciliationService] Anomaly: PaymentIntent ${paymentIntent.id} succeeded but dispatch claimed_at is null for operation ${paymentOp.id}.`);
      
      let updatedSaga = saga;
      if (saga.state === 'capture_pending' || saga.state === 'financial_reconciliation_required') {
        try {
          const { data: revSaga } = await (supabase as any).rpc('mark_commercial_saga_manual_review', {
            p_saga_id: saga.id,
            p_organization_id: saga.organization_id || saga.organizationId,
            p_reason: 'ANOMALY: PaymentIntent succeeded without recorded capture dispatch claim.',
          });
          if (revSaga) updatedSaga = revSaga;
        } catch (e) {}
      }

      return {
        success: false,
        classification: 'DISPATCH_NOT_CLAIMED_RECONCILIATION_REQUIRED',
        saga: updatedSaga,
        paymentOp,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO((updatedSaga?.state || 'failed') as CommercialSagaState),
        error: { code: 'DISPATCH_NOT_CLAIMED', message: 'Authoritative payment succeeded without recorded capture dispatch claim.' },
      };
    }

    // 5. Confirm Canonical Payment Captured via Atomic DB RPC
    if (paymentOp.status !== 'captured') {
      try {
        const { data: confirmedOp, error: rpcErr } = await (supabase as any).rpc('confirm_payment_captured', {
          p_payment_op_id: paymentOp.id,
          p_organization_id: saga.organization_id || saga.organizationId,
          p_provider_payment_id: paymentIntent.id,
        });

        if (rpcErr) {
          console.error('[CommercialCaptureReconciliationService] confirm_payment_captured RPC error:', rpcErr.message);
          return {
            success: false,
            classification: 'MANUAL_REVIEW_REQUIRED',
            saga,
            paymentOp,
            customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO((saga?.state || 'failed') as CommercialSagaState),
            error: { code: 'PAYMENT_CONFIRMATION_RPC_FAILED', message: rpcErr.message },
          };
        }
        if (confirmedOp) paymentOp = confirmedOp;
      } catch (confirmEx: any) {
        console.error('[CommercialCaptureReconciliationService] Exception confirming capture:', confirmEx.message);
        return {
          success: false,
          classification: 'MANUAL_REVIEW_REQUIRED',
          saga,
          paymentOp,
          customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO((saga?.state || 'failed') as CommercialSagaState),
          error: { code: 'PAYMENT_CONFIRMATION_FAILED', message: confirmEx.message },
        };
      }
    }

    // 6. Fresh READ of all entities before Saga Completion Check
    const freshSagaRes = await (supabase as any)
      .from('commercial_number_purchase_sagas')
      .select('*')
      .eq('id', saga.id)
      .maybeSingle();
    if (freshSagaRes.data) saga = freshSagaRes.data;

    if (paymentOp && paymentOp.id) {
      const freshOpRes = await (supabase as any)
        .from('billing_payment_operations')
        .select('*')
        .eq('id', paymentOp.id)
        .maybeSingle();
      if (freshOpRes.data) paymentOp = freshOpRes.data;
    }

    let providerNumberOp: ProviderNumberOperationRecord | null = null;
    if (saga && (saga.provider_number_operation_id || saga.providerNumberOperationId)) {
      const { data: pnoData } = await (supabase as any)
        .from('provider_number_operations')
        .select('*')
        .eq('id', saga.provider_number_operation_id || saga.providerNumberOperationId)
        .maybeSingle();
      providerNumberOp = pnoData || null;
    }

    let phoneRow: PhoneNumberRecord | null = null;
    if (saga && (saga.phone_number_e164 || saga.phoneNumberE164)) {
      const { data: phoneData } = await (supabase as any)
        .from('phone_numbers')
        .select('*')
        .eq('phone_number', saga.phone_number_e164 || saga.phoneNumberE164)
        .eq('organization_id', saga.organization_id || saga.organizationId)
        .maybeSingle();
      phoneRow = phoneData || null;
    }

    // 7. Dual Commercial Completion Predicate Evaluation
    if (saga && paymentOp) {
      const completionCheck = CommercialCaptureService.isEligibleForSagaCompletion({
        saga,
        paymentOp,
        paymentIntent,
        providerNumberOp: providerNumberOp || ({} as any),
        phoneRow: phoneRow || ({} as any),
        expectedMode,
      });

      if (completionCheck.eligible && (saga.state === 'capture_pending' || saga.state === 'financial_reconciliation_required')) {
        try {
          const { data: completedSaga, error: completeRpcErr } = await (supabase as any).rpc('complete_commercial_saga_after_capture', {
            p_saga_id: saga.id,
            p_organization_id: saga.organization_id || saga.organizationId,
          });

          if (!completeRpcErr && completedSaga) {
            saga = completedSaga;
          }
        } catch (completeEx: any) {
          console.error('[CommercialCaptureReconciliationService] Exception completing saga:', completeEx.message);
        }
      } else if (!completionCheck.eligible && (saga.state === 'capture_pending' || saga.state === 'financial_reconciliation_required')) {
        // Stripe succeeded & payment captured, but telecom ownership invalid -> mark manual_review_required
        try {
          const { data: revSaga } = await (supabase as any).rpc('mark_commercial_saga_manual_review', {
            p_saga_id: saga.id,
            p_organization_id: saga.organization_id || saga.organizationId,
            p_reason: `Telecom ownership unverified: ${completionCheck.reason}`,
          });
          if (revSaga) saga = revSaga;
        } catch (e) {}
      }
    }

    return {
      success: saga?.state === 'completed',
      classification: 'CAPTURE_CONFIRMED',
      saga,
      paymentOp,
      customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO((saga?.state || 'capture_pending') as CommercialSagaState),
      message: saga?.state === 'completed' ? 'Commercial purchase saga completed successfully.' : 'Payment captured authoritatively. Final saga completion pending.',
    };
  }

  /**
   * Phase 13.3.3.2C.1 — Full Production Orchestration Pathway for Real Capture Dispatch.
   * 
   * EXACT ORCHESTRATION ORDER:
   * 1-3. Authenticated Owner/Admin, server-resolved org, saga identified (caller responsibility)
   * 4. Canonical saga/payment/provider-number/phone loaded server-side
   * 5. Authoritative Stripe PaymentIntent retrieve
   * 6. Frozen isEligibleForCaptureDispatch()
   * 7. Frozen telecom ownership validation (isEligibleForTelecomOwnership())
   * 8. claim_commercial_saga_for_capture() RPC
   * 9. FRESH reread of saga/payment after saga claim
   * 10. Revalidate conditions affected by claim
   * 11. claim_payment_capture_dispatch() RPC
   * 12. FRESH read of payment operation after payment dispatch claim RPC
   * 13. Verify: capture_dispatch_claimed_at exists, capture_idempotency_key exists, canonical status correct
   * 14. ONLY THIS CLAIM WINNER may call capture adapter
   * 15. Stripe capture POST (via injected dispatcher or StripeCaptureAdapter)
   * 16. Authoritative Stripe retrieve (post-dispatch)
   * 17. Shared reconciliation classification
   * 18. Canonical payment confirmation (confirm_payment_captured RPC)
   * 19. Fresh telecom reads
   * 20. Dual predicate evaluation & saga completion (complete_commercial_saga_after_capture RPC)
   */
  static async executeAuthoritativeCaptureDispatch(
    supabase: SupabaseClient,
    params: {
      sagaId: string;
      organizationId: string;
      expectedMode: 'test' | 'live';
      captureDispatcher?: import('./providers/stripe/stripeCaptureAdapter').CaptureDispatchFunction;
      stripeOverride?: Stripe;
    }
  ): Promise<ReconciliationResult> {
    const { sagaId, organizationId, expectedMode, captureDispatcher, stripeOverride } = params;

    const dispatcher = captureDispatcher || (async (p) => {
      const { StripeCaptureAdapter } = await import('./providers/stripe/stripeCaptureAdapter');
      return StripeCaptureAdapter.capturePaymentIntent({ ...p, supabase });
    });

    // 4. Server-side loading of canonical entities
    const { data: saga } = await (supabase as any)
      .from('commercial_number_purchase_sagas')
      .select('*')
      .eq('id', sagaId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!saga) {
      return {
        success: false,
        classification: 'SAGA_NOT_FOUND',
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO('failed'),
        error: { code: 'SAGA_NOT_FOUND', message: `Commercial saga ${sagaId} not found for organization.` },
      };
    }

    if (!saga.payment_operation_id) {
      return {
        success: false,
        classification: 'PAYMENT_OP_NOT_FOUND',
        saga,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(saga.state as CommercialSagaState),
        error: { code: 'MISSING_PAYMENT_OP_LINK', message: 'Saga has no payment_operation_id.' },
      };
    }

    const { data: paymentOp } = await (supabase as any)
      .from('billing_payment_operations')
      .select('*')
      .eq('id', saga.payment_operation_id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!paymentOp) {
      return {
        success: false,
        classification: 'PAYMENT_OP_NOT_FOUND',
        saga,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(saga.state as CommercialSagaState),
        error: { code: 'PAYMENT_OP_NOT_FOUND', message: 'Linked billing payment operation not found.' },
      };
    }

    let stripeClient: Stripe;
    if (stripeOverride) {
      stripeClient = stripeOverride;
    } else if (paymentOp.provider_account_id) {
      const { StripeClientFactory } = await import('./providers/stripe/stripeClientFactory');
      stripeClient = await StripeClientFactory.getClientForAccount(supabase, paymentOp.provider_account_id, { environment: expectedMode });
    } else {
      stripeClient = getStripeClient();
    }

    const claimedAt = paymentOp.capture_dispatch_claimed_at ?? paymentOp.captureDispatchClaimedAt;
    const idempotencyKey = paymentOp.capture_idempotency_key ?? paymentOp.captureIdempotencyKey;

    // BOUNDARY D: Inconsistent partial dispatch fields check (one exists without the other) -> FAIL CLOSED
    const hasClaimedAt = claimedAt !== null && claimedAt !== undefined;
    const hasIdempotencyKey = idempotencyKey !== null && idempotencyKey !== undefined;

    if ((hasClaimedAt && !hasIdempotencyKey) || (!hasClaimedAt && hasIdempotencyKey)) {
      console.error(`[CommercialCaptureReconciliationService] Inconsistent capture dispatch fields for operation ${paymentOp.id}: claimedAt=${claimedAt}, idempotencyKey=${idempotencyKey}`);
      return {
        success: false,
        classification: 'MANUAL_REVIEW_REQUIRED',
        saga,
        paymentOp,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO((saga.state || 'failed') as CommercialSagaState),
        error: { code: 'INCONSISTENT_DISPATCH_FIELDS', message: 'Inconsistent capture dispatch claim metadata.' },
      };
    }

    // BOUNDARY C: Dispatch permission already consumed OR terminal/captured state -> RECOVERY / RECONCILIATION PATH
    if ((hasClaimedAt && hasIdempotencyKey) || saga.state === 'completed' || paymentOp.status === 'captured') {
      return this.reconcilePaymentStateAndCompleteSaga(supabase, { sagaId, expectedMode, stripeOverride });
    }

    // Unrecognized or terminal non-success saga state check
    if (saga.state !== 'ownership_confirmed' && saga.state !== 'capture_pending') {
      return this.reconcilePaymentStateAndCompleteSaga(supabase, { sagaId, expectedMode, stripeOverride });
    }

    let providerNumberOp: ProviderNumberOperationRecord | null = null;
    if (saga.provider_number_operation_id) {
      const { data: pnoData } = await (supabase as any)
        .from('provider_number_operations')
        .select('*')
        .eq('id', saga.provider_number_operation_id)
        .maybeSingle();
      providerNumberOp = pnoData || null;
    }

    let phoneRow: PhoneNumberRecord | null = null;
    if (saga.phone_number_e164) {
      const { data: phoneData } = await (supabase as any)
        .from('phone_numbers')
        .select('*')
        .eq('phone_number', saga.phone_number_e164)
        .eq('organization_id', organizationId)
        .maybeSingle();
      phoneRow = phoneData || null;
    }

    // 5. Authoritative Stripe PaymentIntent Retrieve
    const opProviderPaymentId = paymentOp.provider_payment_id || paymentOp.providerPaymentId;
    if (!opProviderPaymentId) {
      return {
        success: false,
        classification: 'PROVIDER_ID_MISMATCH',
        saga,
        paymentOp,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(saga.state as CommercialSagaState),
        error: { code: 'MISSING_PROVIDER_PAYMENT_ID', message: 'Payment operation lacks provider_payment_id.' },
      };
    }

    let paymentIntent: Stripe.PaymentIntent;
    try {
      paymentIntent = await stripeClient.paymentIntents.retrieve(opProviderPaymentId);
    } catch (retrieveErr: any) {
      return {
        success: false,
        classification: 'STRIPE_RETRIEVAL_FAILED',
        saga,
        paymentOp,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(saga.state as CommercialSagaState),
        error: { code: 'STRIPE_RETRIEVAL_FAILED', message: 'Authoritative Stripe PaymentIntent retrieval failed.' },
      };
    }

    // 6. Pre-Capture Eligibility Validation (Enforces expectedMode against paymentIntent.livemode)
    const dispatchEligible = CommercialCaptureService.isEligibleForCaptureDispatch({
      saga,
      paymentOp,
      paymentIntent,
      expectedMode,
    });

    if (!dispatchEligible.eligible) {
      // If PaymentIntent is already succeeded, enter reconciliation pathway
      if (paymentIntent.status === 'succeeded') {
        return this.reconcilePaymentStateAndCompleteSaga(supabase, { sagaId, expectedMode, stripeOverride });
      }
      return {
        success: false,
        classification: CommercialCaptureService.classifyCaptureReconciliation({ paymentOp, paymentIntent, expectedMode }),
        saga,
        paymentOp,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(saga.state as CommercialSagaState),
        message: `Pre-capture dispatch check ineligible: ${dispatchEligible.reason}`,
      };
    }

    // 7. Telecom Ownership Validation
    if (!providerNumberOp || !phoneRow) {
      return {
        success: false,
        classification: 'MANUAL_REVIEW_REQUIRED',
        saga,
        paymentOp,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(saga.state as CommercialSagaState),
        error: { code: 'TELECOM_ENTITIES_MISSING', message: 'Telecom operation or phone number record missing before capture dispatch.' },
      };
    }

    const telecomCheck = CommercialCaptureService.isEligibleForTelecomOwnership({ saga, providerNumberOp, phoneRow });
    if (!telecomCheck.eligible) {
      return {
        success: false,
        classification: 'MANUAL_REVIEW_REQUIRED',
        saga,
        paymentOp,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(saga.state as CommercialSagaState),
        error: { code: 'TELECOM_OWNERSHIP_UNVERIFIED', message: `Telecom ownership validation failed: ${telecomCheck.reason}` },
      };
    }

    // 8. Claim Commercial Saga for Capture (ONLY IF saga is in 'ownership_confirmed' state)
    let currentSaga = saga;
    if (currentSaga.state === 'ownership_confirmed') {
      const { data: claimedSaga, error: sagaClaimErr } = await (supabase as any).rpc('claim_commercial_saga_for_capture', {
        p_saga_id: saga.id,
        p_organization_id: organizationId,
      });

      if (sagaClaimErr || !claimedSaga) {
        // Claim loser or state mismatch: DO NOT CALL CAPTURE! Enter reconciliation
        return this.reconcilePaymentStateAndCompleteSaga(supabase, { sagaId, expectedMode, stripeOverride });
      }

      // 9. FRESH reread of saga after saga claim
      const { data: freshSagaAfterClaim } = await (supabase as any)
        .from('commercial_number_purchase_sagas')
        .select('*')
        .eq('id', saga.id)
        .maybeSingle();

      currentSaga = freshSagaAfterClaim || claimedSaga;
    }

    // 10. Revalidate conditions affected by claim (BOUNDARY B: saga MUST be capture_pending)
    if (currentSaga.state !== 'capture_pending') {
      return this.reconcilePaymentStateAndCompleteSaga(supabase, { sagaId, expectedMode, stripeOverride });
    }

    // 11. Claim Payment Capture Dispatch (authorized -> capture_pending + sets claimed_at and idempotency_key)
    const { data: claimedOp, error: opClaimErr } = await (supabase as any).rpc('claim_payment_capture_dispatch', {
      p_payment_op_id: paymentOp.id,
      p_organization_id: organizationId,
      p_saga_id: currentSaga.id,
    });

    if (opClaimErr || !claimedOp) {
      // Claim loser: DO NOT CALL CAPTURE! Enter reconciliation
      return this.reconcilePaymentStateAndCompleteSaga(supabase, { sagaId, expectedMode, stripeOverride });
    }

    // 12 & 13. FRESH read of payment operation & winner verification
    const { data: freshOpAfterClaim } = await (supabase as any)
      .from('billing_payment_operations')
      .select('*')
      .eq('id', paymentOp.id)
      .maybeSingle();

    const winnerOp = freshOpAfterClaim || claimedOp;
    const winnerClaimedAt = winnerOp.capture_dispatch_claimed_at ?? winnerOp.captureDispatchClaimedAt;
    const winnerIdempotencyKey = winnerOp.capture_idempotency_key ?? winnerOp.captureIdempotencyKey;

    if (!winnerClaimedAt || !winnerIdempotencyKey || winnerOp.status !== 'capture_pending') {
      // Verification failed: DO NOT CALL CAPTURE! Enter reconciliation
      return this.reconcilePaymentStateAndCompleteSaga(supabase, { sagaId, expectedMode, stripeOverride });
    }

    // 14 & 15. ONLY THIS CLAIM WINNER may call capture adapter
    const amountMinor = winnerOp.amount_minor ?? winnerOp.amountMinor ?? winnerOp.amount;
    const dispatchResult = await dispatcher({
      providerPaymentId: opProviderPaymentId,
      amountMinor,
      idempotencyKey: winnerIdempotencyKey,
      expectedMode,
    });

    // 16. Authoritative Post-Dispatch Stripe Retrieve (Success OR Failure/Error)
    let postDispatchIntent: Stripe.PaymentIntent | null = null;
    try {
      postDispatchIntent = await stripeClient.paymentIntents.retrieve(opProviderPaymentId);
    } catch (retrieveErr: any) {
      // Ambiguous financial outcome: post-dispatch retrieve failed/timed out
      // DO NOT retry capture automatically, DO NOT mark payment failed, DO NOT release telecom
      return {
        success: false,
        classification: 'DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED',
        saga: currentSaga,
        paymentOp: winnerOp,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(currentSaga.state as CommercialSagaState),
        message: 'Capture POST dispatched but post-dispatch retrieval timed out/failed. Ambiguous financial outcome.',
      };
    }

    // 17. Shared Reconciliation Classification
    const postClassification = CommercialCaptureService.classifyCaptureReconciliation({
      paymentOp: winnerOp,
      paymentIntent: postDispatchIntent,
      expectedMode,
    });

    if (postClassification !== 'CAPTURE_CONFIRMED') {
      // Check if authoritative retrieve proves definite non-captured status (e.g. canceled)
      if (postDispatchIntent.status === 'canceled' || postDispatchIntent.status === 'requires_payment_method') {
        // Transition payment to failed if allowed
        await (supabase as any)
          .from('billing_payment_operations')
          .update({ status: 'failed', updated_at: new Date().toISOString() })
          .eq('id', winnerOp.id);
      }

      return {
        success: false,
        classification: postClassification,
        saga: currentSaga,
        paymentOp: winnerOp,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(currentSaga.state as CommercialSagaState),
        message: `Post-dispatch capture status classified as ${postClassification}.`,
      };
    }

    // 18. Confirm Canonical Payment Captured (capture_pending -> captured)
    let confirmedOp = winnerOp;
    try {
      const { data: rpcOp, error: rpcErr } = await (supabase as any).rpc('confirm_payment_captured', {
        p_payment_op_id: winnerOp.id,
        p_organization_id: organizationId,
        p_provider_payment_id: postDispatchIntent.id,
      });

      if (rpcErr || !rpcOp) {
        // Stripe succeeded but DB confirmation failed -> CAPTURE_CONFIRMED_BUT_LOCAL_RECONCILIATION_INCOMPLETE
        return {
          success: false,
          classification: 'MANUAL_REVIEW_REQUIRED',
          saga: currentSaga,
          paymentOp: winnerOp,
          customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(currentSaga.state as CommercialSagaState),
          error: { code: 'DB_CAPTURE_CONFIRMATION_FAILED', message: rpcErr?.message || 'DB confirm_payment_captured RPC failed.' },
        };
      }
      confirmedOp = rpcOp;
    } catch (confEx: any) {
      return {
        success: false,
        classification: 'MANUAL_REVIEW_REQUIRED',
        saga: currentSaga,
        paymentOp: winnerOp,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(currentSaga.state as CommercialSagaState),
        error: { code: 'DB_CAPTURE_CONFIRMATION_EXCEPTION', message: confEx.message },
      };
    }

    // 19. Fresh Telecom Reads
    let freshProvOp = providerNumberOp;
    let freshPhone = phoneRow;

    if (saga.provider_number_operation_id) {
      const { data: pnoData } = await (supabase as any)
        .from('provider_number_operations')
        .select('*')
        .eq('id', saga.provider_number_operation_id)
        .maybeSingle();
      if (pnoData) freshProvOp = pnoData;
    }

    if (saga.phone_number_e164) {
      const { data: phoneData } = await (supabase as any)
        .from('phone_numbers')
        .select('*')
        .eq('phone_number', saga.phone_number_e164)
        .eq('organization_id', organizationId)
        .maybeSingle();
      if (phoneData) freshPhone = phoneData;
    }

    // 20. Dual Predicate Evaluation & Saga Completion (capture_pending -> completed)
    let completedSaga = currentSaga;
    if (freshProvOp && freshPhone) {
      const completionCheck = CommercialCaptureService.isEligibleForSagaCompletion({
        saga: currentSaga,
        paymentOp: confirmedOp,
        paymentIntent: postDispatchIntent,
        providerNumberOp: freshProvOp,
        phoneRow: freshPhone,
        expectedMode,
      });

      if (completionCheck.eligible && currentSaga.state === 'capture_pending') {
        const { data: rpcSaga, error: completeRpcErr } = await (supabase as any).rpc('complete_commercial_saga_after_capture', {
          p_saga_id: currentSaga.id,
          p_organization_id: organizationId,
        });

        if (!completeRpcErr && rpcSaga) {
          completedSaga = rpcSaga;
        }
      }
    }

    return {
      success: completedSaga.state === 'completed',
      classification: 'CAPTURE_CONFIRMED',
      saga: completedSaga,
      paymentOp: confirmedOp,
      customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO((completedSaga.state || 'completed') as CommercialSagaState),
      message: completedSaga.state === 'completed' ? 'Commercial purchase saga completed successfully.' : 'Payment captured authoritatively. Final saga completion pending.',
    };
  }
}

