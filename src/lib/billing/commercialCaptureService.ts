import Stripe from 'stripe';
import { SupabaseClient } from '@supabase/supabase-js';
import { CommercialSagaStateMachine, CommercialSagaState, CustomerSagaStatusDTO } from './commercialSagaStateMachine';

/**
 * Phase 13.3.3.2A — Commercial Capture Service (Pure Predicates & Classifier)
 * 
 * Authoritative evaluation helpers for:
 * 1. Pre-capture dispatch eligibility (isEligibleForCaptureDispatch)
 * 2. Authoritative Stripe capture success verification (isAuthoritativeCaptureSuccess)
 * 3. Telecom line ownership verification (isEligibleForTelecomOwnership)
 * 4. Final commercial saga completion eligibility (isEligibleForSagaCompletion)
 * 5. Shared reconciliation classifier (classifyCaptureReconciliation)
 * 
 * CONSTRAINTS:
 * - Read-only / Pure functions only.
 * - NO calls to stripe.paymentIntents.capture().
 * - NO database mutations or DDL.
 * - Fail-closed security design.
 */

export type CaptureReconciliationClassification =
  | 'CAPTURE_CONFIRMED'
  | 'STILL_REQUIRES_CAPTURE_UNCLAIMED'
  | 'DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED'
  | 'PAYMENT_NOT_CAPTURABLE'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_PROCESSING'
  | 'MODE_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'PROVIDER_ID_MISMATCH'
  | 'MANUAL_REVIEW_REQUIRED';

export interface CommercialSagaRecord {
  id: string;
  organization_id?: string;
  organizationId?: string;
  state: CommercialSagaState | string;
  phone_number_e164?: string;
  phoneNumberE164?: string;
  retail_amount_minor?: number;
  retailAmountMinor?: number;
  currency: string;
  payment_operation_id?: string | null;
  paymentOperationId?: string | null;
  provider_number_operation_id?: string | null;
  providerNumberOperationId?: string | null;
  [key: string]: any;
}

export interface BillingPaymentOperationRecord {
  id: string;
  organization_id?: string;
  organizationId?: string;
  commercial_saga_id?: string | null;
  commercialSagaId?: string | null;
  provider: string;
  status: string;
  amount_minor?: number;
  amountMinor?: number;
  amount?: number;
  currency: string;
  provider_payment_id?: string | null;
  providerPaymentId?: string | null;
  capture_method?: string | null;
  captureMethod?: string | null;
  capture_dispatch_claimed_at?: string | null;
  captureDispatchClaimedAt?: string | null;
  capture_idempotency_key?: string | null;
  captureIdempotencyKey?: string | null;
  authorization_expires_at?: string | null;
  authorizationExpiresAt?: string | null;
  request_fingerprint?: string | null;
  requestFingerprint?: string | null;
  metadata?: Record<string, any> | null;
  [key: string]: any;
}

export interface ProviderNumberOperationRecord {
  id: string;
  organization_id?: string;
  organizationId?: string;
  phone_number_e164?: string;
  phoneNumberE164?: string;
  status: string;
  provider_resource_id?: string | null;
  providerResourceId?: string | null;
  provider_sid?: string | null;
  twilio_sid?: string | null;
  [key: string]: any;
}

export interface PhoneNumberRecord {
  id: string;
  organization_id?: string;
  organizationId?: string;
  phone_number?: string;
  phone_number_e164?: string;
  phoneNumber?: string;
  status: string;
  provider_resource_id?: string | null;
  providerResourceId?: string | null;
  provider_sid?: string | null;
  twilio_sid?: string | null;
  [key: string]: any;
}

export interface PreCaptureValidationParams {
  saga: CommercialSagaRecord;
  paymentOp: BillingPaymentOperationRecord;
  paymentIntent: Stripe.PaymentIntent;
  expectedMode: 'test' | 'live';
  expectedFingerprint?: string;
}

export interface CaptureSuccessValidationParams {
  paymentOp: BillingPaymentOperationRecord;
  paymentIntent: Stripe.PaymentIntent;
  expectedMode: 'test' | 'live';
}

export interface TelecomOwnershipValidationParams {
  saga: CommercialSagaRecord;
  providerNumberOp: ProviderNumberOperationRecord;
  phoneRow: PhoneNumberRecord;
}

export interface SagaCompletionValidationParams {
  saga: CommercialSagaRecord;
  paymentOp: BillingPaymentOperationRecord;
  paymentIntent: Stripe.PaymentIntent;
  providerNumberOp: ProviderNumberOperationRecord;
  phoneRow: PhoneNumberRecord;
  expectedMode: 'test' | 'live';
}

