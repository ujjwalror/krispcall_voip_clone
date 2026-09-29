export type { TelecomServiceType, TelecomDirection, TelecomRetailRateCard } from '../types';
import type { TelecomServiceType, TelecomDirection, TelecomRetailRateCard } from '../types';

export type SessionType = 'outbound_call' | 'inbound_call' | 'sms' | 'mms' | 'other';
export type SessionStatus = 'active' | 'completed' | 'failed' | 'reconciliation_required';
export type ComponentLegType =
  | 'pstn_outbound'
  | 'pstn_inbound'
  | 'client_leg'
  | 'sms_segment'
  | 'mms_media'
  | 'forwarding'
  | 'transfer'
  | 'conference'
  | 'other';
export type ProviderOpType = 'message_create' | 'call_duration_update' | 'call_terminate' | 'other';
export type ProviderOpStatus =
  | 'prepared'
  | 'dispatch_claimed'
  | 'provider_id_known'
  | 'reconciliation_required'
  | 'confirmed_created'
  | 'confirmed_absent'
  | 'failed';
export type EventProcessingResult = 'processed' | 'duplicate_ignored' | 'out_of_order_ignored' | 'error';

export interface TelecomUsageSession {
  sessionId: string;
  organizationId: string;
  createdByUserId: string | null;
  sessionType: SessionType;
  direction: TelecomDirection;
  status: SessionStatus;
  currency: string;
  totalRetailChargeMinor: number;
  totalWholesaleCostMinor: number;
  reconciliationStatus: 'pending' | 'reconciled' | 'manual_review';
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface TelecomUsageComponent {
  componentId: string;
  sessionId: string;
  organizationId: string;
  internalUsageId: string;
  provider: string;
  providerAccountId: string | null;
  parentProviderResourceId: string | null;
  childProviderResourceId: string | null;
  legType: ComponentLegType;
  sequenceNumber: number;
  durationSeconds: number;
  retailChargeMinor: number;
  providerWholesaleCostMinor: number | null;
  reconciliationStatus: 'pending' | 'reconciled' | 'manual_review';
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface TelecomProviderOperation {
  id: string;
  organizationId: string;
  sessionId: string | null;
  componentId: string | null;
  internalUsageId: string;
  provider: string;
  operationType: ProviderOpType;
  idempotencyKey: string;
  requestFingerprint: string;
  providerResourceId: string | null;
  status: ProviderOpStatus;
  reconciliationStatus: 'none' | 'pending' | 'reconciled' | 'manual_review';
  attemptCount: number;
  dispatchToken: string | null;
  lastError: Record<string, any> | null;
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface TelecomProviderEventLog {
  id: string;
  organizationId: string | null;
  provider: string;
  eventId: string | null;
  providerResourceId: string;
  eventType: string;
  sequenceNumber: number | null;
  payloadFingerprint: string;
  payload: Record<string, any>;
  receivedAt: string;
  processedAt: string | null;
  processingResult: EventProcessingResult;
  errorDetails: string | null;
  metadata: Record<string, any>;
}

export interface RateResolutionParams {
  organizationId: string;
  provider?: string;
  serviceType: TelecomServiceType;
  direction: TelecomDirection;
  destinationPhoneNumber: string; // E.164
  currency?: string;
  timestamp?: string; // ISO string
}

export interface RateResolutionResult {
  matchedRateCard: TelecomRetailRateCard;
  resolutionSource: 'organization_custom' | 'public_tariff';
  matchedPrefix: string;
  unitType: 'minute' | 'message' | 'event';
  retailRateMicro: number;
  billingIncrementSeconds: number;
  minChargeableUnits: number;
  currency: string;
}

export interface SmsEncodingAnalysis {
  encoding: 'GSM-7' | 'UCS-2';
  characterCount: number;
  estimatedSegments: number;
  containsExtensionChars: boolean;
  containsUnicode: boolean;
}

// Provider-Neutral Domain Interfaces (Contracts Only)
export interface TelecomUsageAuthorizationAdapter {
  authorizeUsage(params: {
    organizationId: string;
    internalUsageId: string;
    serviceType: TelecomServiceType;
    direction: TelecomDirection;
    destination: string;
    idempotencyKey: string;
  }): Promise<{
    authorized: boolean;
    reservationId?: string;
    maxDurationSeconds?: number;
    estimatedExposureMinor?: number;
    failureReason?: string;
  }>;
}

export interface TelecomUsageControlAdapter {
  applyDurationLimit(params: {
    providerResourceId: string;
    maxDurationSeconds: number;
  }): Promise<{ success: boolean; error?: string }>;

  terminateUsage(params: {
    providerResourceId: string;
    reason: string;
  }): Promise<{ success: boolean; error?: string }>;
}

export interface TelecomUsageRatingAdapter {
  resolveRate(params: RateResolutionParams): Promise<RateResolutionResult>;
}

export interface TelecomUsageReconciliationAdapter {
  reconcileUsageComponent(params: {
    internalUsageId: string;
    providerResourceId: string;
  }): Promise<{ reconciled: boolean; wholesaleCostMinor?: number; error?: string }>;
}

// Customer-Safe DTO Boundaries (Strictly No Provider SIDs, Wholesale Costs, Margins, or Tokens)
export interface CustomerTelecomComponentDTO {
  componentId: string;
  legType: ComponentLegType;
  durationSeconds: number;
  retailChargeMinor: number;
}

export interface CustomerTelecomSessionDTO {
  sessionId: string;
  sessionType: SessionType;
  direction: TelecomDirection;
  status: SessionStatus;
  currency: string;
  totalRetailChargeMinor: number;
  createdAt: string;
  updatedAt: string;
  components: CustomerTelecomComponentDTO[];
}

export function toCustomerTelecomSessionDTO(
  session: TelecomUsageSession,
  components: TelecomUsageComponent[] = []
): CustomerTelecomSessionDTO {
  return {
    sessionId: session.sessionId,
    sessionType: session.sessionType,
    direction: session.direction,
    status: session.status,
    currency: session.currency,
    totalRetailChargeMinor: session.totalRetailChargeMinor,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    components: components
      .filter((c) => c.sessionId === session.sessionId)
      .map((c) => ({
        componentId: c.componentId,
        legType: c.legType,
        durationSeconds: c.durationSeconds,
        retailChargeMinor: c.retailChargeMinor,
      })),
  };
}
