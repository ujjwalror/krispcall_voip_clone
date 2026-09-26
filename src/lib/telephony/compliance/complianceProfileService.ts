import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { RegulatoryPreCheckService, mapDomainToTwilioRegulationNumberType } from '../marketplace/regulatoryPreCheckService';
import { ComplianceEncryptionService } from './complianceEncryptionService';
import { ComplianceDocumentService } from './complianceDocumentService';
import { ComplianceFingerprintService } from './complianceFingerprint';
import { TwilioProviderComplianceAdapter } from './twilioComplianceAdapter';
import {
  OrganizationComplianceProfile,
  ComplianceProfileWithDetails,
  CreateProfileParams,
  UpdateFieldValuesParams,
  ComplianceRequirementSnapshot,
  ComplianceFieldValue,
  ComplianceInternalStatus,
} from './types';

/**
 * Server-authoritative service for tenant compliance profiles.
 * Strict multi-tenant security: enforces owner/admin roles, field whitelisting,
 * dynamic requirement snapshotting, AES-256-GCM encryption, and factual reuse state evaluation.
 */
export class ComplianceProfileService {
  /**
   * Asserts user role is owner or admin.
   */
  private static assertOwnerOrAdmin(role: string | null | undefined): void {
    if (role !== 'owner' && role !== 'admin') {
      throw new Error('UNAUTHORIZED_ROLE: Compliance profiles require owner or admin role access.');
    }
  }

  /**
   * Helper to map database field value record to domain interface, decrypting sensitive values.
   */
  private static mapFieldValueRecord(f: any): ComplianceFieldValue {
    let value = f.field_value;
    if (f.is_encrypted && f.iv && f.auth_tag) {
      try {
        value = ComplianceEncryptionService.decryptValue(f.field_value, f.iv, f.auth_tag);
      } catch (err) {
        console.warn(`[ComplianceProfileService] Failed to decrypt field ${f.requirement_key}/${f.field_name}:`, err);
        value = '***ENCRYPTED_VALUE_UNAVAILABLE***';
      }
    }

    return {
      id: f.id,
      complianceProfileId: f.compliance_profile_id,
      requirementKey: f.requirement_key,
      fieldName: f.field_name,
      fieldValue: value,
      isEncrypted: Boolean(f.is_encrypted),
      createdAt: f.created_at,
      updatedAt: f.updated_at,
    };
  }

