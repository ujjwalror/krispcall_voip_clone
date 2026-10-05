import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { OffboardingNotificationEventType, OffboardingNotificationRecord } from './types';

export class OffboardingNotificationService {
  /**
   * Records a durable, idempotent offboarding notification event.
   * GUARANTEE: Idempotency identity prevents duplicate notifications on repeated worker evaluations.
   * Delivery channel execution is decoupled from durable event persistence.
   */
  static async recordNotificationEvent(params: {
    organizationId: string;
    phoneNumberId: string;
    phoneNumberE164: string;
    eventType: OffboardingNotificationEventType;
    policyCycleId?: string;
    channel?: 'in_app' | 'email' | 'sms' | 'system';
    metadata?: Record<string, any>;
  }): Promise<{ created: boolean; notification: OffboardingNotificationRecord | null }> {
    const {
      organizationId,
      phoneNumberId,
      phoneNumberE164,
      eventType,
      policyCycleId = 'cycle_1',
      channel = 'in_app',
      metadata = {},
    } = params;

    // Idempotent identity key: orgId:phoneId:eventType:cycleId
    const idempotencyKey = `${organizationId}:${phoneNumberId}:${eventType}:${policyCycleId}`;

    try {
      const supabase = createAdminClient();

      // Check if notification event already exists
      const { data: existing } = await (supabase as any)
        .from('number_lifecycle_notifications')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();

      if (existing) {
        return {
          created: false,
          notification: {
            id: existing.id,
            organizationId: existing.organization_id,
            phoneNumberId: existing.phone_number_id,
            phoneNumberE164: existing.phone_number_e164,
            eventType: existing.event_type as OffboardingNotificationEventType,
            idempotencyKey: existing.idempotency_key,
            deliveryStatus: existing.delivery_status,
            channel: existing.channel,
            metadata: existing.metadata,
            createdAt: existing.created_at,
            deliveredAt: existing.delivered_at,
          },
        };
      }

      // Insert new notification event row
      const newRow = {
        organization_id: organizationId,
        phone_number_id: phoneNumberId,
        phone_number_e164: phoneNumberE164,
        event_type: eventType,
        idempotency_key: idempotencyKey,
        delivery_status: 'pending',
        channel,
        metadata,
      };

      const { data: inserted, error: insertErr } = await (supabase as any)
        .from('number_lifecycle_notifications')
        .insert(newRow)
        .select()
        .single();

      if (insertErr || !inserted) {
        // In case of race condition or DB constraint collision
        return { created: false, notification: null };
      }

      return {
        created: true,
        notification: {
          id: inserted.id,
          organizationId: inserted.organization_id,
          phoneNumberId: inserted.phone_number_id,
          phoneNumberE164: inserted.phone_number_e164,
          eventType: inserted.event_type as OffboardingNotificationEventType,
          idempotencyKey: inserted.idempotency_key,
          deliveryStatus: inserted.delivery_status,
          channel: inserted.channel,
          metadata: inserted.metadata,
          createdAt: inserted.created_at,
          deliveredAt: inserted.delivered_at,
        },
      };
    } catch (err: any) {
      console.warn('[OffboardingNotificationService] Exception recording notification event:', err.message || err);
      return { created: false, notification: null };
    }
  }
}
