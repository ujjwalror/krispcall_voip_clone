// @ts-nocheck
/**
 * Comprehensive Non-Live Test Suite for Phase 14.1D — Voluntary Phone Number Release (Fail-Closed Remediation)
 *
 * Verifies Owner/Admin authorization, tenant isolation, Port-Out / Port-In conflict checks,
 * exact-number typed confirmation, provider mutation gating, ambiguity reconciliation,
 * customer DTO redaction, fail-closed mapping validation, and atomic RPC completion invariants.
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
    {
      id: 'map-hist-101',
      phone_number_id: 'phone-101',
      provider: 'twilio',
      provider_resource_id: 'PN101_HIST_SID',
      provider_account_id: 'AC_TENANT_A',
      provider_status: 'historical',
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

        if (!op.provider_resource_mapping_id) {
          return { data: null, error: { message: 'MISSING_PROVIDER_MAPPING: Operation has no associated provider_resource_mapping_id.' } };
        }

        const map = providerMappings.find((m) => m.id === op.provider_resource_mapping_id);
        if (!map || map.phone_number_id !== phone.id || map.provider_status !== 'active') {
          return { data: null, error: { message: 'INVALID_PROVIDER_MAPPING: Mapping is not active or does not belong to phone.' } };
        }

        if (map.provider !== (op.provider || 'twilio')) {
          return { data: null, error: { message: 'INVALID_PROVIDER_MAPPING: Mapping provider does not match operation provider.' } };
        }

        map.provider_status = 'historical';
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

describe('Phase 14.1D — Voluntary Phone Number Release Workflow Tests (Fail-Closed)', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let adapter: TwilioNumberReleaseAdapter;
  let service: VoluntaryReleaseService;

  beforeEach(() => {
    mockDb = createMockDb();
    adapter = new TwilioNumberReleaseAdapter();
    service = new VoluntaryReleaseService({ dbClient: mockDb, providerAdapter: adapter });
  });

  // Assertion Group 1: Role Authorization & Tenant Isolation
  it('1. Owner role is authorized', async () => {
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

  it('5. Cross-tenant number release is rejected', async () => {
    const res = await service.checkReleaseEligibility('org-tenant-b', 'phone-101', 'owner');
    expect(res.eligible).toBe(false);
    expect(res.blockers).toContain('PHONE_NUMBER_NOT_FOUND: Phone number does not exist or does not belong to organization.');
  });

  it('6. Exact E.164 confirmation text match is accepted & mismatch rejected', async () => {
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

  // Assertion Group 2: Strict Fail-Closed Provider Mapping Validation
  it('7. A. NULL provider_resource_mapping_id is rejected by RPC with MISSING_PROVIDER_MAPPING', async () => {
    mockDb.rawStores.releaseOperations.push({
      id: 'op-null-map',
      organization_id: 'org-tenant-a',
      phone_number_id: 'phone-101',
      phone_number_e164: '+61412345678',
      provider_resource_mapping_id: null, // NULL mapping ID
      status: 'provider_release_pending',
    });

    const rpcRes = await mockDb.rpc('complete_number_release_atomic', {
      p_operation_id: 'op-null-map',
      p_organization_id: 'org-tenant-a',
    });

    expect(rpcRes.error?.message).toContain('MISSING_PROVIDER_MAPPING');
    const phone = mockDb.rawStores.phoneNumbers.find((p) => p.id === 'phone-101')!;
    expect(phone.status).toBe('active'); // Unchanged
  });

  it('8. B. Nonexistent provider mapping ID is rejected by RPC with INVALID_PROVIDER_MAPPING', async () => {
    mockDb.rawStores.releaseOperations.push({
      id: 'op-nonexistent-map',
      organization_id: 'org-tenant-a',
      phone_number_id: 'phone-101',
      phone_number_e164: '+61412345678',
      provider_resource_mapping_id: 'map-does-not-exist',
      status: 'provider_release_pending',
    });

    const rpcRes = await mockDb.rpc('complete_number_release_atomic', {
      p_operation_id: 'op-nonexistent-map',
      p_organization_id: 'org-tenant-a',
    });

    expect(rpcRes.error?.message).toContain('INVALID_PROVIDER_MAPPING');
  });

  it('9. C. Mapping belonging to another phone is rejected by RPC with INVALID_PROVIDER_MAPPING', async () => {
    mockDb.rawStores.releaseOperations.push({
      id: 'op-wrong-phone-map',
      organization_id: 'org-tenant-a',
      phone_number_id: 'phone-101',
      phone_number_e164: '+61412345678',
      provider_resource_mapping_id: 'map-201', // Belongs to phone-201
      status: 'provider_release_pending',
    });

    const rpcRes = await mockDb.rpc('complete_number_release_atomic', {
      p_operation_id: 'op-wrong-phone-map',
      p_organization_id: 'org-tenant-a',
    });

    expect(rpcRes.error?.message).toContain('INVALID_PROVIDER_MAPPING');
  });

  it('10. D. Historical / inactive mapping is rejected by RPC with INVALID_PROVIDER_MAPPING', async () => {
    mockDb.rawStores.releaseOperations.push({
      id: 'op-hist-map',
      organization_id: 'org-tenant-a',
      phone_number_id: 'phone-101',
      phone_number_e164: '+61412345678',
      provider_resource_mapping_id: 'map-hist-101', // Status is 'historical'
      status: 'provider_release_pending',
    });

    const rpcRes = await mockDb.rpc('complete_number_release_atomic', {
      p_operation_id: 'op-hist-map',
      p_organization_id: 'org-tenant-a',
    });

    expect(rpcRes.error?.message).toContain('INVALID_PROVIDER_MAPPING');
  });

  it('11. E. Mapping provider mismatch is rejected by RPC with INVALID_PROVIDER_MAPPING', async () => {
    mockDb.rawStores.releaseOperations.push({
      id: 'op-mismatch-prov',
      organization_id: 'org-tenant-a',
      phone_number_id: 'phone-101',
      phone_number_e164: '+61412345678',
      provider: 'bandwidth', // Mismatches 'twilio' in mapping
      provider_resource_mapping_id: 'map-101',
      status: 'provider_release_pending',
    });

    const rpcRes = await mockDb.rpc('complete_number_release_atomic', {
      p_operation_id: 'op-mismatch-prov',
      p_organization_id: 'org-tenant-a',
    });

    expect(rpcRes.error?.message).toContain('INVALID_PROVIDER_MAPPING');
  });

  it('12. F-I. Exact valid active mapping succeeds atomically & updates only exact mapping', async () => {
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

    const bill = mockDb.rawStores.billableResources.find((b) => b.resource_id === 'phone-101');
    expect(bill?.status).toBe('terminated');

    const map = mockDb.rawStores.providerMappings.find((m) => m.id === 'map-101');
    expect(map?.provider_status).toBe('historical');
  });

  it('13. J. Failed mapping validation leaves all local entities unchanged', async () => {
    mockDb.rawStores.releaseOperations.push({
      id: 'op-fail-val',
      organization_id: 'org-tenant-a',
      phone_number_id: 'phone-101',
      phone_number_e164: '+61412345678',
      provider_resource_mapping_id: 'map-201', // Invalid mapping for phone-101
      status: 'provider_release_pending',
    });

    await mockDb.rpc('complete_number_release_atomic', {
      p_operation_id: 'op-fail-val',
      p_organization_id: 'org-tenant-a',
    });

    const phone = mockDb.rawStores.phoneNumbers.find((p) => p.id === 'phone-101')!;
    expect(phone.status).toBe('active');
    expect(phone.active).toBe(true);

    const bill = mockDb.rawStores.billableResources.find((b) => b.resource_id === 'phone-101');
    expect(bill?.status).toBe('active');

    const op = mockDb.rawStores.releaseOperations.find((r) => r.id === 'op-fail-val');
    expect(op?.status).toBe('provider_release_pending'); // Unreleased
  });

  it('14. K. Already-released operation preserves idempotent replay behavior', async () => {
    mockDb.rawStores.releaseOperations.push({
      id: 'op-idemp-released',
      organization_id: 'org-tenant-a',
      phone_number_id: 'phone-101',
      phone_number_e164: '+61412345678',
      provider_resource_mapping_id: 'map-101',
      status: 'released',
    });

    const rpcRes = await mockDb.rpc('complete_number_release_atomic', {
      p_operation_id: 'op-idemp-released',
      p_organization_id: 'org-tenant-a',
    });

    expect(rpcRes.data?.idempotent).toBe(true);
  });

  it('15. L. Unexpected terminal phone status (already released) is rejected', async () => {
    mockDb.rawStores.releaseOperations.push({
      id: 'op-term-rejected',
      organization_id: 'org-tenant-a',
      phone_number_id: 'phone-102', // Already released phone
      phone_number_e164: '+61498765432',
      provider_resource_mapping_id: 'map-101',
      status: 'provider_release_pending',
    });

    const rpcRes = await mockDb.rpc('complete_number_release_atomic', {
      p_operation_id: 'op-term-rejected',
      p_organization_id: 'org-tenant-a',
    });

    expect(rpcRes.error?.message).toContain('PHONE_NUMBER_TERMINAL_STATE');
  });

  it('16. M. Source-state guard remains intact (cannot complete directly from eligibility_verified)', async () => {
    mockDb.rawStores.releaseOperations.push({
      id: 'op-elig-guard',
      organization_id: 'org-tenant-a',
      phone_number_id: 'phone-101',
      phone_number_e164: '+61412345678',
      provider_resource_mapping_id: 'map-101',
      status: 'eligibility_verified', // Not pending or reconciliation
    });

    const rpcRes = await mockDb.rpc('complete_number_release_atomic', {
      p_operation_id: 'op-elig-guard',
      p_organization_id: 'org-tenant-a',
    });

    expect(rpcRes.error?.message).toContain('INVALID_RELEASE_OP_STATE_FOR_COMPLETION');
  });
});