export interface ValidationResult {
  eligible: boolean;
  reason?: string;
}

export class CommercialCaptureService {
  /**
   * Evaluates if a saga and payment operation are eligible for capture dispatch claim.
   * Pure predicate — fails closed.
   */
  static isEligibleForCaptureDispatch(params: PreCaptureValidationParams): ValidationResult {
    const { saga, paymentOp, paymentIntent, expectedMode, expectedFingerprint } = params;

    if (!saga || !paymentOp || !paymentIntent) {
      return { eligible: false, reason: 'MISSING_REQUIRED_ENTITIES' };
    }

    // Explicit property resolution supporting both snake_case DB fields and camelCase DTOs
    const sagaOrg = saga.organization_id || saga.organizationId;
    const sagaState = saga.state;
    const sagaAmount = saga.retail_amount_minor ?? saga.retailAmountMinor;
    if (sagaAmount === undefined || sagaAmount === null) {
      return { eligible: false, reason: 'MISSING_SAGA_AMOUNT: Saga retail amount is required' };
    }
    const sagaCurrency = (saga.currency || '').toLowerCase();
    const sagaPaymentOpId = saga.payment_operation_id || saga.paymentOperationId;

    const opOrg = paymentOp.organization_id || paymentOp.organizationId;
    const opProvider = paymentOp.provider;
    const opStatus = paymentOp.status;
    const opAmount = paymentOp.amount_minor ?? paymentOp.amountMinor ?? paymentOp.amount;
    if (opAmount === undefined || opAmount === null) {
      return { eligible: false, reason: 'MISSING_PAYMENT_AMOUNT: Payment operation amount is required' };
    }
    const opCurrency = (paymentOp.currency || '').toLowerCase();
    const opProviderPaymentId = paymentOp.provider_payment_id || paymentOp.providerPaymentId;
    const opSagaId = paymentOp.commercial_saga_id || paymentOp.commercialSagaId;
    const opCaptureMethod = paymentOp.capture_method || paymentOp.captureMethod || 'manual';
    const dispatchClaimedAt = paymentOp.capture_dispatch_claimed_at ?? paymentOp.captureDispatchClaimedAt;
    const dispatchIdempotencyKey = paymentOp.capture_idempotency_key ?? paymentOp.captureIdempotencyKey;
    const authExpiresAt = paymentOp.authorization_expires_at ?? paymentOp.authorizationExpiresAt;
    const opFingerprint = paymentOp.request_fingerprint ?? paymentOp.requestFingerprint;

    // 1. Provider MUST be Stripe
    if (opProvider !== 'stripe') {
      return { eligible: false, reason: 'INVALID_PROVIDER: Provider must be stripe' };
    }

    // 2. Exact Provider Payment ID Linkage
    if (!opProviderPaymentId || opProviderPaymentId !== paymentIntent.id) {
      return { eligible: false, reason: 'PROVIDER_PAYMENT_ID_MISMATCH: Payment operation provider_payment_id does not match PaymentIntent' };
    }

    // 3. Organization Security Boundary
    if (!sagaOrg || !opOrg || sagaOrg !== opOrg) {
      return { eligible: false, reason: 'TENANT_MISMATCH: Saga organization does not match payment operation' };
    }

    // 4. Saga & Payment Operation Relational Linkage
    if (opSagaId && opSagaId !== saga.id) {
      return { eligible: false, reason: 'SAGA_LINKAGE_MISMATCH: Payment operation commercial_saga_id does not match saga ID' };
    }
    if (sagaPaymentOpId && sagaPaymentOpId !== paymentOp.id) {
      return { eligible: false, reason: 'PAYMENT_LINKAGE_MISMATCH: Saga payment_operation_id does not match payment operation ID' };
    }

    // 5. Immutable Amount Match
    if (opAmount !== sagaAmount) {
      return { eligible: false, reason: 'AMOUNT_MISMATCH: Payment operation amount does not match saga retail amount' };
    }

    // 6. Currency Match
    if (!opCurrency || opCurrency !== sagaCurrency) {
      return { eligible: false, reason: 'CURRENCY_MISMATCH: Payment operation currency does not match saga currency' };
    }

    // 7. Canonical Payment State must be authorized
    if (opStatus !== 'authorized') {
      return { eligible: false, reason: `INVALID_PAYMENT_STATUS: Payment operation status is '${opStatus}', expected 'authorized'` };
    }

    // 8. Commercial Saga State must be ownership_confirmed or capture_pending
    if (sagaState !== 'ownership_confirmed' && sagaState !== 'capture_pending') {
      return { eligible: false, reason: `INVALID_SAGA_STATE: Commercial saga state is '${sagaState}', expected 'ownership_confirmed' or 'capture_pending'` };
    }

    // 9 & 10. Single-dispatch Lock Constraint (claimed_at and idempotency_key must be null)
    if (dispatchClaimedAt !== null && dispatchClaimedAt !== undefined) {
      return { eligible: false, reason: 'DISPATCH_ALREADY_CLAIMED: capture_dispatch_claimed_at is already set' };
    }
    if (dispatchIdempotencyKey !== null && dispatchIdempotencyKey !== undefined) {
      return { eligible: false, reason: 'DISPATCH_ALREADY_CLAIMED: capture_idempotency_key is already set' };
    }

    // 11. Authoritative Stripe PaymentIntent checks
    if (opCaptureMethod !== 'manual' || paymentIntent.capture_method !== 'manual') {
      return { eligible: false, reason: `INVALID_CAPTURE_METHOD: PaymentIntent capture_method is '${paymentIntent.capture_method}', expected 'manual'` };
    }

    if (paymentIntent.status !== 'requires_capture') {
      return { eligible: false, reason: `INVALID_PAYMENT_INTENT_STATUS: PaymentIntent status is '${paymentIntent.status}', expected 'requires_capture'` };
    }

    if (paymentIntent.amount !== opAmount) {
      return { eligible: false, reason: 'PAYMENT_INTENT_AMOUNT_MISMATCH: PaymentIntent amount does not match expected minor amount' };
    }

    if ((paymentIntent.currency || '').toLowerCase() !== sagaCurrency) {
      return { eligible: false, reason: 'PAYMENT_INTENT_CURRENCY_MISMATCH: PaymentIntent currency does not match expected currency' };
    }

    if (paymentIntent.amount_capturable < sagaAmount) {
      return { eligible: false, reason: 'INSUFFICIENT_AMOUNT_CAPTURABLE: PaymentIntent amount_capturable is less than retail amount' };
    }

    // 12. Mode Verification (test vs live)
    const isLive = expectedMode === 'live';
    if (paymentIntent.livemode !== isLive) {
      return { eligible: false, reason: `MODE_MISMATCH: PaymentIntent livemode is ${paymentIntent.livemode}, expected ${isLive}` };
    }

    // 13. Metadata Linkage & Fingerprint checks
    if (paymentIntent.metadata) {
      if (paymentIntent.metadata.organization_id && paymentIntent.metadata.organization_id !== sagaOrg) {
        return { eligible: false, reason: 'METADATA_TENANT_MISMATCH: PaymentIntent metadata organization_id mismatch' };
      }
      if (paymentIntent.metadata.operation_id && paymentIntent.metadata.operation_id !== paymentOp.id) {
        return { eligible: false, reason: 'METADATA_OPERATION_MISMATCH: PaymentIntent metadata operation_id mismatch' };
      }
    }

    if (expectedFingerprint && opFingerprint && expectedFingerprint !== opFingerprint) {
      return { eligible: false, reason: 'FINGERPRINT_MISMATCH: Selection fingerprint does not match payment operation request fingerprint' };
    }

    // 14. Authorization Expiration check (if value exists)
    if (authExpiresAt) {
      const expiresDate = new Date(authExpiresAt);
      if (!isNaN(expiresDate.getTime()) && expiresDate.getTime() <= Date.now()) {
        return { eligible: false, reason: 'AUTHORIZATION_EXPIRED: Payment authorization hold has expired' };
      }
    }

    return { eligible: true };
  }

