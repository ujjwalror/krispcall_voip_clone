import { SupabaseClient } from '@supabase/supabase-js';
import { ControlPlaneAuditEvent } from './types';

export class TelecomControlPlaneAuditService {
  private static inMemoryAuditTrail: ControlPlaneAuditEvent[] = [];

  /**
   * Sanitizes metadata to strictly remove secrets, tokens, passwords, or raw message bodies.
   */
  public static sanitizeMetadata(metadata?: Record<string, any> | null): Record<string, any> {
    if (!metadata) return {};
    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(metadata)) {
      const lower = key.toLowerCase();
      if (
        lower.includes('token') ||
        lower.includes('secret') ||
        lower.includes('password') ||
        lower.includes('key') ||
        lower.includes('auth') ||
        lower.includes('credential')
      ) {
        sanitized[key] = '[REDACTED]';
      } else if (lower.includes('body') && typeof value === 'string') {
        sanitized[key] = `[REDACTED_CONTENT_LENGTH_${value.length}]`;
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeMetadata(value);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Records an authoritative control plane audit event.
   * Append-only; sanitized; non-fatal on persistence failure.
   */
  public static async logControlEvent(
    event: ControlPlaneAuditEvent,
    client?: SupabaseClient | null
  ): Promise<void> {
    const timestamp = event.createdAt || new Date().toISOString();
    const cleanMeta = this.sanitizeMetadata(event.metadata);
    const cleanPrev = this.sanitizeMetadata(event.previousState);
    const cleanNew = this.sanitizeMetadata(event.newState);

    const structuredEvent: ControlPlaneAuditEvent = {
      ...event,
      createdAt: timestamp,
      metadata: cleanMeta,
      previousState: cleanPrev,
      newState: cleanNew,
    };

    // 1. Maintain in-memory buffer for immediate testing/inspection
    this.inMemoryAuditTrail.push(structuredEvent);
    if (this.inMemoryAuditTrail.length > 500) {
      this.inMemoryAuditTrail.shift();
    }

    // 2. Structured log output
    console.warn(`[TELECOM_CONTROL_PLANE_AUDIT] ${JSON.stringify(structuredEvent)}`);

    // 3. Database persistence if client provided
    if (client) {
      try {
        await (client as any).from('telecom_control_audit_events').insert({
          organization_id: event.organizationId || null,
          actor_id: event.actorId || null,
          authority: event.authority || null,
          control_type: event.controlType,
          operation: event.operation,
          decision: event.decision,
          reason_code: event.reasonCode,
          reason: event.reason,
          previous_state: cleanPrev,
          new_state: cleanNew,
          correlation_id: event.correlationId || null,
          metadata: cleanMeta,
          created_at: timestamp,
        });
      } catch (err: any) {
        // Table may not yet be migrated in remote DB; non-fatal for audit logging
      }
    }
  }

  public static getRecentAuditEvents(): ControlPlaneAuditEvent[] {
    return [...this.inMemoryAuditTrail];
  }

  public static clearAuditTrail(): void {
    this.inMemoryAuditTrail = [];
  }
}
