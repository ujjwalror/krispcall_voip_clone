import 'server-only';
import crypto from 'crypto';
import { ComplianceOperationType } from './types';

export interface FingerprintPayload {
  organizationId: string;
  complianceProfileId: string;
  operationType: ComplianceOperationType;
  entityId?: string | null;
  countryCode: string;
  numberType: string;
  endUserType: string;
  providerRegulationId?: string | null;
  documentMetadataId?: string | null;
  documentSha256?: string | null;
}

/**
 * Allowlisted error categories to prevent raw sensitive payload persistence in DB.
 */
export const ALLOWLISTED_ERROR_CODES: Record<string, string> = {
  PRE_CHECK_FAILED: 'Validation failed before dispatching request to provider.',
  UNAUTHORIZED_ROLE: 'Access denied due to insufficient user privileges.',
  PROVIDER_TIMEOUT: 'Provider request timed out or network connection was lost.',
  PROVIDER_REJECTED: 'Provider API returned an error response.',
  RESOURCE_NOT_FOUND: 'Target provider resource or profile was not found.',
  RECONCILIATION_REQUIRED: 'Operation state is ambiguous and requires provider status reconciliation.',
  CONCURRENT_EXECUTION: 'Operation is currently being executed by another process.',
  INVALID_STATE: 'Operation is not in a valid state for the requested transition.',
};

export class ComplianceFingerprintService {
  /**
   * Generates a deterministic idempotency key for a logical compliance provider operation.
   * Contains strictly non-sensitive internal identifiers.
   */
  static generateIdempotencyKey(
    organizationId: string,
    complianceProfileId: string,
    operationType: ComplianceOperationType,
    entityId?: string | null
  ): string {
    const rawObject = {
      orgId: organizationId,
      profileId: complianceProfileId,
      opType: operationType,
      entity: entityId || 'default',
    };

    const canonicalStr = JSON.stringify(rawObject, Object.keys(rawObject).sort());
    return crypto.createHash('sha256').update(canonicalStr).digest('hex').slice(0, 32);
  }

  /**
   * Generates a canonical SHA-256 fingerprint digest of non-sensitive request identifiers.
   * Uses structured canonical JSON serialization with sorted keys to prevent concatenation collisions.
   */
  static generateRequestFingerprint(payload: FingerprintPayload): string {
    const canonicalObject = {
      country: payload.countryCode.toUpperCase(),
      docId: payload.documentMetadataId || null,
      docSha: payload.documentSha256 || null,
      entity: payload.entityId || null,
      numType: payload.numberType,
      op: payload.operationType,
      org: payload.organizationId,
      profile: payload.complianceProfileId,
      regId: payload.providerRegulationId || null,
      userType: payload.endUserType,
    };

    const canonicalString = JSON.stringify(canonicalObject, Object.keys(canonicalObject).sort());
    return crypto.createHash('sha256').update(canonicalString).digest('hex');
  }

