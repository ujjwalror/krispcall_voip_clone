import 'server-only';
import { createClient } from '@supabase/supabase-js';
import {
  ProviderNumberOperation,
  PurchaseOperationStatus,
  CommercialPriceSnapshot,
  RegulatoryProvisioningContext,
  RequestFingerprintV1Input,
  CustomerPurchaseOperationDTO,
} from './types';
import { generateRequestFingerprintV1 } from './requestFingerprint';

function getServiceSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseServiceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('MISSING_SUPABASE_CONFIG: Service role configuration missing.');
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

export interface CreatePurchaseOperationParams {
  organizationId: string;
  idempotencyKey: string;
  phoneNumberE164: string;
  countryCode: string;
  numberType: 'local' | 'mobile' | 'toll_free';
  provider?: string;

  // Pricing inputs from Phase 12.1 commercial resolution
  retailAmountMinor: number;
  retailCurrency: string;
  providerCostMinor: number;
  providerCostCurrency: string;
  pricingSource: 'explicit_override' | 'pricing_policy';
  pricingPolicyId?: string | null;
  targetMarginPct?: number | null;
  minimumFixedMarginMinor?: number | null;

  // Regulatory context
  complianceProfileId?: string | null;
  endUserType?: 'individual' | 'business' | null;
  regulationSid?: string | null;
  regulatoryBundleSid?: string | null;
  addressSid?: string | null;
  endUserSid?: string | null;
  complianceRequirementFingerprint?: string | null;

  // Phase 12.3 server-authoritative line capacity limit
  maxCapacityLimit?: number | null;

  // Phase 19D.1 optional friendly name
  friendlyName?: string | null;
}