  /**
   * Lists compliance profiles for an organization with details and documents.
   */
  static async getOrganizationProfiles(
    organizationId: string,
    userRole: string
  ): Promise<ComplianceProfileWithDetails[]> {
    this.assertOwnerOrAdmin(userRole);
    const supabase = createAdminClient() as any;

    const { data: profiles, error: pErr } = await supabase
      .from('organization_compliance_profiles')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (pErr) {
      console.error('[ComplianceProfileService] Error listing profiles:', pErr);
      throw new Error(`Failed to list organization compliance profiles: ${pErr.message}`);
    }

    if (!profiles || profiles.length === 0) {
      return [];
    }

    const profileIds = profiles.map((p: any) => p.id);

    // Fetch snapshots, field values, and documents
    const [snapshotsRes, fieldsRes, docsRes] = await Promise.all([
      supabase
        .from('compliance_requirement_snapshots')
        .select('*')
        .in('compliance_profile_id', profileIds),
      supabase
        .from('compliance_field_values')
        .select('*')
        .in('compliance_profile_id', profileIds),
      supabase
        .from('compliance_documents')
        .select('*')
        .in('compliance_profile_id', profileIds),
    ]);

    const snapshotsMap = new Map<string, ComplianceRequirementSnapshot[]>();
    (snapshotsRes.data || []).forEach((s: any) => {
      const arr = snapshotsMap.get(s.compliance_profile_id) || [];
      arr.push({
        id: s.id,
        complianceProfileId: s.compliance_profile_id,
        provider: s.provider,
        providerRegulationId: s.provider_regulation_id,
        countryCode: s.country_code,
        numberType: s.number_type,
        endUserType: s.end_user_type,
        requirementPayload: s.requirement_payload,
        retrievedAt: s.retrieved_at,
      });
      snapshotsMap.set(s.compliance_profile_id, arr);
    });

    const fieldsMap = new Map<string, ComplianceFieldValue[]>();
    (fieldsRes.data || []).forEach((f: any) => {
      const arr = fieldsMap.get(f.compliance_profile_id) || [];
      arr.push(this.mapFieldValueRecord(f));
      fieldsMap.set(f.compliance_profile_id, arr);
    });

    const docsMap = new Map<string, any[]>();
    (docsRes.data || []).forEach((d: any) => {
      const arr = docsMap.get(d.compliance_profile_id) || [];
      arr.push({
        id: d.id,
        organizationId: d.organization_id,
        complianceProfileId: d.compliance_profile_id,
        requirementKey: d.requirement_key,
        documentType: d.document_type,
        storageObjectPath: d.storage_object_path,
        originalFilename: d.original_filename,
        mimeType: d.mime_type,
        sizeBytes: Number(d.size_bytes),
        sha256Hash: d.sha256_hash,
        status: d.status,
        createdBy: d.created_by,
        createdAt: d.created_at,
        updatedAt: d.updated_at,
      });
      docsMap.set(d.compliance_profile_id, arr);
    });

    return profiles.map((p: any) => {
      const pSnapshots = snapshotsMap.get(p.id) || [];
      const pFields = fieldsMap.get(p.id) || [];
      const pDocs = docsMap.get(p.id) || [];

      return {
        id: p.id,
        organizationId: p.organization_id,
        endUserType: p.end_user_type,
        countryCode: p.country_code,
        legalName: p.legal_name,
        givenName: p.given_name || null,
        familyName: p.family_name || null,
        status: p.status as ComplianceInternalStatus,
        createdBy: p.created_by,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        snapshots: pSnapshots,
        fieldValues: pFields,
        documents: pDocs,
        reuseState: 'reuse_requires_validation',
      };
    });
  }

  /**
   * Fetches single compliance profile by ID.
   */
  static async getProfileById(
    organizationId: string,
    profileId: string,
    userRole: string,
    clientOverride?: any
  ): Promise<ComplianceProfileWithDetails | null> {
    this.assertOwnerOrAdmin(userRole);
    const supabase = clientOverride || (createAdminClient() as any);

    const { data: profile, error: pErr } = await supabase
      .from('organization_compliance_profiles')
      .select('*')
      .eq('id', profileId)
      .eq('organization_id', organizationId)
      .single();

    if (pErr || !profile) {
      return null;
    }

    const [snapshotsRes, fieldsRes, docsRes] = await Promise.all([
      supabase
        .from('compliance_requirement_snapshots')
        .select('*')
        .eq('compliance_profile_id', profileId),
      supabase
        .from('compliance_field_values')
        .select('*')
        .eq('compliance_profile_id', profileId),
      supabase
        .from('compliance_documents')
        .select('*')
        .eq('compliance_profile_id', profileId),
    ]);

    const snapshots: ComplianceRequirementSnapshot[] = (snapshotsRes.data || []).map((s: any) => ({
      id: s.id,
      complianceProfileId: s.compliance_profile_id,
      provider: s.provider,
      providerRegulationId: s.provider_regulation_id,
      countryCode: s.country_code,
      numberType: s.number_type,
      endUserType: s.end_user_type,
      requirementPayload: s.requirement_payload,
      retrievedAt: s.retrieved_at,
    }));

    const fieldValues: ComplianceFieldValue[] = (fieldsRes.data || []).map((f: any) =>
      this.mapFieldValueRecord(f)
    );

    const documents = (docsRes.data || []).map((d: any) => ({
      id: d.id,
      organizationId: d.organization_id,
      complianceProfileId: d.compliance_profile_id,
      requirementKey: d.requirement_key,
      documentType: d.document_type,
      storageObjectPath: d.storage_object_path,
      originalFilename: d.original_filename,
      mimeType: d.mime_type,
      sizeBytes: Number(d.size_bytes),
      sha256Hash: d.sha256_hash,
      status: d.status,
      createdBy: d.created_by,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    }));

    return {
      id: profile.id,
      organizationId: profile.organization_id,
      endUserType: profile.end_user_type,
      countryCode: profile.country_code,
      legalName: profile.legal_name,
      status: profile.status as ComplianceInternalStatus,
      createdBy: profile.created_by,
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
      snapshots,
      fieldValues,
      documents,
      reuseState: 'reuse_requires_validation',
    };
  }

