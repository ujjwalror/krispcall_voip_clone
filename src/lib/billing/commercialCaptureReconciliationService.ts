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
      const stripeClient = stripeOverride || getStripeClient();
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
      return {
        success: false,
        classification,
        saga,
        paymentOp,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(saga.state as CommercialSagaState),
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
      
      // READ-ONLY / RECONCILIATION-ONLY ANOMALY BRANCH:
      // ZERO database mutations executed. Canonical saga and payment records remain 100% untouched.
      return {
        success: false,
        classification: 'DISPATCH_NOT_CLAIMED_RECONCILIATION_REQUIRED',
        saga,
        paymentOp,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO((saga?.state || 'failed') as CommercialSagaState),
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
    if (saga && paymentOp && providerNumberOp && phoneRow) {
      const completionCheck = CommercialCaptureService.isEligibleForSagaCompletion({
        saga,
        paymentOp,
        paymentIntent,
        providerNumberOp,
        phoneRow,
        expectedMode,
      });

      if (completionCheck.eligible && saga.state === 'capture_pending') {
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
}
