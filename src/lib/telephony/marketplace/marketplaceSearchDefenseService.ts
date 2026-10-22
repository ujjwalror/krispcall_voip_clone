import 'server-only';
import crypto from 'crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  InventorySearchQuery,
  InventoryNumberItem,
  ProviderPricingAuditResult,
  TwilioInventoryProvider,
  decodeContinuationToken,
} from './inventoryProvider';

export interface MarketplaceSearchVelocityParams {
  organizationId: string;
  userId: string;
  userLimit?: number; // default: 15
  orgLimit?: number; // default: 60
  windowSeconds?: number; // default: 60
  consume?: boolean; // default: true
}

export interface MarketplaceSearchVelocityResult {
  allowed: boolean;
  limitType?: 'user_search_velocity' | 'org_search_velocity' | 'unauthorized_tenant_membership' | 'limiter_storage_error';
  currentRate?: number;
  limitThreshold?: number;
  retryAfterSeconds: number;
  reason?: string;
}

export interface CachedInventoryData {
  numbers: InventoryNumberItem[];
  hasMore: boolean;
  continuationToken?: string;
  pricingAudit: ProviderPricingAuditResult;
  provider: 'twilio';
  cachedAt: number;
}

interface L1CacheEntry {
  data: CachedInventoryData;
  expiresAt: number;
}

export const MARKETPLACE_SEARCH_CACHE_TTL_MS = 60 * 1000; // 60 seconds
export const DEFAULT_USER_SEARCH_LIMIT = 15; // 15 requests / 60 seconds
export const DEFAULT_ORG_SEARCH_LIMIT = 60; // 60 requests / 60 seconds
export const DEFAULT_WINDOW_SECONDS = 60;

/**
 * Builds a deterministic, canonical cache key for an inventory search query.
 * Normalizes case, trims whitespace, standardizes capability booleans,
 * and incorporates administrative provider scope.
 */
export function buildMarketplaceSearchCacheKey(query: InventorySearchQuery): { cacheKey: string; queryHash: string } {
  const countryCode = (query.countryCode || 'US').toUpperCase().trim();
  const rawType = (query.numberType || 'local').toLowerCase().trim();
  const numberType = ['local', 'mobile', 'toll_free'].includes(rawType) ? rawType : 'local';

  const contains = (query.contains || '').toLowerCase().trim();
  const areaCode = (query.areaCode || '').trim();
  const locality = (query.locality || '').toLowerCase().trim();
  const region = (query.region || '').toLowerCase().trim();
  const postalCode = (query.postalCode || '').toLowerCase().trim();

  const voice = query.voiceEnabled === true ? 'v1' : query.voiceEnabled === false ? 'v0' : 'vX';
  const sms = query.smsEnabled === true ? 's1' : query.smsEnabled === false ? 's0' : 'sX';
  const mms = query.mmsEnabled === true ? 'm1' : query.mmsEnabled === false ? 'm0' : 'mX';

  const limitParam = typeof query.limit === 'number' ? query.limit : 50;
  const limit = Math.min(Math.max(isNaN(limitParam) ? 50 : limitParam, 1), 100);

  // Extract page number from pagination token if supplied
  let pageNumber = 0;
  if (query.pageToken) {
    try {
      pageNumber = decodeContinuationToken(query.pageToken, query);
    } catch {
      // If continuation token is invalid, let provider/route handle rejection;
      // for cache key fallback to raw hash of token
      pageNumber = -1;
    }
  }

  // Authoritative Provider Scope: Twilio AvailablePhoneNumbers uses platform parent admin pool
  const providerScope = 'twilio:platform_admin';

  const canonicalString = [
    `scope=${providerScope}`,
    `cc=${countryCode}`,
    `type=${numberType}`,
    `cnt=${contains}`,
    `ac=${areaCode}`,
    `loc=${locality}`,
    `reg=${region}`,
    `pc=${postalCode}`,
    `caps=${voice}_${sms}_${mms}`,
    `lim=${limit}`,
    `page=${pageNumber}`,
  ].join('|');

  const queryHash = crypto.createHash('sha256').update(canonicalString).digest('hex');
  const cacheKey = `mkt_search:v1:${queryHash}`;

  return { cacheKey, queryHash };
}

/**
 * Validates that cached inventory data strictly minimizes data and contains
 * ZERO credentials, tokens, or tenant-sensitive identifiers.
 */
function sanitizeAndAssertSafeCacheData(data: CachedInventoryData): void {
  const serialized = JSON.stringify(data);
  const sensitivePatterns = [
    /accountSid/i,
    /authToken/i,
    /apiSecret/i,
    /apiKeySecret/i,
    /SK[a-f0-9]{32}/i,
    /AC[a-f0-9]{32}/i,
  ];

  for (const pattern of sensitivePatterns) {
    if (pattern.test(serialized)) {
      throw new Error(`CRITICAL_SECURITY_VIOLATION: Attempted to cache sensitive provider credentials matching ${pattern}`);
    }
  }
}