  /**
   * Pure predicate evaluating whether a retrieved Stripe PaymentIntent proves authoritative capture success.
   * Fails closed. Does not make external network requests.
   */
  static isAuthoritativeCaptureSuccess(params: CaptureSuccessValidationParams): ValidationResult {
    const { paymentOp, paymentIntent, expectedMode } = params;

    if (!paymentOp || !paymentIntent) {
      return { eligible: false, reason: 'MISSING_REQUIRED_ENTITIES' };
    }

    const opAmount = paymentOp.amount_minor ?? paymentOp.amountMinor ?? paymentOp.amount;
    const opCurrency = (paymentOp.currency || '').toLowerCase();
    const opProviderPaymentId = paymentOp.provider_payment_id || paymentOp.providerPaymentId;

    // 1. Provider Payment ID linkage match
    if (!opProviderPaymentId || opProviderPaymentId !== paymentIntent.id) {
      return { eligible: false, reason: 'PROVIDER_PAYMENT_ID_MISMATCH: Payment operation provider_payment_id does not match PaymentIntent' };
    }

    // 2. Mode Verification
    const isLive = expectedMode === 'live';
    if (paymentIntent.livemode !== isLive) {
      return { eligible: false, reason: `MODE_MISMATCH: PaymentIntent livemode is ${paymentIntent.livemode}, expected ${isLive}` };
    }

    // 3. Status must be succeeded
    if (paymentIntent.status !== 'succeeded') {
      return { eligible: false, reason: `INVALID_STATUS: PaymentIntent status is '${paymentIntent.status}', expected 'succeeded'` };
    }

    // 4. Currency Match
    if ((paymentIntent.currency || '').toLowerCase() !== opCurrency) {
      return { eligible: false, reason: 'CURRENCY_MISMATCH: PaymentIntent currency does not match operation currency' };
    }

    // 5. Economic Capture Proof: amount_received must equal expected minor amount
    if (paymentIntent.amount_received !== opAmount) {
      return { eligible: false, reason: `AMOUNT_RECEIVED_MISMATCH: PaymentIntent amount_received (${paymentIntent.amount_received}) does not match expected amount (${opAmount})` };
    }

    if (paymentIntent.amount_received <= 0) {
      return { eligible: false, reason: 'ZERO_AMOUNT_CAPTURED: PaymentIntent amount_received must be greater than zero' };
    }

    // 6. Capturable amount must be 0 after full capture
    if (paymentIntent.amount_capturable > 0) {
      return { eligible: false, reason: 'UNCAPTURED_FUNDS_REMAIN: PaymentIntent amount_capturable is not 0' };
    }

    return { eligible: true };
  }

