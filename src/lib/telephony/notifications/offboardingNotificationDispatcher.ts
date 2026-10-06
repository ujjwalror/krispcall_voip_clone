import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { OffboardingNotificationEventType } from '../lifecycle/types';
import {
  DeliveryChannel,
  ChannelDeliveryRequest,
  ChannelDeliveryResult,
  ChannelAttemptRecord,
  DispatcherResult,
} from './types';
import { InAppNotificationAdapter } from './adapters/inAppAdapter';
import { EmailNotificationAdapter } from './adapters/emailAdapter';
import { SmsNotificationAdapter } from './adapters/smsAdapter';

export class OffboardingNotificationDispatcher {
  /**
   * Masks email or phone number for safe structured logging without PII leakage.
   */
  public static maskDestination(dest: string): string {
    if (!dest) return '***';
    const str = dest.trim();
    if (str.includes('@')) {
      const parts = str.split('@');
      const name = parts[0];
      const maskedName = name.length > 2 ? `${name[0]}***${name[name.length - 1]}` : '***';
      return `${maskedName}@${parts[1]}`;
    }
    if (str.length > 5) {
      return `${str.slice(0, 4)}***${str.slice(-4)}`;
    }
    return '***';
  }

  /**
   * Determines if a notification event is a critical service/number-risk notice.
   */
  public static isCriticalNotice(eventType: OffboardingNotificationEventType): boolean {
    return [
      'service_suspended',
      'number_release_pending',
      'final_release_warning',
      'retention_grace_warning',
      'port_out_blocking_release',
    ].includes(eventType);
  }

  /**
   * Resolves notification copy subject & body for event type.
   */
  public static getNotificationCopy(eventType: OffboardingNotificationEventType, phoneE164: string): { subject: string; body: string } {
    switch (eventType) {
      case 'saas_cancellation_received':
        return {
          subject: 'SaaS Subscription Cancellation Received',
          body: `We have received your cancellation request for phone number ${phoneE164}. Your number will remain active through your paid-through date.`,
        };
      case 'service_end_approaching':
        return {
          subject: 'Action Required: Service End Approaching',
          body: `Your paid-through period for ${phoneE164} is approaching its end date. Renew payment to maintain uninterrupted calling and messaging.`,
        };
      case 'retention_grace_warning':
        return {
          subject: 'Payment Past Due: Retention Grace Window Active',
          body: `Payment for ${phoneE164} is past due. Your number is currently in retention grace status. Please renew payment to prevent service suspension.`,
        };
      case 'service_suspended':
        return {
          subject: 'URGENT: Telecom Service Suspended',
          body: `Calling and messaging services for ${phoneE164} have been suspended due to unpaid entitlement. Renew payment immediately to restore service.`,
        };
      case 'number_release_pending':
        return {
          subject: 'CRITICAL: Phone Number Pending Carrier Release',
          body: `Phone number ${phoneE164} has entered release-pending status. Immediate payment restoration is required to prevent permanent carrier release.`,
        };
      case 'final_release_warning':
        return {
          subject: 'FINAL WARNING: Imminent Phone Number Release',
          body: `Final warning: Phone number ${phoneE164} is eligible for permanent release to the carrier pool. Access your account to preserve number entitlement.`,
        };
      case 'service_restored':
        return {
          subject: 'Service Restored',
          body: `Payment has been successfully restored. Calling and messaging for ${phoneE164} are fully active.`,
        };
      case 'port_out_blocking_release':
        return {
          subject: 'Port-Out In Progress: Release Suspended',
          body: `An active port-out request is in progress for ${phoneE164}. Automatic release processing has been suspended.`,
        };
      default:
        return {
          subject: 'Phone Number Lifecycle Notification',
          body: `Update regarding phone number ${phoneE164}.`,
        };
    }
  }