export class ProviderNumberOperationService {
  /**
   * Creates or reuses a purchase operation for a given organization and idempotency key.
   */
  static async createOrReusePurchaseOperation(
    params: CreatePurchaseOperationParams
  ): Promise<ProviderNumberOperation> {
    const supabase = getServiceSupabase();
    const provider = (params.provider || 'twilio').toLowerCase();
    const countryCode = params.countryCode.toUpperCase();
    const numberType = params.numberType.toLowerCase();
    const phoneNumberE164 = params.phoneNumberE164.trim();
    const grossMarginMinor = params.retailAmountMinor - params.providerCostMinor;
    const nowIso = new Date().toISOString();

    const fingerprintInput: RequestFingerprintV1Input = {
      operationType: 'purchase_number',
      organizationId: params.organizationId,
      provider,
      phoneNumberE164,
      countryCode,
      numberType,
      retailAmountMinor: params.retailAmountMinor,
      retailCurrency: params.retailCurrency,
      pricingSource: params.pricingSource,
      pricingPolicyId: params.pricingPolicyId,
      providerCostMinor: params.providerCostMinor,
      providerCostCurrency: params.providerCostCurrency,
      complianceProfileId: params.complianceProfileId,
      endUserType: params.endUserType,
      regulationSid: params.regulationSid,
      regulatoryBundleSid: params.regulatoryBundleSid,
      complianceRequirementFingerprint: params.complianceRequirementFingerprint,
    };

    const requestFingerprint = generateRequestFingerprintV1(fingerprintInput);

    const priceSnapshotPayload: CommercialPriceSnapshot = {
      retailAmountMinor: params.retailAmountMinor,
      retailCurrency: params.retailCurrency.toUpperCase(),
      providerCostMinor: params.providerCostMinor,
      providerCostCurrency: params.providerCostCurrency.toUpperCase(),
      pricingSource: params.pricingSource,
      pricingPolicyId: params.pricingPolicyId || null,
      targetMarginPct: params.targetMarginPct || null,
      minimumFixedMarginMinor: params.minimumFixedMarginMinor || null,
      grossMarginMinor,
      priceResolvedAt: nowIso,
      schemaVersion: 1,
    };

    const regulatoryProvisioningContext: RegulatoryProvisioningContext = {
      provider,
      countryCode,
      numberType,
      endUserType: params.endUserType || null,
      regulationSid: params.regulationSid || null,
      complianceProfileId: params.complianceProfileId || null,
      bundleSid: params.regulatoryBundleSid || null,
      addressSid: params.addressSid || null,
      endUserSid: params.endUserSid || null,
      requirementFingerprint: params.complianceRequirementFingerprint || null,
      readinessVerifiedAt: nowIso,
      providerApprovalStatus: params.regulatoryBundleSid ? 'approved' : 'not_required',
      schemaVersion: 1,
    };

    // Attempt RPC execution if available
    const { data: rpcData, error: rpcError } = await supabase.rpc('create_and_claim_number_purchase_op', {
      p_organization_id: params.organizationId,
      p_phone_number_e164: phoneNumberE164,
      p_country_code: countryCode,
      p_number_type: numberType,
      p_idempotency_key: params.idempotencyKey,
      p_request_fingerprint: requestFingerprint,
      p_retail_amount_minor: params.retailAmountMinor,
      p_retail_currency: params.retailCurrency.toUpperCase(),
      p_provider_cost_minor: params.providerCostMinor,
      p_provider_cost_currency: params.providerCostCurrency.toUpperCase(),
      p_pricing_source: params.pricingSource,
      p_pricing_policy_id: params.pricingPolicyId || null,
      p_gross_margin_minor: grossMarginMinor,
      p_price_snapshot_payload: priceSnapshotPayload,
      p_compliance_profile_id: params.complianceProfileId || null,
      p_regulatory_bundle_sid: params.regulatoryBundleSid || null,
      p_regulatory_provisioning_context: regulatoryProvisioningContext,
    });

    if (!rpcError && rpcData) {
      return ProviderNumberOperationService.mapRowToDomain(rpcData);
    }

    if (rpcError && rpcError.message.includes('IDEMPOTENCY_CONFLICT')) {
      throw new Error('IDEMPOTENCY_CONFLICT: Request fingerprint does not match existing idempotency key.');
    }
    if (rpcError && rpcError.message.includes('NUMBER_ALREADY_OWNED')) {
      throw new Error('NUMBER_ALREADY_OWNED: Phone number is currently owned by an active workspace.');
    }

    // Direct SQL fallback if migration RPC is not present in local database test context
    const { data: existingOp } = await supabase
      .from('provider_number_operations')
      .select('*')
      .eq('organization_id', params.organizationId)
      .eq('idempotency_key', params.idempotencyKey)
      .maybeSingle();

    if (existingOp) {
      if (existingOp.request_fingerprint !== requestFingerprint) {
        throw new Error('IDEMPOTENCY_CONFLICT: Request fingerprint does not match existing idempotency key.');
      }
      return ProviderNumberOperationService.mapRowToDomain(existingOp);
    }

    // Check active ownership in phone_numbers
    const { data: existingOwnership } = await supabase
      .from('phone_numbers')
      .select('id')
      .eq('phone_number', phoneNumberE164)
      .in('status', ['active', 'inactive', 'suspended'])
      .maybeSingle();

    if (existingOwnership) {
      throw new Error('NUMBER_ALREADY_OWNED: Phone number is currently owned by an active workspace.');
    }

    // Insert new operation record
    const { data: inserted, error: insertError } = await supabase
      .from('provider_number_operations')
      .insert({
        organization_id: params.organizationId,
        operation_type: 'purchase_number',
        provider,
        phone_number_e164: phoneNumberE164,
        number_type: numberType,
        country_code: countryCode,
        status: 'in_progress',
        idempotency_key: params.idempotencyKey,
        request_fingerprint: requestFingerprint,
        retail_amount_minor: params.retailAmountMinor,
        retail_currency: params.retailCurrency.toUpperCase(),
        provider_cost_minor: params.providerCostMinor,
        provider_cost_currency: params.providerCostCurrency.toUpperCase(),
        pricing_source: params.pricingSource,
        pricing_policy_id: params.pricingPolicyId || null,
        target_margin_pct: params.targetMarginPct || null,
        minimum_fixed_margin_minor: params.minimumFixedMarginMinor || null,
        gross_margin_minor: grossMarginMinor,
        price_snapshot_payload: priceSnapshotPayload,
        compliance_profile_id: params.complianceProfileId || null,
        regulatory_bundle_sid: params.regulatoryBundleSid || null,
        regulatory_provisioning_context: regulatoryProvisioningContext,
        attempt_count: 1,
        started_at: nowIso,
      })
      .select('*')
      .single();

    if (insertError) {
      if (insertError.code === '23505') {
        throw new Error('ACTIVE_PURCHASE_LOCK_EXISTS: Another operation is actively processing this phone number.');
      }
      throw new Error(`DATABASE_ERROR: ${insertError.message}`);
    }

    return ProviderNumberOperationService.mapRowToDomain(inserted);
  }

