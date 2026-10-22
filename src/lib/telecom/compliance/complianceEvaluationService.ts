import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  CanonicalComplianceCaseState,
  CanonicalNumberType,
  ComplianceEnforcementDecision,
  ComplianceEvaluationResult,
  SubjectType,
} from './types';

export interface EvaluatePurchaseComplianceParams {
  organizationId: string;
  countryCode: string;
  numberType: CanonicalNumberType;
  subjectType: SubjectType;
  phoneNumberE164: string;
  complianceCaseId?: string | null;
  authoritativeNotRequired?: boolean;
}

export interface EvaluateCapabilityComplianceParams {
  organizationId: string;
  phoneNumberId: string;
  capability: string;
}

export class ComplianceEvaluationService {
  /**
   * Evaluates compliance readiness strictly BEFORE provider purchase mutation.
   * Tasks 18, 19, C11-C20.
   */
  static async evaluatePurchaseCompliance(
    params: EvaluatePurchaseComplianceParams,
    dbClient?: any
  ): Promise<ComplianceEvaluationResult> {
    const supabase = dbClient || createAdminClient();

    // 1. Authoritative NOT_REQUIRED Check
    // Strict Invariant: Geographic shortcuts (US/CA => NOT_REQUIRED) are PROHIBITED.
    // NOT_REQUIRED must originate strictly from authoritative requirement discovery or explicit provider contract.
    if (params.authoritativeNotRequired === true) {
      return {
        status: 'NOT_REQUIRED',
        eligibleForPurchase: true,
        eligibleForActivation: true,
        decision: 'ALLOW',
        blockingReasons: [],
      };
    }

    // Check authoritative requirement snapshots in database
    let authoritativeSnapshot: any = null;
    try {
      const { data: snapshot } = await (supabase as any)
        .from('compliance_requirement_snapshots')
        .select('*')
        .eq('country_code', params.countryCode.toUpperCase())
        .eq('canonical_number_type', params.numberType)
        .eq('end_user_type', params.subjectType)
        .order('retrieved_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (snapshot) {
        authoritativeSnapshot = snapshot;
        const reqPayload = snapshot.requirement_payload || {};
        if (reqPayload.bundleRequired === false) {
          return {
            status: 'NOT_REQUIRED',
            eligibleForPurchase: true,
            eligibleForActivation: true,
            decision: 'ALLOW',
            blockingReasons: [],
            applicableComplianceCaseId: null,
          };
        }
      }
    } catch {
      // Table may not exist in legacy test harness -> fail closed below
    }

    // 2. If a specific complianceCaseId was supplied
    if (params.complianceCaseId) {
      const { data: caseRow } = await (supabase as any)
        .from('compliance_cases')
        .select('*')
        .eq('id', params.complianceCaseId)
        .eq('organization_id', params.organizationId)
        .maybeSingle();

      if (!caseRow) {
        return {
          status: 'UNKNOWN',
          eligibleForPurchase: false,
          eligibleForActivation: false,
          decision: 'UNKNOWN_FAIL_CLOSED',
          blockingReasons: [`Compliance case '${params.complianceCaseId}' not found for organization.`],
        };
      }

      const canonicalStatus = caseRow.canonical_status as CanonicalComplianceCaseState;

      // Check context compatibility (country, number_type, and subject_type)
      if (
        caseRow.country_code.toUpperCase() !== params.countryCode.toUpperCase() ||
        caseRow.number_type !== params.numberType ||
        (params.subjectType && caseRow.subject_type !== params.subjectType)
      ) {
        return {
          status: canonicalStatus,
          eligibleForPurchase: false,
          eligibleForActivation: false,
          decision: 'BLOCK_NEW_PROVISIONING',
          blockingReasons: [
            `Compliance case context (${caseRow.country_code}/${caseRow.number_type}/${caseRow.subject_type}) does not match purchase context (${params.countryCode}/${params.numberType}/${params.subjectType}).`,
          ],
        };
      }

      // Check case expiration
      if (caseRow.valid_until && new Date(caseRow.valid_until) <= new Date()) {
        return {
          status: 'EXPIRED',
          eligibleForPurchase: false,
          eligibleForActivation: false,
          decision: 'BLOCK_NEW_PROVISIONING',
          blockingReasons: ['Compliance case has expired.'],
          applicableComplianceCaseId: caseRow.id,
        };
      }

      if (canonicalStatus === 'APPROVED') {
        // Fetch remote resource SID if present
        const { data: mapping } = await (supabase as any)
          .from('provider_resource_mappings')
          .select('provider_resource_id')
          .eq('compliance_case_id', caseRow.id)
          .maybeSingle();

        return {
          status: 'APPROVED',
          eligibleForPurchase: true,
          eligibleForActivation: true,
          decision: 'ALLOW',
          blockingReasons: [],
          applicableComplianceCaseId: caseRow.id,
          applicableBundleSid: mapping?.provider_resource_id || null,
        };
      }

      // All non-APPROVED states FAIL CLOSED for purchase (Task 18)
      let decision: ComplianceEnforcementDecision = 'BLOCK_NEW_PROVISIONING';
      if (canonicalStatus === 'UNKNOWN') decision = 'UNKNOWN_FAIL_CLOSED';
      else if (canonicalStatus === 'MANUAL_REVIEW_REQUIRED') decision = 'MANUAL_REVIEW';

      return {
        status: canonicalStatus,
        eligibleForPurchase: false,
        eligibleForActivation: false,
        decision,
        blockingReasons: [`Compliance case is in state '${canonicalStatus}'. Must be APPROVED before purchase.`],
        applicableComplianceCaseId: caseRow.id,
      };
    }

    // 3. Search for existing eligible APPROVED case for this tenant, country, numberType, and subjectType
    const { data: eligibleCases } = await (supabase as any)
      .from('compliance_cases')
      .select('*')
      .eq('organization_id', params.organizationId)
      .eq('country_code', params.countryCode.toUpperCase())
      .eq('number_type', params.numberType)
      .eq('subject_type', params.subjectType)
      .eq('canonical_status', 'APPROVED')
      .order('approved_at', { ascending: false });

    if (eligibleCases && eligibleCases.length > 0) {
      const activeApproved = eligibleCases.find(
        (c: any) => !c.valid_until || new Date(c.valid_until) > new Date()
      );

      if (activeApproved) {
        const { data: mapping } = await (supabase as any)
          .from('provider_resource_mappings')
          .select('provider_resource_id')
          .eq('compliance_case_id', activeApproved.id)
          .maybeSingle();

        return {
          status: 'APPROVED',
          eligibleForPurchase: true,
          eligibleForActivation: true,
          decision: 'ALLOW',
          blockingReasons: [],
          applicableComplianceCaseId: activeApproved.id,
          applicableBundleSid: mapping?.provider_resource_id || null,
        };
      }
    }

    // No approved case found
    if (!authoritativeSnapshot) {
      return {
        status: 'UNKNOWN',
        eligibleForPurchase: false,
        eligibleForActivation: false,
        decision: 'UNKNOWN_FAIL_CLOSED',
        blockingReasons: [
          `Regulatory requirement state is unknown for ${params.countryCode} ${params.numberType}. Requirements must be authoritatively discovered before purchase.`,
        ],
      };
    }

    return {
      status: 'INCOMPLETE',
      eligibleForPurchase: false,
      eligibleForActivation: false,
      decision: 'BLOCK_NEW_PROVISIONING',
      blockingReasons: [
        `Regulatory compliance approval is required for ${params.countryCode} ${params.numberType} numbers before purchase.`,
      ],
    };
  }

