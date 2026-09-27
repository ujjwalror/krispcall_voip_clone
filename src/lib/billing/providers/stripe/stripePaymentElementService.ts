import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import Stripe from 'stripe';
import { getStripeClient } from './stripeClient';
import { StripeCustomerService } from './stripeCustomerService';
import { RetailPricingService } from '@/lib/telephony/marketplace/pricingService';
import { inventoryProvider } from '@/lib/telephony/marketplace/inventoryProvider';
import { RegulatoryPreCheckService } from '@/lib/telephony/marketplace/regulatoryPreCheckService';
import { PaymentStateMachine } from '../../paymentStateMachine';
import { PaymentCanonicalStatus } from '../../types';

export interface CreateCheckoutSessionParams {
  organizationId: string;
  userId: string;
  phoneNumber: string;
  countryCode: string;
  numberType: string;
  expectedPriceMinor?: number;
  consentToSaveMethod?: boolean;
  attemptToken?: string;
  bundleSid?: string | null;
}

export interface CheckoutSessionResult {
  success: boolean;
  operationId?: string;
  canonicalStatus?: PaymentCanonicalStatus;
  customerSafeStatus?: string;
  clientSecret?: string | null;
  priceSummary?: {
    phoneNumber: string;
    countryCode: string;
    numberType: string;
    monthlyRetailMinor: number;
    currency: string;
    taxStatus: string;
  };
  error?: {
    code: string;
    message: string;
  };
}

export function mapCanonicalToCustomerSafeStatus(status: PaymentCanonicalStatus): string {
  switch (status) {
    case 'pending':
      return 'Preparing checkout';
    case 'requires_customer_action':
      return 'Authentication required';
    case 'authorized':
      return 'Payment authorized';
    case 'failed':
      return 'Payment declined';
    case 'canceled':
      return 'Checkout canceled';
    case 'reconciliation_required':
    case 'manual_review_required':
      return 'Verifying payment status';
    case 'captured':
      return 'Payment authorized';
    default:
      return 'Verifying payment status';
  }
}

export class StripePaymentElementService {
  /**
   * Generates a deterministic request fingerprint for a checkout operation.
   */
  static generateFingerprint(
    organizationId: string,
    phoneNumber: string,
    countryCode: string,
    numberType: string,
    retailMinor: number,
    currency: string,
    pricingPolicyId: string | null,
    attemptToken: string = ''
  ): string {
    const raw = `${organizationId}:${phoneNumber}:${countryCode.toUpperCase()}:${numberType.toLowerCase()}:${retailMinor}:${currency.toUpperCase()}:${pricingPolicyId || 'default'}:${attemptToken}`;
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return `sha256:${hash}`;
  }

