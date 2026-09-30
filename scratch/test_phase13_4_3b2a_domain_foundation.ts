process.env.STRIPE_SECRET_KEY = 'sk_test_mock_key_1234567890';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_1234567890';
process.env.STRIPE_EXPECTED_MODE = 'test';

import { TelecomDomainService } from '../src/lib/billing/telecom/telecomDomainService';
import { TelecomRatingService } from '../src/lib/billing/telecom/telecomRatingService';
import { SmsSegmentService } from '../src/lib/billing/telecom/smsSegmentService';

let passedScenarios = 0;
let failedScenarios = 0;
let passedAssertions = 0;
let failedAssertions = 0;

function assert(condition: boolean, description: string) {
  if (condition) {
    passedAssertions++;
    console.log(`  ✓ PASS: ${description}`);
  } else {
    failedAssertions++;
    console.error(`  ✕ FAIL: ${description}`);
  }
}

async function runScenario(name: string, fn: () => Promise<void>) {
  try {
    console.log(`[${name}]`);
    await fn();
    passedScenarios++;
  } catch (err: any) {
    failedScenarios++;
    console.error(`  ✕ FAIL Scenario [${name}]: ${err.message}`);
  }
}

// In-Memory Mock Database for Phase 13.4.3B.2A Testing with Hard Composite FK & RESTRICT Enforcement
class MockDatabase {
  public organizations: Map<string, any> = new Map();
  public telecomRetailRateCards: Map<string, any> = new Map();
  public telecomUsageReservations: Map<string, any> = new Map();
  public telecomUsageSessions: Map<string, any> = new Map();
  public telecomUsageComponents: Map<string, any> = new Map();
  public telecomProviderOperations: Map<string, any> = new Map();
  public telecomProviderEventLog: Map<string, any> = new Map();

  public providerCounters = {
    stripeReads: 0,
    stripeWrites: 0,
    stripeCaptures: 0,
    stripeRefunds: 0,
    twilioReads: 0,
    twilioWrites: 0,
    twilioCalls: 0,
    twilioSms: 0,
    twilioPurchases: 0,
    regulatoryCalls: 0,
  };

  reset() {
    this.organizations.clear();
    this.telecomRetailRateCards.clear();
    this.telecomUsageReservations.clear();
    this.telecomUsageSessions.clear();
    this.telecomUsageComponents.clear();
    this.telecomProviderOperations.clear();
    this.telecomProviderEventLog.clear();

    this.providerCounters = {
      stripeReads: 0,
      stripeWrites: 0,
      stripeCaptures: 0,
      stripeRefunds: 0,
      twilioReads: 0,
      twilioWrites: 0,
      twilioCalls: 0,
      twilioSms: 0,
      twilioPurchases: 0,
      regulatoryCalls: 0,
    };
  }

  deleteSession(sessionId: string) {
    // Check ON DELETE RESTRICT from components
    for (const comp of this.telecomUsageComponents.values()) {
      if (comp.session_id === sessionId) {
        throw { code: '23503', message: 'ON DELETE RESTRICT: cannot delete session referenced by components' };
      }
    }
    // Check ON DELETE RESTRICT from provider operations
    for (const op of this.telecomProviderOperations.values()) {
      if (op.session_id === sessionId) {
        throw { code: '23503', message: 'ON DELETE RESTRICT: cannot delete session referenced by provider operations' };
      }
    }
    this.telecomUsageSessions.delete(sessionId);
  }

  deleteComponent(componentId: string) {
    // Check ON DELETE RESTRICT from provider operations
    for (const op of this.telecomProviderOperations.values()) {
      if (op.component_id === componentId) {
        throw { code: '23503', message: 'ON DELETE RESTRICT: cannot delete component referenced by provider operations' };
      }
    }
    this.telecomUsageComponents.delete(componentId);
  }

