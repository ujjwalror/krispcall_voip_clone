export type FreshnessState = 'FRESH' | 'SOFT_STALE' | 'EXPIRED' | 'MISSING' | 'AMBIGUOUS' | 'INVALID';

export interface NormalizedWholesaleQuote {
  providerKey: string;
  providerAccountId: string | null;
  serviceType: 'voice_outbound' | 'voice_inbound';
  direction: 'outbound' | 'inbound';
  isoCountry: string;
  destinationPrefix: string;
  originationPrefix: string | null;
  numberType: 'local' | 'mobile' | 'national' | 'toll_free' | 'any' | null;
  currency: string;
  currentPriceMicro: bigint;
  wholesaleRateMicro: bigint;
  basePriceMicro: bigint | null;
  priceUnit: string;
  billingIncrementSeconds: number;
  minChargeableUnits: number;
  fetchedAt: string;
  softStaleAt: string;
  hardExpiresAt: string;
  freshnessState: FreshnessState;
  sourceApiVersion: string;
  pricingFingerprint: string;
  version: number;
  isZero: boolean;
}

export interface GetWholesaleQuoteParams {
  providerKey?: string;
  providerAccountId?: string | null;
  serviceType: 'voice_outbound' | 'voice_inbound';
  direction: 'outbound' | 'inbound';
  destinationPhoneNumber?: string;
  originationPhoneNumber?: string | null;
  isoCountry?: string;
  numberType?: 'local' | 'mobile' | 'national' | 'toll_free' | 'any' | null;
  currency?: string;
  timestamp?: string;
}

export interface SyncPricingResult {
  success: boolean;
  providerKey: string;
  providerAccountId: string;
  isoCountry: string;
  recordsObserved: number;
  recordsInserted: number;
  recordsUpdated: number;
  recordsVersioned: number;
  syncRunId: string;
  fingerprint: string;
  errorMessage?: string;
}

export interface TelecomProviderPricingAdapter {
  providerKey: string;
  getWholesaleQuote(params: GetWholesaleQuoteParams): Promise<NormalizedWholesaleQuote>;
  syncCountryPricing(isoCountry: string, providerAccountId?: string): Promise<SyncPricingResult>;
}
