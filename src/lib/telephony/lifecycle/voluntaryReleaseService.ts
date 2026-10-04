/**
 * Voluntary Phone Number Release Service
 * Phase 14.1D — Voluntary Phone Number Release Workflow
 *
 * Server-authoritative domain service for customer-initiated voluntary number release.
 * Enforces Owner/Admin authorization, tenant isolation, Port-Out / Port-In conflict checks,
 * exact-number typed confirmation, durable operation transitions, provider ambiguity handling,
 * and atomic local completion.
 */

import {
  ProviderNumberReleaseAdapter,
  TwilioNumberReleaseAdapter,
} from './providerNumberReleaseAdapter';

export interface ReleaseEligibilityResult {
  eligible: boolean;
  blockers: string[];
  phoneNumberId?: string;
  phoneNumberE164?: string;
  organizationId?: string;
}

export interface RequestVoluntaryReleaseParams {
  organizationId: string;
  userId: string;
  userRole: string; // Must be 'owner' | 'admin'
  phoneNumberId: string;
  confirmPhoneNumber: string; // Exact E.164 typed confirmation
  idempotencyKey?: string;
}

export interface CustomerReleaseOperationDTO {
  operationId: string;
  organizationId: string;
  phoneNumberId: string;
  phoneNumberE164: string;
  status: string;
  customerSafeStatus: string;
  createdAt: string;
  completedAt?: string | null;
  isIdempotentReplay?: boolean;
}

export interface VoluntaryReleaseServiceDependencies {
  dbClient?: any;
  providerAdapter?: ProviderNumberReleaseAdapter;
}

export class VoluntaryReleaseService {
  private dbClient: any;
  private providerAdapter: ProviderNumberReleaseAdapter;

  constructor(deps?: VoluntaryReleaseServiceDependencies) {
    this.dbClient = deps?.dbClient;
    this.providerAdapter = deps?.providerAdapter || new TwilioNumberReleaseAdapter();
  }

  /**
   * Evaluate eligibility for voluntary number release.
   */
  async checkReleaseEligibility(
    organizationId: string,
    phoneNumberId: string,
    userRole: string
  ): Promise<ReleaseEligibilityResult> {
    const blockers: string[] = [];

    // 1. Authorization Role Check
    const normalizedRole = (userRole || '').toLowerCase();
    if (normalizedRole !== 'owner' && normalizedRole !== 'admin') {
      blockers.push('ROLE_NOT_AUTHORIZED: Only Owner or Admin can release a phone number.');
    }

    if (!this.dbClient) {
      // Mock mode fallback if DB client omitted in unit tests
      return {
        eligible: blockers.length === 0,
        blockers,
        phoneNumberId,
        organizationId,
      };
    }

    // 2. Fetch Phone Number and Verify Tenant Ownership
    const { data: phone, error: phoneErr } = await this.dbClient
      .from('phone_numbers')
      .select('id, organization_id, phone_number, status')
      .eq('id', phoneNumberId)
      .eq('organization_id', organizationId)
      .single();

    if (phoneErr || !phone) {
      blockers.push('PHONE_NUMBER_NOT_FOUND: Phone number does not exist or does not belong to organization.');
      return { eligible: false, blockers, phoneNumberId, organizationId };
    }

    const phoneNumberE164 = phone.phone_number;

    // 3. Lifecycle Status Check
    if (phone.status === 'released') {
      blockers.push('ALREADY_RELEASED: Phone number is already released.');
    }
    if (phone.status === 'ported_out') {
      blockers.push('ALREADY_PORTED_OUT: Phone number is already ported out.');
    }

    // 4. Port-Out Conflict Protection (14.1C)
    // Block release if Port-Out is requested, instructions_ready, port_out_pending, or carrier_processing
    const { data: portOutOps } = await this.dbClient
      .from('number_port_operations')
      .select('id, status')
      .eq('organization_id', organizationId)
      .eq('phone_number_e164', phoneNumberE164)
      .eq('direction', 'port_out')
      .in('status', ['requested', 'instructions_ready', 'port_out_pending', 'carrier_processing']);

    if (portOutOps && portOutOps.length > 0) {
      blockers.push(
        `ACTIVE_PORT_OUT_IN_PROGRESS: Phone number has an active Port-Out operation (${portOutOps[0].status}). Cancel Port-Out before releasing.`
      );
    }

    // 5. Port-In Conflict Protection (14.1B)
    const { data: portInOps } = await this.dbClient
      .from('number_port_operations')
      .select('id, status')
      .eq('organization_id', organizationId)
      .eq('phone_number_e164', phoneNumberE164)
      .eq('direction', 'port_in')
      .in('status', [
        'portability_checking',
        'requirements_pending',
        'ready_for_submission',
        'submitted',
        'under_review',
        'in_progress',
        'scheduled',
      ]);

    if (portInOps && portInOps.length > 0) {
      blockers.push(
        `ACTIVE_PORT_IN_IN_PROGRESS: Phone number has an active Port-In operation (${portInOps[0].status}).`
      );
    }

    // 6. Active Release Conflict Protection
    const { data: activeReleaseOps } = await this.dbClient
      .from('number_release_operations')
      .select('id, status')
      .eq('phone_number_id', phoneNumberId)
      .in('status', [
        'requested',
        'eligibility_verified',
        'provider_release_pending',
        'reconciliation_required',
        'manual_review_required',
      ]);

    if (activeReleaseOps && activeReleaseOps.length > 0) {
      blockers.push(
        `ACTIVE_RELEASE_IN_PROGRESS: Phone number already has an active release operation (${activeReleaseOps[0].status}).`
      );
    }

    return {
      eligible: blockers.length === 0,
      blockers,
      phoneNumberId,
      phoneNumberE164,
      organizationId,
    };
  }