  /**
   * Pure predicate evaluating canonical telecom ownership.
   * Reuses exact frozen Phase 12 / Phase 13.3.2 provider operation & phone_numbers status semantics.
   */
  static isEligibleForTelecomOwnership(params: TelecomOwnershipValidationParams): ValidationResult {
    const { saga, providerNumberOp, phoneRow } = params;

    if (!saga || !providerNumberOp || !phoneRow) {
      return { eligible: false, reason: 'MISSING_TELECOM_ENTITIES' };
    }

    const sagaOrg = saga.organization_id || saga.organizationId;
    const sagaE164 = saga.phone_number_e164 || saga.phoneNumberE164;

    const provOrg = providerNumberOp.organization_id || providerNumberOp.organizationId;
    const provE164 = providerNumberOp.phone_number_e164 || providerNumberOp.phoneNumberE164;
    const provStatus = providerNumberOp.status;
    const provSid = providerNumberOp.provider_resource_id || providerNumberOp.providerResourceId || providerNumberOp.provider_sid || providerNumberOp.twilio_sid;

    const phoneOrg = phoneRow.organization_id || phoneRow.organizationId;
    const phoneE164 = phoneRow.phone_number || phoneRow.phone_number_e164 || phoneRow.phoneNumber;
    const phoneStatus = phoneRow.status;
    const phoneSid = phoneRow.provider_resource_id || phoneRow.providerResourceId || phoneRow.provider_sid || phoneRow.twilio_sid || phoneRow.twilio_phone_number_sid;

    // 1. Organization Boundaries
    if (provOrg !== sagaOrg || phoneOrg !== sagaOrg) {
      return { eligible: false, reason: 'TENANT_MISMATCH: Telecom entities do not match saga organization' };
    }

    // 2. Exact E.164 Match
    if (provE164 !== sagaE164 || phoneE164 !== sagaE164) {
      return { eligible: false, reason: 'E164_MISMATCH: Telecom phone numbers do not match saga E.164' };
    }

    // 3. Provider Number Operation Status (Phase 12 / Phase 13.3.2 semantics: succeeded, completed, reconciled_success)
    const validProvStatuses = ['succeeded', 'completed', 'reconciled_success'];
    if (!validProvStatuses.includes(provStatus)) {
      return { eligible: false, reason: `INVALID_PROVIDER_OP_STATUS: provider_number_operations status is '${provStatus}', expected one of [${validProvStatuses.join(', ')}]` };
    }

    // 4. Canonical Phone Row Status (Phase 12 / Phase 13.3.2 semantics: active, purchased)
    const validPhoneStatuses = ['active', 'purchased'];
    if (!validPhoneStatuses.includes(phoneStatus)) {
      return { eligible: false, reason: `INVALID_PHONE_STATUS: phone_numbers status is '${phoneStatus}', expected one of [${validPhoneStatuses.join(', ')}]` };
    }

    // 5. Matching Provider Resource Identity
    if (!provSid || typeof provSid !== 'string' || !provSid.trim() ||
        !phoneSid || typeof phoneSid !== 'string' || !phoneSid.trim() ||
        provSid.trim() !== phoneSid.trim()) {
      return { eligible: false, reason: 'PROVIDER_RESOURCE_ID_MISMATCH: Provider resource ID mismatch between provider_number_operations and phone_numbers' };
    }

    return { eligible: true };
  }