  /**
   * Server-authoritatively creates or recovers an in-app checkout payment operation & Stripe PaymentIntent.
   */
  static async createOrRecoverCheckoutSession(
    supabase: SupabaseClient,
    params: CreateCheckoutSessionParams
  ): Promise<CheckoutSessionResult> {
    const {
      organizationId,
      userId,
      phoneNumber,
      countryCode,
      numberType,
      expectedPriceMinor,
      consentToSaveMethod = false,
      attemptToken = '',
      bundleSid = null,
    } = params;

    const cc = countryCode.toUpperCase();
    const type = numberType.toLowerCase();

    // 1. Authoritative Server-side Price Resolution
    const retailPrice = await RetailPricingService.resolveRetailPrice(cc, type, 'USD');
    if (!retailPrice.hasConfiguredPrice || retailPrice.monthlyPriceMinor === null) {
      return {
        success: false,
        error: {
          code: 'PRICING_UNAVAILABLE',
          message: 'Retail price is not currently configured for this line category.',
        },
      };
    }

    const monthlyRetailMinor = retailPrice.monthlyPriceMinor;
    const currency = retailPrice.currency || 'USD';

    // Verify against client quote if provided
    if (expectedPriceMinor !== undefined && expectedPriceMinor !== monthlyRetailMinor) {
      return {
        success: false,
        error: {
          code: 'QUOTE_EXPIRED_PRICE_CHANGED',
          message: `The price for this number has changed to $${(monthlyRetailMinor / 100).toFixed(2)}/mo. Please review updated pricing.`,
        },
      };
    }

    // 2. Authoritative Exact Phone Number Availability Recheck
    const digitsOnly = phoneNumber.replace(/[^0-9]/g, '');
    const inventory = await inventoryProvider.searchAvailableNumbers({
      countryCode: cc,
      numberType: type as any,
      contains: digitsOnly,
      limit: 10,
    });

    const isAvailable = inventory.some(
      (item: any) =>
        item.phoneNumber === phoneNumber ||
        item.phoneNumber.replace(/[^0-9]/g, '') === digitsOnly
    );

    if (!isAvailable) {
      return {
        success: false,
        error: {
          code: 'NUMBER_UNAVAILABLE',
          message: 'The requested phone number is no longer available. Please select another number.',
        },
      };
    }

    // 3. Authoritative Regulatory Readiness Recheck
    const regCheck = await RegulatoryPreCheckService.evaluateRequirements(
      cc,
      type,
      'business'
    );
    if (regCheck.status === 'unavailable' || regCheck.status === 'error') {
      return {
        success: false,
        error: {
          code: 'REGULATORY_UNREADINESS',
          message: `Regulatory verification required before checkout: ${regCheck.message}`,
        },
      };
    }

    // 4. Generate Fingerprint and Idempotency Key
    const policyId = retailPrice.snapshot?.policyId || null;
    const fingerprint = this.generateFingerprint(
      organizationId,
      phoneNumber,
      cc,
      type,
      monthlyRetailMinor,
      currency,
      policyId,
      attemptToken
    );
    const opIdempotencyKey = `chk_op_${fingerprint}`;

    // 5. Atomic Claim / Create Operation in public.billing_payment_operations
    const { data: existingOp } = await (supabase as any)
      .from('billing_payment_operations')
      .select('*')
      .eq('idempotency_key', opIdempotencyKey)
      .maybeSingle();

    let op = existingOp;

    if (!op) {
      const priceSnapshot = {
        retailAmountMinor: monthlyRetailMinor,
        currency,
        providerCostMinor: retailPrice.snapshot?.providerCostMinor || null,
        providerCostCurrency: retailPrice.snapshot?.providerCostCurrency || null,
        grossMarginMinor: retailPrice.snapshot?.grossMarginMinor || null,
        policyId,
        pricingSource: retailPrice.snapshot?.pricingSource || 'pricing_policy',
        roundingRule: 'none',
        calculatedAt: new Date().toISOString(),
      };

      const { data: newOp, error: insertErr } = await (supabase as any)
        .from('billing_payment_operations')
        .insert({
          organization_id: organizationId,
          operation_type: 'number_purchase',
          provider: 'stripe',
          status: 'pending',
          amount_minor: monthlyRetailMinor,
          currency: currency.toUpperCase(),
          idempotency_key: opIdempotencyKey,
          request_fingerprint: fingerprint,
          price_snapshot_payload: priceSnapshot,
          metadata: {
            selectionContext: {
              phoneNumber,
              countryCode: cc,
              numberType: type,
              monthlyRetailMinor,
              currency,
              billingInterval: 'monthly',
              bundleSid,
            },
            consentToSaveMethod,
            createdByUserId: userId,
          },
        })
        .select('*')
        .single();

      if (insertErr) {
        if (insertErr.code === '23505') {
          // Race condition hit: fetch existing operation
          const { data: racedOp } = await (supabase as any)
            .from('billing_payment_operations')
            .select('*')
            .eq('idempotency_key', opIdempotencyKey)
            .single();
          op = racedOp;
        } else {
          console.error('[StripePaymentElementService] Insert operation DB error:', insertErr.code, insertErr.message, insertErr.details);
          return {
            success: false,
            error: {
              code: 'OPERATION_CREATION_FAILED',
              message: 'We couldn’t initialize checkout right now. Please try again or contact support if the issue persists.',
            },
          };
        }
      } else {
        op = newOp;
      }
    }

    if (!op) {
      return {
        success: false,
        error: {
          code: 'OPERATION_NOT_FOUND',
          message: 'Unable to initialize or resolve checkout payment operation.',
        },
      };
    }

    // 6. Ensure Stripe Customer
    let stripeCustomerId = op.provider_customer_id;
    if (!stripeCustomerId) {
      stripeCustomerId = await StripeCustomerService.getOrCreateStripeCustomer(
        supabase,
        organizationId
      );

      await (supabase as any)
        .from('billing_payment_operations')
        .update({ provider_customer_id: stripeCustomerId, updated_at: new Date().toISOString() })
        .eq('id', op.id);
      op.provider_customer_id = stripeCustomerId;
    }

    // 7. Stripe PaymentIntent Creation / Recovery with Deterministic Idempotency Key
    const stripe = getStripeClient();
    let paymentIntent: Stripe.PaymentIntent;

    const piIdempotencyKey = `chk_pi_${op.id}`;

    try {
      if (op.provider_payment_id) {
        // Retrieve existing PaymentIntent directly from Stripe API
        paymentIntent = await stripe.paymentIntents.retrieve(op.provider_payment_id);
      } else {
        // Create new PaymentIntent in Stripe TEST MODE with manual capture & deterministic idempotency key
        paymentIntent = await stripe.paymentIntents.create(
          {
            amount: monthlyRetailMinor,
            currency: currency.toLowerCase(),
            customer: stripeCustomerId,
            capture_method: 'manual', // Manual capture as per Section F & G!
            automatic_payment_methods: {
              enabled: true,
            },
            setup_future_usage: consentToSaveMethod ? 'off_session' : undefined, // Section H: ONLY with explicit consent
            metadata: {
              operation_id: op.id,
              organization_id: organizationId,
              phone_number: phoneNumber,
            },
          },
          {
            idempotencyKey: piIdempotencyKey, // Section A.1: Safe replay with SAME deterministic idempotency key
          }
        );

        // Update local operation with provider_payment_id
        const nextStatus: PaymentCanonicalStatus =
          paymentIntent.status === 'requires_action'
            ? 'requires_customer_action'
            : paymentIntent.status === 'requires_capture'
            ? 'authorized'
            : (op.status as PaymentCanonicalStatus);

        await (supabase as any)
          .from('billing_payment_operations')
          .update({
            provider_payment_id: paymentIntent.id,
            status: nextStatus,
            updated_at: new Date().toISOString(),
          })
          .eq('id', op.id);

        op.provider_payment_id = paymentIntent.id;
        op.status = nextStatus;
      }
    } catch (err: any) {
      console.error('[StripePaymentElementService] Stripe API error:', err.message);
      // If result cannot be proven, set local operation to reconciliation_required (Section A.1)
      await (supabase as any)
        .from('billing_payment_operations')
        .update({
          status: 'reconciliation_required',
          failure_code: 'STRIPE_CREATE_AMBIGUOUS',
          failure_message: err.message,
          updated_at: new Date().toISOString(),
        })
        .eq('id', op.id);

      return {
        success: false,
        operationId: op.id,
        canonicalStatus: 'reconciliation_required',
        customerSafeStatus: 'Verifying payment status',
        error: {
          code: 'PAYMENT_INTENT_AMBIGUOUS',
          message: 'Payment status verification is in progress. Please do not retry immediately.',
        },
      };
    }

    const currentCanonicalStatus = op.status as PaymentCanonicalStatus;

    return {
      success: true,
      operationId: op.id,
      canonicalStatus: currentCanonicalStatus,
      customerSafeStatus: mapCanonicalToCustomerSafeStatus(currentCanonicalStatus),
      clientSecret: paymentIntent.client_secret, // Returned strictly to authenticated session (Section J)
      priceSummary: {
        phoneNumber,
        countryCode: cc,
        numberType: type,
        monthlyRetailMinor,
        currency,
        taxStatus: 'Tax not collected (merchant registration pending)',
      },
    };
  }

