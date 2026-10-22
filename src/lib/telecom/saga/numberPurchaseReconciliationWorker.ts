import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import {
  ProviderOutcomeCertainty,
  PurchaseReconciliationState,
  CanonicalPurchaseOperationState,
} from '../domain/types';
import { ProviderContext } from '../provider/types';
import { ProviderAccountResolver } from '../provider/providerAccountResolver';
import {
  TwilioProvisioningAdapter,
  AuthoritativeLookupResult,
} from '@/lib/telephony/commerce/twilioProvisioningAdapter';
import { FinancialAuthorizationBoundary } from './financialAuthorizationBoundary';

export interface ReconciliationResult {
  operationId: string;
  reconciliationState: PurchaseReconciliationState;
  outcomeCertainty: ProviderOutcomeCertainty;
  canonicalState: CanonicalPurchaseOperationState;
  resolvedSid?: string | null;
  message: string;
}

/**
 * ==============================================================================
 * PHASE 23D.3: NUMBER PURCHASE RECONCILIATION WORKER
 * ==============================================================================
 * Audits ambiguous purchase operations against the carrier's subaccount inventory.
 * 
 * STRICT DISTRIBUTED-SYSTEMS RULES:
 * 1. UNKNOWN ≠ FAILED: Operations in ambiguous states must be audited, never assumed failed.
 * 2. Dedicated Subaccount Scoping: Carrier inventory query MUST use the customer's
 *    assigned CUSTOMER_SUBACCOUNT context. Parent account lookup is forbidden.
 * 3. Bounded Audit: Performs up to maxAuditAttempts (default: 3). If inconclusive,
 *    transitions to MANUAL_REVIEW_REQUIRED rather than guessing.
 * 4. Zero Alternate Purchases: Reconciliation NEVER issues an IncomingPhoneNumbers POST.
 */
export class NumberPurchaseReconciliationWorker {
  static readonly MAX_AUDIT_ATTEMPTS = 3;

