import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { OffboardingNotificationDispatcher } from './offboardingNotificationDispatcher';
import { NotificationWorkerBatchResult } from './types';

export class OffboardingNotificationWorker {
  static readonly MAX_RETRIES = 3;

  /**
   * Bounded Delivery Worker Entry Point.
   * Processes pending lifecycle notification delivery tasks deterministically, safely, and idempotently.
   */
  static async processPendingDeliveries(batchSize: number = 50): Promise<NotificationWorkerBatchResult> {
    const supabase = createAdminClient();
    const result: NotificationWorkerBatchResult = {
      totalProcessed: 0,
      succeeded: 0,
      retryableFailures: 0,
      permanentFailures: 0,
      exhausted: 0,
      errors: 0,
    };

    try {
      // 1. Query pending/failed notification delivery tasks
      const { data: records, error } = await (supabase as any)
        .from('number_lifecycle_notifications')
        .select('*')
        .in('delivery_status', ['pending', 'failed'])
        .order('created_at', { ascending: true })
        .limit(batchSize);

      if (error || !records || !Array.isArray(records)) {
        return result;
      }

      for (const notif of records) {
        const attempts = (notif.metadata?.attempts || 0);
        if (attempts >= OffboardingNotificationWorker.MAX_RETRIES) {
          result.exhausted++;
          console.warn('[NotificationWorker:Event]', JSON.stringify({
            event: 'notification_delivery_exhausted',
            notificationId: notif.id,
            organizationId: notif.organization_id,
            attempts,
            timestamp: new Date().toISOString(),
          }));
          continue;
        }

        result.totalProcessed++;
        try {
          console.log('[NotificationWorker:Event]', JSON.stringify({
            event: 'notification_delivery_queued',
            notificationId: notif.id,
            organizationId: notif.organization_id,
            eventType: notif.event_type,
            timestamp: new Date().toISOString(),
          }));

          const dispatchResult = await OffboardingNotificationDispatcher.dispatchNotification(notif.id);

          if (dispatchResult.overallStatus === 'delivered') {
            result.succeeded++;
          } else if (dispatchResult.attemptsCount >= OffboardingNotificationWorker.MAX_RETRIES) {
            result.exhausted++;
          } else {
            result.retryableFailures++;
          }
        } catch (itemErr: any) {
          console.error('[NotificationWorker] Exception processing notification delivery task:', itemErr.message || itemErr);
          result.errors++;
        }
      }

      return result;
    } catch (batchErr: any) {
      console.error('[NotificationWorker] Batch process exception:', batchErr.message || batchErr);
      return result;
    }
  }
}
