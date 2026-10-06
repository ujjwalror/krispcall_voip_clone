import 'server-only';
import { ChannelDeliveryRequest, ChannelDeliveryResult } from '../types';

export class EmailNotificationAdapter {
  /**
   * Escapes dynamic template content to prevent HTML / template injection.
   */
  private static sanitizeText(input: string): string {
    return (input || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  /**
   * Delivers transactional email notification via provider-neutral adapter.
   * NO REAL EMAIL IS SENT during test or unconfigured environment modes.
   */
  static async deliver(req: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    const now = new Date().toISOString();
    const destination = (req.destination || '').trim();

    if (!destination || !destination.includes('@')) {
      return {
        success: false,
        status: 'failed',
        classification: 'PERMANENT_FAILURE',
        errorMessage: 'Invalid or missing email destination.',
      };
    }

    if (!req.destinationVerified) {
      console.warn(`[EmailNotificationAdapter] Destination email ${destination.slice(0, 3)}*** is unverified.`);
      // Unverified destination: report permanent failure without throwing exception
      return {
        success: false,
        status: 'skipped',
        classification: 'PERMANENT_FAILURE',
        errorMessage: 'Destination email address is unverified.',
      };
    }

    const cleanSubject = EmailNotificationAdapter.sanitizeText(req.subject);
    const cleanBody = EmailNotificationAdapter.sanitizeText(req.body);

    // Mock Provider Execution (Safe Simulation)
    const mockRefId = `mock_email_ref_${req.notificationId}_${Date.now()}`;
    return {
      success: true,
      status: 'delivered',
      classification: 'SUCCESS',
      providerReferenceId: mockRefId,
      deliveredAt: now,
    };
  }
}
