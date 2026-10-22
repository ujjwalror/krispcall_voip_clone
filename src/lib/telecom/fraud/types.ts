export type DestinationRiskClassification = 'ALLOWED' | 'RESTRICTED' | 'BLOCKED';

export type TelecomServiceCategory =
  | 'geographic_landline'
  | 'mobile'
  | 'toll_free'
  | 'satellite'
  | 'premium_rate'
  | 'emergency'
  | 'special_services'
  | 'unknown';

export interface DestinationRiskEvaluation {
  destination: string;
  countryCode: string | null; // e.g. 'US', 'AU', 'GB', 'CA', 'NZ'
  e164Prefix: string;
  serviceCategory: TelecomServiceCategory;
  classification: DestinationRiskClassification;
  isEmergency: boolean;
  emergencyType?: '000' | '112' | '911' | '999' | 'other';
  reason: string;
  riskRule?: string;
  maxProviderExposureSeconds?: number;
  requiresManualReview?: boolean;
}

export type TelecomSuspensionLevel = 'USER' | 'NUMBER' | 'ORGANIZATION' | 'NONE';

export interface TelecomSuspensionStatus {
  isSuspended: boolean;
  level: TelecomSuspensionLevel;
  reason?: string;
  suspendedAt?: string;
}

export interface TelecomVelocityCheckParams {
  organizationId: string;
  userId: string;
  serviceType: 'voice_outbound' | 'sms_outbound' | 'mms_outbound';
  destination?: string;
  contentHash?: string;
  body?: string;
  idempotencyKey?: string;
  consume?: boolean;
}

export interface TelecomVelocityCheckResult {
  allowed: boolean;
  limitType?:
    | 'user_call_velocity'
    | 'org_call_velocity'
    | 'user_sms_velocity'
    | 'org_sms_velocity'
    | 'destination_diversity'
    | 'spam_content_burst'
    | 'mms_burst'
    | 'velocity_state_unavailable'
    | 'velocity_hmac_key_unavailable'
    | 'idempotency_key_collision'
    | 'idempotency_key_expired'
    | 'unauthorized_tenant_membership';
  currentRate?: number;
  limitThreshold?: number;
  retryAfterSeconds?: number;
  reason?: string;
  idempotencyReplayed?: boolean;
  eventId?: string;
  createdAt?: string;
  simulatedOnly?: boolean;
}

export type MessagingConsentStatus = 'opted_out' | 'opted_in' | 'unspecified';

export interface MessagingConsentRecord {
  organizationId: string;
  phoneNumber: string; // E.164 recipient
  status: MessagingConsentStatus;
  optOutKeyword?: string;
  optedOutAt?: string;
  optedInAt?: string;
  source?: 'inbound_keyword' | 'manual' | 'api';
}

export interface TelecomSecurityEvent {
  id?: string;
  organizationId: string;
  userId?: string | null;
  phoneNumber?: string | null;
  destination?: string | null;
  riskRule: string;
  operation: 'voice_dial' | 'call_transfer' | 'call_hold' | 'sms_send' | 'mms_send' | 'recording_access' | 'provider_mutation';
  decision: 'blocked' | 'restricted' | 'throttled' | 'allowed';
  reason: string;
  metadata?: Record<string, any>;
  createdAt?: string;
}