  /**
   * Reconciles a single purchase operation currently in an ambiguous state.
   */
  static async reconcileOperation(
    operationId: string,
    organizationId: string,
    supabase: SupabaseClient,
    options?: {
      maxAttempts?: number;
      contextOverride?: ProviderContext;
      mockLookupAdapter?: (e164: string, ctx: ProviderContext) => Promise<AuthoritativeLookupResult>;
    }
  ): Promise<ReconciliationResult> {
    // 1. Fetch operation with strict organization ownership check
    const { data: op, error: opErr } = await (supabase as any)
      .from('provider_number_operations')
      .select('*')
      .eq('id', operationId)
      .maybeSingle();

    if (opErr || !op) {
      throw new Error(`RECONCILIATION_ERROR: Operation '${operationId}' not found.`);
    }

    if (op.organization_id !== organizationId) {
      throw new Error(`TENANT_MISMATCH: Operation '${operationId}' does not belong to organization '${organizationId}'.`);
    }

    // If operation has already reached terminal state, return existing certainty
    if (op.canonical_state === 'CONFIRMED' || op.status === 'succeeded') {
      return {
        operationId,
        reconciliationState: 'RESOLVED',
        outcomeCertainty: 'CONFIRMED_SUCCESS',
        canonicalState: 'CONFIRMED',
        resolvedSid: op.provider_resource_id,
        message: 'Operation is already confirmed succeeded.',
      };
    }

    if (op.canonical_state === 'FAILED' && op.outcome_certainty === 'CONFIRMED_FAILURE') {
      return {
        operationId,
        reconciliationState: 'RESOLVED',
        outcomeCertainty: 'CONFIRMED_FAILURE',
        canonicalState: 'FAILED',
        message: 'Operation is already confirmed failed.',
      };
    }

    // 2. Resolve validated customer subaccount ProviderContext
    let providerContext = options?.contextOverride;
    if (!providerContext) {
      const resolution = await ProviderAccountResolver.resolveAccount(
        {
          organizationId: op.organization_id,
          service: 'NUMBER_MANAGEMENT',
          countryCode: op.country_code,
          intent: 'CUSTOMER_RUNTIME',
        },
        supabase
      );

      if (!resolution.success || !resolution.context) {
        // Cannot audit without customer provider account context -> manual review
        await (supabase as any)
          .from('provider_number_operations')
          .update({
            canonical_state: 'MANUAL_REVIEW_REQUIRED',
            status: 'manual_review_required',
            outcome_certainty: 'MANUAL_REVIEW_REQUIRED',
            reconciliation_state: 'MANUAL_INTERVENTION_REQUIRED',
            sanitized_error_code: 'PROVIDER_CONTEXT_UNRESOLVABLE',
            sanitized_error_message: 'Cannot audit subaccount inventory: provider account context unresolvable.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', operationId);

        return {
          operationId,
          reconciliationState: 'MANUAL_INTERVENTION_REQUIRED',
          outcomeCertainty: 'MANUAL_REVIEW_REQUIRED',
          canonicalState: 'MANUAL_REVIEW_REQUIRED',
          message: 'Provider context unresolvable for subaccount audit.',
        };
      }
      providerContext = resolution.context;
    }

    // Security interlock: Provider context MUST be CUSTOMER_SUBACCOUNT
    if (providerContext.isSharedParent || providerContext.accountType === 'SHARED_PARENT') {
      throw new Error('PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED: Subaccount reconciliation audit cannot execute on SHARED_PARENT account.');
    }

    const currentAttempts = (op.attempt_count || 1);
    const maxAttempts = options?.maxAttempts || this.MAX_AUDIT_ATTEMPTS;

    // 3. Query subaccount inventory for the exact requested E.164
    let lookupResult: AuthoritativeLookupResult | null = null;
    let auditError: Error | null = null;
    try {
      if (options?.mockLookupAdapter) {
        lookupResult = await options.mockLookupAdapter(op.phone_number_e164, providerContext);
      } else {
        lookupResult = await TwilioProvisioningAdapter.lookupOwnedNumberByE164(
          op.phone_number_e164,
          providerContext
        );
      }
    } catch (err: any) {
      auditError = err;
    }

    // Handle Audit Network / API Failure (Inconclusive)
    if (auditError) {
      if (currentAttempts >= maxAttempts) {
        await (supabase as any)
          .from('provider_number_operations')
          .update({
            canonical_state: 'MANUAL_REVIEW_REQUIRED',
            status: 'manual_review_required',
            outcome_certainty: 'MANUAL_REVIEW_REQUIRED',
            reconciliation_state: 'MANUAL_INTERVENTION_REQUIRED',
            sanitized_error_code: 'AUDIT_ATTEMPTS_EXHAUSTED',
            sanitized_error_message: `Carrier inventory audit failed after ${maxAttempts} attempts: ${auditError.message}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', operationId);

        return {
          operationId,
          reconciliationState: 'MANUAL_INTERVENTION_REQUIRED',
          outcomeCertainty: 'MANUAL_REVIEW_REQUIRED',
          canonicalState: 'MANUAL_REVIEW_REQUIRED',
          message: 'Max audit attempts exceeded. Manual intervention required.',
        };
      }

      await (supabase as any)
        .from('provider_number_operations')
        .update({
          canonical_state: 'RECONCILIATION_REQUIRED',
          status: 'reconciliation_required',
          outcome_certainty: 'STILL_UNKNOWN',
          reconciliation_state: 'AUDITING',
          attempt_count: currentAttempts + 1,
          last_reconciled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', operationId);

      return {
        operationId,
        reconciliationState: 'AUDITING',
        outcomeCertainty: 'STILL_UNKNOWN',
        canonicalState: 'RECONCILIATION_REQUIRED',
        message: `Audit attempt ${currentAttempts} inconclusive due to carrier network error. Retrying audit.`,
      };
    }

    // 4. Evaluate Audit Evidence
    // CASE A: Number Found on Customer Subaccount -> CONFIRMED_SUCCESS
    if (lookupResult && lookupResult.found && lookupResult.sid) {
      const confirmedSid = lookupResult.sid;

      // 4a. Check if this resource is already bound to another organization
      const { data: crossResource } = await (supabase as any)
        .from('telecom_provider_resource_records')
        .select('id, organization_id')
        .eq('provider', 'twilio')
        .eq('remote_resource_id', confirmedSid)
        .maybeSingle();

      if (crossResource && crossResource.organization_id !== organizationId) {
        // High severity cross-tenant collision!
        await (supabase as any)
          .from('provider_number_operations')
          .update({
            canonical_state: 'MANUAL_REVIEW_REQUIRED',
            status: 'manual_review_required',
            outcome_certainty: 'MANUAL_REVIEW_REQUIRED',
            reconciliation_state: 'MANUAL_INTERVENTION_REQUIRED',
            sanitized_error_code: 'CROSS_TENANT_RESOURCE_DETECTED',
            sanitized_error_message: 'Carrier resource belongs to another organization in database.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', operationId);

        return {
          operationId,
          reconciliationState: 'MANUAL_INTERVENTION_REQUIRED',
          outcomeCertainty: 'MANUAL_REVIEW_REQUIRED',
          canonicalState: 'MANUAL_REVIEW_REQUIRED',
          message: 'Cross-tenant resource collision detected.',
        };
      }

      // 4b. Upsert / Verify telecom_provider_resource_records
      let resourceRecId = crossResource?.id;
      if (!resourceRecId) {
        const { data: newRec } = await (supabase as any)
          .from('telecom_provider_resource_records')
          .insert({
            organization_id: organizationId,
            provider_account_id: providerContext.providerAccountId,
            provider: 'twilio',
            resource_type: 'incoming_phone_number',
            remote_resource_id: confirmedSid,
            status: 'active',
            last_verified_at: new Date().toISOString(),
          })
          .select('id')
          .single();
        resourceRecId = newRec?.id;
      }

      // 4c. Upsert / Verify canonical phone_numbers row
      const { data: existingPhone } = await (supabase as any)
        .from('phone_numbers')
        .select('id, organization_id')
        .eq('phone_number', op.phone_number_e164)
        .maybeSingle();

      let domainPhoneId = existingPhone?.id;
      if (!domainPhoneId) {
        const { data: newPhone } = await (supabase as any)
          .from('phone_numbers')
          .insert({
            organization_id: organizationId,
            phone_number: op.phone_number_e164,
            country_code: op.country_code,
            number_type: op.number_type,
            status: 'active',
            active: true,
            ownership_state: 'OWNED',
            service_state: 'PROVISIONING',
            is_primary: false,
            provider: 'twilio',
            provider_account_id: providerContext.providerAccountId,
            provider_resource_record_id: resourceRecId,
            provider_phone_number_sid: confirmedSid,
            capabilities_state: {
              VOICE_INBOUND: { stage: 'PROVISIONED', lastVerifiedAt: new Date().toISOString() },
              VOICE_OUTBOUND: { stage: 'PROVISIONED', lastVerifiedAt: new Date().toISOString() },
              SMS_INBOUND: { stage: 'PROVISIONED', lastVerifiedAt: new Date().toISOString() },
              SMS_OUTBOUND: { stage: 'PROVISIONED', lastVerifiedAt: new Date().toISOString() },
            },
            capabilities_voice: true,
            capabilities_sms: true,
            capabilities_mms: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .select('id')
          .single();
        domainPhoneId = newPhone?.id;
      }

      // Link domainPhoneId to resourceRec if newly created
      if (resourceRecId && domainPhoneId) {
        await (supabase as any)
          .from('telecom_provider_resource_records')
          .update({ domain_phone_number_id: domainPhoneId })
          .eq('id', resourceRecId);
      }

      // 4d. Mark operation CONFIRMED_SUCCESS
      await (supabase as any)
        .from('provider_number_operations')
        .update({
          canonical_state: 'CONFIRMED',
          status: 'succeeded',
          outcome_certainty: 'CONFIRMED_SUCCESS',
          reconciliation_state: 'RESOLVED',
          provider_resource_id: confirmedSid,
          reconciled_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          confirmed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', operationId);

      // Capture hold
      if (op.billing_authorization_id) {
        await FinancialAuthorizationBoundary.captureHold(op.billing_authorization_id);
      }

      return {
        operationId,
        reconciliationState: 'RESOLVED',
        outcomeCertainty: 'CONFIRMED_SUCCESS',
        canonicalState: 'CONFIRMED',
        resolvedSid: confirmedSid,
        message: 'Reconciliation confirmed number is owned by customer subaccount.',
      };
    }

    // CASE B: Conclusively Not Found After Max Attempts -> CONFIRMED_FAILURE
    if (lookupResult && !lookupResult.found && currentAttempts >= maxAttempts) {
      await (supabase as any)
        .from('provider_number_operations')
        .update({
          canonical_state: 'FAILED',
          status: 'failed',
          outcome_certainty: 'CONFIRMED_FAILURE',
          reconciliation_state: 'RESOLVED',
          sanitized_error_code: 'CARRIER_MUTATION_NOT_OBSERVED',
          sanitized_error_message: `Number not found in customer subaccount after ${maxAttempts} audit attempts.`,
          billing_authorization_state: 'RELEASED',
          reconciled_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', operationId);

      // Release financial hold
      if (op.billing_authorization_id) {
        await FinancialAuthorizationBoundary.releaseHold(
          op.billing_authorization_id,
          'Reconciliation concluded number was not acquired.'
        );
      }

      return {
        operationId,
        reconciliationState: 'RESOLVED',
        outcomeCertainty: 'CONFIRMED_FAILURE',
        canonicalState: 'FAILED',
        message: 'Reconciliation audit confirmed carrier purchase was not completed.',
      };
    }

    // CASE C: Still Unknown / Inconclusive -> Increment Attempt Count & Retain STILL_UNKNOWN
    await (supabase as any)
      .from('provider_number_operations')
      .update({
        canonical_state: 'RECONCILIATION_REQUIRED',
        status: 'reconciliation_required',
        outcome_certainty: 'STILL_UNKNOWN',
        reconciliation_state: 'AUDITING',
        attempt_count: currentAttempts + 1,
        last_reconciled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', operationId);

    return {
      operationId,
      reconciliationState: 'AUDITING',
      outcomeCertainty: 'STILL_UNKNOWN',
      canonicalState: 'RECONCILIATION_REQUIRED',
      message: `Audit attempt ${currentAttempts} inconclusive. Retrying audit.`,
    };
  }
}