  /**
   * Evaluates compliance gate for runtime capability authorization (Task 20).
   * Invariant: Does NOT universally suspend active service merely because case is UPDATE_REQUIRED or EXPIRED.
   */
  static async evaluateCapabilityCompliance(
    params: EvaluateCapabilityComplianceParams,
    dbClient?: any
  ): Promise<{ decision: ComplianceEnforcementDecision; reason?: string }> {
    const supabase = dbClient || createAdminClient();

    // Check active binding for phone number
    let binding: any = null;
    try {
      const { data, error } = await (supabase as any)
        .from('number_compliance_bindings')
        .select('id, compliance_case_id, status')
        .eq('phone_number_id', params.phoneNumberId)
        .eq('organization_id', params.organizationId)
        .eq('status', 'ACTIVE')
        .maybeSingle();

      if (error) {
        return { decision: 'ALLOW' };
      }
      binding = data;
    } catch {
      return { decision: 'ALLOW' };
    }

    if (!binding) {
      // If no binding exists, number might not require compliance or operates on legacy baseline
      return { decision: 'ALLOW' };
    }

    const { data: caseRow } = await (supabase as any)
      .from('compliance_cases')
      .select('canonical_status, valid_until')
      .eq('id', binding.compliance_case_id)
      .maybeSingle();

    if (!caseRow) {
      return { decision: 'UNKNOWN_FAIL_CLOSED', reason: 'Bound compliance case missing.' };
    }

    const status = caseRow.canonical_status as CanonicalComplianceCaseState;

    if (status === 'APPROVED') {
      return { decision: 'ALLOW' };
    }

    if (status === 'REJECTED') {
      return { decision: 'SUSPEND_EXISTING_SERVICE', reason: 'Regulatory compliance rejected by carrier.' };
    }

    if (status === 'UPDATE_REQUIRED') {
      // Per Task 20: Do NOT immediately suspend existing voice/SMS/MMS on UPDATE_REQUIRED!
      // Block new capability configuration or outbound provisioning, but maintain existing routing.
      return { decision: 'BLOCK_CAPABILITY_ACTIVATION', reason: 'Regulatory compliance update required.' };
    }

    if (status === 'EXPIRED') {
      // Per Task 20: Do not globally disconnect existing numbers without authoritative provider evidence.
      return { decision: 'BLOCK_NEW_OUTBOUND_USAGE', reason: 'Regulatory compliance evidence expired.' };
    }

    return { decision: 'ALLOW' };
  }
}
