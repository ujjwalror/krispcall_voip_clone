import { FreshnessState } from './providers/providerPricingInterface';

export interface FreshnessPolicyConfig {
  /** Ingestion sync interval in hours (provisional default: 12) */
  syncIntervalHours: number;
  /** Soft stale threshold in hours (provisional default: 24) */
  softStaleHours: number;
  /** Hard expiry threshold in hours (provisional default: 48) */
  hardExpiryHours: number;
}

/** Server-side default freshness policy configuration (provisional - calibrated in C.6D.4) */
export const DEFAULT_FRESHNESS_CONFIG: FreshnessPolicyConfig = {
  syncIntervalHours: 12,
  softStaleHours: 24,
  hardExpiryHours: 48,
};

export class FreshnessPolicy {
  /**
   * Calculates soft stale and hard expiry timestamps from fetched_at date using policy config.
   */
  public static calculateTimestamps(
    fetchedAtIso: string,
    configOverrides?: Partial<FreshnessPolicyConfig>
  ): { softStaleAtIso: string; hardExpiresAtIso: string } {
    const config = { ...DEFAULT_FRESHNESS_CONFIG, ...configOverrides };
    const fetchedDate = new Date(fetchedAtIso);
    if (isNaN(fetchedDate.getTime())) {
      throw new Error(`INVALID_FETCHED_AT_DATE: '${fetchedAtIso}' is not a valid ISO date string`);
    }

    const softStaleAt = new Date(fetchedDate.getTime() + config.softStaleHours * 3600 * 1000);
    const hardExpiresAt = new Date(fetchedDate.getTime() + config.hardExpiryHours * 3600 * 1000);

    return {
      softStaleAtIso: softStaleAt.toISOString(),
      hardExpiresAtIso: hardExpiresAt.toISOString(),
    };
  }

  /**
   * Evaluates current freshness state given fetchedAt, softStaleAt, hardExpiresAt timestamps.
   */
  public static evaluateState(
    softStaleAtIso: string,
    hardExpiresAtIso: string,
    nowTimestampIso?: string
  ): FreshnessState {
    const now = nowTimestampIso ? new Date(nowTimestampIso).getTime() : Date.now();
    const softStaleTime = new Date(softStaleAtIso).getTime();
    const hardExpiryTime = new Date(hardExpiresAtIso).getTime();

    if (isNaN(softStaleTime) || isNaN(hardExpiryTime)) {
      return 'INVALID';
    }

    if (now < softStaleTime) {
      return 'FRESH';
    } else if (now < hardExpiryTime) {
      return 'SOFT_STALE';
    } else {
      return 'EXPIRED';
    }
  }
}
