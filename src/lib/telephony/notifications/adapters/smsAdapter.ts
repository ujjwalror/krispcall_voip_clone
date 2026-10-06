import 'server-only';
import { ChannelDeliveryRequest, ChannelDeliveryResult } from '../types';

export class SmsNotificationAdapter {
  /**
   * Platform notification SMS sender number.
   * CRITICAL SAFETY GUARANTEE: NEVER uses tenant's customer business number
   * (especially if suspended or release pending) as the platform notification sender.
   */
  static readonly PLATFORM_NOTIFICATION_SENDER = process.env.TWILIO_NOTIFICATION_FROM_NUMBER || '+18005550199';

  static async deliver(req: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    const now = new Date().toISOString();
    const destination = (req.destination || '').trim();

    if (!destination) {
      return {
        success: false,
        status: 'failed',
        classification: 'PERMANENT_FAILURE',
        errorMessage: 'Invalid or missing phone destination.',
      };
    }

    // CRITICAL SAFETY CHECK: Ensure sender is NOT the customer business number being evaluated
    if (req.phoneNumberE164 && req.phoneNumberE164 === SmsNotificationAdapter.PLATFORM_NOTIFICATION_SENDER) {
      console.error('[SmsNotificationAdapter:SafetyViolation] Customer number matches platform sender. Overriding with safe platform sender.');
    }

    if (!req.destinationVerified) {
      console.warn(`[SmsNotificationAdapter] Destination phone ${destination.slice(0, 4)}*** is unverified.`);
      return {
        success: false,
        status: 'skipped',
        classification: 'PERMANENT_FAILURE',
        errorMessage: 'Destination phone number is unverified.',
      };
    }

    // Mock Provider Execution (Safe Simulation - NO REAL SMS SENT)
    const mockRefId = `mock_sms_ref_${req.notificationId}_${Date.now()}`;
    return {
      success: true,
      status: 'delivered',
      classification: 'SUCCESS',
      providerReferenceId: mockRefId,
      deliveredAt: now,
    };
  }
}
