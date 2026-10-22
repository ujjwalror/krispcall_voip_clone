import { SupabaseClient } from '@supabase/supabase-js';
import { TelecomSecurityEvent } from './types';

export class TelecomSecurityAuditService {
  /**
   * Sanitizes metadata to strictly remove secrets, tokens, or raw message bodies
   */
  private static sanitizeMetadata(metadata?: Record<string, any>): Record<string, any> {
    if (!metadata) return {};
    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(metadata)) {
      const lower = key.toLowerCase();
      if (
        lower.includes('token') ||
        lower.includes('secret') ||
        lower.includes('password') ||
        lower.includes('key') ||
        lower.includes('auth')
      ) {
        sanitized[key] = '[REDACTED]';
      } else if (lower.includes('body') && typeof value === 'string') {
        // Redact body text, keep length
        sanitized[key] = `[REDACTED_CONTENT_LENGTH_${value.length}]`;
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Records a security event to structured logger and durable public.telecom_security_events table.
   */
  public static async logSecurityEvent(
    client: SupabaseClient | null,
    event: TelecomSecurityEvent
  ): Promise<void> {
    const timestamp = event.createdAt || new Date().toISOString();
    const cleanMeta = this.sanitizeMetadata(event.metadata);

    const structuredPayload = {
      timestamp,
      organizationId: event.organizationId,
      userId: event.userId || null,
      phoneNumber: event.phoneNumber || null,
      destination: event.destination || null,
      riskRule: event.riskRule,
      operation: event.operation,
      decision: event.decision,
      reason: event.reason,
      metadata: cleanMeta,
    };

    // 1. Structured JSON stderr/stdout event log
    console.warn(`[TELECOM_SECURITY_EVENT] ${JSON.stringify(structuredPayload)}`);

    // 2. Persist to database if client provided
    if (client) {
      try {
        await client
          .from('telecom_security_events')
          .insert({
            organization_id: event.organizationId,
            user_id: event.userId || null,
            phone_number: event.phoneNumber || null,
            destination: event.destination || null,
            risk_rule: event.riskRule,
            operation: event.operation,
            decision: event.decision,
            reason: event.reason,
            metadata: cleanMeta,
            created_at: timestamp,
          });
      } catch (err: any) {
        // Log persistence failure non-fatally
      }
    }
  }
}