  /**
   * Helper to derive authoritative system-derived field values for a profile context.
   * Strictly verifies that derived values are valid options within the active requirement snapshot.
   */
  public static deriveSystemFieldsForProfile(
    snapshotPayload: any,
    endUserType: string
  ): Array<{ requirementKey: string; fieldName: string; fieldValue: string }> {
    const derived: Array<{ requirementKey: string; fieldName: string; fieldValue: string }> = [];
    if (!snapshotPayload || !Array.isArray(snapshotPayload.endUserRequirements)) {
      return derived;
    }

    const endUserReqs = snapshotPayload.endUserRequirements;

    if (endUserType === 'business') {
      // 1. Business Classification (business_identity) -> DIRECT_CUSTOMER
      const bizClassReq = endUserReqs.find((r: any) => r.fieldKey === 'business_identity' || r.fieldKey === 'business_classification');
      if (bizClassReq) {
        const hasDirectCustomerOpt = Array.isArray(bizClassReq.options) &&
          bizClassReq.options.some((o: any) => o.value === 'DIRECT_CUSTOMER');
        
        if (hasDirectCustomerOpt) {
          derived.push({
            requirementKey: 'business_info',
            fieldName: bizClassReq.fieldKey,
            fieldValue: 'DIRECT_CUSTOMER',
          });
        }
      }

      // 2. Is Subassigned (is_subassigned) -> NO
      const subassignReq = endUserReqs.find((r: any) => r.fieldKey === 'is_subassigned');
      if (subassignReq) {
        const hasNoOpt = Array.isArray(subassignReq.options) &&
          subassignReq.options.some((o: any) => o.value === 'NO');

        if (hasNoOpt) {
          derived.push({
            requirementKey: 'business_info',
            fieldName: subassignReq.fieldKey,
            fieldValue: 'NO',
          });
        }
      }
    }

    return derived;
  }

