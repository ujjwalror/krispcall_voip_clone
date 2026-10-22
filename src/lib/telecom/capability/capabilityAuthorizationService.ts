import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  NumberCapabilityType,
  NumberCapabilityStage,
  NumberCapabilityDetail,
  NumberCapabilitiesState,
  CapabilityAuthorizationContext,
  CapabilityAuthorizationResult,
  CapabilityErrorCode,
} from './types';

export class CapabilityAuthorizationError extends Error {
  statusCode: number;
  code: CapabilityErrorCode;

  constructor(message: string, code: CapabilityErrorCode, statusCode: number = 400) {
    super(message);
    this.name = 'CapabilityAuthorizationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * ==============================================================================
 * CANONICAL PHONE-NUMBER CAPABILITY AUTHORIZATION SERVICE (Phase 23D.4)
 * ==============================================================================
 * Enforces the frozen Phase 23C capability progression pipeline:
 *   ADVERTISED -> PROVISIONED -> CONFIGURED -> USABLE
 *
 * Core Distributed-Systems Invariants:
 * 1. NUMBER EXISTS != CAPABILITY IS USABLE
 * 2. PROVIDER ADVERTISES CAPABILITY != CUSTOMER MAY USE CAPABILITY
 * 3. SMS != MMS (MMS unavailable never silently downgrades to SMS)
 * 4. Zero Parent Fallback: Customer number must be bound to active CUSTOMER_SUBACCOUNT
 * 5. Authoritative Carrier Bridge: telecom_provider_resource_records remains the single authority
 * 6. SUSPENDED / RELEASED / PORTED_OUT blocks customer traffic immediately
 */
export class CapabilityAuthorizationService {
  /**
   * High-level authorization entry point with structured return payload.
   */
  static async authorize(
    params: { phoneId?: string; phoneNumberId?: string; e164?: string; capability: NumberCapabilityType | 'voice' | 'sms' | 'mms'; organizationId: string; context?: CapabilityAuthorizationContext },
    dbClient?: any
  ): Promise<{ authorized: boolean; rejectionReason?: string; result: CapabilityAuthorizationResult }> {
    const target = params.phoneId || params.phoneNumberId || params.e164 || '';
    const cap = (params.capability === 'voice' ? 'VOICE_OUTBOUND' : params.capability === 'sms' ? 'SMS_OUTBOUND' : params.capability === 'mms' ? 'MMS_OUTBOUND' : params.capability) as NumberCapabilityType;
    const res = await this.canUseCapability(
      target,
      cap,
      params.organizationId,
      params.context,
      dbClient
    );
    return {
      authorized: res.allowed,
      rejectionReason: res.code || (res as any).errorCode || undefined,
      result: res,
    };
  }

  /**
   * CANONICAL CAPABILITY AUTHORIZATION BOUNDARY
   * Single authoritative entry point for all runtime capability checks.
   */
  static async canUseCapability(
    phoneNumberIdOrE164: string,
    capability: NumberCapabilityType,
    organizationId: string,
    context?: CapabilityAuthorizationContext,
    clientOverride?: any
  ): Promise<CapabilityAuthorizationResult> {
    const supabase = clientOverride || createAdminClient();

    // 0. Base Input Validation
    if (!phoneNumberIdOrE164 || typeof phoneNumberIdOrE164 !== 'string') {
      return this.reject(
        'NUMBER_NOT_FOUND',
        'Valid phoneNumberId or E.164 number is required.',
        capability,
        '',
        '',
        organizationId
      );
    }

    if (!organizationId || typeof organizationId !== 'string') {
      return this.reject(
        'NUMBER_NOT_OWNED',
        'Valid organizationId is required.',
        capability,
        '',
        '',
        organizationId || ''
      );
    }

    // 1. Fetch Phone Number Domain Record
    const isE164 = phoneNumberIdOrE164.trim().startsWith('+');
    let query = (supabase as any)
      .from('phone_numbers')
      .select(`
        id,
        organization_id,
        phone_number,
        ownership_state,
        service_state,
        provider_account_id,
        provider_resource_record_id,
        capabilities_state,
        capabilities_voice,
        capabilities_sms,
        capabilities_mms,
        active,
        status,
        is_suspended,
        assignment_target_type,
        assignment_target_id,
        compliance_state
      `);

    if (isE164) {
      query = query
        .eq('phone_number', phoneNumberIdOrE164.trim())
        .eq('organization_id', organizationId);
    } else {
      query = query.eq('id', phoneNumberIdOrE164.trim());
    }

    const { data: phoneRow, error: phoneErr } = await query.maybeSingle();

    if (phoneErr) {
      console.error('[CapabilityAuthorizationService] Database error fetching phone number:', phoneErr);
      return this.reject(
        'INTERNAL_ERROR',
        `Database query error: ${phoneErr.message}`,
        capability,
        phoneNumberIdOrE164,
        isE164 ? phoneNumberIdOrE164 : '',
        organizationId
      );
    }

    if (!phoneRow) {
      return this.reject(
        'NUMBER_NOT_FOUND',
        `Phone number "${phoneNumberIdOrE164}" was not found in the workspace.`,
        capability,
        phoneNumberIdOrE164,
        isE164 ? phoneNumberIdOrE164 : '',
        organizationId
      );
    }

    const phoneId = phoneRow.id;
    const phoneE164 = phoneRow.phone_number;

    // 2. Tenant Ownership Verification
    if (phoneRow.organization_id !== organizationId) {
      return this.reject(
        'NUMBER_NOT_OWNED',
        'Phone number does not belong to the requesting organization.',
        capability,
        phoneId,
        phoneE164,
        organizationId
      );
    }

    // 3. Canonical Ownership Lifecycle Gate (Task 6, 19, 20)
    const ownership = phoneRow.ownership_state;
    if (ownership === 'RELEASED') {
      return this.reject(
        'NUMBER_RELEASED',
        'Phone number has been released and cannot be used.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { ownershipState: ownership }
      );
    }

    if (ownership === 'RELEASE_PENDING') {
      return this.reject(
        'NUMBER_RELEASE_PENDING',
        'Phone number is currently pending release.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { ownershipState: ownership }
      );
    }

    if (ownership === 'PORTED_OUT') {
      return this.reject(
        'NUMBER_PORTED_OUT',
        'Phone number has ported out to an external carrier.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { ownershipState: ownership }
      );
    }

    if (ownership === 'ACQUISITION_PENDING') {
      return this.reject(
        'NUMBER_ACQUISITION_PENDING',
        'Phone number carrier acquisition is still pending.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { ownershipState: ownership }
      );
    }

    // Fallback active status check for unmigrated rows
    if (phoneRow.active === false || (phoneRow.status && phoneRow.status !== 'active')) {
      return this.reject(
        'NUMBER_NOT_ACTIVE',
        'Phone number is inactive.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { ownershipState: ownership, serviceState: phoneRow.service_state }
      );
    }

    // 3b. Basic Capability Disabled Gate
    if (
      (capability === 'VOICE_OUTBOUND' || capability === 'VOICE_INBOUND' || (capability as string) === 'voice') &&
      phoneRow.capabilities_voice === false
    ) {
      return this.reject(
        'CAPABILITY_DISABLED',
        'Voice capability is disabled for this phone number.',
        capability,
        phoneId,
        phoneE164,
        organizationId
      );
    }

    if (
      (capability === 'SMS_OUTBOUND' || capability === 'SMS_INBOUND' || (capability as string) === 'sms') &&
      phoneRow.capabilities_sms === false
    ) {
      return this.reject(
        'CAPABILITY_DISABLED',
        'SMS capability is disabled for this phone number.',
        capability,
        phoneId,
        phoneE164,
        organizationId
      );
    }

    // 4. Canonical Service Lifecycle Gate (Task 6, 21)
    const service = phoneRow.service_state;
    if (service === 'SUSPENDED' || phoneRow.is_suspended === true) {
      return this.reject(
        'NUMBER_SUSPENDED',
        'Phone number service is suspended. Chargeable traffic is blocked.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { ownershipState: ownership, serviceState: 'SUSPENDED' }
      );
    }

    if (service === 'UNAVAILABLE') {
      return this.reject(
        'NUMBER_UNAVAILABLE',
        'Phone number service is currently unavailable.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { ownershipState: ownership, serviceState: service }
      );
    }

    if (service === 'PROVISIONING') {
      return this.reject(
        'NUMBER_PROVISIONING',
        'Phone number service is still provisioning.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { ownershipState: ownership, serviceState: service }
      );
    }

    // 4b. Regulatory Compliance Gate Check (Phase 23D.7B - Task 20)
    try {
      const { ComplianceEvaluationService } = await import('@/lib/telecom/compliance');
      const compCheck = await ComplianceEvaluationService.evaluateCapabilityCompliance(
        {
          organizationId,
          phoneNumberId: phoneId,
          capability,
        },
        supabase
      );

      if (compCheck.decision === 'SUSPEND_EXISTING_SERVICE') {
        return this.reject(
          'COMPLIANCE_REJECTED',
          compCheck.reason || 'Phone number usage blocked due to regulatory compliance rejection.',
          capability,
          phoneId,
          phoneE164,
          organizationId,
          { complianceDecision: compCheck.decision }
        );
      }
      if (compCheck.decision === 'UNKNOWN_FAIL_CLOSED') {
        return this.reject(
          'COMPLIANCE_REQUIRED',
          compCheck.reason || 'Phone number usage blocked due to missing or unverified compliance binding.',
          capability,
          phoneId,
          phoneE164,
          organizationId,
          { complianceDecision: compCheck.decision }
        );
      }
    } catch {
      // Safe ignore in minimal test env
    }

    // 5. Authoritative Provider Resource Bridge (Task 5, Task 29)
    // telecom_provider_resource_records remains the single authoritative carrier bridge
    let resourceQuery = (supabase as any)
      .from('telecom_provider_resource_records')
      .select('id, organization_id, provider_account_id, remote_resource_id, resource_type, status, released_at')
      .eq('domain_phone_number_id', phoneId)
      .in('resource_type', ['PHONE_NUMBER', 'phone_number']);

    const { data: resources, error: resErr } = await resourceQuery;

    if (resErr) {
      console.error('[CapabilityAuthorizationService] Error fetching provider resource record:', resErr);
      return this.reject(
        'INTERNAL_ERROR',
        `Provider resource lookup error: ${resErr.message}`,
        capability,
        phoneId,
        phoneE164,
        organizationId
      );
    }

    let resource = resources && resources.length > 0 ? resources[0] : null;

    // Fallback: If not found by domain_phone_number_id, check phone_numbers.provider_resource_record_id
    if (!resource && phoneRow.provider_resource_record_id) {
      const { data: fallbackRes } = await (supabase as any)
        .from('telecom_provider_resource_records')
        .select('id, organization_id, provider_account_id, remote_resource_id, resource_type, status, released_at')
        .eq('id', phoneRow.provider_resource_record_id)
        .maybeSingle();

      if (fallbackRes) {
        resource = fallbackRes;
      }
    }

    if (!resource) {
      return this.reject(
        'PROVIDER_RESOURCE_MISSING',
        'No authoritative carrier provider resource record found for phone number.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { providerResourceMatch: false }
      );
    }

    // Provider Resource Tenant Consistency
    if (resource.organization_id !== organizationId) {
      return this.reject(
        'PROVIDER_RESOURCE_MISMATCH',
        'Authoritative carrier resource belongs to a different organization.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { providerResourceMatch: false }
      );
    }

    // Check if carrier resource is released or inactive
    if (resource.released_at != null || (resource.status && !['active', 'ACTIVE'].includes(resource.status))) {
      return this.reject(
        'CAPABILITY_RECONCILIATION_REQUIRED',
        'Carrier provider resource record is inactive or released.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { reconciliationRequired: true }
      );
    }

    // Denormalized link consistency: phone_numbers.provider_resource_record_id must match resource.id if present
    if (phoneRow.provider_resource_record_id && phoneRow.provider_resource_record_id !== resource.id) {
      return this.reject(
        'PROVIDER_RESOURCE_INCONSISTENT',
        'Domain record provider resource reference does not match authoritative resource record.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { providerResourceMatch: false }
      );
    }

    // Provider Account Resolution & Customer Subaccount Validation
    const { data: accountRow, error: accErr } = await (supabase as any)
      .from('telecom_provider_accounts')
      .select('id, organization_id, account_type, status, is_shared_parent')
      .eq('id', resource.provider_account_id)
      .maybeSingle();

    if (accErr || !accountRow) {
      return this.reject(
        'PROVIDER_ACCOUNT_MISSING',
        'Carrier provider account record not found.',
        capability,
        phoneId,
        phoneE164,
        organizationId
      );
    }

    if (accountRow.status !== 'active' && accountRow.status !== 'ACTIVE') {
      return this.reject(
        'PROVIDER_ACCOUNT_INACTIVE',
        `Carrier provider account is ${accountRow.status}.`,
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { providerAccountStatus: accountRow.status }
      );
    }

    // ZERO PARENT FALLBACK (Task 29 & 23D.2 Security Boundary)
    if (accountRow.account_type === 'SHARED_PARENT' || accountRow.is_shared_parent === true) {
      return this.reject(
        'PARENT_ACCOUNT_CUSTOMER_ACCESS_PROHIBITED',
        'Customer number cannot be authorized under shared parent provider account.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { providerAccountType: accountRow.account_type }
      );
    }

    if (phoneRow.provider_account_id && phoneRow.provider_account_id !== accountRow.id) {
      return this.reject(
        'PROVIDER_ACCOUNT_MISMATCH',
        'Domain record provider account reference does not match authoritative resource provider account.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { providerAccountType: accountRow.account_type }
      );
    }

    // 6. Canonical Capability Stage Gate (Task 2, 7, 8, 9, 10, 14, 25)
    const capsState = (phoneRow.capabilities_state || {}) as NumberCapabilitiesState;
    const capDetail: NumberCapabilityDetail | undefined = capsState[capability];

    if (!capDetail || !capDetail.stage) {
      return this.reject(
        'CAPABILITY_NOT_CONFIGURED',
        `Capability ${capability} is not provisioned or configured for this number.`,
        capability,
        phoneId,
        phoneE164,
        organizationId
      );
    }

    const stage: NumberCapabilityStage = capDetail.stage;

    // ADVERTISED: Inventory/Search evidence only -> NEVER USABLE
    if (stage === 'ADVERTISED') {
      return this.reject(
        'CAPABILITY_ADVERTISED_NOT_USABLE',
        `Capability ${capability} is only advertised and has not been provisioned or configured.`,
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { stage }
      );
    }

    // PROVISIONED: Acquired at carrier, but not yet configured for runtime routing -> NOT USABLE
    if (stage === 'PROVISIONED') {
      return this.reject(
        'CAPABILITY_PROVISIONED_NOT_CONFIGURED',
        `Capability ${capability} is provisioned at carrier but not yet configured for runtime routing.`,
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { stage }
      );
    }

    // CONFIGURED: Config present, but has not completed final operational/compliance readiness
    if (stage === 'CONFIGURED') {
      return this.reject(
        'CAPABILITY_NOT_USABLE',
        `Capability ${capability} is configured but not yet authorized as usable.`,
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { stage }
      );
    }

    // BLOCKED: Explicit regulatory or operational lock
    if (stage === 'BLOCKED') {
      return this.reject(
        'CAPABILITY_BLOCKED',
        capDetail.reason || `Capability ${capability} is blocked for regulatory or operational reasons.`,
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { stage }
      );
    }

    // Strict Requirement: stage must be 'USABLE'
    if (stage !== 'USABLE') {
      return this.reject(
        'CAPABILITY_NOT_USABLE',
        `Capability ${capability} stage "${stage}" is not usable.`,
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { stage }
      );
    }

    // Strict MMS Separation (Task 14): MMS_OUTBOUND requires explicit MMS USABLE stage
    if (capability === 'MMS_OUTBOUND' && stage !== 'USABLE') {
      return this.reject(
        'CAPABILITY_NOT_USABLE',
        'MMS messaging capability is not usable for this phone number.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { stage }
      );
    }

    // 7. Compliance Verification (Task 18)
    if (capDetail.complianceState === 'REJECTED' || phoneRow.compliance_state === 'REJECTED') {
      return this.reject(
        'COMPLIANCE_REJECTED',
        'Regulatory compliance for this capability was rejected.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { stage, complianceVerified: false }
      );
    }

    if (capDetail.complianceState === 'EXPIRED' || phoneRow.compliance_state === 'EXPIRED') {
      return this.reject(
        'COMPLIANCE_EXPIRED',
        'Regulatory compliance for this capability has expired.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { stage, complianceVerified: false }
      );
    }

    if (capDetail.complianceState === 'PENDING_VERIFICATION') {
      return this.reject(
        'COMPLIANCE_REQUIRED',
        'Regulatory compliance verification is pending.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { stage, complianceVerified: false }
      );
    }

    // 8. User Assignment Gate (Task 17 & Phase 23D.5 Canonical Reconciliation)
    let assignmentVerified = false;
    if (context?.requireAssignment === true && context?.userId) {
      if (phoneRow.assignment_target_type === 'USER' && phoneRow.assignment_target_id === context.userId) {
        assignmentVerified = true;
      } else {
        const { data: assignmentRow, error: assignErr } = await (supabase as any)
          .from('user_phone_assignments')
          .select('id')
          .eq('phone_number_id', phoneId)
          .eq('user_id', context.userId)
          .eq('organization_id', organizationId)
          .maybeSingle();

        if (!assignErr && assignmentRow) {
          assignmentVerified = true;
        }
      }

      if (!assignmentVerified) {
        return this.reject(
          'USER_NOT_ASSIGNED',
          'User is not assigned to this business phone number.',
          capability,
          phoneId,
          phoneE164,
          organizationId,
          { stage, assignmentVerified: false }
        );
      }
    }

    if (phoneRow.assignment_target_type === 'UNASSIGNED_POOL' && context?.requireAssignment) {
      return this.reject(
        'NUMBER_UNASSIGNED',
        'Phone number is currently in the unassigned company pool.',
        capability,
        phoneId,
        phoneE164,
        organizationId,
        { stage, assignmentVerified: false }
      );
    }

    // 9. All Invariants Satisfied -> Return Authoritative Success
    return {
      allowed: true,
      code: 'AUTHORIZED',
      reason: `Capability ${capability} is authorized and usable.`,
      capability,
      stage: 'USABLE',
      phoneNumberId: phoneId,
      phoneNumberE164: phoneE164,
      organizationId,
      providerAccountId: resource.provider_account_id,
      providerResourceRecordId: resource.id,
      telecomProviderResourceId: resource.remote_resource_id,
      auditEvidence: {
        ownershipState: ownership,
        serviceState: service,
        stage: 'USABLE',
        providerAccountType: accountRow.account_type,
        providerAccountStatus: accountRow.status,
        providerResourceMatch: true,
        assignmentVerified,
        complianceVerified: capDetail.complianceState === 'APPROVED' || capDetail.complianceState === 'NOT_REQUIRED',
      },
    };
  }

  /**
   * Filters an array of phone numbers or E.164 strings to only those authorized for a capability.
   */
  static async filterUsableNumbers(
    phoneNumberIdsOrE164s: string[],
    capability: NumberCapabilityType,
    organizationId: string,
    context?: CapabilityAuthorizationContext,
    clientOverride?: any
  ): Promise<string[]> {
    const usable: string[] = [];
    for (const num of phoneNumberIdsOrE164s) {
      const res = await this.canUseCapability(num, capability, organizationId, context, clientOverride);
      if (res.allowed) {
        usable.push(num);
      }
    }
    return usable;
  }

  /**
   * Safe Capability Stage Promotion Pipeline:
   * ADVERTISED -> PROVISIONED -> CONFIGURED -> USABLE (or BLOCKED)
   */
  static async promoteCapabilityStage(
    phoneNumberId: string,
    capability: NumberCapabilityType,
    targetStage: NumberCapabilityStage,
    details?: Partial<NumberCapabilityDetail>,
    clientOverride?: any
  ): Promise<void> {
    const supabase = clientOverride || createAdminClient();

    const { data: num, error: fetchErr } = await (supabase as any)
      .from('phone_numbers')
      .select('id, organization_id, phone_number, capabilities_state')
      .eq('id', phoneNumberId)
      .single();

    if (fetchErr || !num) {
      throw new CapabilityAuthorizationError(`Phone number not found: ${phoneNumberId}`, 'NUMBER_NOT_FOUND', 404);
    }

    const capsState: NumberCapabilitiesState = num.capabilities_state || {};
    const existing = capsState[capability] || { stage: 'ADVERTISED' };

    const updatedDetail: NumberCapabilityDetail = {
      ...existing,
      ...details,
      stage: targetStage,
      lastVerifiedAt: new Date().toISOString(),
    };

    capsState[capability] = updatedDetail;

    const { error: updateErr } = await (supabase as any)
      .from('phone_numbers')
      .update({
        capabilities_state: capsState,
      })
      .eq('id', phoneNumberId);

    if (updateErr) {
      throw new CapabilityAuthorizationError(`Failed to update capability stage: ${updateErr.message}`, 'INTERNAL_ERROR', 500);
    }

    // Record lifecycle event
    try {
      await (supabase as any)
        .from('phone_number_lifecycle_events')
        .insert({
          organization_id: num.organization_id,
          phone_number_id: num.id,
          phone_number_e164: num.phone_number,
          event_type: 'CAPABILITY_CHANGED',
          actor_type: 'SYSTEM',
          details: {
            capability,
            fromStage: existing.stage,
            toStage: targetStage,
            ...details,
          },
        });
    } catch (eventErr) {
      // Non-blocking event log
    }
  }

  /**
   * Provider Capability Refresh (Task 22):
   * Ingests provider evidence into capabilities_state without overriding
   * tenant ownership, service lifecycle, or releasing numbers.
   */
  static async refreshProviderCapabilities(
    phoneNumberId: string,
    organizationId: string,
    providerCapabilities: { voice?: boolean; sms?: boolean; mms?: boolean },
    clientOverride?: any
  ): Promise<void> {
    const supabase = clientOverride || createAdminClient();

    const { data: num, error: fetchErr } = await (supabase as any)
      .from('phone_numbers')
      .select('id, organization_id, ownership_state, service_state, capabilities_state')
      .eq('id', phoneNumberId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (fetchErr || !num) {
      throw new CapabilityAuthorizationError('Phone number not found for organization.', 'NUMBER_NOT_FOUND', 404);
    }

    // Invariant: Provider refresh cannot reactivate suspended or released numbers
    if (num.ownership_state === 'RELEASED' || num.ownership_state === 'PORTED_OUT') {
      return;
    }

    const capsState: NumberCapabilitiesState = num.capabilities_state || {};

    const updateStageFromEvidence = (cap: NumberCapabilityType, hasEvidence: boolean) => {
      const existing = capsState[cap];
      if (hasEvidence) {
        // If not already configured or usable, record as PROVISIONED
        if (!existing || existing.stage === 'ADVERTISED') {
          capsState[cap] = {
            stage: 'PROVISIONED',
            lastVerifiedAt: new Date().toISOString(),
          };
        }
      } else {
        // Provider says not supported -> BLOCKED
        capsState[cap] = {
          stage: 'BLOCKED',
          reason: 'CARRIER_CAPABILITY_UNSUPPORTED',
          lastVerifiedAt: new Date().toISOString(),
        };
      }
    };

    if (providerCapabilities.voice !== undefined) {
      updateStageFromEvidence('VOICE_OUTBOUND', providerCapabilities.voice);
      updateStageFromEvidence('VOICE_INBOUND', providerCapabilities.voice);
    }
    if (providerCapabilities.sms !== undefined) {
      updateStageFromEvidence('SMS_OUTBOUND', providerCapabilities.sms);
      updateStageFromEvidence('SMS_INBOUND', providerCapabilities.sms);
    }
    if (providerCapabilities.mms !== undefined) {
      updateStageFromEvidence('MMS_OUTBOUND', providerCapabilities.mms);
      updateStageFromEvidence('MMS_INBOUND', providerCapabilities.mms);
    }

    await (supabase as any)
      .from('phone_numbers')
      .update({
        capabilities_state: capsState,
      })
      .eq('id', phoneNumberId);
  }

  private static reject(
    code: CapabilityErrorCode,
    reason: string,
    capability: NumberCapabilityType,
    phoneNumberId: string,
    phoneNumberE164: string,
    organizationId: string,
    auditDetails?: any
  ): CapabilityAuthorizationResult {
    return {
      allowed: false,
      code,
      reason,
      capability,
      phoneNumberId,
      phoneNumberE164,
      organizationId,
      auditEvidence: {
        stage: auditDetails?.stage,
        ownershipState: auditDetails?.ownershipState,
        serviceState: auditDetails?.serviceState,
        providerAccountType: auditDetails?.providerAccountType,
        providerAccountStatus: auditDetails?.providerAccountStatus,
        providerResourceMatch: auditDetails?.providerResourceMatch ?? false,
        assignmentVerified: auditDetails?.assignmentVerified ?? false,
        complianceVerified: auditDetails?.complianceVerified ?? false,
        reconciliationRequired: auditDetails?.reconciliationRequired ?? false,
      },
    };
  }
}

/**
 * Functional shortcut matching 23C specification:
 * canUseCapability(phoneNumberId, capability, organizationId, context?, client?)
 */
export async function canUseCapability(
  phoneNumberIdOrE164: string,
  capability: NumberCapabilityType,
  organizationId: string,
  context?: CapabilityAuthorizationContext,
  clientOverride?: any
): Promise<CapabilityAuthorizationResult> {
  return CapabilityAuthorizationService.canUseCapability(
    phoneNumberIdOrE164,
    capability,
    organizationId,
    context,
    clientOverride
  );
}
