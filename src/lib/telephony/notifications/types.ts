import 'server-only';
import { OffboardingNotificationEventType } from '../lifecycle/types';

export type DeliveryChannel = 'in_app' | 'email' | 'sms' | 'system';

export type DeliveryClassification =
  | 'SUCCESS'
  | 'RETRYABLE_FAILURE'
  | 'PERMANENT_FAILURE';

export interface ChannelDeliveryRequest {
  notificationId: string;
  organizationId: string;
  phoneNumberId: string;
  phoneNumberE164: string;
  eventType: OffboardingNotificationEventType;
  channel: DeliveryChannel;
  destination: string;
  destinationVerified: boolean;
  criticalNotice: boolean;
  mandatoryNotice: boolean;
  subject: string;
  body: string;
  metadata?: Record<string, any>;
}

export interface ChannelDeliveryResult {
  success: boolean;
  status: 'pending' | 'delivered' | 'failed' | 'skipped';
  classification: DeliveryClassification;
  providerReferenceId?: string;
  errorMessage?: string;
  deliveredAt?: string;
}

export interface ChannelAttemptRecord {
  channel: DeliveryChannel;
  destinationMasked: string;
  status: 'pending' | 'delivered' | 'failed' | 'skipped';
  classification: DeliveryClassification;
  providerReferenceId?: string;
  errorMessage?: string;
  attemptedAt: string;
}

export interface DispatcherResult {
  notificationId: string;
  organizationId: string;
  overallStatus: 'delivered' | 'failed' | 'pending' | 'skipped';
  channelResults: Record<DeliveryChannel, ChannelDeliveryResult>;
  attemptsCount: number;
}

export interface NotificationWorkerBatchResult {
  totalProcessed: number;
  succeeded: number;
  retryableFailures: number;
  permanentFailures: number;
  exhausted: number;
  errors: number;
}