  /**
   * Creates a draft compliance profile and captures a dynamic requirement snapshot via RegulatoryPreCheckService.
   */
  static async createDraftProfile(
    organizationId: string,
    userId: string,
    userRole: string,
    params: CreateProfileParams
  ): Promise<ComplianceProfileWithDetails> {
    this.assertOwnerOrAdmin(userRole);
    const countryCode = (params.countryCode || 'US').toUpperCase().trim();
    const numberType = params.numberType;
    const endUserType = params.endUserType || 'business';
    const legalName = (params.legalName || '').trim();

    if (!legalName) {
      throw new Error('Legal business or individual name is required.');
    }

    const mappedType = mapDomainToTwilioRegulationNumberType(numberType);
    if (!mappedType) {
      throw new Error(`Unsupported or invalid number category '${numberType}'.`);
    }

    // 1. Fetch dynamic requirement set from Twilio Regulations API
    const preCheck = await RegulatoryPreCheckService.evaluateRequirements(
      countryCode,
      numberType,
      endUserType
    );

    const supabase = createAdminClient() as any;

    // 2. Insert organization compliance profile record
    const { data: newProfile, error: pErr } = await supabase
      .from('organization_compliance_profiles')
      .insert({
        organization_id: organizationId,
        end_user_type: endUserType,
        country_code: countryCode,
        legal_name: legalName,
        given_name: params.givenName || null,
        family_name: params.familyName || null,
        status: 'draft',
        created_by: userId,
      })
      .select('*')
      .single();

    if (pErr || !newProfile) {
      console.error('[ComplianceProfileService] Error creating profile record:', pErr);
      throw new Error(`Failed to create compliance profile: ${pErr?.message || 'Unknown database error'}`);
    }

    // 3. Store dynamic requirement snapshot
    const { data: newSnapshot, error: sErr } = await supabase
      .from('compliance_requirement_snapshots')
      .insert({
        compliance_profile_id: newProfile.id,
        provider: 'twilio',
        provider_regulation_id: preCheck.regulationId,
        country_code: countryCode,
        number_type: numberType,
        end_user_type: endUserType,
        requirement_payload: preCheck,
      })
      .select('*')
      .single();

    if (sErr || !newSnapshot) {
      console.error('[ComplianceProfileService] Error inserting requirement snapshot:', sErr);
      throw new Error(`Failed to record requirement snapshot: ${sErr?.message || 'Snapshot insertion error'}`);
    }

    // 4. Auto-populate system-derived fields for active snapshot context
    const systemFields = this.deriveSystemFieldsForProfile(preCheck, endUserType);
    for (const sf of systemFields) {
      await supabase.from('compliance_field_values').upsert({
        compliance_profile_id: newProfile.id,
        requirement_key: sf.requirementKey,
        field_name: sf.fieldName,
        field_value: sf.fieldValue,
        is_encrypted: false,
      }, { onConflict: 'compliance_profile_id,requirement_key,field_name' });
    }

    return {
      id: newProfile.id,
      organizationId: newProfile.organization_id,
      endUserType: newProfile.end_user_type,
      countryCode: newProfile.country_code,
      legalName: newProfile.legal_name,
      status: newProfile.status as ComplianceInternalStatus,
      createdBy: newProfile.created_by,
      createdAt: newProfile.created_at,
      updatedAt: newProfile.updated_at,
      snapshots: [
        {
          id: newSnapshot.id,
          complianceProfileId: newSnapshot.compliance_profile_id,
          provider: newSnapshot.provider,
          providerRegulationId: newSnapshot.provider_regulation_id,
          countryCode: newSnapshot.country_code,
          numberType: newSnapshot.number_type,
          endUserType: newSnapshot.end_user_type,
          requirementPayload: newSnapshot.requirement_payload,
          retrievedAt: newSnapshot.retrieved_at,
        },
      ],
      fieldValues: [],
      documents: [],
      reuseState: 'reuse_requires_validation',
    };
  }