  /**
   * Creates a purchase operation in 'pending' status using create_purchase_op_pending RPC.
   */
  static async createPurchaseOperationPending(
    params: CreatePurchaseOperationParams
  ): Promise<ProviderNumberOperation> {
    const supabase = getServiceSupabase();
    const provider = (params.provider || 'twilio').toLowerCase();
    const countryCode = params.countryCode.toUpperCase();
    const numberType = params.numberType.toLowerCase();
    const phoneNumberE164 = params.phoneNumberE164.trim();
    const grossMarginMinor = params.retailAmountMinor - params.providerCostMinor;
    const nowIso = new Date().toISOString();

    const fingerprintInput: RequestFingerprintV1Input = {
      operationType: 'purchase_number',
      organizationId: params.organizationId,
      provider,
      phoneNumberE164,
      countryCode,
      numberType,
      retailAmountMinor: params.retailAmountMinor,
      retailCurrency: params.retailCurrency,
      pricingSource: params.pricingSource,
      pricingPolicyId: params.pricingPolicyId,
      providerCostMinor: params.providerCostMinor,
      providerCostCurrency: params.providerCostCurrency,
      complianceProfileId: params.complianceProfileId,
      endUserType: params.endUserType,
      regulationSid: params.regulationSid,
      regulatoryBundleSid: params.regulatoryBundleSid,
      complianceRequirementFingerprint: params.complianceRequirementFingerprint,
    };

    const requestFingerprint = generateRequestFingerprintV1(fingerprintInput);

    const priceSnapshotPayload: CommercialPriceSnapshot = {
      retailAmountMinor: params.retailAmountMinor,
      retailCurrency: params.retailCurrency.toUpperCase(),
      providerCostMinor: params.providerCostMinor,
      providerCostCurrency: params.providerCostCurrency.toUpperCase(),
      pricingSource: params.pricingSource,
      pricingPolicyId: params.pricingPolicyId || null,
      targetMarginPct: params.targetMarginPct || null,
      minimumFixedMarginMinor: params.minimumFixedMarginMinor || null,
      grossMarginMinor,
      priceResolvedAt: nowIso,
      schemaVersion: 1,
    };

    const regulatoryProvisioningContext: RegulatoryProvisioningContext = {
      provider,
      countryCode,
      numberType,
      endUserType: params.endUserType || null,
      regulationSid: params.regulationSid || null,
      complianceProfileId: params.complianceProfileId || null,
      bundleSid: params.regulatoryBundleSid || null,
      addressSid: params.addressSid || null,
      endUserSid: params.endUserSid || null,
      requirementFingerprint: params.complianceRequirementFingerprint || null,
      readinessVerifiedAt: nowIso,
      providerApprovalStatus: params.regulatoryBundleSid ? 'approved' : 'not_required',
      schemaVersion: 1,
    };

    // Execute RPC
    const { data: rpcData, error: rpcError } = await supabase.rpc('create_purchase_op_pending', {
      p_organization_id: params.organizationId,
      p_phone_number_e164: phoneNumberE164,
      p_country_code: countryCode,
      p_number_type: numberType,
      p_idempotency_key: params.idempotencyKey,
      p_request_fingerprint: requestFingerprint,
      p_retail_amount_minor: params.retailAmountMinor,
      p_retail_currency: params.retailCurrency.toUpperCase(),
      p_provider_cost_minor: params.providerCostMinor,
      p_provider_cost_currency: params.providerCostCurrency.toUpperCase(),
      p_pricing_source: params.pricingSource,
      p_pricing_policy_id: params.pricingPolicyId || null,
      p_gross_margin_minor: grossMarginMinor,
      p_price_snapshot_payload: priceSnapshotPayload,
      p_compliance_profile_id: params.complianceProfileId || null,
      p_regulatory_bundle_sid: params.regulatoryBundleSid || null,
      p_regulatory_provisioning_context: regulatoryProvisioningContext,
      p_max_capacity_limit: params.maxCapacityLimit || 50,
    });

    if (!rpcError && rpcData) {
      return ProviderNumberOperationService.mapRowToDomain(rpcData);
    }

    if (rpcError) {
      if (rpcError.message.includes('IDEMPOTENCY_CONFLICT')) {
        throw new Error('IDEMPOTENCY_CONFLICT: Request fingerprint does not match existing idempotency key.');
      }
      if (rpcError.message.includes('CAPACITY_LIMIT_EXCEEDED')) {
        throw new Error('CAPACITY_LIMIT_EXCEEDED: Organization number capacity limit reached.');
      }
      if (rpcError.message.includes('INVALID_CAPACITY_LIMIT')) {
        throw new Error('INVALID_CAPACITY_LIMIT: Server-authoritative line capacity limit is required and must be greater than zero.');
      }
      if (rpcError.message.includes('NUMBER_ALREADY_OWNED')) {
        throw new Error('NUMBER_ALREADY_OWNED: Phone number is currently owned by an active workspace.');
      }
      if (rpcError.message.includes('ACTIVE_PURCHASE_LOCK_EXISTS')) {
        throw new Error('ACTIVE_PURCHASE_LOCK_EXISTS: Another operation is actively processing this phone number.');
      }
      throw new Error(`RPC_EXECUTION_FAILED: ${rpcError.message}`);
    }

    throw new Error('RPC_EXECUTION_FAILED: Failed to create pending purchase operation row.');
  }