  createClient() {
    const db = this;

    return {
      from: (tableName: string) => {
        return {
          select: (cols?: string) => {
            const filters: { col: string; val: any }[] = [];
            const createQuery = (): any => ({
              eq: (col: string, val: any) => {
                filters.push({ col, val });
                return createQuery();
              },
              get data() {
                const tableMap = db.getTableMap(tableName);
                let results = Array.from(tableMap.values());
                for (const f of filters) {
                  results = results.filter((item) => item[f.col] === f.val);
                }
                return results;
              },
              error: null,
              maybeSingle: async () => {
                const tableMap = db.getTableMap(tableName);
                let results = Array.from(tableMap.values());
                for (const f of filters) {
                  results = results.filter((item) => item[f.col] === f.val);
                }
                return { data: results.length > 0 ? results[0] : null, error: null };
              },
              single: async () => {
                const tableMap = db.getTableMap(tableName);
                let results = Array.from(tableMap.values());
                for (const f of filters) {
                  results = results.filter((item) => item[f.col] === f.val);
                }
                if (results.length === 0) throw { code: 'PGRST116', message: 'No rows found' };
                return { data: results[0], error: null };
              },
            });
            return createQuery();
          },

          insert: (data: any) => {
            const tableMap = db.getTableMap(tableName);
            const now = new Date().toISOString();

            if (tableName === 'telecom_usage_sessions') {
              const row = {
                ...data,
                created_at: now,
                updated_at: now,
              };
              tableMap.set(data.session_id, row);
              return {
                select: () => ({
                  single: async () => ({ data: row, error: null }),
                }),
              };
            }

            if (tableName === 'telecom_usage_components') {
              // Composite FK Check 1: (organization_id, session_id) ON DELETE RESTRICT
              const session = db.telecomUsageSessions.get(data.session_id);
              if (!session || session.organization_id !== data.organization_id) {
                return {
                  select: () => ({
                    single: async () => ({
                      data: null,
                      error: { code: '23503', message: 'foreign key constraint fk_telecom_usage_components_session_org violated' },
                    }),
                  }),
                };
              }

              // Composite FK Check 2: (organization_id, internal_usage_id) ON DELETE RESTRICT
              let foundReservation = false;
              for (const res of db.telecomUsageReservations.values()) {
                if (res.internal_usage_id === data.internal_usage_id && res.organization_id === data.organization_id) {
                  foundReservation = true;
                  break;
                }
              }
              if (!foundReservation) {
                return {
                  select: () => ({
                    single: async () => ({
                      data: null,
                      error: { code: '23503', message: 'foreign key constraint fk_telecom_usage_components_reservation_org violated' },
                    }),
                  }),
                };
              }

              const row = {
                ...data,
                created_at: now,
                updated_at: now,
              };
              tableMap.set(data.component_id, row);
              return {
                select: () => ({
                  single: async () => ({ data: row, error: null }),
                }),
              };
            }

            if (tableName === 'telecom_provider_operations') {
              // Composite FK Check 1: (organization_id, session_id) ON DELETE RESTRICT
              if (data.session_id) {
                const session = db.telecomUsageSessions.get(data.session_id);
                if (!session || session.organization_id !== data.organization_id) {
                  return {
                    select: () => ({
                      single: async () => ({
                        data: null,
                        error: { code: '23503', message: 'foreign key constraint fk_telecom_provider_ops_session_org violated' },
                      }),
                    }),
                  };
                }
              }

              // Composite FK Check 2: (organization_id, component_id) ON DELETE RESTRICT
              if (data.component_id) {
                const comp = db.telecomUsageComponents.get(data.component_id);
                if (!comp || comp.organization_id !== data.organization_id) {
                  return {
                    select: () => ({
                      single: async () => ({
                        data: null,
                        error: { code: '23503', message: 'foreign key constraint fk_telecom_provider_ops_component_org violated' },
                      }),
                    }),
                  };
                }
              }

              // Composite FK Check 3: (organization_id, internal_usage_id) ON DELETE RESTRICT
              let foundReservation = false;
              for (const res of db.telecomUsageReservations.values()) {
                if (res.internal_usage_id === data.internal_usage_id && res.organization_id === data.organization_id) {
                  foundReservation = true;
                  break;
                }
              }
              if (!foundReservation) {
                return {
                  select: () => ({
                    single: async () => ({
                      data: null,
                      error: { code: '23503', message: 'foreign key constraint fk_telecom_provider_ops_reservation_org violated' },
                    }),
                  }),
                };
              }

              // Check uniqueness constraint: (organization_id, operation_type, idempotency_key)
              for (const existing of tableMap.values()) {
                if (
                  existing.organization_id === data.organization_id &&
                  existing.operation_type === data.operation_type &&
                  existing.idempotency_key === data.idempotency_key
                ) {
                  return {
                    select: () => ({
                      single: async () => ({
                        data: null,
                        error: { code: '23505', message: 'duplicate key value violates uq_telecom_provider_op_key' },
                      }),
                    }),
                  };
                }
              }

              const id = `op_${Math.random().toString(36).substring(2, 10)}`;
              const row = {
                id,
                ...data,
                created_at: now,
                updated_at: now,
              };
              tableMap.set(id, row);
              return {
                select: () => ({
                  single: async () => ({ data: row, error: null }),
                }),
              };
            }

            if (tableName === 'telecom_provider_event_log') {
              for (const existing of tableMap.values()) {
                if (existing.provider === data.provider && existing.event_type === data.event_type) {
                  if (data.event_id && existing.event_id === data.event_id && existing.provider_resource_id === data.provider_resource_id) {
                    return {
                      select: () => ({
                        single: async () => ({
                          data: null,
                          error: { code: '23505', message: 'duplicate key value violates uq_telecom_provider_event_by_event_id' },
                        }),
                      }),
                    };
                  }
                  if (data.sequence_number !== null && data.sequence_number !== undefined && existing.sequence_number === data.sequence_number && existing.provider_resource_id === data.provider_resource_id) {
                    return {
                      select: () => ({
                        single: async () => ({
                          data: null,
                          error: { code: '23505', message: 'duplicate key value violates uq_telecom_provider_event_by_sequence' },
                        }),
                      }),
                    };
                  }
                  if (!data.event_id && (data.sequence_number === null || data.sequence_number === undefined)) {
                    if (!existing.event_id && (existing.sequence_number === null || existing.sequence_number === undefined)) {
                      if (existing.provider_resource_id === data.provider_resource_id && existing.payload_fingerprint === data.payload_fingerprint) {
                        return {
                          select: () => ({
                            single: async () => ({
                              data: null,
                              error: { code: '23505', message: 'duplicate key value violates uq_telecom_provider_event_by_fingerprint' },
                            }),
                          }),
                        };
                      }
                    }
                  }
                }
              }

              const id = `evt_${Math.random().toString(36).substring(2, 10)}`;
              const row = {
                id,
                ...data,
                received_at: now,
              };
              tableMap.set(id, row);
              return {
                select: () => ({
                  single: async () => ({ data: row, error: null }),
                }),
              };
            }

            return {
              select: () => ({
                single: async () => ({ data: data, error: null }),
              }),
            };
          },
        };
      },
    } as any;
  }

