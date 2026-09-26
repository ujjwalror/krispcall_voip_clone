import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { ComplianceProfileService } from './complianceProfileService';
import { ProviderResourceMappingService } from './providerResourceMappingService';
import { TwilioFieldMapper } from './twilioFieldMapper';
import { ComplianceResourceType, ComplianceRequirementSnapshot } from './types';

export interface ProviderPreflightPlanStep {
  stepIndex: number;
  operationType: string;
  resourceType: ComplianceResourceType;
  sourceEntityId: string;
  required: boolean;
  alreadySatisfied: boolean;
  existingResourceSid?: string;
  blocked: boolean;
  blockReason?: string;
  reconciliationRequired: boolean;
  futureMutationRequired: boolean;
  dispatchMode?: 'metadata_only' | 'multipart_with_evidence';
  fileEvidenceRequired?: boolean;
  storageAvailable?: boolean;
  hashValid?: boolean;
  mimeValid?: boolean;
  sizeValid?: boolean;
}

export interface ProviderPreflightResult {
  ready: boolean;
  profileId: string;
  organizationId: string;
  provider: 'twilio';
  countryCode: string;
  numberType: string;
  endUserType: string;
  regulationSid?: string | null;
  addressRequired: boolean;
  plan: ProviderPreflightPlanStep[];
  errors: string[];
  warnings: string[];
}