  /**
   * Updates dynamic field values for a profile, classifying sensitivity and encrypting sensitive values using AES-256-GCM.
   */
  static async updateFieldValues(
    organizationId: string,
    profileId: string,
    userRole: string,
    params: UpdateFieldValuesParams
  ): Promise<ComplianceProfileWithDetails> {
    this.assertOwnerOrAdmin(userRole);
    const existing = await this.getProfileById(organizationId, profileId, userRole);
    if (!existing) {
      throw new Error('Compliance profile not found for organization.');
    }
    const primarySnapshot = existing.snapshots[0];
    const payload = primarySnapshot?.requirementPayload || {};
    const snapshotReqs = payload.endUserRequirements || [];
    const allowedFieldKeys: string[] = snapshotReqs.map((r: any) => r.fieldKey).filter(Boolean);

    const supabase = createAdminClient() as any;

    // Merge incoming field values with system-derived fields (browser override protection)
    const systemFields = this.deriveSystemFieldsForProfile(payload, existing.endUserType);
    const targetFieldValues = [...(params.fieldValues || [])];

    for (const sf of systemFields) {
      const existingIdx = targetFieldValues.findIndex((fv) => fv.fieldName === sf.fieldName);
      if (existingIdx >= 0) {
        targetFieldValues[existingIdx] = {
          requirementKey: sf.requirementKey,
          fieldName: sf.fieldName,
          fieldValue: sf.fieldValue,
        };
      } else {
        targetFieldValues.push({
          requirementKey: sf.requirementKey,
          fieldName: sf.fieldName,
          fieldValue: sf.fieldValue,
        });
      }
    }

    // Process field values with classification and encryption
    for (const fv of targetFieldValues) {
      const reqKey = (fv.requirementKey || '').trim();
      const fieldName = (fv.fieldName || '').trim();
      const rawVal = (fv.fieldValue || '').trim();

      if (!reqKey || !fieldName) {
        throw new Error('requirementKey and fieldName are required.');
      }

      // Perform strict whitelisting: ONLY actual writable expanded provider field keys belonging to current snapshot are allowed
      if (allowedFieldKeys.length > 0) {
        if (!allowedFieldKeys.includes(fieldName)) {
          throw new Error(`UNALLOWED_KEY: Field requirement key '${fieldName}' is not whitelisted by provider regulations.`);
        }
      } else {
        // No-regulation context (or snapshot with 0 field requirements): no writable fields are authorized
        throw new Error(`UNALLOWED_KEY: Field requirement key '${fieldName}' is not whitelisted by provider regulations.`);
      }

      // Perform provider finite enum validation if options are defined for this field
      const matchingReq = snapshotReqs.find((r: any) => r.fieldKey === fieldName);
      if (matchingReq && Array.isArray(matchingReq.options) && matchingReq.options.length > 0) {
        const allowedValues = matchingReq.options.map((o: any) => o.value);
        if (!allowedValues.includes(rawVal)) {
          throw new Error(`INVALID_ENUM_VALUE: Value '${rawVal}' is not valid for field '${fieldName}'. Allowed values: ${allowedValues.join(', ')}`);
        }
      }

      const sensitivity = ComplianceEncryptionService.classifySensitivity(reqKey, fieldName);

      let isEncrypted = false;
      let dbValue = rawVal;
      let ivHex: string | null = null;
      let authTagHex: string | null = null;
      let encVersion: string | null = null;

      if (sensitivity === 'sensitive' || sensitivity === 'high_sensitivity') {
        const encrypted = ComplianceEncryptionService.encryptValue(rawVal);
        isEncrypted = true;
        dbValue = encrypted.ciphertext;
        ivHex = encrypted.iv;
        authTagHex = encrypted.authTag;
        encVersion = encrypted.version;
      }

      const upsertRecord = {
        compliance_profile_id: profileId,
        requirement_key: reqKey,
        field_name: fieldName,
        field_value: dbValue,
        is_encrypted: isEncrypted,
        encryption_version: encVersion,
        iv: ivHex,
        auth_tag: authTagHex,
      };

      const { error: fErr } = await supabase
        .from('compliance_field_values')
        .upsert(upsertRecord, { onConflict: 'compliance_profile_id,requirement_key,field_name' });

      if (fErr) {
        console.error('[ComplianceProfileService] Error upserting field value:', fErr);
        throw new Error(`Failed to save compliance field value: ${fErr.message}`);
      }
    }

    // Re-fetch profile and evaluate status transition based on factual completeness
    await this.evaluateProfileStatus(organizationId, profileId, userRole);
    const updatedProfile = await this.getProfileById(organizationId, profileId, userRole);
    if (!updatedProfile) {
      throw new Error('Failed to retrieve updated profile.');
    }

    return updatedProfile;
  }

  /**
   * Evaluates dynamic completeness of profile fields and supporting documents.
   * Transitions status to 'ready_for_submission' when all required fields and documents are satisfied.
   */
  static async evaluateProfileStatus(
    organizationId: string,
    profileId: string,
    userRole: string
  ): Promise<ComplianceInternalStatus> {
    const profile = await this.getProfileById(organizationId, profileId, userRole);
    if (!profile) return 'draft';

    const reqSnapshot = profile.snapshots[0];
    const snapshotPayload = reqSnapshot?.requirementPayload || {};

    const requiredEndUserFields: string[] = (snapshotPayload.endUserRequirements || [])
      .filter((r: any) => r.required !== false)
      .map((r: any) => r.fieldKey || r.type);

    const requiredDocReqs: string[] = (snapshotPayload.supportingDocumentRequirements || [])
      .filter((d: any) => d.fileEvidenceRequired !== false)
      .map((d: any) => d.requirementKey || d.type);

    const savedFieldKeys = new Set(profile.fieldValues.map((fv) => fv.fieldName));
    const validUploadedDocKeys = new Set(
      (profile.documents || [])
        .filter(
          (doc) =>
            doc.complianceProfileId === profileId &&
            doc.organizationId === organizationId &&
            Boolean(doc.storageObjectPath)
        )
        .map((doc) => doc.requirementKey)
    );

    const allFieldsComplete = requiredEndUserFields.every(
      (k) => savedFieldKeys.has(k) || profile.fieldValues.some((fv) => fv.requirementKey === k)
    );
    const allDocsComplete = requiredDocReqs.every((k) => validUploadedDocKeys.has(k));

    let newStatus: ComplianceInternalStatus = 'draft';
    if (
      (requiredEndUserFields.length === 0 || allFieldsComplete) &&
      (requiredDocReqs.length === 0 || allDocsComplete)
    ) {
      newStatus = 'ready_for_submission';
    } else if (profile.fieldValues.length > 0 || (profile.documents && profile.documents.length > 0)) {
      newStatus = 'information_required';
    }

    if (newStatus !== profile.status) {
      const supabase = createAdminClient() as any;
      await supabase
        .from('organization_compliance_profiles')
        .update({ status: newStatus })
        .eq('id', profileId);

      profile.status = newStatus;
    }

    return newStatus;
  }