  /**
   * Sanitizes external error messages to prevent sensitive information or raw auth tokens
   * from entering database logs. Returns an allowlisted static summary when possible.
   */
  static sanitizeErrorMessage(errorCode: string, message?: string | null): string {
    const safeSummary = ALLOWLISTED_ERROR_CODES[errorCode];
    if (safeSummary && (!message || message.length > 200)) {
      return safeSummary;
    }

    if (!message) return 'Unknown error occurred';

    return message
      .replace(/(Basic|Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [REDACTED]')
      .replace(/(SK[a-f0-9]{32}|AC[a-f0-9]{32})/gi, '[REDACTED_TWILIO_SID]')
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
      .slice(0, 200);
  }

  /**
   * Generates a canonical SHA-256 fingerprint digest of normalized compliance requirement payload.
   * Deterministic across JSON key ordering, array ordering of fields/enums/docs, and presentation metadata differences.
   * Returns null if payload is null, unparseable, or structurally invalid (fails closed).
   */
  static generateRequirementFingerprint(payload: any): string | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    try {
      const regId = (payload.providerRegulationId || payload.regulationId || payload.id || '').toString().trim();
      const endUserType = (payload.endUserType || payload.end_user_type || '').toString().toLowerCase().trim();

      // Normalize End User Field Requirements
      const rawFieldReqs = payload.endUserRequirements || payload.fieldRequirements || payload.requirements || [];
      const normalizedFields = (Array.isArray(rawFieldReqs) ? rawFieldReqs : [])
        .map((f: any) => {
          const fieldKey = (f.fieldKey || f.key || f.type || '').toString().toLowerCase().trim();
          const required = f.required !== false;
          let options: string[] = [];
          if (Array.isArray(f.options)) {
            options = f.options
              .map((o: any) => (typeof o === 'object' ? o.value || o.id : o).toString().trim())
              .filter(Boolean)
              .sort();
          }
          return { fieldKey, required, options };
        })
        .filter((f: any) => f.fieldKey !== '')
        .sort((a: any, b: any) => a.fieldKey.localeCompare(b.fieldKey));

      // Normalize Supporting Document Requirements
      const rawDocReqs = payload.supportingDocumentRequirements || payload.documentRequirements || payload.documents || [];
      const normalizedDocs = (Array.isArray(rawDocReqs) ? rawDocReqs : [])
        .map((d: any) => {
          const reqKey = (d.requirementKey || d.key || d.type || '').toString().toLowerCase().trim();
          const required = d.fileEvidenceRequired !== false && d.required !== false;
          const acceptedTypes = (Array.isArray(d.acceptedDocumentTypes) ? d.acceptedDocumentTypes : [])
            .map((t: any) => t.toString().trim())
            .filter(Boolean)
            .sort();
          return { reqKey, required, acceptedTypes };
        })
        .filter((d: any) => d.reqKey !== '')
        .sort((a: any, b: any) => a.reqKey.localeCompare(b.reqKey));

      // Address requirement flag
      const addressRequired = Boolean(payload.addressRequired || payload.address_required);

      const canonicalStructure = {
        regId,
        endUserType,
        addressRequired,
        fields: normalizedFields,
        docs: normalizedDocs,
      };

      const canonicalString = JSON.stringify(canonicalStructure);
      return crypto.createHash('sha256').update(canonicalString).digest('hex');
    } catch (err) {
      console.warn('[ComplianceFingerprintService] Failed to generate requirement fingerprint:', err);
      return null;
    }
  }

  /**
   * Classifies requirement snapshot staleness against live provider precheck response.
   * Returns 'CURRENT' | 'STALE' | 'UNKNOWN'.
   */
  static classifySnapshotStatus(
    snapshot: {
      provider?: string | null;
      countryCode?: string | null;
      numberType?: string | null;
      endUserType?: string | null;
      providerRegulationId?: string | null;
      requirementPayload?: any;
    } | null,
    livePrecheck: {
      status?: string | null;
      regulationId?: string | null;
      requirementsPayload?: any;
      countryCode?: string | null;
      numberType?: string | null;
      endUserType?: string | null;
    } | null
  ): 'CURRENT' | 'STALE' | 'UNKNOWN' {
    if (!livePrecheck || livePrecheck.status === 'unavailable' || livePrecheck.status === 'error') {
      return 'UNKNOWN';
    }

    if (!snapshot || !snapshot.requirementPayload) {
      return 'STALE';
    }

    // 1. Check primary dimension matches
    const snapshotRegId = (snapshot.providerRegulationId || snapshot.requirementPayload?.providerRegulationId || '').trim();
    const liveRegId = (livePrecheck.regulationId || livePrecheck.requirementsPayload?.providerRegulationId || '').trim();

    if (snapshotRegId !== '' && liveRegId !== '' && snapshotRegId !== liveRegId) {
      return 'STALE';
    }

    // 2. Check 5-dimension key parameters if present
    if (snapshot.countryCode && livePrecheck.countryCode && snapshot.countryCode.toUpperCase() !== livePrecheck.countryCode.toUpperCase()) {
      return 'STALE';
    }
    if (snapshot.endUserType && livePrecheck.endUserType && snapshot.endUserType.toLowerCase() !== livePrecheck.endUserType.toLowerCase()) {
      return 'STALE';
    }

    // 3. Compute and compare requirement fingerprints
    const snapshotFingerprint = this.generateRequirementFingerprint(snapshot.requirementPayload);
    const liveFingerprint = this.generateRequirementFingerprint(livePrecheck.requirementsPayload || livePrecheck);

    if (!snapshotFingerprint || !liveFingerprint || snapshotFingerprint !== liveFingerprint) {
      return 'STALE';
    }

    return 'CURRENT';
  }

  /**
   * Validates exact 5-Dimension Compatibility Key for Tier E Provider Approval Reuse.
   * Key = (provider, countryCode, normalizedNumberType, endUserType, currentRegulationSid).
   */
  static validate5DimensionKey(
    snapshot: {
      provider: string;
      countryCode: string;
      numberType: string;
      endUserType: string;
      providerRegulationId?: string | null;
    },
    livePrecheck: {
      provider?: string;
      countryCode: string;
      numberType: string;
      endUserType: string;
      regulationId?: string | null;
    }
  ): boolean {
    const providerMatch = (snapshot.provider || 'twilio').toLowerCase() === (livePrecheck.provider || 'twilio').toLowerCase();
    const countryMatch = (snapshot.countryCode || '').toUpperCase() === (livePrecheck.countryCode || '').toUpperCase();
    const numberTypeMatch = (snapshot.numberType || '').toLowerCase() === (livePrecheck.numberType || '').toLowerCase();
    const endUserTypeMatch = (snapshot.endUserType || '').toLowerCase() === (livePrecheck.endUserType || '').toLowerCase();
    
    const snapReg = (snapshot.providerRegulationId || '').trim();
    const liveReg = (livePrecheck.regulationId || '').trim();
    const regMatch = snapReg !== '' && liveReg !== '' && snapReg === liveReg;

    return providerMatch && countryMatch && numberTypeMatch && endUserTypeMatch && regMatch;
  }
}

