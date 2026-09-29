import { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import {
  TelecomUsageSession,
  TelecomUsageComponent,
  TelecomProviderOperation,
  TelecomProviderEventLog,
  CustomerTelecomSessionDTO,
  toCustomerTelecomSessionDTO,
  SessionType,
  TelecomDirection,
  ComponentLegType,
  ProviderOpType,
} from './types';

export interface CreateSessionParams {
  sessionId: string;
  organizationId: string;
  createdByUserId?: string | null;
  sessionType: SessionType;
  direction: TelecomDirection;
  currency?: string;
  metadata?: Record<string, any>;
}

export interface CreateComponentParams {
  componentId: string;
  sessionId: string;
  organizationId: string;
  internalUsageId: string;
  provider?: string;
  providerAccountId?: string | null;
  parentProviderResourceId?: string | null;
  childProviderResourceId?: string | null;
  legType: ComponentLegType;
  sequenceNumber?: number;
  durationSeconds?: number;
  retailChargeMinor?: number;
  providerWholesaleCostMinor?: number | null;
  metadata?: Record<string, any>;
}

export interface RecordProviderOpParams {
  organizationId: string;
  sessionId?: string | null;
  componentId?: string | null;
  internalUsageId: string;
  provider?: string;
  operationType: ProviderOpType;
  idempotencyKey: string;
  requestPayload: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface LogProviderEventParams {
  organizationId?: string | null;
  provider?: string;
  eventId?: string | null;
  providerResourceId: string;
  eventType: string;
  sequenceNumber?: number | null;
  payload: Record<string, any>;
  metadata?: Record<string, any>;
}

export class TelecomDomainService {
  /**
   * Generates a deterministic SHA-256 fingerprint for request payloads.
   */
  public static generateFingerprint(payload: Record<string, any>): string {
    const jsonStr = JSON.stringify(payload, Object.keys(payload).sort());
    return crypto.createHash('sha256').update(jsonStr).digest('hex');
  }

  /**
   * Creates a new customer telecom usage session.
   */
  public static async createSession(
    client: SupabaseClient,
    params: CreateSessionParams
  ): Promise<TelecomUsageSession> {
    const {
      sessionId,
      organizationId,
      createdByUserId = null,
      sessionType,
      direction,
      currency = 'USD',
      metadata = {},
    } = params;

    const { data, error } = await client
      .from('telecom_usage_sessions')
      .insert({
        session_id: sessionId,
        organization_id: organizationId,
        created_by_user_id: createdByUserId,
        session_type: sessionType,
        direction: direction,
        status: 'active',
        currency: currency,
        total_retail_charge_minor: 0,
        total_wholesale_cost_minor: 0,
        reconciliation_status: 'pending',
        metadata: metadata,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`FAILED_TO_CREATE_SESSION: ${error.message}`);
    }

    return this.mapSession(data);
  }

  /**
   * Creates a provider/billable leg component under an existing session.
   */
  public static async createComponent(
    client: SupabaseClient,
    params: CreateComponentParams
  ): Promise<TelecomUsageComponent> {
    const {
      componentId,
      sessionId,
      organizationId,
      internalUsageId,
      provider = 'twilio',
      providerAccountId = null,
      parentProviderResourceId = null,
      childProviderResourceId = null,
      legType,
      sequenceNumber = 0,
      durationSeconds = 0,
      retailChargeMinor = 0,
      providerWholesaleCostMinor = null,
      metadata = {},
    } = params;

    const { data, error } = await client
      .from('telecom_usage_components')
      .insert({
        component_id: componentId,
        session_id: sessionId,
        organization_id: organizationId,
        internal_usage_id: internalUsageId,
        provider: provider,
        provider_account_id: providerAccountId,
        parent_provider_resource_id: parentProviderResourceId,
        child_provider_resource_id: childProviderResourceId,
        leg_type: legType,
        sequence_number: sequenceNumber,
        duration_seconds: durationSeconds,
        retail_charge_minor: retailChargeMinor,
        provider_wholesale_cost_minor: providerWholesaleCostMinor,
        reconciliation_status: 'pending',
        metadata: metadata,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`FAILED_TO_CREATE_COMPONENT: ${error.message}`);
    }

    return this.mapComponent(data);
  }

  /**
   * Records a provider operation with durable idempotency and fingerprint validation.
   * If the same idempotency key is submitted with a different request fingerprint, FAILS CLOSED!
   */
  public static async recordProviderOperation(
    client: SupabaseClient,
    params: RecordProviderOpParams
  ): Promise<{ operation: TelecomProviderOperation; isDuplicate: boolean }> {
    const {
      organizationId,
      sessionId = null,
      componentId = null,
      internalUsageId,
      provider = 'twilio',
      operationType,
      idempotencyKey,
      requestPayload,
      metadata = {},
    } = params;

    const fingerprint = this.generateFingerprint(requestPayload);

    // 1. Check for existing operation under (organizationId, operationType, idempotencyKey)
    const { data: existingOp } = await client
      .from('telecom_provider_operations')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('operation_type', operationType)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();

    if (existingOp) {
      if (existingOp.request_fingerprint !== fingerprint) {
        throw new Error(
          `IDEMPOTENCY_FINGERPRINT_CONFLICT: Operation ${idempotencyKey} already exists with a different request payload fingerprint.`
        );
      }

      return {
        operation: this.mapOperation(existingOp),
        isDuplicate: true,
      };
    }

    // 2. Insert new provider operation
    const { data, error } = await client
      .from('telecom_provider_operations')
      .insert({
        organization_id: organizationId,
        session_id: sessionId,
        component_id: componentId,
        internal_usage_id: internalUsageId,
        provider: provider,
        operation_type: operationType,
        idempotency_key: idempotencyKey,
        request_fingerprint: fingerprint,
        status: 'prepared',
        reconciliation_status: 'none',
        attempt_count: 1,
        metadata: metadata,
      })
      .select()
      .single();

    if (error) {
      // Re-check for race condition fingerprint conflict
      if (error.code === '23505') {
        const { data: raceOp } = await client
          .from('telecom_provider_operations')
          .select('*')
          .eq('organization_id', organizationId)
          .eq('operation_type', operationType)
          .eq('idempotency_key', idempotencyKey)
          .single();

        if (raceOp.request_fingerprint !== fingerprint) {
          throw new Error(
            `IDEMPOTENCY_FINGERPRINT_CONFLICT: Operation ${idempotencyKey} already exists with a different request payload fingerprint.`
          );
        }

        return {
          operation: this.mapOperation(raceOp),
          isDuplicate: true,
        };
      }
      throw new Error(`FAILED_TO_RECORD_PROVIDER_OPERATION: ${error.message}`);
    }

    return {
      operation: this.mapOperation(data),
      isDuplicate: false,
    };
  }

  /**
   * Durably logs an incoming webhook provider event with multi-column partial unique index deduplication.
   */
  public static async logProviderEvent(
    client: SupabaseClient,
    params: LogProviderEventParams
  ): Promise<{ event: TelecomProviderEventLog | null; isDuplicate: boolean }> {
    const {
      organizationId = null,
      provider = 'twilio',
      eventId = null,
      providerResourceId,
      eventType,
      sequenceNumber = null,
      payload,
      metadata = {},
    } = params;

    const fingerprint = this.generateFingerprint(payload);

    const { data, error } = await client
      .from('telecom_provider_event_log')
      .insert({
        organization_id: organizationId,
        provider: provider,
        event_id: eventId,
        provider_resource_id: providerResourceId,
        event_type: eventType,
        sequence_number: sequenceNumber,
        payload_fingerprint: fingerprint,
        payload: payload,
        processing_result: 'processed',
        metadata: metadata,
      })
      .select()
      .single();

    if (error) {
      // Unique constraint violation means this event was already ingested and deduplicated
      if (error.code === '23505') {
        return { event: null, isDuplicate: true };
      }
      throw new Error(`FAILED_TO_LOG_PROVIDER_EVENT: ${error.message}`);
    }

    return {
      event: this.mapEvent(data),
      isDuplicate: false,
    };
  }

  /**
   * Converts a session and its components to a Customer-Safe DTO (stripping provider SIDs, wholesale costs, margins, and tokens).
   */
  public static async getCustomerSessionSummary(
    client: SupabaseClient,
    sessionId: string
  ): Promise<CustomerTelecomSessionDTO | null> {
    const { data: session } = await client
      .from('telecom_usage_sessions')
      .select('*')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (!session) {
      return null;
    }

    const { data: components } = await client
      .from('telecom_usage_components')
      .select('*')
      .eq('session_id', sessionId);

    const mappedSession = this.mapSession(session);
    const mappedComponents = (components || []).map((c) => this.mapComponent(c));

    return toCustomerTelecomSessionDTO(mappedSession, mappedComponents);
  }

  // Private DB row mappers
  private static mapSession(row: any): TelecomUsageSession {
    return {
      sessionId: row.session_id,
      organizationId: row.organization_id,
      createdByUserId: row.created_by_user_id,
      sessionType: row.session_type,
      direction: row.direction,
      status: row.status,
      currency: row.currency,
      totalRetailChargeMinor: Number(row.total_retail_charge_minor || 0),
      totalWholesaleCostMinor: Number(row.total_wholesale_cost_minor || 0),
      reconciliationStatus: row.reconciliation_status,
      metadata: row.metadata || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private static mapComponent(row: any): TelecomUsageComponent {
    return {
      componentId: row.component_id,
      sessionId: row.session_id,
      organizationId: row.organization_id,
      internalUsageId: row.internal_usage_id,
      provider: row.provider,
      providerAccountId: row.provider_account_id,
      parentProviderResourceId: row.parent_provider_resource_id,
      childProviderResourceId: row.child_provider_resource_id,
      legType: row.leg_type,
      sequenceNumber: Number(row.sequence_number || 0),
      durationSeconds: Number(row.duration_seconds || 0),
      retailChargeMinor: Number(row.retail_charge_minor || 0),
      providerWholesaleCostMinor: row.provider_wholesale_cost_minor !== null ? Number(row.provider_wholesale_cost_minor) : null,
      reconciliationStatus: row.reconciliation_status,
      metadata: row.metadata || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private static mapOperation(row: any): TelecomProviderOperation {
    return {
      id: row.id,
      organizationId: row.organization_id,
      sessionId: row.session_id,
      componentId: row.component_id,
      internalUsageId: row.internal_usage_id,
      provider: row.provider,
      operationType: row.operation_type,
      idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      providerResourceId: row.provider_resource_id,
      status: row.status,
      reconciliationStatus: row.reconciliation_status,
      attemptCount: Number(row.attempt_count || 0),
      dispatchToken: row.dispatch_token,
      lastError: row.last_error,
      metadata: row.metadata || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private static mapEvent(row: any): TelecomProviderEventLog {
    return {
      id: row.id,
      organizationId: row.organization_id,
      provider: row.provider,
      eventId: row.event_id,
      providerResourceId: row.provider_resource_id,
      eventType: row.event_type,
      sequenceNumber: row.sequence_number !== null ? Number(row.sequence_number) : null,
      payloadFingerprint: row.payload_fingerprint,
      payload: row.payload || {},
      receivedAt: row.received_at,
      processedAt: row.processed_at,
      processingResult: row.processing_result,
      errorDetails: row.error_details,
      metadata: row.metadata || {},
    };
  }
}
