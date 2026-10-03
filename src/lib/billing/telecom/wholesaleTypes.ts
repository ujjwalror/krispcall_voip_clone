import { TelecomServiceType, TelecomDirection } from '../types';

export interface NormalizedWholesaleCostDTO {
  /** Internal provider account linkage from billing_provider_accounts */
  providerAccountId?: string | null;
  /** Internal provider key (e.g. 'twilio', 'bandwidth') */
  providerKey: string;
  /** Domain service type */
  serviceType: TelecomServiceType;
  /** Direction */
  direction: TelecomDirection;
  /** Destination E.164 phone number */
  destinationPhoneNumber: string;
  /** Winning destination prefix matched on rate card */
  matchedPrefix: string;
  /** Tariff currency (strictly 'USD') */
  currency: 'USD' | string;
  /** Wholesale rate in sub-cent micro-units (1 cent = 10,000 micro-units) */
  wholesaleRateMicro: number;
  /** Unit type ('minute', 'message', 'event') */
  unitType: 'minute' | 'message' | 'event' | string;
  /** Billing increment in seconds (e.g. 60) */
  billingIncrementSeconds: number;
  /** Minimum chargeable units (e.g. 1) */
  minChargeableUnits: number;
  /** Projected total wholesale cost for initial window (in minor cents) */
  estimatedWholesaleCostMinor: number;
  /** Provider rate card reference / version identifier */
  providerRateReference?: string | null;
  /** ISO timestamp when wholesale rate was snapshot */
  observedAt: string;
}

export interface RecordWholesaleSnapshotParams {
  organizationId: string;
  reservationId: string;
  internalUsageId: string;
  providerAccountId?: string | null;
  providerKey?: string;
  serviceType: TelecomServiceType;
  direction: TelecomDirection;
  currency?: string;
  estimatedWholesaleRateMicro: number;
  estimatedWholesaleCostMinor: number;
  metadata?: Record<string, any>;
}

export interface RecordCostObservationParams {
  organizationId: string;
  internalUsageId: string;
  sourceAuthority: 'preliminary_callback' | 'finalized_api_fetch' | 'invoice_reconciled' | 'manual_adjustment';
  economicEffect: 'charge' | 'credit' | 'correction_increase' | 'correction_decrease' | 'unknown';
  costSource: string;
  providerCostMicro: number | bigint;
  rawSign: 'positive' | 'negative' | 'zero';
  costComponent?: string;
  rawProviderPriceText?: string | null;
  fingerprint?: string;
  settlementLedgerId?: string | null;
  retailChargeMinor?: number | null;
  rawPayload?: Record<string, any>;
}

export interface TelecomUsageEconomicsSummary {
  id: string;
  organizationId: string;
  reservationId: string;
  internalUsageId: string;
  providerAccountId?: string | null;
  settlementLedgerId?: string | null;
  providerKey: string;
  serviceType: string;
  direction: string;
  currency: string;
  estimatedWholesaleRateMicro: number;
  estimatedWholesaleCostMinor: number;
  retailChargeMinor?: number | null;
  netActualProviderCostMicro?: number | null;
  netActualProviderCostMinor?: number | null;
  costStatus: string;
  createdAt: string;
  updatedAt: string;
}