  /**
   * Request and execute voluntary number release.
   */
  async requestVoluntaryRelease(
    params: RequestVoluntaryReleaseParams
  ): Promise<CustomerReleaseOperationDTO> {
    const { organizationId, userId, userRole, phoneNumberId, confirmPhoneNumber, idempotencyKey } = params;

    // 1. Run Eligibility & Role Check
    const eligibility = await this.checkReleaseEligibility(organizationId, phoneNumberId, userRole);
    if (!eligibility.eligible) {
      throw new Error(`RELEASE_ELIGIBILITY_FAILED: ${eligibility.blockers.join('; ')}`);
    }

    const phoneNumberE164 = eligibility.phoneNumberE164 || confirmPhoneNumber;

    // 2. Server-Side Exact Phone Number Typed Confirmation Validation
    if ((confirmPhoneNumber || '').trim() !== phoneNumberE164.trim()) {
      throw new Error(
        `TYPED_CONFIRMATION_MISMATCH: Input confirmation "${confirmPhoneNumber}" does not match exact E.164 phone number "${phoneNumberE164}".`
      );
    }

    if (!this.dbClient) {
      // Mock execution mode for unit tests without DB harness
      const mockResult = await this.providerAdapter.releaseNumber({
        organizationId,
        phoneNumberId,
        phoneNumberE164,
        idempotencyKey,
      });

      return {
        operationId: `MOCK_OP_${phoneNumberId}`,
        organizationId,
        phoneNumberId,
        phoneNumberE164,
        status: mockResult.outcomeClass === 'confirmed_success' ? 'released' : 'reconciliation_required',
        customerSafeStatus: mockResult.customerSafeMessage || 'Release requested',
        createdAt: new Date().toISOString(),
        completedAt: mockResult.outcomeClass === 'confirmed_success' ? new Date().toISOString() : null,
      };
    }

    // 3. Idempotency Check
    if (idempotencyKey) {
      const { data: existingOp } = await this.dbClient
        .from('number_release_operations')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('idempotency_key', idempotencyKey)
        .single();

      if (existingOp) {
        return this.toCustomerDTO(existingOp, true);
      }
    }

    // 4. Fetch Provider Resource Mapping for Trusted Provenance
    const { data: providerMapping } = await this.dbClient
      .from('number_provider_mappings')
      .select('id, provider, provider_resource_id, provider_account_id, provider_status')
      .eq('phone_number_id', phoneNumberId)
      .eq('provider_status', 'active')
      .maybeSingle();

    // 5. Insert Operation Record (Initial Status: 'requested')
    const { data: op, error: insertErr } = await this.dbClient
      .from('number_release_operations')
      .insert({
        organization_id: organizationId,
        phone_number_id: phoneNumberId,
        phone_number_e164: phoneNumberE164,
        release_source: 'voluntary',
        status: 'requested',
        idempotency_key: idempotencyKey || null,
        initiated_by_user_id: userId,
        provider: providerMapping?.provider || 'twilio',
        provider_resource_mapping_id: providerMapping?.id || null,
        customer_safe_status: 'Release requested',
      })
      .select('*')
      .single();

    if (insertErr || !op) {
      throw new Error(`RELEASE_OP_INSERT_FAILED: ${insertErr?.message || 'Failed to create release operation record.'}`);
    }

    const opId = op.id;

    // 6. Transition status -> 'eligibility_verified'
    await this.dbClient
      .from('number_release_operations')
      .update({ status: 'eligibility_verified', updated_at: new Date().toISOString() })
      .eq('id', opId);

    // 7. Transition status -> 'provider_release_pending' (DURABLE transition before provider mutation)
    await this.dbClient
      .from('number_release_operations')
      .update({
        status: 'provider_release_pending',
        customer_safe_status: 'Release request submitted to provider',
        updated_at: new Date().toISOString(),
      })
      .eq('id', opId);

    // 8. Invoke Provider Adapter
    const providerResult = await this.providerAdapter.releaseNumber({
      organizationId,
      phoneNumberId,
      phoneNumberE164,
      providerResourceMappingId: providerMapping?.id,
      providerResourceId: providerMapping?.provider_resource_id,
      providerAccountId: providerMapping?.provider_account_id,
      providerName: providerMapping?.provider || 'twilio',
      idempotencyKey,
    });

    // 9. Handle Provider Outcome
    if (providerResult.outcomeClass === 'confirmed_success') {
      // Authoritative Provider Success -> Invoke Atomic Completion RPC
      const { data: rpcRes, error: rpcErr } = await this.dbClient.rpc('complete_number_release_atomic', {
        p_operation_id: opId,
        p_organization_id: organizationId,
        p_released_at: new Date().toISOString(),
        p_release_notes: providerResult.customerSafeMessage || 'Confirmed provider release',
      });

      if (rpcErr) {
        throw new Error(`ATOMIC_COMPLETION_RPC_FAILED: ${rpcErr.message}`);
      }

      const { data: finalOp } = await this.dbClient
        .from('number_release_operations')
        .select('*')
        .eq('id', opId)
        .single();

      return this.toCustomerDTO(finalOp || op);
    }

    if (providerResult.outcomeClass === 'ambiguous') {
      // Timeout / 5xx Ambiguity -> Transition to 'reconciliation_required'
      const { data: ambOp } = await this.dbClient
        .from('number_release_operations')
        .update({
          status: 'reconciliation_required',
          ambiguity_started_at: new Date().toISOString(),
          customer_safe_status: 'Release confirmation in progress.',
          failure_class: 'provider_timeout_or_5xx',
          updated_at: new Date().toISOString(),
        })
        .eq('id', opId)
        .select('*')
        .single();

      return this.toCustomerDTO(ambOp);
    }

    if (providerResult.outcomeClass === 'manual_review_required') {
      const { data: manOp } = await this.dbClient
        .from('number_release_operations')
        .update({
          status: 'manual_review_required',
          customer_safe_status: 'Release requires manual review.',
          failure_class: 'untrusted_mapping_or_provenance_mismatch',
          updated_at: new Date().toISOString(),
        })
        .eq('id', opId)
        .select('*')
        .single();

      return this.toCustomerDTO(manOp);
    }

    // Default Definite Rejection -> State 'failed'
    const { data: failOp } = await this.dbClient
      .from('number_release_operations')
      .update({
        status: 'failed',
        customer_safe_status: providerResult.customerSafeMessage || 'Provider rejected release request.',
        failure_class: providerResult.sanitizedErrorMessage || 'provider_rejection',
        updated_at: new Date().toISOString(),
      })
      .eq('id', opId)
      .select('*')
      .single();

    return this.toCustomerDTO(failOp);
  }