  /**
   * Atomically claims execution ownership of a pending operation for dispatch with tenant verification.
   * STRICT FAIL-CLOSED: No direct SQL fallback permitted.
   */
  static async claimOperationForDispatch(
    operationId: string,
    organizationId: string
  ): Promise<ProviderNumberOperation> {
    const supabase = getServiceSupabase();

    // Execute RPC with tenant predicate
    const { data: rpcData, error: rpcError } = await supabase.rpc('claim_purchase_op_dispatch', {
      p_operation_id: operationId,
      p_organization_id: organizationId,
    });

    if (!rpcError && rpcData) {
      return ProviderNumberOperationService.mapRowToDomain(rpcData);
    }

    if (rpcError) {
      if (rpcError.message.includes('CLAIM_FAILED')) {
        throw new Error('CLAIM_FAILED: Operation for organization is not in pending state or missing. Zero dispatch permitted.');
      }
      throw new Error(`RPC_EXECUTION_FAILED: ${rpcError.message}`);
    }

    throw new Error('CLAIM_FAILED: Operation for organization is not in pending state or missing. Zero dispatch permitted.');
  }

  /**
   * Marks operation as succeeded and idempotently persists local ownership records.
   */
  static async markOperationSucceeded(
    operationId: string,
    providerResourceId: string,
    providerStatus: string = 'active',
    executionProviderCostMinor?: number | null,
    executionProviderCostCurrency?: string | null
  ): Promise<ProviderNumberOperation> {
    const supabase = getServiceSupabase();

    // Attempt RPC execution
    const { data: rpcData, error: rpcError } = await supabase.rpc('reconcile_provider_number_purchase', {
      p_operation_id: operationId,
      p_provider_resource_id: providerResourceId,
      p_provider_status: providerStatus,
    });

    if (!rpcError && rpcData) {
      return ProviderNumberOperationService.mapRowToDomain(rpcData);
    }

    // Fallback direct update + local persistence
    const { data: op } = await supabase
      .from('provider_number_operations')
      .select('*')
      .eq('id', operationId)
      .single();

    if (!op) throw new Error('OPERATION_NOT_FOUND');

    // 1. Ensure phone_numbers record exists
    let phoneId: string;
    const { data: existingPhone } = await supabase
      .from('phone_numbers')
      .select('id')
      .eq('phone_number', op.phone_number_e164)
      .maybeSingle();

    if (existingPhone) {
      phoneId = existingPhone.id;
      await supabase
        .from('phone_numbers')
        .update({ status: 'active', active: true })
        .eq('id', phoneId);
    } else {
      const friendlyName = (op as any).friendly_name || ((op as any).price_snapshot_payload?.friendlyName) || 'Business Number';
      const { data: newPhone } = await supabase
        .from('phone_numbers')
        .insert({
          organization_id: op.organization_id,
          phone_number: op.phone_number_e164,
          friendly_name: friendlyName,
          country_code: op.country_code,
          number_type: op.number_type,
          status: 'active',
          acquisition_source: 'provider_purchase',
          active: true,
        })
        .select('id')
        .single();
      phoneId = newPhone!.id;
    }

    // 2. Ensure number_provider_mappings record exists
    const { data: existingMapping } = await supabase
      .from('number_provider_mappings')
      .select('id')
      .eq('provider', op.provider)
      .eq('provider_resource_id', providerResourceId)
      .maybeSingle();

    if (!existingMapping) {
      await supabase.from('number_provider_mappings').insert({
        phone_number_id: phoneId,
        provider: op.provider,
        provider_resource_id: providerResourceId,
        provider_status: providerStatus,
      });
    }

    // 3. Mark operation succeeded
    const updatePayload: Record<string, any> = {
      status: 'succeeded',
      provider_resource_id: providerResourceId,
      provider_status: providerStatus,
      completed_at: new Date().toISOString(),
      last_reconciled_at: new Date().toISOString(),
    };

    if (executionProviderCostMinor !== undefined && executionProviderCostMinor !== null) {
      updatePayload.execution_provider_cost_minor = executionProviderCostMinor;
    }
    if (executionProviderCostCurrency) {
      updatePayload.execution_provider_cost_currency = executionProviderCostCurrency;
    }

    const { data: updatedOp, error: updateErr } = await supabase
      .from('provider_number_operations')
      .update(updatePayload)
      .eq('id', operationId)
      .select('*')
      .single();

    if (updateErr) throw new Error(`PERSISTENCE_ERROR: ${updateErr.message}`);

    return ProviderNumberOperationService.mapRowToDomain(updatedOp);
  }