  /**
   * Dispatches lifecycle notification delivery across intended channels.
   */
  static async dispatchNotification(notificationId: string): Promise<DispatcherResult> {
    const supabase = createAdminClient();
    const now = new Date().toISOString();

    // 1. Fetch lifecycle notification record
    const { data: notif, error } = await (supabase as any)
      .from('number_lifecycle_notifications')
      .select('*')
      .eq('id', notificationId)
      .single();

    if (error || !notif) {
      throw new Error(`Lifecycle notification ${notificationId} not found.`);
    }

    const orgId = notif.organization_id;
    const eventType = notif.event_type as OffboardingNotificationEventType;
    const phoneE164 = notif.phone_number_e164;
    const criticalNotice = OffboardingNotificationDispatcher.isCriticalNotice(eventType);
    const mandatoryNotice = criticalNotice;

    // 2. Resolve target organization contact information
    const { data: orgData } = await (supabase as any)
      .from('organizations')
      .select('billing_email, billing_phone, owner_id')
      .eq('id', orgId)
      .maybeSingle();

    let emailDest = orgData?.billing_email || '';
    let phoneDest = orgData?.billing_phone || '';
    let emailVerified = true;
    let phoneVerified = true;

    if (orgData?.owner_id) {
      const { data: ownerProfile } = await (supabase as any)
        .from('profiles')
        .select('email, phone_number')
        .eq('id', orgData.owner_id)
        .maybeSingle();

      if (ownerProfile) {
        if (!emailDest) emailDest = ownerProfile.email || '';
        if (!phoneDest) phoneDest = ownerProfile.phone_number || '';
      }
    }

    const copy = OffboardingNotificationDispatcher.getNotificationCopy(eventType, phoneE164);
    const existingMetadata = notif.metadata || {};
    const existingHistory: ChannelAttemptRecord[] = existingMetadata.deliveryHistory || [];
    const attemptsCount = (existingMetadata.attempts || 0) + 1;

    console.log('[NotificationDispatcher:Event]', JSON.stringify({
      event: 'notification_delivery_attempted',
      notificationId,
      organizationId: orgId,
      eventType,
      attemptNumber: attemptsCount,
      criticalNotice,
      timestamp: now,
    }));

    // Target delivery channels (in_app is default for all lifecycle events)
    const targetChannels: DeliveryChannel[] = ['in_app', 'email'];
    if (criticalNotice) {
      targetChannels.push('sms');
    }

    const channelResults: Record<DeliveryChannel, ChannelDeliveryResult> = {
      in_app: { success: false, status: 'pending', classification: 'RETRYABLE_FAILURE' },
      email: { success: false, status: 'pending', classification: 'RETRYABLE_FAILURE' },
      sms: { success: false, status: 'pending', classification: 'RETRYABLE_FAILURE' },
      system: { success: false, status: 'pending', classification: 'RETRYABLE_FAILURE' },
    };

    const newAttempts: ChannelAttemptRecord[] = [...existingHistory];
    let allSucceeded = true;
    let anySucceeded = false;

    for (const ch of targetChannels) {
      // Idempotency Check: Skip channel if already delivered in previous attempt
      const alreadyDelivered = existingHistory.some((h) => h.channel === ch && h.status === 'delivered');
      if (alreadyDelivered) {
        channelResults[ch] = { success: true, status: 'delivered', classification: 'SUCCESS' };
        anySucceeded = true;
        continue;
      }

      const dest = ch === 'email' ? emailDest : ch === 'sms' ? phoneDest : orgId;
      const verified = ch === 'email' ? emailVerified : ch === 'sms' ? phoneVerified : true;

      const req: ChannelDeliveryRequest = {
        notificationId,
        organizationId: orgId,
        phoneNumberId: notif.phone_number_id,
        phoneNumberE164: phoneE164,
        eventType,
        channel: ch,
        destination: dest,
        destinationVerified: verified,
        criticalNotice,
        mandatoryNotice,
        subject: copy.subject,
        body: copy.body,
        metadata: existingMetadata,
      };

      let result: ChannelDeliveryResult;
      try {
        if (ch === 'in_app') {
          result = await InAppNotificationAdapter.deliver(req);
        } else if (ch === 'email') {
          result = await EmailNotificationAdapter.deliver(req);
        } else if (ch === 'sms') {
          result = await SmsNotificationAdapter.deliver(req);
        } else {
          result = { success: true, status: 'delivered', classification: 'SUCCESS' };
        }
      } catch (err: any) {
        result = {
          success: false,
          status: 'failed',
          classification: 'RETRYABLE_FAILURE',
          errorMessage: err.message || 'Adapter execution error',
        };
      }

      channelResults[ch] = result;
      newAttempts.push({
        channel: ch,
        destinationMasked: OffboardingNotificationDispatcher.maskDestination(dest),
        status: result.status,
        classification: result.classification,
        providerReferenceId: result.providerReferenceId,
        errorMessage: result.errorMessage,
        attemptedAt: now,
      });

      if (result.success) {
        anySucceeded = true;
      } else {
        allSucceeded = false;
      }
    }

    const overallStatus = allSucceeded || anySucceeded ? 'delivered' : attemptsCount >= 3 ? 'failed' : 'pending';

    const updatedMetadata = {
      ...existingMetadata,
      attempts: attemptsCount,
      lastAttemptAt: now,
      deliveryHistory: newAttempts,
      criticalNotice,
      mandatoryNotice,
    };

    await (supabase as any)
      .from('number_lifecycle_notifications')
      .update({
        delivery_status: overallStatus,
        delivered_at: overallStatus === 'delivered' ? now : notif.delivered_at,
        metadata: updatedMetadata,
      })
      .eq('id', notificationId);

    console.log('[NotificationDispatcher:Event]', JSON.stringify({
      event: overallStatus === 'delivered' ? 'notification_delivery_succeeded' : 'notification_delivery_failed',
      notificationId,
      organizationId: orgId,
      overallStatus,
      attemptsCount,
      timestamp: now,
    }));

    return {
      notificationId,
      organizationId: orgId,
      overallStatus,
      channelResults,
      attemptsCount,
    };
  }
}