/**
 * Service: MarketplaceSearchDefenseService
 * Provides authoritative distributed rate limiting (via PostgreSQL)
 * and safe dual-tier caching (L1 in-memory + L2 PostgreSQL) with
 * single-flight stampede protection.
 */
export class MarketplaceSearchDefenseService {
  // L1 In-Memory Cache (Process-Local Fast Tier)
  private static l1Cache: Map<string, L1CacheEntry> = new Map();

  // In-flight request collapse map (Single-Flight Stampede Defense)
  private static inFlightSearches: Map<string, Promise<CachedInventoryData>> = new Map();

  /**
   * Resets the L1 in-memory cache and in-flight map. (Used for testing & cache clearing).
   */
  public static clearL1Cache(): void {
    this.l1Cache.clear();
    this.inFlightSearches.clear();
  }

  public static getL1CacheSize(): number {
    return this.l1Cache.size;
  }

  public static getInFlightCount(): number {
    return this.inFlightSearches.size;
  }

  /**
   * Authoritative Distributed Rate Limiter
   * Calls the PostgreSQL atomic check-and-consume RPC.
   *
   * SECURITY INVARIANT:
   * FAIL CLOSED on database or storage error. If limiter cannot be evaluated,
   * requests MUST NOT proceed to upstream Twilio.
   */
  public static async checkAndConsumeRateLimit(
    params: MarketplaceSearchVelocityParams,
    client?: SupabaseClient | any
  ): Promise<MarketplaceSearchVelocityResult> {
    const {
      organizationId,
      userId,
      userLimit = DEFAULT_USER_SEARCH_LIMIT,
      orgLimit = DEFAULT_ORG_SEARCH_LIMIT,
      windowSeconds = DEFAULT_WINDOW_SECONDS,
      consume = true,
    } = params;

    const dbClient = client || createAdminClient();

    try {
      const { data, error } = await (dbClient as any).rpc(
        'check_and_consume_marketplace_search_velocity',
        {
          p_organization_id: organizationId,
          p_user_id: userId,
          p_user_limit: userLimit,
          p_org_limit: orgLimit,
          p_window_seconds: windowSeconds,
          p_consume: consume,
        }
      );

      if (error) {
        console.error('[MarketplaceSearchDefenseService] Velocity RPC execution error:', error.message || error);
        // FAIL CLOSED: Deny request with retry-after
        return {
          allowed: false,
          limitType: 'limiter_storage_error',
          currentRate: 0,
          limitThreshold: userLimit,
          retryAfterSeconds: 60,
          reason: 'Marketplace search rate limiter temporarily unavailable.',
        };
      }

      if (!data) {
        // Null result fails closed
        return {
          allowed: false,
          limitType: 'limiter_storage_error',
          currentRate: 0,
          limitThreshold: userLimit,
          retryAfterSeconds: 60,
          reason: 'Marketplace search rate limiter returned empty response.',
        };
      }

      return {
        allowed: Boolean(data.allowed),
        limitType: data.limitType,
        currentRate: data.currentRate,
        limitThreshold: data.limitThreshold,
        retryAfterSeconds: typeof data.retryAfterSeconds === 'number' ? data.retryAfterSeconds : 60,
        reason: data.reason,
      };
    } catch (err: any) {
      console.error('[MarketplaceSearchDefenseService] Velocity check exception:', err.message || err);
      // FAIL CLOSED: Do not allow unbounded provider queries
      return {
        allowed: false,
        limitType: 'limiter_storage_error',
        currentRate: 0,
        limitThreshold: userLimit,
        retryAfterSeconds: 60,
        reason: 'Marketplace search rate limiter exception.',
      };
    }
  }