  /**
   * Retrieves checkout session state safely for an existing operation or organization.
   */
  static async getCheckoutSessionStatus(
    supabase: SupabaseClient,
    organizationId: string,
    operationId?: string,
    phoneNumber?: string
  ): Promise<CheckoutSessionResult> {
    let query = (supabase as any)
      .from('billing_payment_operations')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('operation_type', 'number_purchase');

    if (operationId) {
      query = query.eq('id', operationId);
    } else if (phoneNumber) {
      query = query.filter('metadata->selectionContext->>phoneNumber', 'eq', phoneNumber);
    } else {
      query = query.order('created_at', { ascending: false }).limit(1);
    }

    const { data, error } = await query.maybeSingle();

    if (error || !data) {
      return {
        success: false,
        error: {
          code: 'SESSION_NOT_FOUND',
          message: 'No active checkout session found.',
        },
      };
    }

    const canonicalStatus = data.status as PaymentCanonicalStatus;
    let clientSecret: string | null = null;

    if (data.provider_payment_id && !['canceled', 'failed', 'captured'].includes(canonicalStatus)) {
      try {
        const stripe = getStripeClient();
        const pi = await stripe.paymentIntents.retrieve(data.provider_payment_id);
        clientSecret = pi.client_secret;
      } catch (err: any) {
        console.warn('[StripePaymentElementService] Failed to retrieve client_secret:', err.message);
      }
    }

    const sel = data.metadata?.selectionContext || {};

    return {
      success: true,
      operationId: data.id,
      canonicalStatus,
      customerSafeStatus: mapCanonicalToCustomerSafeStatus(canonicalStatus),
      clientSecret,
      priceSummary: {
        phoneNumber: sel.phoneNumber || '',
        countryCode: sel.countryCode || 'US',
        numberType: sel.numberType || 'local',
        monthlyRetailMinor: data.amount_minor,
        currency: data.currency,
        taxStatus: 'Tax not collected (merchant registration pending)',
      },
    };
  }