  /**
   * Marks operation as failed (releasing the active purchase lock).
   */
  static async markOperationFailed(
    operationId: string,
    errorCode: string,
    errorMessage: string
  ): Promise<ProviderNumberOperation> {
    const supabase = getServiceSupabase();
    const { data, error } = await supabase
      .from('provider_number_operations')
      .update({
        status: 'failed',
        sanitized_error_code: errorCode,
        sanitized_error_message: errorMessage,
        completed_at: new Date().toISOString(),
      })
      .eq('id', operationId)
      .select('*')
      .single();

    if (error || !data) throw new Error(`UPDATE_FAILED: ${error?.message}`);
    return ProviderNumberOperationService.mapRowToDomain(data);
  }

  /**
   * Transitions operation to reconciliation_required (retains active purchase lock).
   */
  static async markOperationReconciliationRequired(
    operationId: string,
    errorCode: string,
    errorMessage: string
  ): Promise<ProviderNumberOperation> {
    const supabase = getServiceSupabase();
    const { data, error } = await supabase
      .from('provider_number_operations')
      .update({
        status: 'reconciliation_required',
        sanitized_error_code: errorCode,
        sanitized_error_message: errorMessage,
        last_reconciled_at: new Date().toISOString(),
      })
      .eq('id', operationId)
      .select('*')
      .single();

    if (error || !data) throw new Error(`UPDATE_FAILED: ${error?.message}`);
    return ProviderNumberOperationService.mapRowToDomain(data);
  }