  /**
   * Safe Dual-Tier Cached Search with Single-Flight Stampede Collapse.
   *
   * Flow:
   * 1. Check L1 Memory Cache. If valid hit -> return immediately.
   * 2. Check L2 Database Cache. If valid hit -> warm L1, return.
   * 3. If in-flight single-flight search exists for same key -> await existing promise.
   * 4. If miss -> execute Twilio provider call, update L1 & L2, resolve in-flight promise.
   */
  public static async executeSearchWithCache(options: {
    query: InventorySearchQuery;
    provider?: TwilioInventoryProvider;
    client?: SupabaseClient | any;
    bypassCache?: boolean;
    ttlMs?: number;
  }): Promise<CachedInventoryData> {
    const {
      query,
      provider = new TwilioInventoryProvider(),
      client,
      bypassCache = false,
      ttlMs = MARKETPLACE_SEARCH_CACHE_TTL_MS,
    } = options;

    const { cacheKey, queryHash } = buildMarketplaceSearchCacheKey(query);
    const now = Date.now();

    // 1. Check L1 In-Memory Cache
    if (!bypassCache) {
      const l1Entry = this.l1Cache.get(cacheKey);
      if (l1Entry && l1Entry.expiresAt > now) {
        return l1Entry.data;
      }
      if (l1Entry && l1Entry.expiresAt <= now) {
        this.l1Cache.delete(cacheKey);
      }
    }

    const dbClient = client || createAdminClient();

    // 2. Check L2 PostgreSQL Cache
    if (!bypassCache && dbClient?.from) {
      try {
        const { data: l2Row, error: l2Err } = await (dbClient as any)
          .from('marketplace_inventory_search_cache')
          .select('numbers, has_more, continuation_token, pricing_audit, expires_at')
          .eq('cache_key', cacheKey)
          .gt('expires_at', new Date(now).toISOString())
          .maybeSingle();

        if (!l2Err && l2Row && l2Row.numbers) {
          const cachedData: CachedInventoryData = {
            numbers: (l2Row.numbers as unknown as InventoryNumberItem[]) || [],
            hasMore: Boolean(l2Row.has_more),
            continuationToken: l2Row.continuation_token || undefined,
            pricingAudit: l2Row.pricing_audit || {
              provider: 'twilio',
              countryCode: (query.countryCode || 'US').toUpperCase(),
              currency: 'USD',
              phoneNumberPrices: [],
              note: 'Cached provider pricing',
            },
            provider: 'twilio',
            cachedAt: now,
          };

          // Warm L1 cache
          this.setL1Entry(cacheKey, cachedData, new Date(l2Row.expires_at).getTime());
          return cachedData;
        }
      } catch (err: any) {
        // L2 cache read error is non-fatal: fall through to provider query
        console.warn('[MarketplaceSearchDefenseService] L2 cache read failed (falling back to provider):', err.message || err);
      }
    }

    // 3. Single-Flight Stampede Protection
    if (!bypassCache && this.inFlightSearches.has(cacheKey)) {
      return await this.inFlightSearches.get(cacheKey)!;
    }

    // 4. Cache Miss: Execute Provider Call
    const flightPromise = (async (): Promise<CachedInventoryData> => {
      try {
        const [searchResult, pricingAudit] = await Promise.all([
          provider.searchAvailableNumbers(query),
          provider.auditProviderPricing(query.countryCode || 'US'),
        ]);

        const freshData: CachedInventoryData = {
          numbers: searchResult.numbers || [],
          hasMore: Boolean(searchResult.hasMore),
          continuationToken: searchResult.continuationToken,
          pricingAudit,
          provider: 'twilio',
          cachedAt: Date.now(),
        };

        // Assert data minimization / zero credential safety
        sanitizeAndAssertSafeCacheData(freshData);

        const expiresAtMs = Date.now() + ttlMs;

        // Populate L1 cache
        this.setL1Entry(cacheKey, freshData, expiresAtMs);

        // Populate L2 distributed PostgreSQL cache
        if (dbClient?.from) {
          try {
            await (dbClient as any)
              .from('marketplace_inventory_search_cache')
              .upsert(
                {
                  cache_key: cacheKey,
                  query_hash: queryHash,
                  numbers: freshData.numbers as any,
                  has_more: freshData.hasMore,
                  continuation_token: freshData.continuationToken || null,
                  pricing_audit: freshData.pricingAudit as any,
                  fetched_at: new Date(freshData.cachedAt).toISOString(),
                  expires_at: new Date(expiresAtMs).toISOString(),
                },
                { onConflict: 'cache_key' }
              );
          } catch (upsertErr: any) {
            console.warn('[MarketplaceSearchDefenseService] L2 cache write failed:', upsertErr.message || upsertErr);
          }
        }

        return freshData;
      } finally {
        this.inFlightSearches.delete(cacheKey);
      }
    })();

    if (!bypassCache) {
      this.inFlightSearches.set(cacheKey, flightPromise);
    }

    return await flightPromise;
  }

  private static setL1Entry(cacheKey: string, data: CachedInventoryData, expiresAt: number): void {
    // Evict oldest if cache exceeds 1000 items (simple bounded memory)
    if (this.l1Cache.size >= 1000) {
      const firstKey = this.l1Cache.keys().next().value;
      if (firstKey) this.l1Cache.delete(firstKey);
    }
    this.l1Cache.set(cacheKey, { data, expiresAt });
  }
}