  /**
   * Pure predicate evaluating whether a saga is eligible for final completion RPC.
   * Requires: Authoritative Stripe capture success + Canonical captured payment + Authoritative telecom ownership + Legal saga state (capture_pending).
   */
  static isEligibleForSagaCompletion(params: SagaCompletionValidationParams): ValidationResult {
    const { saga, paymentOp, paymentIntent, providerNumberOp, phoneRow, expectedMode } = params;

    if (!saga) {
      return { eligible: false, reason: 'MISSING_SAGA' };
    }

    // A. Saga state MUST be capture_pending (the legal state required by complete_commercial_saga_after_capture)
    if (saga.state !== 'capture_pending') {
      return { eligible: false, reason: `INVALID_SAGA_STATE: Saga state is '${saga.state}', expected 'capture_pending'` };
    }

    // B. Payment Operation status MUST be captured
    const opStatus = paymentOp?.status;
    if (opStatus !== 'captured') {
      return { eligible: false, reason: `PAYMENT_NOT_CAPTURED: Payment operation status is '${opStatus}', expected 'captured'` };
    }

    // C. Authoritative Stripe capture success check
    const captureProof = this.isAuthoritativeCaptureSuccess({ paymentOp, paymentIntent, expectedMode });
    if (!captureProof.eligible) {
      return { eligible: false, reason: `STRIPE_CAPTURE_UNVERIFIED: ${captureProof.reason}` };
    }

    // D. Telecom Ownership check
    const telecomProof = this.isEligibleForTelecomOwnership({ saga, providerNumberOp, phoneRow });
    if (!telecomProof.eligible) {
      return { eligible: false, reason: `TELECOM_OWNERSHIP_UNVERIFIED: ${telecomProof.reason}` };
    }

    return { eligible: true };
  }

  /**
   * Deterministic Shared Reconciliation Classifier.
   * 
   * Classifies authoritative Stripe PaymentIntent truth into a safe classification enum.
   * 
   * CRITICAL CONSERVATIVE AMBIGUOUS DISPATCH RULE:
   * If capture_dispatch_claimed_at IS NOT NULL and Stripe status is requires_capture,
   * it MUST return DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED (NEVER safe replay).
   */
  static classifyCaptureReconciliation(params: {
    paymentOp: BillingPaymentOperationRecord;
    paymentIntent: Stripe.PaymentIntent;
    expectedMode: 'test' | 'live';
  }): CaptureReconciliationClassification {
    const { paymentOp, paymentIntent, expectedMode } = params;

    if (!paymentOp || !paymentIntent) {
      return 'MANUAL_REVIEW_REQUIRED';
    }

    const opProvider = paymentOp.provider;
    const opProviderPaymentId = paymentOp.provider_payment_id || paymentOp.providerPaymentId;
    const opAmount = paymentOp.amount_minor ?? paymentOp.amountMinor ?? paymentOp.amount;
    const opCurrency = (paymentOp.currency || '').toLowerCase();
    const dispatchClaimedAt = paymentOp.capture_dispatch_claimed_at ?? paymentOp.captureDispatchClaimedAt;

    // 1. Provider Identity Check
    if (opProvider !== 'stripe' || !opProviderPaymentId || opProviderPaymentId !== paymentIntent.id) {
      return 'PROVIDER_ID_MISMATCH';
    }

    // 2. Mode Match
    const isLive = expectedMode === 'live';
    if (paymentIntent.livemode !== isLive) {
      return 'MODE_MISMATCH';
    }

    // 3. Currency Match
    if ((paymentIntent.currency || '').toLowerCase() !== opCurrency) {
      return 'CURRENCY_MISMATCH';
    }

    // 4. Amount Match
    if (paymentIntent.amount !== opAmount) {
      return 'AMOUNT_MISMATCH';
    }

    // 5. Authoritative Status Classification
    switch (paymentIntent.status) {
      case 'succeeded': {
        const successProof = this.isAuthoritativeCaptureSuccess({ paymentOp, paymentIntent, expectedMode });
        return successProof.eligible ? 'CAPTURE_CONFIRMED' : 'AMOUNT_MISMATCH';
      }

      case 'requires_capture': {
        // CONSERVATIVE RULE: If dispatch already claimed, DO NOT allow safe capture replay!
        if (dispatchClaimedAt !== null && dispatchClaimedAt !== undefined) {
          return 'DISPATCH_ALREADY_CLAIMED_RECONCILIATION_REQUIRED';
        }

        if (paymentOp.status === 'authorized') {
          return 'STILL_REQUIRES_CAPTURE_UNCLAIMED';
        }

        return 'MANUAL_REVIEW_REQUIRED';
      }

      case 'processing':
        return 'PAYMENT_PROCESSING';

      case 'canceled':
      case 'requires_payment_method':
        return 'PAYMENT_FAILED';

      default:
        return 'PAYMENT_NOT_CAPTURABLE';
    }
  }