  /**
   * Server-authoritative 5-Tier Compliance Reuse Evaluation Engine.
   * Evaluates legal identity selection (Tier A), field compatibility (Tier B), document eligibility (Tier C),
   * provider resource mappings (Tier D), and full provider approval reuse (Tier E).
   * Ensures OLD snapshots, OLD Regulation SIDs, and non-approved provider statuses FAIL CLOSED.
   */
  static async evaluateOrganizationReuseState(
    organizationId: string,
    countryCode: string,
    numberType: string,
    endUserType: 'business' | 'individual',
    livePreCheck: any,
    userRole: string = 'admin'
  ): Promise<{
    hasApprovedReuse: boolean;
    reusableProfileId: string | null;
    reusableBundleSid: string | null;
    reuseState: 'fully_reusable' | 'partially_reusable' | 'reuse_requires_validation' | 'incompatible';
    tierA_identityReusable: boolean;
    tierB_fieldsReusable: boolean;
    tierC_documentsReusable: boolean;
    tierD_resourcesReusable: boolean;
    tierE_approvalReusable: boolean;
    reasons: string[];
  }> {
    const reasons: string[] = [];

    // 1. Fetch organization profiles
    const profiles = await this.getOrganizationProfiles(organizationId, userRole);
    if (!profiles || profiles.length === 0) {
      return {
        hasApprovedReuse: false,
        reusableProfileId: null,
        reusableBundleSid: null,
        reuseState: 'incompatible',
        tierA_identityReusable: false,
        tierB_fieldsReusable: false,
        tierC_documentsReusable: false,
        tierD_resourcesReusable: false,
        tierE_approvalReusable: false,
        reasons: ['No existing compliance profiles found for organization.'],
      };
    }

    // 2. Filter profiles matching endUserType (Tier A identity evaluation)
    const matchingProfiles = profiles.filter((p) => p.endUserType === endUserType);
    if (matchingProfiles.length === 0) {
      return {
        hasApprovedReuse: false,
        reusableProfileId: null,
        reusableBundleSid: null,
        reuseState: 'incompatible',
        tierA_identityReusable: false,
        tierB_fieldsReusable: false,
        tierC_documentsReusable: false,
        tierD_resourcesReusable: false,
        tierE_approvalReusable: false,
        reasons: [`No existing profiles found matching end-user category '${endUserType}'.`],
      };
    }

    const supabase = createAdminClient() as any;

    // 3. Evaluate each profile for Tier E Approval Reuse & lower tiers
    for (const profile of matchingProfiles) {
      const primarySnapshot = profile.snapshots[0];
      
      // Tier A: Identity selection is valid for this profile
      const tierA = Boolean(profile.legalName && profile.organizationId === organizationId);

      // Check snapshot staleness against livePreCheck
      const snapshotStatus = ComplianceFingerprintService.classifySnapshotStatus(primarySnapshot || null, livePreCheck);
      const is5DimMatch = primarySnapshot
        ? ComplianceFingerprintService.validate5DimensionKey(primarySnapshot, {
            provider: 'twilio',
            countryCode,
            numberType,
            endUserType,
            regulationId: livePreCheck?.regulationId,
          })
        : false;

      // Tier B: Field completeness against live precheck requirements
      const requiredFields: any[] = livePreCheck?.endUserRequirements || livePreCheck?.requirementsPayload?.endUserRequirements || [];
      const requiredFieldKeys = requiredFields.filter((r: any) => r.required !== false).map((r: any) => r.fieldKey);
      const savedFieldKeys = new Set(profile.fieldValues.map((fv) => fv.fieldName));
      const tierB = requiredFieldKeys.every((k) => savedFieldKeys.has(k));

      // Tier C: Document completeness against live precheck requirements
      const requiredDocs: any[] = livePreCheck?.supportingDocumentRequirements || livePreCheck?.requirementsPayload?.supportingDocumentRequirements || [];
      const requiredDocKeys = requiredDocs.filter((d: any) => d.fileEvidenceRequired !== false).map((d: any) => d.requirementKey);
      const validDocKeys = new Set((profile.documents || []).filter((d: any) => d.status === 'verified' || Boolean(d.storageObjectPath)).map((d: any) => d.requirementKey));
      const tierC = requiredDocKeys.every((k) => validDocKeys.has(k));

      // Query provider compliance operations for this profile
      const { data: operations } = await supabase
        .from('provider_compliance_operations')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('compliance_profile_id', profile.id)
        .order('created_at', { ascending: false });

      const approvedOp = (operations || []).find((op: any) => {
        const status = (op.status || '').toLowerCase();
        const payloadStatus = (op.payload?.status || op.payload?.bundleStatus || '').toLowerCase();
        const isApproved = status === 'approved' || status === 'succeeded' || payloadStatus === 'approved';
        return isApproved && Boolean(op.provider_resource_id || op.payload?.bundleSid);
      });

      const tierD = Boolean(approvedOp || (operations && operations.length > 0));

      // Tier E: Requires FULL provider approval, exact 5-dimension key match, AND snapshot status == CURRENT
      const tierEInitial = Boolean(tierA && tierB && tierC && tierD && approvedOp && is5DimMatch && snapshotStatus === 'CURRENT');

      if (tierEInitial && approvedOp) {
        const bundleSid = approvedOp.provider_resource_id || approvedOp.payload?.bundleSid || null;
        if (!bundleSid) continue;

        // Synchronous Live Provider Bundle Status Check (FAIL CLOSED if unreachable/non-approved)
        let liveBundleApproved = false;
        try {
          const adapter = new TwilioProviderComplianceAdapter();
          const liveRes = await adapter.getResourceStatus('bundle', bundleSid);
          const liveStatus = (liveRes?.status || '').toLowerCase();
          liveBundleApproved = liveStatus === 'approved' || liveStatus === 'succeeded';
        } catch (err: any) {
          console.warn(`[ComplianceProfileService] Live bundle status check failed for ${bundleSid}:`, err.message || err);
          liveBundleApproved = false; // FAIL CLOSED
        }

        if (liveBundleApproved) {
          return {
            hasApprovedReuse: true,
            reusableProfileId: profile.id,
            reusableBundleSid: bundleSid,
            reuseState: 'fully_reusable',
            tierA_identityReusable: true,
            tierB_fieldsReusable: true,
            tierC_documentsReusable: true,
            tierD_resourcesReusable: true,
            tierE_approvalReusable: true,
            reasons: ['Profile satisfies 5-dimension key, canonical requirement fingerprint, and live confirmed approved provider bundle status.'],
          };
        }
      }
    }

    // No fully approved Tier E profile found, but return best partial evaluation for UX
    const bestProfile = matchingProfiles[0];
    return {
      hasApprovedReuse: false,
      reusableProfileId: bestProfile.id,
      reusableBundleSid: null,
      reuseState: 'reuse_requires_validation',
      tierA_identityReusable: true,
      tierB_fieldsReusable: false,
      tierC_documentsReusable: false,
      tierD_resourcesReusable: false,
      tierE_approvalReusable: false,
      reasons: ['No existing profile satisfies current 5-dimension provider regulation and live approval requirements.'],
    };
  }
}
