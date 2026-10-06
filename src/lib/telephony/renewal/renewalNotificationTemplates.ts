import 'server-only';
import { formatRenewalDeadline } from './deadlineFormatter';

export type RenewalNotificationType =
  | 'T_MINUS_7_UPCOMING_NOTICE'
  | 'T_MINUS_5_PAYMENT_REQUIRED'
  | 'T_MINUS_5_AUTOPAY_SCHEDULED'
  | 'PAYMENT_FAILURE_IMMEDIATE'
  | 'T_MINUS_3_RETRY_REMINDER'
  | 'T_MINUS_2_STRONG_WARNING'
  | 'T_MINUS_1_FINAL_WARNING'
  | 'RENEWAL_SUCCESSFUL'
  | 'RELEASE_ELIGIBLE'
  | 'PORT_OUT_FUNDING_REQUIRED';

export interface RenewalNotificationPayload {
  notificationType: RenewalNotificationType;
  phoneNumberE164: string;
  organizationId: string;
  providerExposureAt: string | Date;
  customerTimeZone?: string | null;
  amountMinor?: number;
  currency?: string;
  failureReason?: string;
}

export interface FormattedRenewalNotification {
  notificationType: RenewalNotificationType;
  title: string;
  body: string;
  formattedDeadline: string;
  channel: 'in_app';
  isRealEmailEnabled: false;
  isRealSmsEnabled: false;
}

export class RenewalNotificationTemplateService {
  /**
   * Generates localized notification content adhering strictly to Approved Policy V1 wording guidelines.
   * Real email and SMS delivery remain strictly OFF. Mock sender is never exposed.
   */
  static buildNotification(payload: RenewalNotificationPayload): FormattedRenewalNotification {
    const {
      notificationType,
      phoneNumberE164,
      providerExposureAt,
      customerTimeZone,
      amountMinor = 1500,
      currency = 'USD',
      failureReason,
    } = payload;

    const formattedDeadline = formatRenewalDeadline(providerExposureAt, customerTimeZone);
    const formattedAmount = `$${(amountMinor / 100).toFixed(2)} ${currency}`;

    let title = '';
    let body = '';

    switch (notificationType) {
      case 'T_MINUS_7_UPCOMING_NOTICE':
        title = `Upcoming Renewal Notice: ${phoneNumberE164}`;
        body = `Your phone number ${phoneNumberE164} is scheduled for renewal. Funded-through deadline is ${formattedDeadline}. Renewal amount: ${formattedAmount}.`;
        break;

      case 'T_MINUS_5_AUTOPAY_SCHEDULED':
        title = `Autopay Scheduled: ${phoneNumberE164}`;
        body = `Autopay for phone number ${phoneNumberE164} (${formattedAmount}) will be attempted shortly. Next provider boundary deadline: ${formattedDeadline}.`;
        break;

      case 'T_MINUS_5_PAYMENT_REQUIRED':
        title = `Payment Required: ${phoneNumberE164}`;
        body = `Your phone number ${phoneNumberE164} requires renewal. Payment of ${formattedAmount} is required by ${formattedDeadline} to continue maintaining this number. If payment is not received by the applicable deadline and you have not started an eligible port-out, your number may become eligible for automatic release after the required safety checks.`;
        break;

      case 'PAYMENT_FAILURE_IMMEDIATE':
        title = `Payment Attempt Failed: ${phoneNumberE164}`;
        body = `A payment attempt for ${phoneNumberE164} (${formattedAmount}) failed${failureReason ? `: ${failureReason}` : ''}. Payment must be completed by ${formattedDeadline} to prevent service disruption.`;
        break;

      case 'T_MINUS_3_RETRY_REMINDER':
        title = `Payment Reminder: ${phoneNumberE164}`;
        body = `Reminder: Payment for ${phoneNumberE164} (${formattedAmount}) remains due by ${formattedDeadline}. Please update your payment method or complete payment manually.`;
        break;

      case 'T_MINUS_2_STRONG_WARNING':
        title = `Action Required — Number Renewal Warning: ${phoneNumberE164}`;
        body = `Payment is still required to maintain this phone number (${phoneNumberE164}). If payment is not completed by ${formattedDeadline}, your number may become eligible for release after safety verification.`;
        break;

      case 'T_MINUS_1_FINAL_WARNING':
        title = `FINAL NOTICE: ${phoneNumberE164} At Risk of Release`;
        body = `Final notice: your phone number ${phoneNumberE164} is not funded for its next rental period. Complete payment by ${formattedDeadline}. If payment is not completed by this deadline and no eligible port-out or other protection is in progress, your number may become eligible for automatic release. Once a number is released, recovery cannot be guaranteed.`;
        break;

      case 'RENEWAL_SUCCESSFUL':
        title = `Renewal Successful: ${phoneNumberE164}`;
        body = `Payment of ${formattedAmount} succeeded. Phone number ${phoneNumberE164} is fully funded through ${formattedDeadline}.`;
        break;

      case 'RELEASE_ELIGIBLE':
        title = `Number Pending Release Eligibility Review: ${phoneNumberE164}`;
        body = `Funding deadline ${formattedDeadline} has passed for ${phoneNumberE164}. The number is undergoing automated safety interlock evaluation prior to release eligibility.`;
        break;

      case 'PORT_OUT_FUNDING_REQUIRED':
        title = `Port-Out Active — Funding Required: ${phoneNumberE164}`;
        body = `Your port-out for ${phoneNumberE164} is in progress. Number release is blocked, but rental funding remains required until porting fully completes at the carrier.`;
        break;
    }

    return {
      notificationType,
      title,
      body,
      formattedDeadline,
      channel: 'in_app',
      isRealEmailEnabled: false,
      isRealSmsEnabled: false,
    };
  }
}
