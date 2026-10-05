import 'server-only';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { NormalizedRegulatoryPreCheckResult } from '../marketplace/regulatoryPreCheckService';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';

function getServiceSupabase() {
  if (!supabaseUrl || !supabaseServiceKey) {
    return null;
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

export interface CacheLookupParams {
  countryCode: string;
  numberType: string;
  endUserType: 'business' | 'individual';
  provider?: string;
  providerAccountId?: string;
}

export interface CacheEvalOptions {
  bypassCache?: boolean;
  cachePolicy?: 'use_cache' | 'bypass' | 'refresh';
}

export interface RegulatoryCacheRecord {
  id?: string;
  provider: string;
  provider_account_id: string;
  country_code: string;
  number_type: string;
  end_user_type: string;
  status: string;
  regulation_id: string | null;
  address_requirement: string | null;
  end_user_requirements: any;
  supporting_document_requirements: any;
  bundle_required: boolean;
  message: string | null;
  provider_metadata: any;
  fingerprint: string;
  fetched_at: string;
  expires_at: string;
  refresh_lock_until?: string | null;
}

/**
 * Computes a deterministic SHA-256 fingerprint for canonicalized regulatory requirements metadata.
 */
export function computeRegulatoryFingerprint(result: NormalizedRegulatoryPreCheckResult): string {
  const canonicalObject = {
    status: result.status,
    regulationId: result.regulationId || null,
    addressRequirement: result.addressRequirement || null,
    bundleRequired: Boolean(result.bundleRequired),
    endUserRequirements: (result.endUserRequirements || []).map((req) => ({
      fieldKey: req.fieldKey,
      required: Boolean(req.required),
      inputType: req.inputType,
      options: req.options || null,
    })),
    supportingDocumentRequirements: (result.supportingDocumentRequirements || []).map((doc) => ({
      requirementKey: doc.requirementKey,
      fileEvidenceRequired: Boolean(doc.fileEvidenceRequired),
      acceptedDocuments: (doc.acceptedDocuments || []).map((ad) => ({ type: ad.type, name: ad.name })),
    })),
  };

  const jsonStr = JSON.stringify(canonicalObject);
  return crypto.createHash('sha256').update(jsonStr).digest('hex');
}

/**
 * Server-side TTL configuration in hours.
 * Default: 24 hours (86,400 seconds).
 * Reasoning: Provider regulatory schema definitions (End-User fields and Document evidence) are updated infrequently
 * by telecom regulators (typically on weekly/monthly cadences). A conservative 24-hour TTL maximizes UI performance
 * and protects against provider rate limits during public-SaaS browsing while ensuring daily metadata freshness.
 */
export function getRegulatoryCacheTtlSeconds(): number {
  const envTtlHours = process.env.REGULATORY_METADATA_CACHE_TTL_HOURS;
  if (envTtlHours) {
    const parsed = parseInt(envTtlHours, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 720) {
      return parsed * 3600;
    }
  }
  return 24 * 3600; // 24 Hours default
}

// In-memory L1 cache & single-flight promise registry
const l1MemoryCache = new Map<string, RegulatoryCacheRecord>();
const inFlightPromises = new Map<string, Promise<NormalizedRegulatoryPreCheckResult>>();

/**
 * Provider-Neutral Regulatory Metadata Cache Layer.
 * 
 * CORE CONTRACT:
 * - Cache accelerates browsing display.
 * - Cache MUST NEVER authorize a phone-number purchase.
 * - ProvisioningEngine / Purchase Gate forces a live fresh lookup (bypassCache: true).
 */
export class RegulatoryMetadataCacheService {
  /**
   * Generates a isolated provider/account/country/type cache key.
   */
  static generateCacheKey(params: CacheLookupParams): string {
    const provider = (params.provider || 'twilio').toLowerCase();
    const account = (params.providerAccountId || 'default').trim();
    const cc = (params.countryCode || 'US').toUpperCase();
    const type = (params.numberType || 'local').toLowerCase();
    const userType = (params.endUserType || 'business').toLowerCase();
    return `${provider}:${account}:${cc}:${type}:${userType}`;
  }

  /**
   * Evaluates or retrieves regulatory requirements, utilizing cache for browsing while allowing
   * explicit bypass for buy-time fresh validation.
   */
  static async getOrFetchRequirements(
    params: CacheLookupParams,
    options: CacheEvalOptions | undefined,
    liveFetcher: () => Promise<NormalizedRegulatoryPreCheckResult>
  ): Promise<NormalizedRegulatoryPreCheckResult> {
    const cacheKey = this.generateCacheKey(params);
    const shouldBypass = options?.bypassCache === true || options?.cachePolicy === 'bypass';

    if (shouldBypass) {
      const startTime = Date.now();
      console.log(`[RegulatoryMetadataCacheService] OBSERVABILITY purchase_fresh_validation key=${cacheKey}`);
      
      const freshResult = await liveFetcher();
      const elapsed = Date.now() - startTime;
      console.log(`[RegulatoryMetadataCacheService] OBSERVABILITY provider_latency_ms=${elapsed} key=${cacheKey}`);

      if (freshResult.status !== 'unavailable' && freshResult.status !== 'error') {
        // Asynchronously update/refresh the cache entry with fresh provider result
        this.updateCacheRecord(params, freshResult).catch((err) => {
          console.warn(`[RegulatoryMetadataCacheService] Background cache update failed for ${cacheKey}:`, err.message || err);
        });
      }
      return freshResult;
    }

    // Browsing flow: Single-flight check within local Node process
    const existingInFlight = inFlightPromises.get(cacheKey);
    if (existingInFlight) {
      console.log(`[RegulatoryMetadataCacheService] Single-flight coalesced concurrent miss for key=${cacheKey}`);
      return existingInFlight;
    }

    const fetchPromise = (async () => {
      try {
        const cacheLookupStart = Date.now();
        const cachedRecord = await this.readCacheRecord(params);
        const cacheLookupDurationMs = Date.now() - cacheLookupStart;

        const now = new Date();

        if (cachedRecord && new Date(cachedRecord.expires_at) > now) {
          console.log(
            `[RegulatoryMetadataCacheService] OBSERVABILITY cache_hit key=${cacheKey} duration_ms=${cacheLookupDurationMs}`
          );
          return this.denormalizeCacheRecord(cachedRecord, params);
        }

        if (cachedRecord) {
          console.log(`[RegulatoryMetadataCacheService] OBSERVABILITY cache_expired key=${cacheKey}`);
        } else {
          console.log(`[RegulatoryMetadataCacheService] OBSERVABILITY cache_miss key=${cacheKey}`);
        }

        // Cache Miss or Expired -> Query live provider
        const providerStart = Date.now();
        const freshResult = await liveFetcher();
        const providerLookupDurationMs = Date.now() - providerStart;

        console.log(
          `[RegulatoryMetadataCacheService] OBSERVABILITY provider_refresh key=${cacheKey} duration_ms=${providerLookupDurationMs}`
        );

        if (freshResult.status === 'unavailable' || freshResult.status === 'error') {
          console.warn(`[RegulatoryMetadataCacheService] OBSERVABILITY provider_refresh_failed key=${cacheKey}`);
          return freshResult;
        }

        const newFingerprint = computeRegulatoryFingerprint(freshResult);

        if (cachedRecord && cachedRecord.fingerprint && cachedRecord.fingerprint !== newFingerprint) {
          console.log(
            `[RegulatoryMetadataCacheService] OBSERVABILITY regulation_changed key=${cacheKey} old_fp=${cachedRecord.fingerprint} new_fp=${newFingerprint}`
          );
        }

        await this.updateCacheRecord(params, freshResult, newFingerprint);
        return freshResult;
      } finally {
        inFlightPromises.delete(cacheKey);
      }
    })();

    inFlightPromises.set(cacheKey, fetchPromise);
    return fetchPromise;
  }

  /**
   * Reads cached record from L1 memory or Supabase Postgres L2.
   */
  private static async readCacheRecord(params: CacheLookupParams): Promise<RegulatoryCacheRecord | null> {
    const cacheKey = this.generateCacheKey(params);
    const memoryRecord = l1MemoryCache.get(cacheKey);
    if (memoryRecord) {
      return memoryRecord;
    }

    const supabase = getServiceSupabase();
    if (!supabase) return null;

    try {
      const provider = (params.provider || 'twilio').toLowerCase();
      const account = (params.providerAccountId || 'default').trim();
      const cc = (params.countryCode || 'US').toUpperCase();
      const type = (params.numberType || 'local').toLowerCase();
      const userType = (params.endUserType || 'business').toLowerCase();

      const { data, error } = await supabase
        .from('regulatory_metadata_cache')
        .select('*')
        .eq('provider', provider)
        .eq('provider_account_id', account)
        .eq('country_code', cc)
        .eq('number_type', type)
        .eq('end_user_type', userType)
        .maybeSingle();

      if (error) {
        console.warn(`[RegulatoryMetadataCacheService] DB read warning:`, error.message);
        return null;
      }
      if (data) {
        l1MemoryCache.set(cacheKey, data as RegulatoryCacheRecord);
        return data as RegulatoryCacheRecord;
      }
      return null;
    } catch (e: any) {
      console.warn(`[RegulatoryMetadataCacheService] DB read exception:`, e.message || e);
      return null;
    }
  }

  /**
   * Updates or inserts cached record in L1 memory & Supabase Postgres L2.
   */
  public static async updateCacheRecord(
    params: CacheLookupParams,
    result: NormalizedRegulatoryPreCheckResult,
    fingerprintOverride?: string
  ): Promise<void> {
    const cacheKey = this.generateCacheKey(params);
    const provider = (params.provider || 'twilio').toLowerCase();
    const account = (params.providerAccountId || 'default').trim();
    const cc = (params.countryCode || 'US').toUpperCase();
    const type = (params.numberType || 'local').toLowerCase();
    const userType = (params.endUserType || 'business').toLowerCase();

    const ttlSeconds = getRegulatoryCacheTtlSeconds();
    const fetchedAt = new Date();
    const expiresAt = new Date(fetchedAt.getTime() + ttlSeconds * 1000);
    const fingerprint = fingerprintOverride || computeRegulatoryFingerprint(result);

    const recordPayload: RegulatoryCacheRecord = {
      provider,
      provider_account_id: account,
      country_code: cc,
      number_type: type,
      end_user_type: userType,
      status: result.status,
      regulation_id: result.regulationId || null,
      address_requirement: result.addressRequirement || null,
      end_user_requirements: result.endUserRequirements || [],
      supporting_document_requirements: result.supportingDocumentRequirements || [],
      bundle_required: Boolean(result.bundleRequired),
      message: result.message || null,
      provider_metadata: result.providerMetadata || {},
      fingerprint,
      fetched_at: fetchedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    };

    l1MemoryCache.set(cacheKey, recordPayload);

    const supabase = getServiceSupabase();
    if (!supabase) return;

    try {
      const { error } = await supabase.from('regulatory_metadata_cache').upsert(recordPayload, {
        onConflict: 'provider,provider_account_id,country_code,number_type,end_user_type',
      });

      if (error) {
        console.warn(`[RegulatoryMetadataCacheService] DB upsert warning:`, error.message);
      }
    } catch (e: any) {
      console.warn(`[RegulatoryMetadataCacheService] DB upsert exception:`, e.message || e);
    }
  }

  /**
   * Converts cached DB record back to NormalizedRegulatoryPreCheckResult.
   */
  private static denormalizeCacheRecord(
    record: RegulatoryCacheRecord,
    params: CacheLookupParams
  ): NormalizedRegulatoryPreCheckResult {
    return {
      status: record.status as any,
      regulationId: record.regulation_id,
      countryCode: (record.country_code || params.countryCode).toUpperCase(),
      numberType: record.number_type || params.numberType,
      endUserType: (record.end_user_type as any) || params.endUserType,
      addressRequirement: record.address_requirement,
      endUserRequirements: Array.isArray(record.end_user_requirements) ? record.end_user_requirements : [],
      supportingDocumentRequirements: Array.isArray(record.supporting_document_requirements)
        ? record.supporting_document_requirements
        : [],
      bundleRequired: Boolean(record.bundle_required),
      providerMetadata: record.provider_metadata || undefined,
      message: record.message || 'Verification requirements retrieved from regulatory metadata cache.',
    };
  }
}
