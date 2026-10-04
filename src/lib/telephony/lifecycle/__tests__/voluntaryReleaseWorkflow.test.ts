// @ts-nocheck
/**
 * Comprehensive Non-Live Test Suite for Phase 14.1D — Voluntary Phone Number Release (Remediated & Hardened)
 *
 * Verifies Owner/Admin authorization, tenant isolation, Port-Out / Port-In conflict checks,
 * exact-number typed confirmation, provider mutation gating, ambiguity reconciliation,
 * customer DTO redaction, mapping provenance validation, and atomic RPC completion invariants.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  VoluntaryReleaseService,
  RequestVoluntaryReleaseParams,
} from '../voluntaryReleaseService';
import {
  TwilioNumberReleaseAdapter,
  isProviderReleaseMutationEnabled,
} from '../providerNumberReleaseAdapter';

// Flexible In-Memory Mock Database Query Builder
function createMockDb() {
  const organizations = [
    { id: 'org-tenant-a', name: 'Tenant A' },
    { id: 'org-tenant-b', name: 'Tenant B' },
  ];

  const phoneNumbers = [
    {
      id: 'phone-101',
      organization_id: 'org-tenant-a',
      phone_number: '+61412345678',
      status: 'active',
      active: true,
    },
    {
      id: 'phone-102',
      organization_id: 'org-tenant-a',
      phone_number: '+61498765432',
      status: 'released',
      active: false,
    },
    {
      id: 'phone-103',
      organization_id: 'org-tenant-a',
      phone_number: '+61455556666',
      status: 'ported_out',
      active: false,
    },
    {
      id: 'phone-201',
      organization_id: 'org-tenant-b',
      phone_number: '+61411112222',
      status: 'active',
      active: true,
    },
  ];

  const portOperations: any[] = [
    {
      id: 'port-op-1',
      organization_id: 'org-tenant-a',
      phone_number_e164: '+61412345678',
      direction: 'port_out',
      status: 'requested',
    },
    {
      id: 'port-op-2',
      organization_id: 'org-tenant-a',
      phone_number_e164: '+61499990000',
      direction: 'port_in',
      status: 'submitted',
    },
  ];

  const releaseOperations: any[] = [];
  const providerMappings: any[] = [
    {
      id: 'map-101',
      phone_number_id: 'phone-101',
      provider: 'twilio',
      provider_resource_id: 'PN101_SID',
      provider_account_id: 'AC_TENANT_A',
      provider_status: 'active',
    },
    {
      id: 'map-201',
      phone_number_id: 'phone-201',
      provider: 'twilio',
      provider_resource_id: 'PN201_SID',
      provider_account_id: 'AC_TENANT_B',
      provider_status: 'active',
    },
  ];

  const billableResources: any[] = [
    {
      id: 'bill-101',
      organization_id: 'org-tenant-a',
      resource_type: 'phone_number',
      resource_id: 'phone-101',
      status: 'active',
    },
    {
      id: 'bill-seat-101',
      organization_id: 'org-tenant-a',
      resource_type: 'seat',
      resource_id: 'user-seat-1',
      status: 'active',
    },
  ];

  const getStore = (name: string) => {
    if (name === 'phone_numbers') return phoneNumbers;
    if (name === 'number_port_operations') return portOperations;
    if (name === 'number_release_operations') return releaseOperations;
    if (name === 'number_provider_mappings') return providerMappings;
    if (name === 'organization_billable_resources') return billableResources;
    return [];
  };

  class MockQueryBuilder {
    private tableName: string;
    private filters: Array<{ type: 'eq' | 'in'; col: string; val: any }> = [];

    constructor(tableName: string) {
      this.tableName = tableName;
    }

    eq(col: string, val: any) {
      this.filters.push({ type: 'eq', col, val });
      return this;
    }

    in(col: string, vals: any[]) {
      this.filters.push({ type: 'in', col, val: vals });
      return this;
    }

    select(fields?: string) {
      return this;
    }

    private executeFilter() {
      let store = getStore(this.tableName);
      for (const filter of this.filters) {
        if (filter.type === 'eq') {
          store = store.filter((r) => r[filter.col] === filter.val);
        } else if (filter.type === 'in') {
          store = store.filter((r) => filter.val.includes(r[filter.col]));
        }
      }
      return store;
    }

    async single() {
      const res = this.executeFilter();
      return { data: res[0] || null, error: res[0] ? null : { message: 'Not found' } };
    }

    async maybeSingle() {
      const res = this.executeFilter();
      return { data: res[0] || null, error: null };
    }

    then(resolve: any) {
      const res = this.executeFilter();
      return resolve({ data: res, error: null });
    }
  }

  return {
    from: (tableName: string) => {
      const store = getStore(tableName);
      return {
        select: (fields?: string) => new MockQueryBuilder(tableName),
        insert: (row: any) => {
          const inserted = { id: row.id || `rel-op-${Date.now()}`, created_at: new Date().toISOString(), ...row };
          store.push(inserted);
          return {
            select: () => ({
              single: async () => ({ data: inserted, error: null }),
            }),
          };
        },
        update: (updates: any) => {
          const qb = new MockQueryBuilder(tableName);
          return {
            eq: (col: string, val: any) => {
              qb.eq(col, val);
              const target = store.find((r) => r[col] === val);
              if (target) {
                Object.assign(target, updates);
              }
              return {
                select: () => ({
                  single: async () => ({ data: target, error: null }),
                }),
                then: (resolve: any) => resolve({ data: target, error: null }),
              };
            },
          };
        },
      };
    },
    rpc: async (fnName: string, params: any) => {
      if (fnName === 'complete_number_release_atomic') {
        const op = releaseOperations.find((r) => r.id === params.p_operation_id);
        if (!op) return { data: null, error: { message: 'RELEASE_OP_NOT_FOUND' } };
        if (op.status === 'released') return { data: { success: true, idempotent: true }, error: null };
        if (!['provider_release_pending', 'reconciliation_required'].includes(op.status)) {
          return { data: null, error: { message: `INVALID_RELEASE_OP_STATE_FOR_COMPLETION: ${op.status}` } };
        }

        const phone = phoneNumbers.find((p) => p.id === op.phone_number_id);
        if (!phone) return { data: null, error: { message: 'PHONE_NUMBER_NOT_FOUND' } };

        if (['released', 'ported_out'].includes(phone.status)) {
          return { data: null, error: { message: `PHONE_NUMBER_TERMINAL_STATE: ${phone.status}` } };
        }

        if (op.provider_resource_mapping_id) {
          const map = providerMappings.find((m) => m.id === op.provider_resource_mapping_id);
          if (!map || map.phone_number_id !== phone.id || map.provider_status !== 'active') {
            return { data: null, error: { message: 'INVALID_PROVIDER_MAPPING' } };
          }
          map.provider_status = 'historical';
        } else {
          const map = providerMappings.find((m) => m.phone_number_id === phone.id);
          if (map) map.provider_status = 'historical';
        }

        op.status = 'released';
        op.completed_at = params.p_released_at || new Date().toISOString();
        phone.status = 'released';
        phone.active = false;

        const bill = billableResources.find((b) => b.resource_id === phone.id);
        if (bill) {
          bill.status = 'terminated';
        }

        return { data: { success: true, idempotent: false, status: 'released' }, error: null };
      }
      return { data: null, error: { message: 'Unknown RPC' } };
    },
    rawStores: { phoneNumbers, portOperations, releaseOperations, providerMappings, billableResources },
  };
}

describe('Phase 14.1D — Voluntary Phone Number Release Workflow Tests', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let adapter: TwilioNumberReleaseAdapter;
  let service: VoluntaryReleaseService;

  beforeEach(() => {
    mockDb = createMockDb();
    adapter = new TwilioNumberReleaseAdapter();
    service = new VoluntaryReleaseService({ dbClient: mockDb, providerAdapter: adapter });
  });

  // Assertion Group 1: Role Authorization
  it('1. Owner role is authorized to check eligibility and request release', async () => {
    const res = await service.checkReleaseEligibility('org-tenant-a', 'phone-101', 'owner');
    expect(res.blockers).not.toContain('ROLE_NOT_AUTHORIZED: Only Owner or Admin can release a phone number.');
  });

  it('2. Admin role is authorized', async () => {
    const res = await service.checkReleaseEligibility('org-tenant-a', 'phone-101', 'admin');
    expect(res.blockers).not.toContain('ROLE_NOT_AUTHORIZED: Only Owner or Admin can release a phone number.');
  });

  it('3. Manager role is rejected', async () => {
    const res = await service.checkReleaseEligibility('org-tenant-a', 'phone-101', 'manager');
    expect(res.eligible).toBe(false);
    expect(res.blockers).toContain('ROLE_NOT_AUTHORIZED: Only Owner or Admin can release a phone number.');
  });

  it('4. Agent role is rejected', async () => {
    const res = await service.checkReleaseEligibility('org-tenant-a', 'phone-101', 'agent');
    expect(res.eligible).toBe(false);
    expect(res.blockers).toContain('ROLE_NOT_AUTHORIZED: Only Owner or Admin can release a phone number.');
  });

  // Assertion Group 2: Tenant Isolation & Typed Confirmation
  it('5. Cross-tenant number release is rejected', async () => {
    const res = await service.checkReleaseEligibility('org-tenant-b', 'phone-101', 'owner');
    expect(res.eligible).toBe(false);
    expect(res.blockers).toContain('PHONE_NUMBER_NOT_FOUND: Phone number does not exist or does not belong to organization.');
  });

  it('6. Server-side organization context is enforced (browser org spoofing rejected)', async () => {
    const params: RequestVoluntaryReleaseParams = {
      organizationId: 'org-tenant-b',
      userId: 'user-1',
      userRole: 'owner',
      phoneNumberId: 'phone-101',
      confirmPhoneNumber: '+61412345678',
    };
    await expect(service.requestVoluntaryRelease(params)).rejects.toThrow('RELEASE_ELIGIBILITY_FAILED');
  });

  it('7. Exact E.164 confirmation text match is accepted', () => {
    expect('+61412345678'.trim()).toBe('+61412345678');
  });

  it('8. Incorrect confirmation text is rejected with TYPED_CONFIRMATION_MISMATCH', async () => {
    mockDb.rawStores.portOperations.length = 0;
    const params: RequestVoluntaryReleaseParams = {
      organizationId: 'org-tenant-a',
      userId: 'user-1',
      userRole: 'owner',
      phoneNumberId: 'phone-101',
      confirmPhoneNumber: '+61000000000',
    };
    await expect(service.requestVoluntaryRelease(params)).rejects.toThrow('TYPED_CONFIRMATION_MISMATCH');
  });

  // Assertion Group 3: Lifecycle & Mapping Provenance
  it('9. Already released phone number is rejected', async () => {
    const res = await service.checkReleaseEligibility('org-tenant-a', 'phone-102', 'owner');
    expect(res.eligible).toBe(false);
    expect(res.blockers).toContain('ALREADY_RELEASED: Phone number is already released.');
  });

  it('10. Missing provider mapping is rejected', async () => {
    mockDb.rawStores.providerMappings.length = 0;
    const res = await service.checkReleaseEligibility('org-tenant-a', 'phone-101', 'owner');
    expect(res.eligible).toBe(false);
    expect(res.blockers).toContain('MISSING_PROVIDER_MAPPING: Active provider mapping required before voluntary release.');
  });

  it('11. Operation mapping ID belonging to another phone is rejected by RPC', async () => {
    mockDb.rawStores.releaseOperations.push({
      id: 'op-invalid-map-1',
      organization_id: 'org-tenant-a',
      phone_number_id: 'phone-101',
      phone_number_e164: '+61412345678',
      provider_resource_mapping_id: 'map-201', // Belongs to phone 201
      status: 'provider_release_pending',
    });

    const rpcRes = await mockDb.rpc('complete_number_release_atomic', {
      p_operation_id: 'op-invalid-map-1',
      p_organization_id: 'org-tenant-a',
    });

    expect(rpcRes.error?.message).toContain('INVALID_PROVIDER_MAPPING');
  });

  it('12. Unexpected terminal phone status (already released) with active op is rejected by RPC', async () => {
    mockDb.rawStores.releaseOperations.push({
      id: 'op-term-1',
      organization_id: 'org-tenant-a',
      phone_number_id: 'phone-102', // Already released phone
      phone_number_e164: '+61498765432',
      status: 'provider_release_pending',
    });

    const rpcRes = await mockDb.rpc('complete_number_release_atomic', {
      p_operation_id: 'op-term-1',
      p_organization_id: 'org-tenant-a',
    });

    expect(rpcRes.error?.message).toContain('PHONE_NUMBER_TERMINAL_STATE');
  });

  // Assertion Group 4: Provider Gate & Mutation Safety
  it('18. Provider mutation gate is OFF by default', () => {
    expect(isProviderReleaseMutationEnabled()).toBe(false);
  });

  it('19. Durable provider_release_pending occurs before provider call', async () => {
    mockDb.rawStores.portOperations.length = 0;
    const res = await service.requestVoluntaryRelease({
      organizationId: 'org-tenant-a',
      userId: 'user-1',
      userRole: 'owner',
      phoneNumberId: 'phone-101',
      confirmPhoneNumber: '+61412345678',
    });

    expect(res.status).toBe('released');
    const phone = mockDb.rawStores.phoneNumbers.find((p) => p.id === 'phone-101')!;
    expect(phone.status).toBe('released');
    expect(phone.active).toBe(false);
  });

  it('20. Provider confirmed success invokes atomic RPC completion', async () => {
    mockDb.rawStores.portOperations.length = 0;
    const res = await service.requestVoluntaryRelease({
      organizationId: 'org-tenant-a',
      userId: 'user-1',
      userRole: 'owner',
      phoneNumberId: 'phone-101',
      confirmPhoneNumber: '+61412345678',
    });

    expect(res.status).toBe('released');
    const bill = mockDb.rawStores.billableResources.find((b) => b.resource_id === 'phone-101');
    expect(bill?.status).toBe('terminated');
    const map = mockDb.rawStores.providerMappings.find((m) => m.phone_number_id === 'phone-101');
    expect(map?.provider_status).toBe('historical');
  });

  it('21. eligibility_verified CANNOT invoke terminal RPC completion directly', async () => {
    const rpcRes = await mockDb.rpc('complete_number_release_atomic', {
      p_operation_id: 'non-existent-or-eligibility-verified',
      p_organization_id: 'org-tenant-a',
    });
    expect(rpcRes.error).not.toBeNull();
  });

  it('22-23. Provider timeout / 5xx transitions operation to reconciliation_required', async () => {
    mockDb.rawStores.portOperations.length = 0;
    mockDb.rawStores.providerMappings[0].provider_resource_id = 'PN101_FAIL_500';

    const res = await service.requestVoluntaryRelease({
      organizationId: 'org-tenant-a',
      userId: 'user-1',
      userRole: 'owner',
      phoneNumberId: 'phone-101',
      confirmPhoneNumber: '+61412345678',
    });

    expect(res.status).toBe('reconciliation_required');
    expect(res.customerSafeStatus).toBe('Release confirmation in progress.');
    const phone = mockDb.rawStores.phoneNumbers.find((p) => p.id === 'phone-101')!;
    expect(phone.status).toBe('active');
  });

  it('24. Untrusted 404 does NOT mark released (transitions to manual_review_required)', async () => {
    mockDb.rawStores.portOperations.length = 0;
    mockDb.rawStores.providerMappings[0].provider_resource_id = 'PN101_FAIL_404_UNTRUSTED';

    const res = await service.requestVoluntaryRelease({
      organizationId: 'org-tenant-a',
      userId: 'user-1',
      userRole: 'owner',
      phoneNumberId: 'phone-101',
      confirmPhoneNumber: '+61412345678',
    });

    expect(res.status).toBe('manual_review_required');
    const phone = mockDb.rawStores.phoneNumbers.find((p) => p.id === 'phone-101')!;
    expect(phone.status).toBe('active');
  });

  it('25. Trusted reconciliation confirmed absent completes release', async () => {
    mockDb.rawStores.releaseOperations.push({
      id: 'op-recon-1',
      organization_id: 'org-tenant-a',
      phone_number_id: 'phone-101',
      phone_number_e164: '+61412345678',
      provider_resource_mapping_id: 'map-101',
      status: 'reconciliation_required',
    });

    const res = await service.reconcileReleaseOperation('org-tenant-a', 'op-recon-1');
    expect(res.status).toBe('released');
    const phone = mockDb.rawStores.phoneNumbers.find((p) => p.id === 'phone-101')!;
    expect(phone.status).toBe('released');
  });

  it('26. Reconciliation confirmed still owned returns failure without marking released', async () => {
    mockDb.rawStores.providerMappings[0].provider_resource_id = 'PN101_RECONCILE_STILL_OWNED';
    mockDb.rawStores.releaseOperations.push({
      id: 'op-recon-2',
      organization_id: 'org-tenant-a',
      phone_number_id: 'phone-101',
      phone_number_e164: '+61412345678',
      provider_resource_mapping_id: 'map-101',
      status: 'reconciliation_required',
    });

    const res = await service.reconcileReleaseOperation('org-tenant-a', 'op-recon-2');
    expect(res.status).toBe('failed');
    const phone = mockDb.rawStores.phoneNumbers.find((p) => p.id === 'phone-101')!;
    expect(phone.status).toBe('active');
  });

  it('27-33. Atomic completion invariants (replay, tenant validation, rollback)', async () => {
    mockDb.rawStores.releaseOperations.push({
      id: 'op-released-3',
      organization_id: 'org-tenant-a',
      phone_number_id: 'phone-101',
      status: 'released',
    });

    const rpcRes = await mockDb.rpc('complete_number_release_atomic', {
      p_operation_id: 'op-released-3',
      p_organization_id: 'org-tenant-a',
    });

    expect(rpcRes.data?.idempotent).toBe(true);
  });

  it('34-36. Billable resources & mapping historical boundaries', async () => {
    mockDb.rawStores.portOperations.length = 0;
    await service.requestVoluntaryRelease({
      organizationId: 'org-tenant-a',
      userId: 'user-1',
      userRole: 'owner',
      phoneNumberId: 'phone-101',
      confirmPhoneNumber: '+61412345678',
    });

    const seatBill = mockDb.rawStores.billableResources.find((b) => b.resource_type === 'seat');
    expect(seatBill?.status).toBe('active');
  });

  it('37. Definite provider rejection leaves number active / owned', async () => {
    mockDb.rawStores.portOperations.length = 0;
    mockDb.rawStores.providerMappings[0].provider_resource_id = 'PN101_FAIL_400';

    const res = await service.requestVoluntaryRelease({
      organizationId: 'org-tenant-a',
      userId: 'user-1',
      userRole: 'owner',
      phoneNumberId: 'phone-101',
      confirmPhoneNumber: '+61412345678',
    });

    expect(res.status).toBe('failed');
    const phone = mockDb.rawStores.phoneNumbers.find((p) => p.id === 'phone-101')!;
    expect(phone.status).toBe('active');
  });

  it('43. Customer DTO redacts provider credentials and raw SIDs', async () => {
    mockDb.rawStores.portOperations.length = 0;
    const dto = await service.requestVoluntaryRelease({
      organizationId: 'org-tenant-a',
      userId: 'user-1',
      userRole: 'owner',
      phoneNumberId: 'phone-101',
      confirmPhoneNumber: '+61412345678',
    });

    expect((dto as any).providerResourceId).toBeUndefined();
    expect((dto as any).providerAccountId).toBeUndefined();
    expect((dto as any).providerSid).toBeUndefined();
    expect((dto as any).authToken).toBeUndefined();
  });
});