  /**
   * Reconcile a release operation against provider inventory.
   */
  async reconcileReleaseOperation(
    organizationId: string,
    operationId: string
  ): Promise<CustomerReleaseOperationDTO> {
    if (!this.dbClient) {
      throw new Error('RECONCILE_FAILED: DB client required for reconciliation.');
    }

    const { data: op, error: opErr } = await this.dbClient
      .from('number_release_operations')
      .select('*')
      .eq('id', operationId)
      .eq('organization_id', organizationId)
      .single();

    if (opErr || !op) {
      throw new Error(`RELEASE_OP_NOT_FOUND: Operation ${operationId} not found.`);
    }

    if (op.status === 'released') {
      return this.toCustomerDTO(op, true);
    }

    const { data: providerMapping } = await this.dbClient
      .from('number_provider_mappings')
      .select('provider_resource_id, provider_account_id, provider')
      .eq('phone_number_id', op.phone_number_id)
      .maybeSingle();

    const reconRes = await this.providerAdapter.reconcileNumberRelease({
      organizationId,
      phoneNumberId: op.phone_number_id,
      phoneNumberE164: op.phone_number_e164,
      providerResourceId: providerMapping?.provider_resource_id,
      providerAccountId: providerMapping?.provider_account_id,
      providerName: providerMapping?.provider || 'twilio',
    });

    if (reconRes.outcomeClass === 'confirmed_absent') {
      // Reconciled confirmed absent -> Invoke atomic completion RPC
      await this.dbClient.rpc('complete_number_release_atomic', {
        p_operation_id: operationId,
        p_organization_id: organizationId,
        p_released_at: new Date().toISOString(),
        p_release_notes: 'Reconciled: resource absent from provider inventory',
      });

      const { data: updatedOp } = await this.dbClient
        .from('number_release_operations')
        .select('*')
        .eq('id', operationId)
        .single();

      return this.toCustomerDTO(updatedOp);
    }

    if (reconRes.outcomeClass === 'confirmed_still_owned') {
      // Confirmed still owned -> Release did not occur. Transition to failed for clean retry
      const { data: updatedOp } = await this.dbClient
        .from('number_release_operations')
        .update({
          status: 'failed',
          customer_safe_status: 'Number is still active with provider. Release attempt failed.',
          last_reconciliation_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', operationId)
        .select('*')
        .single();

      return this.toCustomerDTO(updatedOp);
    }

    // Uncertain or Ambiguous -> Remain reconciliation_required or manual_review_required
    const targetStatus = reconRes.outcomeClass === 'manual_review_required' ? 'manual_review_required' : 'reconciliation_required';
    const { data: updatedOp } = await this.dbClient
      .from('number_release_operations')
      .update({
        status: targetStatus,
        customer_safe_status: reconRes.customerSafeMessage || 'Release confirmation in progress.',
        last_reconciliation_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', operationId)
      .select('*')
      .single();

    return this.toCustomerDTO(updatedOp);
  }

  /**
   * Convert database release operation record into customer-safe DTO.
   * Redacts provider SIDs, account SIDs, auth credentials, and internal telemetry.
   */
  private toCustomerDTO(op: any, isIdempotentReplay?: boolean): CustomerReleaseOperationDTO {
    return {
      operationId: op.id,
      organizationId: op.organization_id,
      phoneNumberId: op.phone_number_id,
      phoneNumberE164: op.phone_number_e164,
      status: op.status,
      customerSafeStatus: op.customer_safe_status || op.status,
      createdAt: op.created_at,
      completedAt: op.completed_at || null,
      isIdempotentReplay: isIdempotentReplay || false,
    };
  }
}
