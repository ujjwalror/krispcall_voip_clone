import 'server-only';
import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  CanonicalNumberType,
  ComplianceRequirementSnapshot,
  DiscoverRequirementsParams,
  DiscoveredRequirementResult,
  SubjectType,
} from './types';
import { TwilioComplianceAdapter } from './adapters/twilioComplianceAdapter';

export class RequirementDiscoveryService {
  /**
   * Computes a deterministic SHA-256 fingerprint for canonicalized regulatory requirements.
   */
  public static computeRequirementFingerprint(payload: Record<string, any>): string {
    const sortKeys = (obj: any): any => {
      if (obj === null || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(sortKeys);
      return Object.keys(obj)
        .sort()
        .reduce((acc: any, key: string) => {
          acc[key] = sortKeys(obj[key]);
          return acc;
        }, {});
    };
    const sortedJson = JSON.stringify(sortKeys(payload));
    return crypto.createHash('sha256').update(sortedJson).digest('hex');
  }

  /**
   * Alias for computeRequirementFingerprint.
   */
  public static computeFingerprint(payload: Record<string, any>): string {
    return this.computeRequirementFingerprint(payload);
  }

  /**
   * Discovers factual provider regulations dynamically.
   * NEVER hardcodes country-to-document requirements.
   * NEVER maps provider outages, timeouts, or 5xx errors to NOT_REQUIRED.
   */
  static async discoverRequirements(
    params: DiscoverRequirementsParams,
    providerAdapterOrDb?: any,
    clientOverride?: any
  ): Promise<{
    snapshotId: string;
    provider: string;
    countryCode: string;
    numberType: CanonicalNumberType;
    subjectType: SubjectType;
    requirementsRequired: boolean;
    regulationId: string | null;
    fingerprint: string;
    result: DiscoveredRequirementResult;
    snapshot: ComplianceRequirementSnapshot;
    isNewSnapshot: boolean;
  }> {
    let adapter: any;
    let supabase: any;

    if (providerAdapterOrDb && (typeof providerAdapterOrDb.queryRegulations === 'function' || typeof providerAdapterOrDb.discoverRequirements === 'function')) {
      adapter = providerAdapterOrDb;
      supabase = clientOverride || createAdminClient();
    } else if (providerAdapterOrDb && typeof providerAdapterOrDb.from === 'function') {
      supabase = providerAdapterOrDb;
      adapter = clientOverride && (typeof clientOverride.queryRegulations === 'function' || typeof clientOverride.discoverRequirements === 'function')
        ? clientOverride
        : new TwilioComplianceAdapter();
    } else {
      supabase = clientOverride || createAdminClient();
      adapter = new TwilioComplianceAdapter();
    }

    const cc = (params.countryCode || '').toUpperCase().trim();

    if (!cc || !params.numberType || !params.subjectType) {
      throw new Error('VALIDATION_ERROR: countryCode, numberType, and subjectType are required.');
    }

    const allowedNumberTypes = ['local', 'mobile', 'toll_free', 'national'];
    if (!allowedNumberTypes.includes(params.numberType)) {
      throw new Error(`VALIDATION_ERROR: Invalid number type '${params.numberType}'.`);
    }

    // 1. Query live or mock provider adapter dynamically
    let discovered: DiscoveredRequirementResult;
    try {
      const queryFn = adapter.queryRegulations || adapter.discoverRequirements;
      discovered = await queryFn.call(adapter, {
        countryCode: cc,
        numberType: params.numberType,
        endUserType: params.subjectType,
      });
    } catch (err: any) {
      // Invariant Task 19: Provider failure MUST NEVER become NOT_REQUIRED
      throw new Error(`REGULATORY_DISCOVERY_OUTAGE: Provider regulation query failed (${err.message}). Operation must fail closed.`);
    }

    if (!discovered || typeof discovered !== 'object' || discovered.bundleRequired === undefined) {
      throw new Error('REGULATORY_DISCOVERY_ERROR: Provider returned empty or malformed regulation response.');
    }

    // Ensure fingerprint is calculated deterministically
    const fingerprintPayload = {
      provider: params.provider,
      providerRegulationId: discovered.providerRegulationId,
      countryCode: cc,
      numberType: params.numberType,
      endUserType: params.subjectType,
      bundleRequired: discovered.bundleRequired,
      addressRequirement: discovered.addressRequirement,
      requiredEndUserFields: discovered.requiredEndUserFields,
      requiredDocumentTypes: discovered.requiredDocumentTypes,
    };
    const fingerprint = this.computeRequirementFingerprint(fingerprintPayload);
    discovered.fingerprint = fingerprint;

    // 2. Snapshot Persistence & Immutability Check (Task 3 & 29)
    // Check if an existing snapshot with the identical fingerprint exists
    const { data: existingSnapshot } = await (supabase as any)
      .from('compliance_requirement_snapshots')
      .select('*')
      .eq('country_code', cc)
      .eq('number_type', params.numberType)
      .eq('end_user_type', params.subjectType)
      .eq('fingerprint', fingerprint)
      .order('retrieved_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingSnapshot) {
      const snap = this.mapRowToSnapshot(existingSnapshot);
      return {
        snapshotId: snap.id,
        provider: params.provider,
        countryCode: cc,
        numberType: params.numberType,
        subjectType: params.subjectType,
        requirementsRequired: discovered.bundleRequired,
        regulationId: discovered.providerRegulationId,
        fingerprint: snap.fingerprint || fingerprint || '',
        result: discovered,
        snapshot: snap,
        isNewSnapshot: false,
      };
    }

    // If requirements changed or first observation, insert a NEW immutable snapshot (never mutate old)
    const { data: newSnapshotRow, error: insErr } = await (supabase as any)
      .from('compliance_requirement_snapshots')
      .insert({
        provider: params.provider,
        provider_regulation_id: discovered.providerRegulationId,
        country_code: cc,
        number_type: params.numberType,
        canonical_number_type: params.numberType,
        end_user_type: params.subjectType,
        requirement_payload: fingerprintPayload,
        constraints_payload: discovered.rawProviderMetadata || {},
        fingerprint,
        retrieved_at: new Date().toISOString(),
      })
      .select('*')
      .single();

    if (insErr || !newSnapshotRow) {
      throw new Error(`DATABASE_ERROR: Failed to persist requirement snapshot: ${insErr?.message}`);
    }

    const snap = this.mapRowToSnapshot(newSnapshotRow);
    return {
      snapshotId: snap.id,
      provider: params.provider,
      countryCode: cc,
      numberType: params.numberType,
      subjectType: params.subjectType,
      requirementsRequired: discovered.bundleRequired,
      regulationId: discovered.providerRegulationId,
      fingerprint: snap.fingerprint || fingerprint || '',
      result: discovered,
      snapshot: snap,
      isNewSnapshot: true,
    };
  }

  /**
   * Saves a new immutable snapshot explicitly.
   */
  static async saveSnapshot(
    params: {
      provider: string;
      countryCode: string;
      numberType: CanonicalNumberType;
      subjectType: SubjectType;
      requirementPayload: Record<string, any>;
      constraintsPayload?: Record<string, any>;
    },
    dbClient?: any
  ): Promise<ComplianceRequirementSnapshot> {
    const supabase = dbClient || createAdminClient();
    const fingerprint = this.computeRequirementFingerprint({
      provider: params.provider,
      countryCode: params.countryCode.toUpperCase(),
      numberType: params.numberType,
      subjectType: params.subjectType,
      requirementPayload: params.requirementPayload,
      constraintsPayload: params.constraintsPayload || {},
    });

    const { data: row, error } = await (supabase as any)
      .from('compliance_requirement_snapshots')
      .insert({
        provider: params.provider,
        country_code: params.countryCode.toUpperCase(),
        number_type: params.numberType,
        canonical_number_type: params.numberType,
        end_user_type: params.subjectType,
        requirement_payload: params.requirementPayload,
        constraints_payload: params.constraintsPayload || {},
        fingerprint,
        retrieved_at: new Date().toISOString(),
      })
      .select('*')
      .single();

    if (error || !row) {
      throw new Error(`Failed to save requirement snapshot: ${error?.message}`);
    }

    return this.mapRowToSnapshot(row);
  }

  /**
   * Caches regulatory requirements in regulatory_metadata_cache.
   */
  static async cacheRequirements(
    countryCode: string,
    numberType: CanonicalNumberType,
    subjectType: SubjectType,
    data: Record<string, any>,
    ttlSeconds: number,
    dbClient?: any
  ): Promise<void> {
    const supabase = dbClient || createAdminClient();
    const cc = countryCode.toUpperCase();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const fingerprint = this.computeRequirementFingerprint(data);

    const { data: existing } = await (supabase as any)
      .from('regulatory_metadata_cache')
      .select('id')
      .eq('country_code', cc)
      .eq('number_type', numberType)
      .eq('end_user_type', subjectType)
      .maybeSingle();

    if (existing) {
      await (supabase as any)
        .from('regulatory_metadata_cache')
        .update({
          status: 'requirements_found',
          bundle_required: true,
          provider_metadata: data,
          fingerprint,
          fetched_at: new Date().toISOString(),
          expires_at: expiresAt,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
    } else {
      await (supabase as any)
        .from('regulatory_metadata_cache')
        .insert({
          provider: 'twilio',
          provider_account_id: 'default',
          country_code: cc,
          number_type: numberType,
          end_user_type: subjectType,
          status: 'requirements_found',
          bundle_required: true,
          provider_metadata: data,
          fingerprint,
          fetched_at: new Date().toISOString(),
          expires_at: expiresAt,
          updated_at: new Date().toISOString(),
        });
    }
  }

  /**
   * Retrieves fresh cached requirements if within TTL, else returns null.
   */
  static async getCachedRequirements(
    countryCode: string,
    numberType: CanonicalNumberType,
    subjectType: SubjectType,
    dbClient?: any
  ): Promise<Record<string, any> | null> {
    const supabase = dbClient || createAdminClient();
    const { data: row } = await (supabase as any)
      .from('regulatory_metadata_cache')
      .select('*')
      .eq('country_code', countryCode.toUpperCase())
      .eq('number_type', numberType)
      .eq('end_user_type', subjectType)
      .maybeSingle();

    if (!row) return null;

    if (new Date(row.expires_at) <= new Date()) {
      return null; // Expired cache fails closed (Task 5, 52, 53)
    }

    return row.provider_metadata || row;
  }

  /**
   * Fetches the latest requirement snapshot for a given context.
   */
  static async getLatestSnapshot(
    countryCode: string,
    numberType: CanonicalNumberType,
    subjectType: SubjectType,
    dbClient?: any
  ): Promise<ComplianceRequirementSnapshot | null> {
    const supabase = dbClient || createAdminClient();
    const { data: row } = await (supabase as any)
      .from('compliance_requirement_snapshots')
      .select('*')
      .eq('country_code', countryCode.toUpperCase())
      .eq('number_type', numberType)
      .eq('end_user_type', subjectType)
      .order('retrieved_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return row ? this.mapRowToSnapshot(row) : null;
  }

  private static mapRowToSnapshot(row: any): ComplianceRequirementSnapshot {
    return {
      id: row.id,
      complianceProfileId: row.compliance_profile_id,
      provider: row.provider,
      providerRegulationId: row.provider_regulation_id,
      countryCode: row.country_code,
      numberType: row.number_type,
      canonicalNumberType: row.canonical_number_type,
      endUserType: row.end_user_type,
      requirementPayload: row.requirement_payload || {},
      constraintsPayload: row.constraints_payload || {},
      retrievedAt: row.retrieved_at,
      fingerprint: row.fingerprint,
    };
  }
}