  /**
   * Transitions operation to manual_review_required (retains active purchase lock & marketplace suppression).
   */
  static async markOperationManualReviewRequired(
    operationId: string,
    errorCode: string,
    errorMessage: string
  ): Promise<ProviderNumberOperation> {
    const supabase = getServiceSupabase();
    const { data, error } = await supabase
      .from('provider_number_operations')
      .update({
        status: 'manual_review_required',
        sanitized_error_code: errorCode,
        sanitized_error_message: errorMessage,
        last_reconciled_at: new Date().toISOString(),
      })
      .eq('id', operationId)
      .select('*')
      .single();

    if (error || !data) throw new Error(`UPDATE_FAILED: ${error?.message}`);
    return ProviderNumberOperationService.mapRowToDomain(data);
  }

  /**
   * Reconciles an ambiguous operation using an authoritative provider lookup callback.
   * 
   * Inconclusive negative observations DO NOT transition to failed—they transition to manual_review_required,
   * retaining the global purchase lock and marketplace suppression.
   */
  static async reconcileOperation(
    operationId: string,
    providerLookupFn: (e164: string) => Promise<{ found: boolean; resourceId?: string; status?: string; conclusiveFailure?: boolean }>
  ): Promise<ProviderNumberOperation> {
    const supabase = getServiceSupabase();
    const { data: op } = await supabase
      .from('provider_number_operations')
      .select('*')
      .eq('id', operationId)
      .single();

    if (!op) throw new Error('OPERATION_NOT_FOUND');

    const result = await providerLookupFn(op.phone_number_e164);

    if (result.found && result.resourceId) {
      return await ProviderNumberOperationService.markOperationSucceeded(operationId, result.resourceId, result.status || 'active');
    }

    if (result.conclusiveFailure) {
      return await ProviderNumberOperationService.markOperationFailed(
        operationId,
        'PROVIDER_PURCHASE_FAILED',
        'Authoritative provider evidence confirms purchase did not occur.'
      );
    }

    // Inconclusive observation -> increment attempt count, set manual_review_required (retaining lock)
    const newAttemptCount = (op.attempt_count || 1) + 1;
    const { data: updated } = await supabase
      .from('provider_number_operations')
      .update({
        status: 'manual_review_required',
        attempt_count: newAttemptCount,
        last_reconciled_at: new Date().toISOString(),
        sanitized_error_code: 'INCONCLUSIVE_RECONCILIATION',
        sanitized_error_message: 'Provider evidence remains inconclusive. Manual review required. Lock retained.',
      })
      .eq('id', operationId)
      .select('*')
      .single();

    return ProviderNumberOperationService.mapRowToDomain(updated);
  }