  /**
   * Read-only helper: Performs FRESH database reads of saga, payment operation,
   * provider number operation, and phone row, then evaluates isEligibleForSagaCompletion.
   * NO DB MUTATIONS OR RPCs ARE EXECUTED.
   */
  static async checkFreshEligibilityForSagaCompletion(
    supabase: SupabaseClient,
    sagaId: string,
    paymentIntent: Stripe.PaymentIntent,
    expectedMode: 'test' | 'live'
  ): Promise<ValidationResult> {
    if (!sagaId || !paymentIntent) {
      return { eligible: false, reason: 'MISSING_ARGUMENTS' };
    }

    // 1. Fresh READ of commercial saga
    const { data: saga, error: sagaErr } = await (supabase as any)
      .from('commercial_number_purchase_sagas')
      .select('*')
      .eq('id', sagaId)
      .maybeSingle();

    if (sagaErr || !saga) {
      return { eligible: false, reason: 'SAGA_NOT_FOUND' };
    }

    // 2. Fresh READ of payment operation
    if (!saga.payment_operation_id) {
      return { eligible: false, reason: 'SAGA_HAS_NO_PAYMENT_OPERATION' };
    }

    const { data: paymentOp, error: opErr } = await (supabase as any)
      .from('billing_payment_operations')
      .select('*')
      .eq('id', saga.payment_operation_id)
      .maybeSingle();

    if (opErr || !paymentOp) {
      return { eligible: false, reason: 'PAYMENT_OP_NOT_FOUND' };
    }

    // 3. Fresh READ of provider number operation
    if (!saga.provider_number_operation_id) {
      return { eligible: false, reason: 'SAGA_HAS_NO_PROVIDER_NUMBER_OPERATION' };
    }

    const { data: providerNumberOp, error: pnoErr } = await (supabase as any)
      .from('provider_number_operations')
      .select('*')
      .eq('id', saga.provider_number_operation_id)
      .maybeSingle();

    if (pnoErr || !providerNumberOp) {
      return { eligible: false, reason: 'PROVIDER_NUMBER_OP_NOT_FOUND' };
    }

    // 4. Fresh READ of canonical phone_numbers row
    const { data: phoneRow, error: phoneErr } = await (supabase as any)
      .from('phone_numbers')
      .select('*')
      .eq('phone_number', saga.phone_number_e164)
      .eq('organization_id', saga.organization_id)
      .maybeSingle();

    if (phoneErr || !phoneRow) {
      return { eligible: false, reason: 'PHONE_NUMBER_ROW_NOT_FOUND' };
    }

    // 5. Evaluate pure eligibility against fresh DB entities
    return this.isEligibleForSagaCompletion({
      saga,
      paymentOp,
      paymentIntent,
      providerNumberOp,
      phoneRow,
      expectedMode,
    });
  }

  /**
   * Customer-safe DTO Mapping.
   * Reuses CommercialSagaStateMachine.mapStateToCustomerDTO.
   * Hides all internal IDs, PaymentIntent IDs, Twilio SIDs, and internal codes.
   */
  static getCustomerSafeSagaDTO(state: CommercialSagaState): CustomerSagaStatusDTO {
    return CommercialSagaStateMachine.mapStateToCustomerDTO(state);
  }
}