export class TwilioPreflightService {
  /**
   * Evaluates a local compliance profile for provider submission readiness.
   * Performs READ-ONLY structural and compatibility checks without executing provider mutations.
   * NEVER returns decrypted KYC plaintext or sensitive credentials in the result.
   */
  static async runPreflight(
    organizationId: string,
    complianceProfileId: string,
    userRole: string,
    clientOverride?: any
  ): Promise<ProviderPreflightResult> {
    // 1. Authorization: Only owner or admin allowed
    if (userRole !== 'owner' && userRole !== 'admin') {
      throw new Error('UNAUTHORIZED_ROLE: Compliance preflight requires owner or admin role access.');
    }

    const supabase = clientOverride || (createAdminClient() as any);
    const errors: string[] = [];
    const warnings: string[] = [];

    // 2. Fetch Profile
    const { data: profile, error: profileErr } = await supabase
      .from('organization_compliance_profiles')
      .select('*')
      .eq('id', complianceProfileId)
      .single();

    if (profileErr || !profile) {
      return {
        ready: false,
        profileId: complianceProfileId,
        organizationId,
        provider: 'twilio',
        countryCode: '',
        numberType: '',
        endUserType: '',
        addressRequired: false,
        plan: [],
        errors: [`Profile not found or access denied: ${complianceProfileId}`],
        warnings: [],
      };
    }

    // Check organization isolation
    if (profile.organization_id !== organizationId) {
      throw new Error('FORBIDDEN: Cross-tenant access denied.');
    }

    // Check profile internal status
    const currentStatus = profile.status || profile.internal_status;
    if (currentStatus !== 'ready_for_submission' && currentStatus !== 'submitted') {
      errors.push(`Profile internal status is '${currentStatus}'. Must be 'ready_for_submission' for provider preflight.`);
    }

    // 3. Fetch Requirement Snapshot
    const { data: snapshotRow, error: snapErr } = await supabase
      .from('compliance_requirement_snapshots')
      .select('*')
      .eq('compliance_profile_id', complianceProfileId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (snapErr || !snapshotRow) {
      errors.push('Authoritative requirement snapshot missing for profile.');
    }

    const snapshot: ComplianceRequirementSnapshot = snapshotRow
      ? {
          id: snapshotRow.id,
          complianceProfileId: snapshotRow.compliance_profile_id || snapshotRow.complianceProfileId,
          provider: 'twilio',
          providerRegulationId: snapshotRow.provider_regulation_id || snapshotRow.regulation_sid || snapshotRow.providerRegulationId || null,
          countryCode: snapshotRow.country_code || snapshotRow.countryCode || '',
          numberType: snapshotRow.number_type || snapshotRow.numberType || 'local',
          endUserType: snapshotRow.end_user_type || snapshotRow.endUserType || 'business',
          requirementPayload: snapshotRow.requirement_payload || snapshotRow.requirementPayload || {
            status: 'success',
            regulationId: snapshotRow.provider_regulation_id || snapshotRow.regulation_sid || null,
            countryCode: snapshotRow.country_code || '',
            numberType: snapshotRow.number_type || 'local',
            endUserType: snapshotRow.end_user_type || 'business',
            addressRequirement: 'required',
            endUserRequirements: [],
            supportingDocumentRequirements: [],
            bundleRequired: true,
          },
          retrievedAt: snapshotRow.retrieved_at || snapshotRow.created_at || new Date().toISOString(),
        }
      : {
          id: '',
          complianceProfileId,
          provider: 'twilio',
          providerRegulationId: null,
          countryCode: profile.country_code || '',
          numberType: profile.number_type || 'local',
          endUserType: profile.end_user_type || 'business',
          requirementPayload: {
            status: 'success',
            regulationId: null,
            countryCode: profile.country_code || '',
            numberType: profile.number_type || 'local',
            endUserType: profile.end_user_type || 'business',
            addressRequirement: 'required',
            endUserRequirements: [],
            supportingDocumentRequirements: [],
            bundleRequired: true,
          },
          retrievedAt: new Date().toISOString(),
        };

    const targetContext = {
      countryCode: snapshot.countryCode,
      numberType: snapshot.numberType as any,
      endUserType: snapshot.endUserType as any,
      providerRegulationId: snapshot.providerRegulationId,
    };

    // 4. Fetch Field Values & Check Decryption
    const { data: fieldRows, error: fieldsErr } = await supabase
      .from('compliance_field_values')
      .select('*')
      .eq('compliance_profile_id', complianceProfileId);

    if (fieldsErr) {
      errors.push(`Failed to fetch compliance field values: ${fieldsErr.message}`);
    }

    const fieldValues: { requirementKey: string; fieldName: string; fieldValue: string }[] = [];
    if (fieldRows && fieldRows.length > 0) {
      for (const f of fieldRows) {
        let val = f.field_value;
        if (f.is_encrypted && f.iv && f.auth_tag) {
          try {
            // Attempt decryption to ensure key and ciphertext are intact
            val = ComplianceProfileService['mapFieldValueRecord'](f).fieldValue;
            if (val === '***ENCRYPTED_VALUE_UNAVAILABLE***') {
              errors.push(`Decryption failed for encrypted field '${f.field_name}'. Key or ciphertext invalid.`);
            }
          } catch (err) {
            errors.push(`Decryption exception for encrypted field '${f.field_name}'.`);
          }
        }
        fieldValues.push({
          requirementKey: f.requirement_key,
          fieldName: f.field_name,
          fieldValue: val,
        });
      }
    }

    // 5. Fetch Supporting Documents
    const { data: docRows, error: docsErr } = await supabase
      .from('compliance_documents')
      .select('*')
      .eq('compliance_profile_id', complianceProfileId);

    if (docsErr) {
      errors.push(`Failed to fetch compliance documents: ${docsErr.message}`);
    }

    const documents = docRows || [];
    if (documents.length === 0) {
      warnings.push('No supporting documents uploaded for profile.');
    }

    // Verify document storage & hashes
    for (const doc of documents) {
      if (!doc.file_path) {
        errors.push(`Document '${doc.id}' missing file path in private storage.`);
      }
      if (!doc.file_hash) {
        warnings.push(`Document '${doc.id}' missing cryptographic hash.`);
      }
    }

    // 6. Check Unresolved Reconciliation Operations
    const { data: unresolvedOps, error: opsErr } = await supabase
      .from('provider_compliance_operations')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('compliance_profile_id', complianceProfileId)
      .eq('status', 'reconciliation_required');

    const blockedPendingReconciliation = !opsErr && unresolvedOps && unresolvedOps.length > 0;
    if (blockedPendingReconciliation) {
      errors.push('Submission BLOCKED: Unresolved operations require reconciliation before provider submission can proceed.');
    }

    // 7. Check Existing Mappings and Compatibility
    const existingMappings = await ProviderResourceMappingService.getMappingsForProfile(
      organizationId,
      complianceProfileId,
      supabase
    );

    const getExistingMapping = (type: ComplianceResourceType, sourceId: string = 'primary') => {
      return existingMappings.find((m) => m.resourceType === type && m.sourceEntityId === sourceId);
    };

    // Determine Address requirement
    const addressRequired = TwilioFieldMapper.isAddressRequired(snapshot as any, fieldValues);

    // 8. Generate Submission Plan
    const plan: ProviderPreflightPlanStep[] = [];
    let stepIndex = 1;

    // Step 1: Address (if required)
    if (addressRequired) {
      const existingAddress = getExistingMapping('address');
      const isCompatible = existingAddress ? ProviderResourceMappingService.isResourceCompatible(existingAddress, targetContext) : false;

      plan.push({
        stepIndex: stepIndex++,
        operationType: 'create_address',
        resourceType: 'address',
        sourceEntityId: 'primary',
        required: true,
        alreadySatisfied: isCompatible,
        existingResourceSid: isCompatible ? existingAddress?.providerResourceId : undefined,
        blocked: blockedPendingReconciliation || (!isCompatible && !!existingAddress),
        blockReason: blockedPendingReconciliation
          ? 'Unresolved reconciliation required'
          : existingAddress && !isCompatible
          ? 'Incompatible existing address mapping'
          : undefined,
        reconciliationRequired: blockedPendingReconciliation,
        futureMutationRequired: !isCompatible,
      });
    }

    // Step 2: End User
    const existingEndUser = getExistingMapping('end_user');
    const isEndUserCompatible = existingEndUser ? ProviderResourceMappingService.isResourceCompatible(existingEndUser, targetContext) : false;

    plan.push({
      stepIndex: stepIndex++,
      operationType: 'create_end_user',
      resourceType: 'end_user',
      sourceEntityId: 'primary',
      required: true,
      alreadySatisfied: isEndUserCompatible,
      existingResourceSid: isEndUserCompatible ? existingEndUser?.providerResourceId : undefined,
      blocked: blockedPendingReconciliation || (!isEndUserCompatible && !!existingEndUser),
      blockReason: blockedPendingReconciliation
        ? 'Unresolved reconciliation required'
        : existingEndUser && !isEndUserCompatible
        ? 'Incompatible existing end user mapping'
        : undefined,
      reconciliationRequired: blockedPendingReconciliation,
      futureMutationRequired: !isEndUserCompatible,
    });

    // Steps 3..N: Supporting Documents (Distinct for each document)
    for (const doc of documents) {
      const existingDocMapping = getExistingMapping('supporting_document', doc.id);
      const isDocCompatible = existingDocMapping ? ProviderResourceMappingService.isResourceCompatible(existingDocMapping, targetContext) : false;

      const hasFilePath = Boolean(doc.file_path);
      const hasHash = Boolean(doc.file_hash);
      const fileEvidenceRequired = true; // By default compliance documents uploaded in collection require evidence
      const dispatchMode = fileEvidenceRequired ? 'multipart_with_evidence' : 'metadata_only';

      plan.push({
        stepIndex: stepIndex++,
        operationType: 'create_supporting_document',
        resourceType: 'supporting_document',
        sourceEntityId: doc.id,
        required: true,
        alreadySatisfied: isDocCompatible,
        existingResourceSid: isDocCompatible ? existingDocMapping?.providerResourceId : undefined,
        blocked: blockedPendingReconciliation || (!isDocCompatible && !!existingDocMapping) || !hasFilePath,
        blockReason: blockedPendingReconciliation
          ? 'Unresolved reconciliation required'
          : !hasFilePath
          ? 'Missing private storage file path'
          : existingDocMapping && !isDocCompatible
          ? 'Incompatible existing supporting document mapping'
          : undefined,
        reconciliationRequired: blockedPendingReconciliation,
        futureMutationRequired: !isDocCompatible,
        dispatchMode,
        fileEvidenceRequired,
        storageAvailable: hasFilePath,
        hashValid: hasHash,
        mimeValid: true,
        sizeValid: doc.size_bytes ? doc.size_bytes <= 10 * 1024 * 1024 : true,
      });
    }

    // Step N+1: Bundle
    const existingBundle = getExistingMapping('bundle');
    const isBundleCompatible = existingBundle ? ProviderResourceMappingService.isResourceCompatible(existingBundle, targetContext) : false;

    plan.push({
      stepIndex: stepIndex++,
      operationType: 'create_bundle',
      resourceType: 'bundle',
      sourceEntityId: 'primary',
      required: true,
      alreadySatisfied: isBundleCompatible,
      existingResourceSid: isBundleCompatible ? existingBundle?.providerResourceId : undefined,
      blocked: blockedPendingReconciliation || (!isBundleCompatible && !!existingBundle),
      blockReason: blockedPendingReconciliation
        ? 'Unresolved reconciliation required'
        : existingBundle && !isBundleCompatible
        ? 'Incompatible existing bundle mapping'
        : undefined,
      reconciliationRequired: blockedPendingReconciliation,
      futureMutationRequired: !isBundleCompatible,
    });

    // Step N+2: Item Assignments
    if (addressRequired) {
      plan.push({
        stepIndex: stepIndex++,
        operationType: 'assign_item_address',
        resourceType: 'address',
        sourceEntityId: 'primary',
        required: true,
        alreadySatisfied: false,
        blocked: blockedPendingReconciliation,
        reconciliationRequired: blockedPendingReconciliation,
        futureMutationRequired: true,
      });
    }

    plan.push({
      stepIndex: stepIndex++,
      operationType: 'assign_item_end_user',
      resourceType: 'end_user',
      sourceEntityId: 'primary',
      required: true,
      alreadySatisfied: false,
      blocked: blockedPendingReconciliation,
      reconciliationRequired: blockedPendingReconciliation,
      futureMutationRequired: true,
    });

    for (const doc of documents) {
      plan.push({
        stepIndex: stepIndex++,
        operationType: `assign_item_supporting_document_${doc.id.slice(0, 8)}`,
        resourceType: 'supporting_document',
        sourceEntityId: doc.id,
        required: true,
        alreadySatisfied: false,
        blocked: blockedPendingReconciliation,
        reconciliationRequired: blockedPendingReconciliation,
        futureMutationRequired: true,
      });
    }

    // Step N+3: Evaluation & Submission
    plan.push({
      stepIndex: stepIndex++,
      operationType: 'evaluate_bundle',
      resourceType: 'bundle',
      sourceEntityId: 'primary',
      required: true,
      alreadySatisfied: false,
      blocked: blockedPendingReconciliation,
      reconciliationRequired: blockedPendingReconciliation,
      futureMutationRequired: true,
    });

    plan.push({
      stepIndex: stepIndex++,
      operationType: 'submit_bundle',
      resourceType: 'bundle',
      sourceEntityId: 'primary',
      required: true,
      alreadySatisfied: false,
      blocked: blockedPendingReconciliation,
      reconciliationRequired: blockedPendingReconciliation,
      futureMutationRequired: true,
    });

    const isReady = errors.length === 0 && !blockedPendingReconciliation;

    return {
      ready: isReady,
      profileId: complianceProfileId,
      organizationId,
      provider: 'twilio',
      countryCode: snapshot.countryCode,
      numberType: snapshot.numberType,
      endUserType: snapshot.endUserType,
      regulationSid: snapshot.providerRegulationId,
      addressRequired,
      plan,
      errors,
      warnings,
    };
  }
}