  /**
   * Helper function for marketplace query contract:
   * Checks if a phone number is suppressed because it is currently owned OR actively being purchased/reconciled.
   */
  static async isNumberSuppressedFromMarketplace(phoneNumberE164: string): Promise<boolean> {
    const supabase = getServiceSupabase();

    // 1. Check current ownership
    const { data: phoneOwned } = await supabase
      .from('phone_numbers')
      .select('id')
      .eq('phone_number', phoneNumberE164)
      .in('status', ['active', 'inactive', 'suspended'])
      .maybeSingle();

    if (phoneOwned) return true;

    // 2. Check active or ambiguous purchase operations
    const { data: activeOp } = await supabase
      .from('provider_number_operations')
      .select('id')
      .eq('phone_number_e164', phoneNumberE164)
      .eq('operation_type', 'purchase_number')
      .in('status', ['pending', 'in_progress', 'reconciliation_required', 'manual_review_required'])
      .maybeSingle();

    return !!activeOp;
  }

  /**
   * Retrieves an operation by ID for an authorized organization.
   */
  static async getOperationById(
    operationId: string,
    organizationId: string
  ): Promise<ProviderNumberOperation | null> {
    const supabase = getServiceSupabase();
    const { data } = await supabase
      .from('provider_number_operations')
      .select('*')
      .eq('id', operationId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    return data ? ProviderNumberOperationService.mapRowToDomain(data) : null;
  }

  /**
   * Maps internal domain operation into a customer-safe DTO.
   */
  static toCustomerSafeDTO(op: ProviderNumberOperation): CustomerPurchaseOperationDTO {
    const retailAmountFormatted = `$${(op.retailAmountMinor / 100).toFixed(2)}/month`;
    let customerMessage: string | null = null;

    switch (op.status) {
      case 'pending':
      case 'in_progress':
        customerMessage = 'Purchase operation is processing.';
        break;
      case 'succeeded':
        customerMessage = 'Phone number purchase completed successfully.';
        break;
      case 'failed':
        customerMessage = op.sanitizedErrorMessage || 'Phone number purchase failed.';
        break;
      case 'reconciliation_required':
      case 'manual_review_required':
        customerMessage = 'Purchase outcome verification in progress.';
        break;
    }

    return {
      operationId: op.id,
      phoneNumberE164: op.phoneNumberE164,
      countryCode: op.countryCode,
      numberType: op.numberType,
      status: op.status,
      retailAmountFormatted,
      retailCurrency: op.retailCurrency,
      createdAt: op.createdAt,
      completedAt: op.completedAt || null,
      customerMessage,
    };
  }

  private static mapRowToDomain(row: any): ProviderNumberOperation {
    return {
      id: row.id,
      organizationId: row.organization_id,
      operationType: row.operation_type,
      provider: row.provider,
      phoneNumberE164: row.phone_number_e164,
      numberType: row.number_type,
      countryCode: row.country_code,
      status: row.status as PurchaseOperationStatus,
      idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      providerResourceId: row.provider_resource_id,
      providerStatus: row.provider_status,
      retailAmountMinor: row.retail_amount_minor,
      retailCurrency: row.retail_currency,
      providerCostMinor: row.provider_cost_minor,
      providerCostCurrency: row.provider_cost_currency,
      pricingSource: row.pricing_source,
      pricingPolicyId: row.pricing_policy_id,
      targetMarginPct: row.target_margin_pct ? Number(row.target_margin_pct) : null,
      minimumFixedMarginMinor: row.minimum_fixed_margin_minor,
      grossMarginMinor: row.gross_margin_minor,
      priceResolvedAt: row.price_resolved_at,
      priceSnapshotPayload: row.price_snapshot_payload,
      complianceProfileId: row.compliance_profile_id,
      regulatoryBundleSid: row.regulatory_bundle_sid,
      regulatoryProvisioningContext: row.regulatory_provisioning_context,
      paymentAuthorizationId: row.payment_authorization_id,
      paymentStatus: row.payment_status,
      attemptCount: row.attempt_count,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      lastReconciledAt: row.last_reconciled_at,
      sanitizedErrorCode: row.sanitized_error_code,
      sanitizedErrorMessage: row.sanitized_error_message,
      executionProviderCostMinor: row.execution_provider_cost_minor ?? null,
      executionProviderCostCurrency: row.execution_provider_cost_currency ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