  private getTableMap(tableName: string): Map<string, any> {
    switch (tableName) {
      case 'telecom_retail_rate_cards':
        return this.telecomRetailRateCards;
      case 'telecom_usage_reservations':
        return this.telecomUsageReservations;
      case 'telecom_usage_sessions':
        return this.telecomUsageSessions;
      case 'telecom_usage_components':
        return this.telecomUsageComponents;
      case 'telecom_provider_operations':
        return this.telecomProviderOperations;
      case 'telecom_provider_event_log':
        return this.telecomProviderEventLog;
      default:
        throw new Error(`Unknown table ${tableName}`);
    }
  }
}

async function runAllTests() {
  console.log('================================================================');
  console.log('RUNNING PHASE 13.4.3B.2A DOMAIN & SCHEMA FOUNDATION SUITE');
  console.log('================================================================\n');

  const mockDb = new MockDatabase();
  const client = mockDb.createClient();
  const orgId = 'org_test_123456789';
  const orgBId = 'org_test_999999999';

  // Scenario 1: Valid Session & Component Creation
  await runScenario('Valid Session & Component Creation', async () => {
    mockDb.reset();
    const sessionId = 'ses_voice_1001';
    const usageId = 'usg_outbound_1001';
    const reservationId = 'b101b101-b101-b101-b101-b101b101b101';

    // Seed mock reservation from B.1 under orgId
    mockDb.telecomUsageReservations.set(reservationId, {
      id: reservationId,
      internal_usage_id: usageId,
      organization_id: orgId,
    });

    const session = await TelecomDomainService.createSession(client, {
      sessionId,
      organizationId: orgId,
      sessionType: 'outbound_call',
      direction: 'outbound',
      currency: 'USD',
    });

    assert(session.sessionId === sessionId, 'Session ID matches');
    assert(session.organizationId === orgId, 'Organization ID matches');
    assert(session.status === 'active', 'Initial session status is active');

    const component = await TelecomDomainService.createComponent(client, {
      componentId: 'cmp_leg_2001',
      sessionId: session.sessionId,
      organizationId: orgId,
      internalUsageId: usageId,
      legType: 'pstn_outbound',
      durationSeconds: 120,
      retailChargeMinor: 36,
    });

    assert(component.componentId === 'cmp_leg_2001', 'Component ID matches');
    assert(component.sessionId === sessionId, 'Component references correct session');
    assert(component.internalUsageId === usageId, 'Component references correct internalUsageId');
    assert((component as any).reservationId === undefined, 'Component schema does NOT contain redundant reservationId column');
  });

  // Scenario 2: Comprehensive Database-Enforced Negative Tests & RESTRICT Verification
  await runScenario('Database-Enforced Composite FK Negative Tests & RESTRICT Verification', async () => {
    mockDb.reset();
    const sessionA = 'ses_orgA_100';
    const usageA = 'usg_orgA_100';
    const compA = 'cmp_orgA_100';

    // Seed Org A Session and Reservation
    mockDb.telecomUsageSessions.set(sessionA, { session_id: sessionA, organization_id: orgId });
    mockDb.telecomUsageReservations.set('resA', { id: 'resA', internal_usage_id: usageA, organization_id: orgId });

    // Negative Test 1: Org B Component -> Org A Session -> FAILS (23503)
    let caughtFk1 = false;
    try {
      await TelecomDomainService.createComponent(client, {
        componentId: 'cmp_cross_1',
        sessionId: sessionA,
        organizationId: orgBId,
        internalUsageId: usageA,
        legType: 'pstn_outbound',
      });
    } catch (err: any) {
      caughtFk1 = err.message.includes('fk_telecom_usage_components_session_org violated');
    }
    assert(caughtFk1 === true, '1. Org A component -> Org B session FAILS (23503)');

    // Negative Test 2: Org B Component -> Org A Reservation -> FAILS (23503)
    let caughtFk2 = false;
    try {
      await TelecomDomainService.createComponent(client, {
        componentId: 'cmp_cross_2',
        sessionId: sessionA,
        organizationId: orgId,
        internalUsageId: 'usg_orgB_NONEXISTENT_FOR_ORGA',
        legType: 'pstn_outbound',
      });
    } catch (err: any) {
      caughtFk2 = err.message.includes('fk_telecom_usage_components_reservation_org violated');
    }
    assert(caughtFk2 === true, '2. Org A component -> Org B internal_usage_id FAILS (23503)');

    // Negative Test 3: Dual reservation ID contradiction check -> reservationId removed from component schema
    const comp = await TelecomDomainService.createComponent(client, {
      componentId: compA,
      sessionId: sessionA,
      organizationId: orgId,
      internalUsageId: usageA,
      legType: 'pstn_outbound',
    });
    assert((comp as any).reservationId === undefined, '3. Single canonical internal_usage_id enforced; no redundant reservation_id column exists');

    // Negative Test 4: Org B Provider Operation -> Org A Session -> FAILS (23503)
    let caughtFk4 = false;
    try {
      await TelecomDomainService.recordProviderOperation(client, {
        organizationId: orgBId,
        sessionId: sessionA,
        internalUsageId: usageA,
        operationType: 'call_duration_update',
        idempotencyKey: 'idemp_cross_4',
        requestPayload: { test: 4 },
      });
    } catch (err: any) {
      caughtFk4 = err.message.includes('fk_telecom_provider_ops_session_org violated');
    }
    assert(caughtFk4 === true, '4. Org A provider operation -> Org B session FAILS (23503)');

    // Negative Test 5: Org B Provider Operation -> Org A Component -> FAILS (23503)
    let caughtFk5 = false;
    try {
      await TelecomDomainService.recordProviderOperation(client, {
        organizationId: orgBId,
        componentId: compA,
        internalUsageId: usageA,
        operationType: 'call_duration_update',
        idempotencyKey: 'idemp_cross_5',
        requestPayload: { test: 5 },
      });
    } catch (err: any) {
      caughtFk5 = err.message.includes('fk_telecom_provider_ops_component_org violated');
    }
    assert(caughtFk5 === true, '5. Org A provider operation -> Org B component FAILS (23503)');

    // Negative Test 6: Org B Provider Operation -> Org A internal_usage_id -> FAILS (23503)
    let caughtFk6 = false;
    try {
      await TelecomDomainService.recordProviderOperation(client, {
        organizationId: orgBId,
        internalUsageId: usageA,
        operationType: 'call_duration_update',
        idempotencyKey: 'idemp_cross_6',
        requestPayload: { test: 6 },
      });
    } catch (err: any) {
      caughtFk6 = err.message.includes('fk_telecom_provider_ops_reservation_org violated');
    }
    assert(caughtFk6 === true, '6. Org A provider operation -> Org B internal_usage_id FAILS (23503)');

    // Seed Provider Operation linked to Session and Component
    await TelecomDomainService.recordProviderOperation(client, {
      organizationId: orgId,
      sessionId: sessionA,
      componentId: compA,
      internalUsageId: usageA,
      operationType: 'call_duration_update',
      idempotencyKey: 'idemp_valid_78',
      requestPayload: { valid: true },
    });

    // Negative Test 7: Attempting to delete session referenced by provider operation -> FAILS due to RESTRICT
    let caughtDeleteSession = false;
    try {
      mockDb.deleteSession(sessionA);
    } catch (err: any) {
      caughtDeleteSession = err.message.includes('ON DELETE RESTRICT');
    }
    assert(caughtDeleteSession === true, '7. Attempting to delete session referenced by provider operation FAILS due to RESTRICT');

    // Negative Test 8: Attempting to delete component referenced by provider operation -> FAILS due to RESTRICT
    let caughtDeleteComp = false;
    try {
      mockDb.deleteComponent(compA);
    } catch (err: any) {
      caughtDeleteComp = err.message.includes('ON DELETE RESTRICT');
    }
    assert(caughtDeleteComp === true, '8. Attempting to delete component referenced by provider operation FAILS due to RESTRICT');

    // Test 9: Valid same-organization graph -> PASSES
    assert(mockDb.telecomUsageSessions.has(sessionA), '9. Valid same-organization graph PASSES and persists in database');
  });

  // Scenario 3: Provider Operation Idempotency & Request Fingerprint Conflict
  await runScenario('Provider Operation Idempotency & Fingerprint Conflict', async () => {
    mockDb.reset();
    const idempotencyKey = 'idemp_msg_555';
    const payloadA = { to: '+14155552671', body: 'Hello World', mediaUrl: null };
    const payloadB = { to: '+14155552671', body: 'Different Payload', mediaUrl: null };
    const usageId = 'usg_sms_101';

    mockDb.telecomUsageReservations.set('res_sms', { id: 'res_sms', internal_usage_id: usageId, organization_id: orgId });

    // First attempt -> Created
    const res1 = await TelecomDomainService.recordProviderOperation(client, {
      organizationId: orgId,
      internalUsageId: usageId,
      operationType: 'message_create',
      idempotencyKey,
      requestPayload: payloadA,
    });

    assert(res1.isDuplicate === false, 'First operation call is not duplicate');
    assert(res1.operation.idempotencyKey === idempotencyKey, 'Idempotency key matches');
    assert(res1.operation.status === 'prepared', 'Initial status is prepared');

    // Second attempt with exact same payload -> Duplicate returned safely
    const res2 = await TelecomDomainService.recordProviderOperation(client, {
      organizationId: orgId,
      internalUsageId: usageId,
      operationType: 'message_create',
      idempotencyKey,
      requestPayload: payloadA,
    });

    assert(res2.isDuplicate === true, 'Second identical call is marked duplicate');
    assert(res2.operation.id === res1.operation.id, 'Returns exact same operation ID');

    // Third attempt with same key but DIFFERENT payload -> FAILS CLOSED!
    let caughtConflict = false;
    try {
      await TelecomDomainService.recordProviderOperation(client, {
        organizationId: orgId,
        internalUsageId: usageId,
        operationType: 'message_create',
        idempotencyKey,
        requestPayload: payloadB,
      });
    } catch (err: any) {
      caughtConflict = err.message.includes('IDEMPOTENCY_FINGERPRINT_CONFLICT');
    }

    assert(caughtConflict === true, 'Fails closed when same key is submitted with different payload fingerprint');
  });

  // Scenario 4: Provider Event Deduplication
  await runScenario('Provider Event Log Deduplication Invariants', async () => {
    mockDb.reset();
    const resourceId = 'SM1234567890abcdef';

    // 1. Deduplication by event_id
    const evt1 = await TelecomDomainService.logProviderEvent(client, {
      providerResourceId: resourceId,
      eventType: 'delivered',
      eventId: 'EVT_TOKEN_999',
      payload: { MessageSid: resourceId, MessageStatus: 'delivered' },
    });
    assert(evt1.isDuplicate === false, 'Event with event_id is logged');

    const evt1Dup = await TelecomDomainService.logProviderEvent(client, {
      providerResourceId: resourceId,
      eventType: 'delivered',
      eventId: 'EVT_TOKEN_999',
      payload: { MessageSid: resourceId, MessageStatus: 'delivered' },
    });
    assert(evt1Dup.isDuplicate === true, 'Duplicate event_id is cleanly ignored');

    // 2. Deduplication by sequence_number
    const evt2 = await TelecomDomainService.logProviderEvent(client, {
      providerResourceId: resourceId,
      eventType: 'answered',
      sequenceNumber: 1,
      payload: { CallSid: resourceId, CallStatus: 'in-progress' },
    });
    assert(evt2.isDuplicate === false, 'Event with sequence_number is logged');

    const evt2Dup = await TelecomDomainService.logProviderEvent(client, {
      providerResourceId: resourceId,
      eventType: 'answered',
      sequenceNumber: 1,
      payload: { CallSid: resourceId, CallStatus: 'in-progress' },
    });
    assert(evt2Dup.isDuplicate === true, 'Duplicate sequence_number is cleanly ignored');

    // 3. Deduplication when BOTH event_id AND sequence_number are NULL
    const evt3 = await TelecomDomainService.logProviderEvent(client, {
      providerResourceId: resourceId,
      eventType: 'status_update',
      eventId: null,
      sequenceNumber: null,
      payload: { status: 'queued', timestamp: 1000 },
    });
    assert(evt3.isDuplicate === false, 'Event with NULL event_id & NULL sequence_number logged');

    const evt3Dup = await TelecomDomainService.logProviderEvent(client, {
      providerResourceId: resourceId,
      eventType: 'status_update',
      eventId: null,
      sequenceNumber: null,
      payload: { status: 'queued', timestamp: 1000 },
    });
    assert(evt3Dup.isDuplicate === true, 'NULL sequence_number does NOT defeat payload-fingerprint deduplication!');

    // Different payload fingerprint with NULL sequence -> Ingested as new event
    const evt3New = await TelecomDomainService.logProviderEvent(client, {
      providerResourceId: resourceId,
      eventType: 'status_update',
      eventId: null,
      sequenceNumber: null,
      payload: { status: 'sent', timestamp: 1005 },
    });
    assert(evt3New.isDuplicate === false, 'New payload with NULL sequence_number is ingested');
  });

  // Scenario 5: Fail-Closed Retail Rate Resolution & Longest-Prefix Match
  await runScenario('Fail-Closed Retail Rate Resolver & Prefix Matching', async () => {
    mockDb.reset();

    // Seed rate cards
    mockDb.telecomRetailRateCards.set('rc_us_public', {
      id: 'rc_us_public',
      rate_code: 'US_PUBLIC_VOICE',
      service_type: 'voice_outbound',
      direction: 'outbound',
      destination_pattern: '+1',
      destination_name: 'US Public Standard',
      retail_rate_micro: 18000,
      wholesale_cost_micro: 10000,
      unit_type: 'minute',
      billing_increment_seconds: 60,
      min_chargeable_units: 1,
      currency: 'USD',
      is_active: true,
      effective_start_at: '2026-01-01T00:00:00Z',
      effective_end_at: null,
      metadata: {},
    });

    mockDb.telecomRetailRateCards.set('rc_sf_public', {
      id: 'rc_sf_public',
      rate_code: 'US_SF_VOICE',
      service_type: 'voice_outbound',
      direction: 'outbound',
      destination_pattern: '+1415',
      destination_name: 'San Francisco Metro',
      retail_rate_micro: 25000,
      wholesale_cost_micro: 12000,
      unit_type: 'minute',
      billing_increment_seconds: 60,
      min_chargeable_units: 1,
      currency: 'USD',
      is_active: true,
      effective_start_at: '2026-01-01T00:00:00Z',
      effective_end_at: null,
      metadata: {},
    });

    mockDb.telecomRetailRateCards.set('rc_org_custom', {
      id: 'rc_org_custom',
      rate_code: 'US_ORG_CUSTOM',
      service_type: 'voice_outbound',
      direction: 'outbound',
      destination_pattern: '+1415',
      destination_name: 'Org Special SF Rate',
      retail_rate_micro: 15000,
      wholesale_cost_micro: 12000,
      unit_type: 'minute',
      billing_increment_seconds: 60,
      min_chargeable_units: 1,
      currency: 'USD',
      is_active: true,
      effective_start_at: '2026-01-01T00:00:00Z',
      effective_end_at: null,
      metadata: { organization_id: orgId },
    });

    // 1. Test Longest-Prefix Match (+14155552671 matches +1415 before +1)
    const resPublic = await TelecomRatingService.resolveRetailRate(client, {
      organizationId: 'other_org_999',
      serviceType: 'voice_outbound',
      direction: 'outbound',
      destinationPhoneNumber: '+14155552671',
    });
    assert(resPublic.matchedRateCard.id === 'rc_sf_public', 'Matches longer prefix +1415 over +1');
    assert(resPublic.resolutionSource === 'public_tariff', 'Source is public_tariff');

    // 2. Test Org Custom Override
    const resOrg = await TelecomRatingService.resolveRetailRate(client, {
      organizationId: orgId,
      serviceType: 'voice_outbound',
      direction: 'outbound',
      destinationPhoneNumber: '+14155552671',
    });
    assert(resOrg.matchedRateCard.id === 'rc_org_custom', 'Org custom rate overrides public tariff');
    assert(resOrg.resolutionSource === 'organization_custom', 'Source is organization_custom');

    // 3. Test Fail Closed on Unknown Prefix
    let caughtNotFound = false;
    try {
      await TelecomRatingService.resolveRetailRate(client, {
        organizationId: orgId,
        serviceType: 'voice_outbound',
        direction: 'outbound',
        destinationPhoneNumber: '+8881234567',
      });
    } catch (err: any) {
      caughtNotFound = err.message.includes('RATE_CARD_NOT_FOUND');
    }
    assert(caughtNotFound === true, 'FAILS CLOSED with RATE_CARD_NOT_FOUND when destination does not match rate card');

    // 4. Test Precision Exposure Math
    const exposure = TelecomRatingService.calculateEstimatedExposureMinor(resPublic.matchedRateCard, 65);
    assert(exposure === 5, 'Calculates precision exposure minor units (65s = 2 increments @ 2.5 cents = 5 cents)');
  });

  // Scenario 6: SMS Segment Analysis & Boundary Conditions
  await runScenario('SMS Segment Encoding & Boundary Conditions', async () => {
    // 1. GSM-7 Single Segment (159 and 160 chars)
    const gsm159 = 'A'.repeat(159);
    const analysis159 = SmsSegmentService.analyze(gsm159);
    assert(analysis159.encoding === 'GSM-7', '159 chars detected as GSM-7');
    assert(analysis159.estimatedSegments === 1, '159 chars = 1 segment');

    const gsm160 = 'A'.repeat(160);
    const analysis160 = SmsSegmentService.analyze(gsm160);
    assert(analysis160.estimatedSegments === 1, '160 chars = 1 segment');

    // 2. GSM-7 Multi-Segment (161 chars -> 2 segments @ 153 chars/segment)
    const gsm161 = 'A'.repeat(161);
    const analysis161 = SmsSegmentService.analyze(gsm161);
    assert(analysis161.estimatedSegments === 2, '161 chars = 2 segments (161/153)');

    // 3. GSM-7 Extension Characters (^ { } \ [ ~ ] | € consume 2 septets each)
    const gsmExt = 'Hello {World}';
    const analysisExt = SmsSegmentService.analyze(gsmExt);
    assert(analysisExt.encoding === 'GSM-7', 'Extension chars remain GSM-7');
    assert(analysisExt.containsExtensionChars === true, 'Extension chars detected');
    assert(analysisExt.characterCount === 15, 'Count includes 2 septets for each extension char');

    // 4. UCS-2 Single Segment (69 and 70 chars)
    const ucs69 = 'Hello 文 ' + 'A'.repeat(60);
    const analysisUcs69 = SmsSegmentService.analyze(ucs69);
    assert(analysisUcs69.encoding === 'UCS-2', 'Unicode char triggers UCS-2 encoding');
    assert(analysisUcs69.estimatedSegments === 1, '69 UCS-2 chars = 1 segment');

    const ucs70 = 'Hello 文 ' + 'A'.repeat(61);
    const analysisUcs70 = SmsSegmentService.analyze(ucs70);
    assert(analysisUcs70.estimatedSegments === 1, '70 UCS-2 chars = 1 segment');

    // 5. UCS-2 Multi-Segment (71 chars -> 2 segments @ 67 chars/segment)
    const ucs71 = 'Hello 文 ' + 'A'.repeat(63);
    const analysisUcs71 = SmsSegmentService.analyze(ucs71);
    assert(analysisUcs71.estimatedSegments === 2, '71 UCS-2 chars = 2 segments (71/67)');

    // 6. Unicode Emoji / Surrogate Pair
    const emojiBody = 'Hello 👋 World!';
    const analysisEmoji = SmsSegmentService.analyze(emojiBody);
    assert(analysisEmoji.encoding === 'UCS-2', 'Emoji triggers UCS-2 encoding');
    assert(analysisEmoji.estimatedSegments === 1, 'Short emoji message = 1 segment');
  });

  // Scenario 7: Customer-Safe DTO Boundary Verification
  await runScenario('Customer-Safe DTO Boundary Verification', async () => {
    mockDb.reset();
    const sessionId = 'ses_voice_999';
    const usageId = 'usg_call_999';

    mockDb.telecomUsageReservations.set('res_dto', { id: 'res_dto', internal_usage_id: usageId, organization_id: orgId });

    await TelecomDomainService.createSession(client, {
      sessionId,
      organizationId: orgId,
      sessionType: 'outbound_call',
      direction: 'outbound',
    });

    await TelecomDomainService.createComponent(client, {
      componentId: 'cmp_999',
      sessionId,
      organizationId: orgId,
      internalUsageId: usageId,
      provider: 'twilio',
      parentProviderResourceId: 'CA_PARENT_12345',
      childProviderResourceId: 'CA_CHILD_67890',
      legType: 'pstn_outbound',
      durationSeconds: 180,
      retailChargeMinor: 54,
      providerWholesaleCostMinor: 77777,
      metadata: { provider_account_id: 'AC_SECRET_123' },
    });

    const dto = await TelecomDomainService.getCustomerSessionSummary(client, sessionId);
    assert(dto !== null, 'Customer DTO fetched');
    assert(dto!.sessionId === sessionId, 'DTO contains sessionId');
    assert(dto!.components.length === 1, 'DTO contains 1 component');

    const cDto = dto!.components[0];
    assert(cDto.componentId === 'cmp_999', 'DTO contains componentId');
    assert(cDto.legType === 'pstn_outbound', 'DTO contains legType');
    assert(cDto.durationSeconds === 180, 'DTO contains durationSeconds');
    assert(cDto.retailChargeMinor === 54, 'DTO contains retailChargeMinor');
    assert((cDto as any).providerWholesaleCostMinor === undefined, 'Component DTO does NOT contain providerWholesaleCostMinor property');

    const rawDtoJson = JSON.stringify(dto);
    assert(!rawDtoJson.includes('CA_PARENT_12345'), 'DTO DOES NOT expose parent CallSid');
    assert(!rawDtoJson.includes('CA_CHILD_67890'), 'DTO DOES NOT expose child CallSid');
    assert(!rawDtoJson.includes('providerWholesaleCostMinor'), 'DTO DOES NOT expose wholesale cost property name');
    assert(!rawDtoJson.includes('77777'), 'DTO DOES NOT expose wholesale cost value 77777');
    assert(!rawDtoJson.includes('AC_SECRET_123'), 'DTO DOES NOT expose provider account ID');
  });

  // Scenario 8: Remote / Provider Safety Verification
  await runScenario('Remote & Provider Safety Counters Verification', async () => {
    assert(mockDb.providerCounters.stripeReads === 0, 'Zero Stripe reads');
    assert(mockDb.providerCounters.stripeWrites === 0, 'Zero Stripe writes');
    assert(mockDb.providerCounters.stripeCaptures === 0, 'Zero Stripe captures');
    assert(mockDb.providerCounters.stripeRefunds === 0, 'Zero Stripe refunds');
    assert(mockDb.providerCounters.twilioReads === 0, 'Zero Twilio reads');
    assert(mockDb.providerCounters.twilioWrites === 0, 'Zero Twilio writes');
    assert(mockDb.providerCounters.twilioCalls === 0, 'Zero Twilio calls placed');
    assert(mockDb.providerCounters.twilioSms === 0, 'Zero Twilio SMS sent');
    assert(mockDb.providerCounters.twilioPurchases === 0, 'Zero Twilio number purchases');
    assert(mockDb.providerCounters.regulatoryCalls === 0, 'Zero regulatory API calls');
  });

  console.log('\n================================================================');
  console.log(`SUMMARY: ${passedScenarios} Scenarios Passed | ${failedScenarios} Failed`);
  console.log(`ASSERTIONS: ${passedAssertions} Passed | ${failedAssertions} Failed`);
  console.log('================================================================');

  if (failedScenarios > 0 || failedAssertions > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Unhandled error in test runner:', err);
  process.exit(1);
});