  /**
   * Authoritatively cancels an active checkout payment operation & Stripe authorization hold.
   */
  static async cancelCheckoutSession(
    supabase: SupabaseClient,
    organizationId: string,
    operationId: string,
    cancellationReason: string
  ): Promise<{ success: boolean; customerSafeStatus: string; message: string }> {
    const { data: op, error } = await (supabase as any)
      .from('billing_payment_operations')
      .select('*')
      .eq('id', operationId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error || !op) {
      return {
        success: false,
        customerSafeStatus: 'Checkout canceled',
        message: 'Checkout operation not found or unauthorized.',
      };
    }

    const currentStatus = op.status as PaymentCanonicalStatus;

    if (currentStatus === 'canceled') {
      return {
        success: true,
        customerSafeStatus: 'Checkout canceled',
        message: 'Checkout operation is already canceled.',
      };
    }

    // Cancel Stripe PaymentIntent if provider_payment_id exists
    if (op.provider_payment_id) {
      try {
        const stripe = getStripeClient();
        await stripe.paymentIntents.cancel(op.provider_payment_id, {
          cancellation_reason: 'abandoned',
        });
      } catch (err: any) {
        console.error('[StripePaymentElementService] Error canceling PaymentIntent:', err.message);
        // Section N: If Stripe cancellation result is ambiguous, RECONCILE FIRST
        await (supabase as any)
          .from('billing_payment_operations')
          .update({
            status: 'reconciliation_required',
            failure_code: 'CANCEL_AMBIGUOUS',
            failure_message: err.message,
            updated_at: new Date().toISOString(),
          })
          .eq('id', op.id);

        return {
          success: false,
          customerSafeStatus: 'Verifying payment status',
          message: 'Cancellation is being verified with payment provider.',
        };
      }
    }

    // Validate state machine transition to 'canceled'
    if (PaymentStateMachine.isTransitionAllowed(currentStatus, 'canceled')) {
      await (supabase as any)
        .from('billing_payment_operations')
        .update({
          status: 'canceled',
          failure_code: 'CUSTOMER_CANCELED',
          failure_message: cancellationReason || 'Explicit customer cancellation',
          updated_at: new Date().toISOString(),
        })
        .eq('id', op.id);

      return {
        success: true,
        customerSafeStatus: 'Checkout canceled',
        message: 'Checkout payment operation canceled successfully.',
      };
    } else {
      return {
        success: false,
        customerSafeStatus: mapCanonicalToCustomerSafeStatus(currentStatus),
        message: `Operation cannot be canceled from current state '${currentStatus}'.`,
      };
    }
  }
}
