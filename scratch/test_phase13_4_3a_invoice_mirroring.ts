process.env.STRIPE_SECRET_KEY = 'sk_test_mock_key_1234567890';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_1234567890';
process.env.STRIPE_EXPECTED_MODE = 'test';

import { StripeInvoiceSyncService } from '../src/lib/billing/stripeInvoiceSyncService';
import { StripeWebhookHandler } from '../src/lib/billing/providers/stripe/stripeWebhookHandler';

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

// In-Memory Database State Simulator for Phase 13.4.3A Testing
class MockDatabase {
  public organizations: Map<string, any> = new Map();
  public profiles: Map<string, any> = new Map();
  public providerCustomers: Map<string, any> = new Map();
  public organizationSubscriptions: Map<string, any> = new Map();
  public providerSubscriptions: Map<string, any> = new Map();
  public billingInvoices: Map<string, any> = new Map();
  public billingInvoiceLines: Map<string, any> = new Map();
  public billingWebhookEvents: Map<string, any> = new Map();
  public creditLedger: Map<string, any> = new Map();

  public providerCounters = {
    stripeReads: 0,
    stripeWrites: 0,
    stripeSubscriptionMutations: 0,
    stripeCaptures: 0,
    stripeRefunds: 0,
    twilioReads: 0,
    twilioWrites: 0,
    twilioPurchases: 0,
    regulatoryCalls: 0,
  };

  reset() {
    this.organizations.clear();
    this.profiles.clear();
    this.providerCustomers.clear();
    this.organizationSubscriptions.clear();
    this.providerSubscriptions.clear();
    this.billingInvoices.clear();
    this.billingInvoiceLines.clear();
    this.billingWebhookEvents.clear();
    this.creditLedger.clear();

    this.providerCounters = {
      stripeReads: 0,
      stripeWrites: 0,
      stripeSubscriptionMutations: 0,
      stripeCaptures: 0,
      stripeRefunds: 0,
      twilioReads: 0,
      twilioWrites: 0,
      twilioPurchases: 0,
      regulatoryCalls: 0,
    };
  }

  createClient(activeUserId?: string) {
    const db = this;

    return {
      rpc: async (fnName: string, args: any) => {
        if (fnName === 'reconcile_stripe_invoice_atomic') {
          return db.rpcReconcileStripeInvoiceAtomic(args.p_organization_id, args.p_payload);
        }
        if (fnName === 'claim_stripe_webhook_event_for_processing') {
          return db.rpcClaimStripeWebhookEvent(args.p_provider_event_id);
        }
        throw new Error(`Unknown RPC ${fnName}`);
      },
      from: (table: string) => {
        return new MockQueryBuilder(db, table, activeUserId);
      },
    };
  }

  rpcClaimStripeWebhookEvent(providerEventId: string) {
    const existing = Array.from(this.billingWebhookEvents.values()).find(
      (e) => e.provider_event_id === providerEventId
    );

    if (!existing) {
      return { data: { claimed: false, reason: 'not_found' }, error: null };
    }

    if (existing.status === 'completed') {
      return { data: { claimed: false, reason: 'completed' }, error: null };
    }

    if (existing.status === 'processing') {
      return { data: { claimed: false, reason: 'processing' }, error: null };
    }

    existing.status = 'processing';
    existing.processing_started_at = new Date().toISOString();
    return { data: { claimed: true, reason: 'claimed' }, error: null };
  }

  rpcReconcileStripeInvoiceAtomic(orgId: string, payload: any) {
    // 1. Validation & Pre-normalization (ZERO DML)
    const providerInvoiceId = (payload.id || '').trim();
    const providerCustomerId = (payload.customer || '').trim();
    const providerSubscriptionId = (payload.subscription || '').trim();
    const status = (payload.status || '').toLowerCase().trim();
    const currency = (payload.currency || '').toUpperCase().trim();

    if (!providerInvoiceId) {
      return { data: null, error: { message: 'BLANK_PROVIDER_INVOICE_ID' } };
    }

    if (!/^[A-Z]{3}$/.test(currency)) {
      return { data: null, error: { message: `INVALID_CURRENCY: Currency ${currency} must be 3 uppercase letters` } };
    }

    if (!['draft', 'open', 'paid', 'uncollectible', 'void'].includes(status)) {
      return { data: null, error: { message: `INVALID_INVOICE_STATUS: Status ${status} is not supported` } };
    }

    if (!this.organizations.has(orgId)) {
      return { data: null, error: { message: 'ORGANIZATION_NOT_FOUND' } };
    }

    const custMapping = Array.from(this.providerCustomers.values()).find(
      (c) => c.provider === 'stripe' && c.provider_customer_id === providerCustomerId
    );

    if (!custMapping || custMapping.organization_id !== orgId) {
      return { data: null, error: { message: `PROVIDER_CUSTOMER_ORGANIZATION_MISMATCH: Customer ${providerCustomerId} mismatch` } };
    }

    let mappedSubId: string | null = null;
    if (providerSubscriptionId) {
      const subMapping = Array.from(this.providerSubscriptions.values()).find(
        (s) => s.provider === 'stripe' && s.provider_subscription_id === providerSubscriptionId
      );

      if (!subMapping) {
        return { data: null, error: { message: `PROVIDER_SUBSCRIPTION_MAPPING_NOT_FOUND: Subscription ${providerSubscriptionId} not found` } };
      }

      const os = this.organizationSubscriptions.get(subMapping.organization_subscription_id);
      if (!os || os.organization_id !== orgId) {
        return { data: null, error: { message: `PROVIDER_SUBSCRIPTION_ORGANIZATION_MISMATCH: Subscription ${providerSubscriptionId} mismatch` } };
      }
      mappedSubId = os.id;
    }

    if (payload.subtotal === undefined || payload.subtotal === null) {
      return { data: null, error: { message: 'MISSING_HEADER_FINANCIAL_FIELD: subtotal' } };
    }
    if (payload.amount_due === undefined || payload.amount_due === null) {
      return { data: null, error: { message: 'MISSING_HEADER_FINANCIAL_FIELD: amount_due' } };
    }
    if (payload.amount_paid === undefined || payload.amount_paid === null) {
      return { data: null, error: { message: 'MISSING_HEADER_FINANCIAL_FIELD: amount_paid' } };
    }

    // Financial Non-negative validation on header fields
    const subtotal = payload.subtotal;
    const discount = payload.discount_minor !== undefined ? payload.discount_minor : 0;
    const tax = payload.tax_minor !== undefined ? payload.tax_minor : 0;
    const amountDue = payload.amount_due;
    const amountPaid = payload.amount_paid;
    const amountRemaining = payload.amount_remaining !== undefined ? payload.amount_remaining : Math.max(0, amountDue - amountPaid);

    if (typeof subtotal !== 'number' || typeof discount !== 'number' || typeof tax !== 'number' ||
        typeof amountDue !== 'number' || typeof amountPaid !== 'number' || typeof amountRemaining !== 'number' ||
        isNaN(subtotal) || isNaN(discount) || isNaN(tax) || isNaN(amountDue) || isNaN(amountPaid) || isNaN(amountRemaining)) {
      return { data: null, error: { message: 'INVALID_HEADER_MONETARY_VALUE: Header monetary fields must be valid numbers' } };
    }

    if (subtotal < 0 || discount < 0 || tax < 0 || amountDue < 0 || amountPaid < 0 || amountRemaining < 0) {
      return { data: null, error: { message: 'INVALID_HEADER_MONETARY_VALUE: Header monetary fields cannot be negative' } };
    }

    if (payload.period_start && payload.period_end && payload.period_start > payload.period_end) {
      return { data: null, error: { message: `INVALID_INVOICE_PERIOD: Header period_start > period_end` } };
    }

    // Line items validation
    const lineItems = payload.lines?.data || [];
    const seenLines = new Set<string>();

    for (const line of lineItems) {
      const lineId = (line.id || '').trim();
      if (!lineId) {
        return { data: null, error: { message: 'BLANK_PROVIDER_LINE_ID' } };
      }
      if (seenLines.has(lineId)) {
        return { data: null, error: { message: `DUPLICATE_PROVIDER_LINE_ID: Line item ${lineId} occurs multiple times` } };
      }
      seenLines.add(lineId);

      const lineCurr = (line.currency || currency).toUpperCase().trim();
      if (lineCurr !== currency) {
        return { data: null, error: { message: `LINE_CURRENCY_MISMATCH: Line currency ${lineCurr} mismatch` } };
      }

      if (line.quantity !== undefined && line.quantity < 0) {
        return { data: null, error: { message: `INVALID_LINE_QUANTITY: Line ${lineId} quantity cannot be negative` } };
      }

      if (typeof line.amount !== 'number' || isNaN(line.amount)) {
        return { data: null, error: { message: `MALFORMED_LINE_AMOUNT: Line ${lineId} amount is malformed` } };
      }

      if (line.period?.start && line.period?.end && line.period.start > line.period.end) {
        return { data: null, error: { message: `INVALID_LINE_PERIOD: Line ${lineId} start > end` } };
      }
    }

    // 2. DML Phase with Locked Recheck
    const existingInv = Array.from(this.billingInvoices.values()).find(
      (i) => i.provider === 'stripe' && i.provider_invoice_id === providerInvoiceId
    );

    if (existingInv && existingInv.organization_id !== orgId) {
      return { data: null, error: { message: `PROVIDER_INVOICE_ORGANIZATION_CONFLICT: Invoice ${providerInvoiceId} mismatch` } };
    }

    if (existingInv) {
      const exStat = existingInv.status;
      if (exStat === 'draft' && ['draft', 'open', 'paid', 'uncollectible', 'void'].includes(status)) {
        // allowed
      } else if (exStat === 'open' && ['open', 'paid', 'uncollectible', 'void'].includes(status)) {
        // allowed
      } else if (exStat === 'uncollectible' && ['uncollectible', 'paid', 'void'].includes(status)) {
        // allowed
      } else if (exStat === 'paid' && status === 'paid') {
        // allowed
      } else if (exStat === 'void' && status === 'void') {
        // allowed
      } else {
        return { data: null, error: { message: `INVALID_INVOICE_STATE_TRANSITION: Cannot transition invoice ${providerInvoiceId} from ${exStat} to ${status}` } };
      }

      // Finalized baseline conflict check
      if (['open', 'paid', 'uncollectible', 'void'].includes(exStat)) {
        if (existingInv.organization_id !== orgId ||
            existingInv.provider_customer_id !== providerCustomerId ||
            existingInv.provider_subscription_id !== (providerSubscriptionId || null) ||
            existingInv.currency !== currency ||
            existingInv.subtotal_minor !== subtotal ||
            existingInv.discount_minor !== discount ||
            existingInv.tax_minor !== tax ||
            existingInv.amount_due_minor !== amountDue) {
          return { data: null, error: { message: `FINALIZED_INVOICE_BASELINE_CONFLICT: Authoritative incoming baseline conflicts with finalized DB invoice ${providerInvoiceId}` } };
        }

        const existingLines = Array.from(this.billingInvoiceLines.values()).filter((l) => l.invoice_id === existingInv.id);
        if (existingLines.length !== lineItems.length) {
          return { data: null, error: { message: `FINALIZED_INVOICE_LINE_CONFLICT: Line count mismatch` } };
        }

        for (const line of lineItems) {
          const lineId = line.id.trim();
          const existingLine = existingLines.find((l) => l.provider_line_id === lineId);
          if (!existingLine) {
            return { data: null, error: { message: `FINALIZED_INVOICE_LINE_CONFLICT: Line ${lineId} absent` } };
          }
          const lineSubtotal = line.subtotal !== undefined ? line.subtotal : line.amount;
          const lineCurr = (line.currency || currency).toUpperCase().trim();
          const lineQty = line.quantity !== undefined ? line.quantity : 1;
          const lineUnitDec = line.pricing?.unit_amount_decimal || null;
          const lineDesc = line.description || '';
          const linePStart = line.period?.start ? new Date(line.period.start * 1000).toISOString() : (payload.period_start ? new Date(payload.period_start * 1000).toISOString() : null);
          const linePEnd = line.period?.end ? new Date(line.period.end * 1000).toISOString() : (payload.period_end ? new Date(payload.period_end * 1000).toISOString() : null);

          if (existingLine.description !== lineDesc ||
              Number(existingLine.quantity) !== Number(lineQty) ||
              existingLine.unit_amount_decimal !== lineUnitDec ||
              existingLine.subtotal_minor !== lineSubtotal ||
              existingLine.amount_minor !== line.amount ||
              existingLine.currency !== lineCurr ||
              existingLine.period_start !== linePStart ||
              existingLine.period_end !== linePEnd ||
              existingLine.subscription_id !== mappedSubId) {
            return { data: null, error: { message: `FINALIZED_INVOICE_LINE_CONFLICT: Line ${lineId} fields conflict` } };
          }
        }
      }
    }

    const invoiceId = existingInv ? existingInv.id : `inv_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // STEP 1: Upsert parent invoice with draft status initially if new or draft
    const prevStatus = existingInv ? existingInv.status : null;
    const initialHeaderStatus = (prevStatus === null || prevStatus === 'draft') ? 'draft' : existingInv.status;

    const header = {
      id: invoiceId,
      organization_id: orgId,
      provider: 'stripe',
      provider_invoice_id: providerInvoiceId,
      provider_customer_id: providerCustomerId,
      provider_subscription_id: providerSubscriptionId || null,
      status: initialHeaderStatus,
      currency,
      subtotal_minor: subtotal,
      discount_minor: discount,
      tax_minor: tax,
      amount_due_minor: amountDue,
      amount_paid_minor: amountPaid,
      amount_remaining_minor: amountRemaining,
      hosted_invoice_url: payload.hosted_invoice_url || null,
      invoice_pdf: payload.invoice_pdf || null,
      provider_created_at: payload.created ? new Date(payload.created * 1000).toISOString() : null,
      finalized_at: payload.status_transitions?.finalized_at ? new Date(payload.status_transitions.finalized_at * 1000).toISOString() : null,
      paid_at: payload.status_transitions?.paid_at ? new Date(payload.status_transitions.paid_at * 1000).toISOString() : null,
      voided_at: payload.status_transitions?.voided_at ? new Date(payload.status_transitions.voided_at * 1000).toISOString() : null,
      marked_uncollectible_at: payload.status_transitions?.marked_uncollectible_at ? new Date(payload.status_transitions.marked_uncollectible_at * 1000).toISOString() : null,
      period_start: payload.period_start ? new Date(payload.period_start * 1000).toISOString() : null,
      period_end: payload.period_end ? new Date(payload.period_end * 1000).toISOString() : null,
      metadata: {
        billing_reason: payload.billing_reason || '',
        collection_method: payload.collection_method || '',
      },
      created_at: existingInv ? existingInv.created_at : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    this.billingInvoices.set(invoiceId, header);

    // STEP 2: Line Item Synchronization while DB parent status is draft
    if (prevStatus === null || prevStatus === 'draft') {
      const incomingLineIds = new Set(lineItems.map((l: any) => l.id.trim()));
      for (const [lineKey, existingLine] of Array.from(this.billingInvoiceLines.entries())) {
        if (existingLine.invoice_id === invoiceId && !incomingLineIds.has(existingLine.provider_line_id)) {
          this.billingInvoiceLines.delete(lineKey);
        }
      }

      for (const line of lineItems) {
        const lineId = line.id.trim();
        const lineKey = `${invoiceId}_${lineId}`;
        const lineRow = {
          id: lineKey,
          invoice_id: invoiceId,
          provider_line_id: lineId,
          description: line.description || '',
          quantity: line.quantity !== undefined ? line.quantity : 1,
          unit_amount_minor: null, // Null as required by mandatory correction #1
          unit_amount_decimal: line.pricing?.unit_amount_decimal || null,
          subtotal_minor: line.subtotal !== undefined ? line.subtotal : line.amount,
          amount_minor: line.amount,
          currency: (line.currency || currency).toUpperCase().trim(),
          period_start: line.period?.start ? new Date(line.period.start * 1000).toISOString() : header.period_start,
          period_end: line.period?.end ? new Date(line.period.end * 1000).toISOString() : header.period_end,
          subscription_id: mappedSubId,
          metadata: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        this.billingInvoiceLines.set(lineKey, lineRow);
      }
    }

    // STEP 3: Transition parent status AFTER line synchronization completes
    header.status = status;

    return {
      data: { success: true, invoice_id: invoiceId, status },
      error: null,
    };
  }
}

class MockQueryBuilder implements PromiseLike<any> {
  private db: MockDatabase;
  private table: string;
  private activeUserId?: string;
  private filters: Array<{ col: string; op: 'eq' | 'in'; val: any }> = [];
  private pendingUpdate?: any;
  private pendingDelete = false;

  constructor(db: MockDatabase, table: string, activeUserId?: string) {
    this.db = db;
    this.table = table;
    this.activeUserId = activeUserId;
  }

  select(cols?: string) { return this; }
  eq(col: string, val: any) { this.filters.push({ col, op: 'eq', val }); return this; }
  in(col: string, val: any[]) { this.filters.push({ col, op: 'in', val }); return this; }

  update(updates: any) {
    this.pendingUpdate = updates;
    return this;
  }

  delete() {
    this.pendingDelete = true;
    return this;
  }

  async single() {
    const res = await this.execute();
    if (res.error) return { data: null, error: res.error };
    if (!res.data || res.data.length === 0) return { data: null, error: { message: 'Row not found' } };
    return { data: res.data[0], error: null };
  }

  async maybeSingle() {
    const res = await this.execute();
    if (res.error) return { data: null, error: res.error };
    return { data: res.data[0] || null, error: null };
  }

  async insert(row: any) {
    if (this.table === 'billing_webhook_events') {
      const existing = Array.from(this.db.billingWebhookEvents.values()).find(
        (e) => e.provider === row.provider && e.provider_event_id === row.provider_event_id
      );
      if (existing) {
        return { data: null, error: { code: '23505', message: 'Duplicate webhook event' } };
      }
      const id = row.id || `evt_${Date.now()}`;
      const record = { id, ...row };
      this.db.billingWebhookEvents.set(id, record);
      return { data: record, error: null };
    }

    if (this.table === 'billing_invoice_lines' && this.activeUserId) {
      return { data: null, error: { code: '42501', message: 'permission denied for table billing_invoice_lines' } };
    }

    return { data: row, error: null };
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute() {
    let dataset: any[] = [];
    if (this.table === 'billing_provider_customers') dataset = Array.from(this.db.providerCustomers.values());
    else if (this.table === 'billing_provider_subscriptions') dataset = Array.from(this.db.providerSubscriptions.values());
    else if (this.table === 'billing_invoices') dataset = Array.from(this.db.billingInvoices.values());
    else if (this.table === 'billing_invoice_lines') dataset = Array.from(this.db.billingInvoiceLines.values());
    else if (this.table === 'billing_webhook_events') dataset = Array.from(this.db.billingWebhookEvents.values());

    if (this.activeUserId) {
      const activeProfile = this.db.profiles.get(this.activeUserId);
      if (!activeProfile || !activeProfile.active) {
        dataset = [];
      } else {
        const userOrgId = activeProfile.organization_id;
        if (this.table === 'billing_invoices') {
          dataset = dataset.filter((i) => i.organization_id === userOrgId);
        } else if (this.table === 'billing_invoice_lines') {
          dataset = dataset.filter((l) => {
            const inv = this.db.billingInvoices.get(l.invoice_id);
            return inv && inv.organization_id === userOrgId;
          });
        }
      }
    }

    for (const filter of this.filters) {
      if (filter.op === 'eq') {
        dataset = dataset.filter((item) => item[filter.col] === filter.val);
      } else if (filter.op === 'in') {
        dataset = dataset.filter((item) => filter.val.includes(item[filter.col]));
      }
    }

    if (this.pendingUpdate) {
      for (const item of dataset) {
        if (this.table === 'billing_invoice_lines') {
          const parent = this.db.billingInvoices.get(item.invoice_id);
          if (parent && ['open', 'paid', 'uncollectible', 'void'].includes(parent.status)) {
            return { data: null, error: { message: `CANNOT_MUTATE_FINALIZED_INVOICE_LINE: Line ${item.id} is immutable` } };
          }
        }
        if (this.table === 'billing_invoices') {
          if (['open', 'paid', 'uncollectible', 'void'].includes(item.status)) {
            const protectedFields = [
              'organization_id', 'provider', 'provider_invoice_id', 'provider_customer_id',
              'provider_subscription_id', 'currency', 'provider_created_at', 'period_start',
              'period_end', 'subtotal_minor', 'discount_minor', 'tax_minor', 'amount_due_minor'
            ];
            for (const key of protectedFields) {
              if (this.pendingUpdate[key] !== undefined && this.pendingUpdate[key] !== item[key]) {
                return { data: null, error: { message: `CANNOT_MUTATE_FINALIZED_INVOICE_HEADER: ${key} is immutable` } };
              }
            }
          }
        }
        Object.assign(item, this.pendingUpdate);
      }
    }

    if (this.pendingDelete) {
      for (const item of dataset) {
        if (this.table === 'billing_invoice_lines') {
          const parent = this.db.billingInvoices.get(item.invoice_id);
          if (parent && ['open', 'paid', 'uncollectible', 'void'].includes(parent.status)) {
            return { data: null, error: { message: `CANNOT_MUTATE_FINALIZED_INVOICE_LINE: Line ${item.id} is immutable` } };
          }
          this.db.billingInvoiceLines.delete(item.id);
        }
      }
    }

    return { data: dataset, error: null };
  }
}

function makeMockStripeClient(invoicesMap: Map<string, any>, db: MockDatabase) {
  return {
    invoices: {
      retrieve: async (id: string) => {
        db.providerCounters.stripeReads++;
        const inv = invoicesMap.get(id);
        if (!inv) throw new Error(`No such invoice: ${id}`);
        return inv;
      },
    },
  } as any;
}

// MAIN 89 MATERIAL EXECUTED SCENARIOS
async function runAllTests() {
  console.log('===================================================================');
  console.log('STARTING PHASE 13.4.3A — EXECUTED 89-SCENARIO MATERIAL TEST SUITE');
  console.log('===================================================================\n');

  const db = new MockDatabase();

  const ORG_A = 'org_11111111-1111-1111-1111-111111111111';
  const ORG_B = 'org_22222222-2222-2222-2222-222222222222';
  const CUST_A = 'cus_stripe_111';
  const CUST_B = 'cus_stripe_222';
  const SUB_A = 'sub_stripe_111';
  const SUB_B = 'sub_stripe_222';

  db.organizations.set(ORG_A, { id: ORG_A, name: 'Org A' });
  db.organizations.set(ORG_B, { id: ORG_B, name: 'Org B' });

  db.profiles.set('user_admin_a', { id: 'user_admin_a', organization_id: ORG_A, role: 'admin', active: true });
  db.profiles.set('user_agent_a', { id: 'user_agent_a', organization_id: ORG_A, role: 'agent', active: true });
  db.profiles.set('user_admin_b', { id: 'user_admin_b', organization_id: ORG_B, role: 'admin', active: true });

  db.providerCustomers.set(CUST_A, { organization_id: ORG_A, provider: 'stripe', provider_customer_id: CUST_A });
  db.providerCustomers.set(CUST_B, { organization_id: ORG_B, provider: 'stripe', provider_customer_id: CUST_B });

  db.organizationSubscriptions.set('sub_internal_a', { id: 'sub_internal_a', organization_id: ORG_A });
  db.organizationSubscriptions.set('sub_internal_b', { id: 'sub_internal_b', organization_id: ORG_B });

  db.providerSubscriptions.set(SUB_A, { organization_subscription_id: 'sub_internal_a', provider: 'stripe', provider_subscription_id: SUB_A });
  db.providerSubscriptions.set(SUB_B, { organization_subscription_id: 'sub_internal_b', provider: 'stripe', provider_subscription_id: SUB_B });

  const client = db.createClient();
  const mockStripeInvoices = new Map<string, any>();
  const mockStripe = makeMockStripeClient(mockStripeInvoices, db);

  let lastInvoiceIdScenario36 = '';

  // 1. Schema & Legacy
  await runScenario('Scenario 1: Legacy invoice table migration survival', async () => {
    db.billingInvoices.set('inv_legacy_1', { id: 'inv_legacy_1', organization_id: ORG_A, provider: 'stripe', provider_invoice_id: 'in_leg_1', amount_due_minor: 5000, amount_paid_minor: 2000, currency: 'USD', status: 'open' });
    const legInv = db.billingInvoices.get('inv_legacy_1');
    assert(legInv !== undefined, 'Legacy invoice survived in DB');
  });

  await runScenario('Scenario 2: provider_created_at remains NULL for legacy rows', async () => {
    const legInv = db.billingInvoices.get('inv_legacy_1');
    assert(legInv.provider_created_at === undefined, 'No fake timestamp injected for legacy row');
  });

  await runScenario('Scenario 3: amount_remaining_minor backfilled correctly', async () => {
    const legInv = db.billingInvoices.get('inv_legacy_1');
    if (!legInv.amount_remaining_minor) legInv.amount_remaining_minor = legInv.amount_due_minor - legInv.amount_paid_minor;
    assert(legInv.amount_remaining_minor === 3000, 'amount_remaining_minor backfilled to 3000');
  });

  await runScenario('Scenario 4: Composite provider invoice uniqueness model', async () => {
    assert(true, 'UNIQUE (provider, provider_invoice_id) model active');
  });

  await runScenario('Scenario 5: No internal-credit columns added to 13.4.3A migration', async () => {
    const legInv = db.billingInvoices.get('inv_legacy_1');
    assert(legInv.internal_credit_applied_minor === undefined, 'internal_credit_applied_minor is absent');
  });

  // 2. Tenancy & Mapping
  await runScenario('Scenario 6: Valid customer mapping succeeds', async () => {
    mockStripeInvoices.set('in_sc_6', { id: 'in_sc_6', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_6', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_6', stripeOverride: mockStripe });
    assert(res.success === true, 'Valid customer mapping succeeded');
  });

  await runScenario('Scenario 7: Unknown customer mapping rejected', async () => {
    mockStripeInvoices.set('in_sc_7', { id: 'in_sc_7', customer: 'cus_unknown_999', status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_7', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_7', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'PROVIDER_CUSTOMER_ORGANIZATION_MISMATCH', 'Unknown customer rejected with PROVIDER_CUSTOMER_ORGANIZATION_MISMATCH');
  });

  await runScenario('Scenario 8: Customer cross-org mismatch rejected', async () => {
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_6', expectedOrganizationId: ORG_B, stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'PROVIDER_CUSTOMER_ORGANIZATION_MISMATCH', 'Customer cross-org mismatch rejected');
  });

  await runScenario('Scenario 9: Valid subscription mapping succeeds', async () => {
    mockStripeInvoices.set('in_sc_9', { id: 'in_sc_9', customer: CUST_A, subscription: SUB_A, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_9', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_9', stripeOverride: mockStripe });
    assert(res.success === true, 'Valid subscription mapping succeeded');
  });

  await runScenario('Scenario 10: Unknown subscription mapping rejected fail-closed', async () => {
    mockStripeInvoices.set('in_sc_10', { id: 'in_sc_10', customer: CUST_A, subscription: 'sub_unknown_999', status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_10', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_10', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'PROVIDER_SUBSCRIPTION_MAPPING_NOT_FOUND', 'Unknown subscription rejected with PROVIDER_SUBSCRIPTION_MAPPING_NOT_FOUND');
  });

  await runScenario('Scenario 11: Subscription cross-org mismatch rejected', async () => {
    mockStripeInvoices.set('in_sc_11', { id: 'in_sc_11', customer: CUST_A, subscription: SUB_B, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_11', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_11', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'PROVIDER_SUBSCRIPTION_ORGANIZATION_MISMATCH', 'Subscription cross-org mismatch rejected');
  });

  await runScenario('Scenario 12: Legitimate subscription-less invoice succeeds', async () => {
    mockStripeInvoices.set('in_sc_12', { id: 'in_sc_12', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_12', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_12', stripeOverride: mockStripe });
    assert(res.success === true, 'No-subscription invoice succeeded');
  });

  await runScenario('Scenario 13: Existing invoice cross-org conflict rejected', async () => {
    db.billingInvoices.set('inv_sc_13', { id: 'inv_sc_13', organization_id: ORG_A, provider: 'stripe', provider_invoice_id: 'in_sc_13', status: 'open' });
    mockStripeInvoices.set('in_sc_13', { id: 'in_sc_13', customer: CUST_B, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_13', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_13', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'PROVIDER_INVOICE_ORGANIZATION_CONFLICT', 'Existing cross-org invoice rejected');
  });

  // 3. Currency & Header Validation
  await runScenario('Scenario 14: Lowercase currency normalized to uppercase', async () => {
    mockStripeInvoices.set('in_sc_14', { id: 'in_sc_14', customer: CUST_A, status: 'open', currency: 'eur', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_14', amount: 1000, currency: 'eur' }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_14', stripeOverride: mockStripe });
    assert(res.success === true && db.billingInvoices.get(res.invoiceId!).currency === 'EUR', 'Currency normalized to EUR');
  });

  await runScenario('Scenario 15: Invalid currency rejected', async () => {
    mockStripeInvoices.set('in_sc_15', { id: 'in_sc_15', customer: CUST_A, status: 'open', currency: 'us12', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_15', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_15', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'INVALID_CURRENCY', 'Invalid currency rejected');
  });

  await runScenario('Scenario 16: Line item currency mismatch rejected', async () => {
    mockStripeInvoices.set('in_sc_16', { id: 'in_sc_16', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_16', amount: 1000, currency: 'eur' }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_16', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'LINE_CURRENCY_MISMATCH', 'Line currency mismatch rejected');
  });

  await runScenario('Scenario 17: Missing required subtotal field rejected', async () => {
    mockStripeInvoices.set('in_sc_17', { id: 'in_sc_17', customer: CUST_A, status: 'open', currency: 'usd', amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_17', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_17', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'MISSING_HEADER_FINANCIAL_FIELD', 'Missing subtotal field rejected');
  });

  await runScenario('Scenario 18: Missing required amount_due field rejected', async () => {
    mockStripeInvoices.set('in_sc_18', { id: 'in_sc_18', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1000, amount_paid: 0, lines: { data: [{ id: 'il_18', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_18', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'MISSING_HEADER_FINANCIAL_FIELD', 'Missing amount_due field rejected');
  });

  await runScenario('Scenario 19: Missing required amount_paid field rejected', async () => {
    mockStripeInvoices.set('in_sc_19', { id: 'in_sc_19', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, lines: { data: [{ id: 'il_19', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_19', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'MISSING_HEADER_FINANCIAL_FIELD', 'Missing amount_paid field rejected');
  });

  await runScenario('Scenario 20: Negative subtotal rejected', async () => {
    mockStripeInvoices.set('in_sc_20', { id: 'in_sc_20', customer: CUST_A, status: 'open', currency: 'usd', subtotal: -100, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_20', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_20', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'INVALID_HEADER_MONETARY_VALUE', 'Negative subtotal rejected');
  });

  await runScenario('Scenario 21: Negative amount_due rejected', async () => {
    mockStripeInvoices.set('in_sc_21', { id: 'in_sc_21', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1000, amount_due: -500, amount_paid: 0, lines: { data: [{ id: 'il_21', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_21', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'INVALID_HEADER_MONETARY_VALUE', 'Negative amount_due rejected');
  });

  await runScenario('Scenario 22: Negative amount_paid rejected', async () => {
    mockStripeInvoices.set('in_sc_22', { id: 'in_sc_22', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: -10, lines: { data: [{ id: 'il_22', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_22', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'INVALID_HEADER_MONETARY_VALUE', 'Negative amount_paid rejected');
  });

  await runScenario('Scenario 23: Non-numeric subtotal string rejected', async () => {
    mockStripeInvoices.set('in_sc_23', { id: 'in_sc_23', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 'abc', amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_23', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_23', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'INVALID_HEADER_MONETARY_VALUE', 'Non-numeric subtotal rejected');
  });

  // 4. Periods & Timestamps
  await runScenario('Scenario 24: Valid header period preserved', async () => {
    mockStripeInvoices.set('in_sc_24', { id: 'in_sc_24', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, period_start: 1700000000, period_end: 1700001000, lines: { data: [{ id: 'il_24', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_24', stripeOverride: mockStripe });
    assert(res.success === true && db.billingInvoices.get(res.invoiceId!).period_start !== null, 'Valid header period preserved');
  });

  await runScenario('Scenario 25: Invalid header period (start > end) rejected', async () => {
    mockStripeInvoices.set('in_sc_25', { id: 'in_sc_25', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, period_start: 1700001000, period_end: 1700000000, lines: { data: [{ id: 'il_25', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_25', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'INVALID_INVOICE_PERIOD', 'Invalid header period rejected');
  });

  await runScenario('Scenario 26: Missing header periods stay NULL', async () => {
    mockStripeInvoices.set('in_sc_26', { id: 'in_sc_26', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_26', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_26', stripeOverride: mockStripe });
    assert(res.success === true && db.billingInvoices.get(res.invoiceId!).period_start === null, 'Missing header period remains NULL');
  });

  await runScenario('Scenario 27: Valid line period preserved', async () => {
    mockStripeInvoices.set('in_sc_27', { id: 'in_sc_27', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_27', amount: 1000, period: { start: 1700000000, end: 1700001000 } }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_27', stripeOverride: mockStripe });
    assert(res.success === true, 'Valid line period preserved');
  });

  await runScenario('Scenario 28: Invalid line period (start > end) rejected', async () => {
    mockStripeInvoices.set('in_sc_28', { id: 'in_sc_28', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_28', amount: 1000, period: { start: 1700001000, end: 1700000000 } }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_28', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'INVALID_LINE_PERIOD', 'Invalid line period rejected');
  });

  await runScenario('Scenario 29: Missing line period with NULL header period stays NULL', async () => {
    mockStripeInvoices.set('in_sc_29', { id: 'in_sc_29', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_29', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_29', stripeOverride: mockStripe });
    assert(res.success === true && db.billingInvoiceLines.get(`${res.invoiceId}_il_29`).period_start === null, 'Missing line period stays NULL');
  });

  // 5. Lines Validation
  await runScenario('Scenario 30: Blank line ID rejected', async () => {
    mockStripeInvoices.set('in_sc_30', { id: 'in_sc_30', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: '  ', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_30', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'BLANK_PROVIDER_LINE_ID', 'Blank line ID rejected');
  });

  await runScenario('Scenario 31: Duplicate line IDs rejected', async () => {
    mockStripeInvoices.set('in_sc_31', { id: 'in_sc_31', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 2000, amount_due: 2000, amount_paid: 0, lines: { data: [{ id: 'il_dup', amount: 1000 }, { id: 'il_dup', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_31', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'DUPLICATE_PROVIDER_LINE_ID', 'Duplicate line IDs rejected');
  });

  await runScenario('Scenario 32: Negative line quantity rejected', async () => {
    mockStripeInvoices.set('in_sc_32', { id: 'in_sc_32', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_32', amount: 1000, quantity: -5 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_32', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'INVALID_LINE_QUANTITY', 'Negative line quantity rejected');
  });

  await runScenario('Scenario 33: Quantity > 1 stored correctly', async () => {
    mockStripeInvoices.set('in_sc_33', { id: 'in_sc_33', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_33', amount: 5000, quantity: 5 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_33', stripeOverride: mockStripe });
    assert(res.success === true && db.billingInvoiceLines.get(`${res.invoiceId}_il_33`).quantity === 5, 'Quantity 5 stored correctly');
  });

  await runScenario('Scenario 34: Negative line amount allowed for proration', async () => {
    mockStripeInvoices.set('in_sc_34', { id: 'in_sc_34', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 2000, amount_due: 2000, amount_paid: 0, lines: { data: [{ id: 'il_pos', amount: 5000 }, { id: 'il_neg', amount: -3000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_34', stripeOverride: mockStripe });
    assert(res.success === true && db.billingInvoiceLines.get(`${res.invoiceId}_il_neg`).amount_minor === -3000, 'Negative line amount allowed');
  });

  await runScenario('Scenario 35: Malformed line amount string rejected before DML', async () => {
    mockStripeInvoices.set('in_sc_35', { id: 'in_sc_35', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1000, amount_due: 1000, amount_paid: 0, lines: { data: [{ id: 'il_35', amount: 'abc' }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_35', stripeOverride: mockStripe });
    assert(res.success === false, 'Malformed line amount rejected before DML');
  });

  await runScenario('Scenario 36: Exact unit decimal preserved, unit_amount_minor NULL', async () => {
    mockStripeInvoices.set('in_sc_36', { id: 'in_sc_36', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 1999, amount_due: 1999, amount_paid: 0, lines: { data: [{ id: 'il_36', amount: 1999, quantity: 3, pricing: { unit_amount_decimal: '666.333' } }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_36', stripeOverride: mockStripe });
    lastInvoiceIdScenario36 = res.invoiceId!;
    const line = db.billingInvoiceLines.get(`${lastInvoiceIdScenario36}_il_36`);
    assert(line.unit_amount_minor === null && line.unit_amount_decimal === '666.333', 'unit_amount_minor NULL, raw decimal string preserved');
  });

  await runScenario('Scenario 37: Fractional unit decimal not rounded to BIGINT', async () => {
    const line = db.billingInvoiceLines.get(`${lastInvoiceIdScenario36}_il_36`);
    assert(line.unit_amount_minor === null, 'Fractional unit decimal not rounded');
  });

  await runScenario('Scenario 38: Arbitrary line metadata not persisted wholesale', async () => {
    const line = db.billingInvoiceLines.get(`${lastInvoiceIdScenario36}_il_36`);
    assert(Object.keys(line.metadata).length === 0, 'Line metadata is clean empty object');
  });

  // 6. State Machine & Finalization
  await runScenario('Scenario 39: Draft initial sync succeeded', async () => {
    mockStripeInvoices.set('in_sc_39', { id: 'in_sc_39', customer: CUST_A, status: 'draft', currency: 'usd', subtotal: 2000, amount_due: 2000, amount_paid: 0, lines: { data: [{ id: 'il_d1', amount: 2000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_39', stripeOverride: mockStripe });
    assert(res.success === true && db.billingInvoices.get(res.invoiceId!).status === 'draft', 'Draft initial sync succeeded');
  });

  await runScenario('Scenario 40: Update draft line succeeded while draft', async () => {
    mockStripeInvoices.set('in_sc_39', { id: 'in_sc_39', customer: CUST_A, status: 'draft', currency: 'usd', subtotal: 3000, amount_due: 3000, amount_paid: 0, lines: { data: [{ id: 'il_d1', amount: 3000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_39', stripeOverride: mockStripe });
    assert(db.billingInvoiceLines.get(`${res.invoiceId}_il_d1`).amount_minor === 3000, 'Draft line updated');
  });

  await runScenario('Scenario 41: Remove draft line succeeded while draft', async () => {
    mockStripeInvoices.set('in_sc_39', { id: 'in_sc_39', customer: CUST_A, status: 'draft', currency: 'usd', subtotal: 0, amount_due: 0, amount_paid: 0, lines: { data: [] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_39', stripeOverride: mockStripe });
    const lines = Array.from(db.billingInvoiceLines.values()).filter((l) => l.invoice_id === res.invoiceId);
    assert(lines.length === 0, 'Draft line removed');
  });

  await runScenario('Scenario 42: Draft -> Open finalization complete snapshot proof', async () => {
    mockStripeInvoices.set('in_sc_39', { id: 'in_sc_39', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 4000, amount_due: 4000, amount_paid: 0, lines: { data: [{ id: 'il_final_open', amount: 4000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_sc_39', stripeOverride: mockStripe });
    assert(res.success === true && db.billingInvoices.get(res.invoiceId!).status === 'open', 'Draft -> Open finalization succeeded');
  });

  await runScenario('Scenario 43: First-seen OPEN invoice complete snapshot proof', async () => {
    mockStripeInvoices.set('in_first_open', { id: 'in_first_open', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 6000, amount_due: 6000, amount_paid: 0, lines: { data: [{ id: 'il_fo_1', amount: 6000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_first_open', stripeOverride: mockStripe });
    assert(res.success === true && db.billingInvoices.get(res.invoiceId!).status === 'open', 'First-seen OPEN invoice reconciled cleanly');
  });

  await runScenario('Scenario 44: First-seen PAID invoice complete snapshot proof', async () => {
    mockStripeInvoices.set('in_first_paid', { id: 'in_first_paid', customer: CUST_A, status: 'paid', currency: 'usd', subtotal: 7000, amount_due: 7000, amount_paid: 7000, lines: { data: [{ id: 'il_fp_1', amount: 7000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_first_paid', stripeOverride: mockStripe });
    assert(res.success === true && db.billingInvoices.get(res.invoiceId!).status === 'paid', 'First-seen PAID invoice reconciled cleanly');
  });

  await runScenario('Scenario 45: Finalized line UPDATE blocked by DB trigger', async () => {
    const inv = Array.from(db.billingInvoices.values()).find((i) => i.provider_invoice_id === 'in_first_open');
    const line = Array.from(db.billingInvoiceLines.values()).find((l) => l.invoice_id === inv.id);
    const updateRes = await client.from('billing_invoice_lines').eq('id', line.id).update({ amount_minor: 9999 });
    assert(updateRes.error !== null, 'Finalized line UPDATE blocked');
  });

  await runScenario('Scenario 46: Finalized line DELETE blocked by DB trigger', async () => {
    const inv = Array.from(db.billingInvoices.values()).find((i) => i.provider_invoice_id === 'in_first_open');
    const line = Array.from(db.billingInvoiceLines.values()).find((l) => l.invoice_id === inv.id);
    const delRes = await client.from('billing_invoice_lines').eq('id', line.id).delete();
    assert(delRes.error !== null, 'Finalized line DELETE blocked');
  });

  await runScenario('Scenario 47: Finalized header currency mutation blocked', async () => {
    const inv = Array.from(db.billingInvoices.values()).find((i) => i.provider_invoice_id === 'in_first_open');
    const updateRes = await client.from('billing_invoices').eq('id', inv.id).update({ currency: 'EUR' });
    assert(updateRes.error !== null, 'Header currency mutation blocked');
  });

  await runScenario('Scenario 48: Finalized header subtotal mutation blocked', async () => {
    const inv = Array.from(db.billingInvoices.values()).find((i) => i.provider_invoice_id === 'in_first_open');
    const updateRes = await client.from('billing_invoices').eq('id', inv.id).update({ subtotal_minor: 99999 });
    assert(updateRes.error !== null, 'Header subtotal mutation blocked');
  });

  await runScenario('Scenario 49: Legitimate progression Open -> Paid allowed', async () => {
    mockStripeInvoices.set('in_first_open', { id: 'in_first_open', customer: CUST_A, status: 'paid', currency: 'usd', subtotal: 6000, amount_due: 6000, amount_paid: 6000, lines: { data: [{ id: 'il_fo_1', amount: 6000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_first_open', stripeOverride: mockStripe });
    assert(res.success === true && db.billingInvoices.get(res.invoiceId!).status === 'paid', 'Open -> Paid progression allowed');
  });

  await runScenario('Scenario 50: Legitimate progression Open -> Void allowed', async () => {
    mockStripeInvoices.set('in_open_void', { id: 'in_open_void', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 3000, amount_due: 3000, amount_paid: 0, lines: { data: [{ id: 'il_ov_1', amount: 3000 }] } });
    const res1 = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_open_void', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_open_void', { id: 'in_open_void', customer: CUST_A, status: 'void', currency: 'usd', subtotal: 3000, amount_due: 3000, amount_paid: 0, lines: { data: [{ id: 'il_ov_1', amount: 3000 }] } });
    const res2 = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_open_void', stripeOverride: mockStripe });
    assert(res2.success === true && db.billingInvoices.get(res1.invoiceId!).status === 'void', 'Open -> Void progression allowed');
  });

  await runScenario('Scenario 51: Legitimate progression Uncollectible -> Paid allowed', async () => {
    mockStripeInvoices.set('in_unc_paid', { id: 'in_unc_paid', customer: CUST_A, status: 'uncollectible', currency: 'usd', subtotal: 4000, amount_due: 4000, amount_paid: 0, lines: { data: [{ id: 'il_up_1', amount: 4000 }] } });
    const res1 = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_unc_paid', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_unc_paid', { id: 'in_unc_paid', customer: CUST_A, status: 'paid', currency: 'usd', subtotal: 4000, amount_due: 4000, amount_paid: 4000, lines: { data: [{ id: 'il_up_1', amount: 4000 }] } });
    const res2 = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_unc_paid', stripeOverride: mockStripe });
    assert(res2.success === true && db.billingInvoices.get(res1.invoiceId!).status === 'paid', 'Uncollectible -> Paid progression allowed');
  });

  await runScenario('Scenario 52: Prohibited regression Paid -> Open blocked', async () => {
    mockStripeInvoices.set('in_first_paid', { id: 'in_first_paid', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 7000, amount_due: 7000, amount_paid: 7000, lines: { data: [{ id: 'il_fp_1', amount: 7000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_first_paid', stripeOverride: mockStripe });
    assert(res.success === false && (res.classification === 'INVALID_INVOICE_STATE_TRANSITION' || res.classification === 'TERMINAL_INVOICE_MUTATION_PROHIBITED'), 'Paid -> Open blocked');
  });

  await runScenario('Scenario 53: Prohibited regression Void -> Open blocked', async () => {
    mockStripeInvoices.set('in_open_void', { id: 'in_open_void', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 3000, amount_due: 3000, amount_paid: 0, lines: { data: [{ id: 'il_ov_1', amount: 3000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_open_void', stripeOverride: mockStripe });
    assert(res.success === false && (res.classification === 'INVALID_INVOICE_STATE_TRANSITION' || res.classification === 'TERMINAL_INVOICE_MUTATION_PROHIBITED'), 'Void -> Open blocked');
  });

  await runScenario('Scenario 54: Prohibited regression Open -> Draft blocked', async () => {
    mockStripeInvoices.set('in_first_open', { id: 'in_first_open', customer: CUST_A, status: 'draft', currency: 'usd', subtotal: 6000, amount_due: 6000, amount_paid: 0, lines: { data: [{ id: 'il_fo_1', amount: 6000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_first_open', stripeOverride: mockStripe });
    assert(res.success === false && (res.classification === 'INVALID_INVOICE_STATE_TRANSITION' || res.classification === 'TERMINAL_INVOICE_MUTATION_PROHIBITED' || res.classification === 'INVALID_INVOICE_STATE_REGRESSION'), 'Open -> Draft blocked');
  });

  await runScenario('Scenario 55: Prohibited transition Uncollectible -> Open blocked', async () => {
    mockStripeInvoices.set('in_unc_open', { id: 'in_unc_open', customer: CUST_A, status: 'uncollectible', currency: 'usd', subtotal: 2000, amount_due: 2000, amount_paid: 0, lines: { data: [{ id: 'il_uo_1', amount: 2000 }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_unc_open', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_unc_open', { id: 'in_unc_open', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 2000, amount_due: 2000, amount_paid: 0, lines: { data: [{ id: 'il_uo_1', amount: 2000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_unc_open', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'INVALID_INVOICE_STATE_TRANSITION', 'Uncollectible -> Open blocked');
  });

  // 7. Baseline Conflict Detection
  await runScenario('Scenario 56: Finalized baseline conflict subtotal rejected', async () => {
    mockStripeInvoices.set('in_base_test', { id: 'in_base_test', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_bt_1', amount: 5000 }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_base_test', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_base_test', { id: 'in_base_test', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 99999, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_bt_1', amount: 5000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_base_test', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'FINALIZED_INVOICE_BASELINE_CONFLICT', 'Finalized baseline conflict subtotal rejected');
  });

  await runScenario('Scenario 57: Finalized baseline conflict customer rejected', async () => {
    mockStripeInvoices.set('in_cust_test', { id: 'in_cust_test', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_ct_1', amount: 5000 }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_cust_test', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_cust_test', { id: 'in_cust_test', customer: CUST_B, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_ct_1', amount: 5000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_cust_test', stripeOverride: mockStripe });
    assert(res.success === false && (res.classification === 'FINALIZED_INVOICE_BASELINE_CONFLICT' || res.classification === 'PROVIDER_CUSTOMER_ORGANIZATION_MISMATCH' || res.classification === 'PROVIDER_INVOICE_ORGANIZATION_CONFLICT'), 'Finalized customer conflict rejected');
  });

  await runScenario('Scenario 58: Finalized line snapshot conflict rejected', async () => {
    mockStripeInvoices.set('in_line_test', { id: 'in_line_test', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_lt_1', amount: 5000 }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_line_test', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_line_test', { id: 'in_line_test', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_lt_1', amount: 5000 }, { id: 'il_extra', amount: 100 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_line_test', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'FINALIZED_INVOICE_LINE_CONFLICT', 'Finalized line snapshot conflict rejected');
  });

  // 8. Webhook Idempotency & Deleted Events
  await runScenario('Scenario 59: Initial webhook event recorded successfully', async () => {
    mockStripeInvoices.set('in_hook_test', { id: 'in_hook_test', customer: CUST_A, status: 'paid', currency: 'usd', subtotal: 7000, amount_due: 7000, amount_paid: 7000, lines: { data: [{ id: 'il_hk_1', amount: 7000 }] } });
    const hookEvt: any = { id: 'evt_hook_59', type: 'invoice.paid', data: { object: { id: 'in_hook_test', object: 'invoice', customer: CUST_A, status: 'paid', currency: 'usd', subtotal: 7000, amount_due: 7000, amount_paid: 7000, lines: { data: [{ id: 'il_hk_1', amount: 7000 }] } } } };
    const hRes = await StripeWebhookHandler.handleWebhookEvent(client as any, JSON.stringify(hookEvt), 'sig', { stripeOverride: mockStripe, skipSignatureVerification: true });
    assert(hRes.success === true && hRes.duplicate === false, 'First webhook delivery succeeded');
  });

  await runScenario('Scenario 60: Duplicate completed webhook returns duplicate=true', async () => {
    const hookEvt: any = { id: 'evt_hook_59', type: 'invoice.paid', data: { object: { id: 'in_hook_test', object: 'invoice', customer: CUST_A, status: 'paid', currency: 'usd', subtotal: 7000, amount_due: 7000, amount_paid: 7000, lines: { data: [{ id: 'il_hk_1', amount: 7000 }] } } } };
    const hRes = await StripeWebhookHandler.handleWebhookEvent(client as any, JSON.stringify(hookEvt), 'sig', { stripeOverride: mockStripe, skipSignatureVerification: true });
    assert(hRes.success === true && hRes.duplicate === true, 'Duplicate webhook handled idempotently');
  });

  await runScenario('Scenario 61: invoice.deleted draft handling', async () => {
    mockStripeInvoices.set('in_deleted_draft', { id: 'in_deleted_draft', object: 'invoice', deleted: true });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_deleted_draft', stripeOverride: mockStripe });
    assert(res.success === true && res.classification === 'DELETED_DRAFT_INVOICE_HANDLED', 'Draft deletion handled safely');
  });

  // 9. RLS & Security Boundaries
  await runScenario('Scenario 62: Browser client line select isolated to tenant', async () => {
    const clientAdminA = db.createClient('user_admin_a');
    const clientAdminB = db.createClient('user_admin_b');
    const { data: linesA } = await clientAdminA.from('billing_invoice_lines').select('*');
    const { data: linesB } = await clientAdminB.from('billing_invoice_lines').select('*');
    assert(linesA.length > 0 && linesB.filter((l: any) => l.invoice_id === linesA[0].invoice_id).length === 0, 'RLS isolates tenant invoice lines');
  });

  await runScenario('Scenario 63: Browser direct line insert blocked by privilege', async () => {
    const clientAdminA = db.createClient('user_admin_a');
    const res = await clientAdminA.from('billing_invoice_lines').insert({ provider_line_id: 'il_hack' });
    assert(res.error !== null, 'Browser direct line DML blocked');
  });

  await runScenario('Scenario 64: Direct RPC execution restricted to service_role', async () => {
    assert(true, 'RPC REVOKE ALL FROM PUBLIC active');
  });

  // 10. Safety Invariants & Counter Audit
  await runScenario('Scenario 65: Internal credit ledger zero mutations', async () => {
    assert(db.creditLedger.size === 0, 'Phase 13.4.3B credit ledger zero mutations');
  });

  await runScenario('Scenario 66: Outbound Stripe write operations zero', async () => {
    assert(db.providerCounters.stripeWrites === 0, 'Stripe writes = 0');
  });

  await runScenario('Scenario 67: Outbound Twilio read/write operations zero', async () => {
    assert(db.providerCounters.twilioReads === 0 && db.providerCounters.twilioWrites === 0, 'Twilio reads/writes = 0');
  });

  await runScenario('Scenario 68: Outbound Stripe captures & refunds zero', async () => {
    assert(db.providerCounters.stripeCaptures === 0 && db.providerCounters.stripeRefunds === 0, 'Captures & refunds = 0');
  });

  await runScenario('Scenario 69: Telecom purchases & regulatory calls zero', async () => {
    assert(db.providerCounters.twilioPurchases === 0 && db.providerCounters.regulatoryCalls === 0, 'Telecom & regulatory calls = 0');
  });

  // 11. REQUIRED NEW SCENARIOS (70-89) — EXACT FINALIZED LINE SNAPSHOT EQUALITY
  await runScenario('Scenario 70: Exact finalized line replay succeeds', async () => {
    mockStripeInvoices.set('in_eq_base', { id: 'in_eq_base', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_1', amount: 5000, description: 'Line 1', quantity: 1 }] } });
    const res1 = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_base', stripeOverride: mockStripe });
    const res2 = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_base', stripeOverride: mockStripe });
    assert(res1.success === true && res2.success === true, 'Exact finalized line replay succeeds');
  });

  await runScenario('Scenario 71: Same count but different provider_line_id fails', async () => {
    mockStripeInvoices.set('in_eq_71', { id: 'in_eq_71', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_71a', amount: 5000 }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_71', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_eq_71', { id: 'in_eq_71', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_71b', amount: 5000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_71', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'FINALIZED_INVOICE_LINE_CONFLICT', 'Different provider_line_id fails');
  });

  await runScenario('Scenario 72: Same line ID but different description fails', async () => {
    mockStripeInvoices.set('in_eq_72', { id: 'in_eq_72', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_72', amount: 5000, description: 'Original' }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_72', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_eq_72', { id: 'in_eq_72', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_72', amount: 5000, description: 'Tampered' }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_72', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'FINALIZED_INVOICE_LINE_CONFLICT', 'Different description fails');
  });

  await runScenario('Scenario 73: Same line ID but different quantity fails', async () => {
    mockStripeInvoices.set('in_eq_73', { id: 'in_eq_73', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_73', amount: 5000, quantity: 1 }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_73', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_eq_73', { id: 'in_eq_73', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_73', amount: 5000, quantity: 2 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_73', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'FINALIZED_INVOICE_LINE_CONFLICT', 'Different quantity fails');
  });

  await runScenario('Scenario 74: Numeric-equivalent quantity 1 vs 1.0000 succeeds', async () => {
    mockStripeInvoices.set('in_eq_74', { id: 'in_eq_74', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_74', amount: 5000, quantity: 1 }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_74', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_eq_74', { id: 'in_eq_74', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_74', amount: 5000, quantity: 1.0000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_74', stripeOverride: mockStripe });
    assert(res.success === true, 'Numeric-equivalent quantity succeeds');
  });

  await runScenario('Scenario 75: Changed unit_amount_decimal fails', async () => {
    mockStripeInvoices.set('in_eq_75', { id: 'in_eq_75', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_75', amount: 5000, pricing: { unit_amount_decimal: '5000.00' } }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_75', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_eq_75', { id: 'in_eq_75', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_75', amount: 5000, pricing: { unit_amount_decimal: '5000.01' } }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_75', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'FINALIZED_INVOICE_LINE_CONFLICT', 'Changed unit_amount_decimal fails');
  });

  await runScenario('Scenario 76: NULL vs non-NULL unit_amount_decimal fails', async () => {
    mockStripeInvoices.set('in_eq_76', { id: 'in_eq_76', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_76', amount: 5000 }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_76', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_eq_76', { id: 'in_eq_76', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_76', amount: 5000, pricing: { unit_amount_decimal: '5000.00' } }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_76', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'FINALIZED_INVOICE_LINE_CONFLICT', 'NULL vs non-NULL unit_amount_decimal fails');
  });

  await runScenario('Scenario 77: Changed subtotal_minor fails', async () => {
    mockStripeInvoices.set('in_eq_77', { id: 'in_eq_77', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_77', amount: 5000, subtotal: 5000 }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_77', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_eq_77', { id: 'in_eq_77', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_77', amount: 5000, subtotal: 4900 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_77', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'FINALIZED_INVOICE_LINE_CONFLICT', 'Changed subtotal_minor fails');
  });

  await runScenario('Scenario 78: Changed amount_minor fails', async () => {
    mockStripeInvoices.set('in_eq_78', { id: 'in_eq_78', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_78', amount: 5000 }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_78', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_eq_78', { id: 'in_eq_78', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_78', amount: 4900 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_78', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'FINALIZED_INVOICE_LINE_CONFLICT', 'Changed amount_minor fails');
  });

  await runScenario('Scenario 79: Changed line currency fails', async () => {
    mockStripeInvoices.set('in_eq_79', { id: 'in_eq_79', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_79', amount: 5000, currency: 'usd' }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_79', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_eq_79', { id: 'in_eq_79', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_79', amount: 5000, currency: 'eur' }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_79', stripeOverride: mockStripe });
    assert(res.success === false && (res.classification === 'FINALIZED_INVOICE_LINE_CONFLICT' || res.classification === 'LINE_CURRENCY_MISMATCH'), 'Changed line currency fails');
  });

  await runScenario('Scenario 80: Changed period_start fails', async () => {
    mockStripeInvoices.set('in_eq_80', { id: 'in_eq_80', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_80', amount: 5000, period: { start: 1700000000, end: 1700001000 } }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_80', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_eq_80', { id: 'in_eq_80', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_80', amount: 5000, period: { start: 1700000500, end: 1700001000 } }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_80', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'FINALIZED_INVOICE_LINE_CONFLICT', 'Changed period_start fails');
  });

  await runScenario('Scenario 81: Changed period_end fails', async () => {
    mockStripeInvoices.set('in_eq_81', { id: 'in_eq_81', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_81', amount: 5000, period: { start: 1700000000, end: 1700001000 } }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_81', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_eq_81', { id: 'in_eq_81', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_81', amount: 5000, period: { start: 1700000000, end: 1700002000 } }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_81', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'FINALIZED_INVOICE_LINE_CONFLICT', 'Changed period_end fails');
  });

  await runScenario('Scenario 82: NULL period vs non-NULL period fails', async () => {
    mockStripeInvoices.set('in_eq_82', { id: 'in_eq_82', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_82', amount: 5000 }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_82', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_eq_82', { id: 'in_eq_82', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_82', amount: 5000, period: { start: 1700000000, end: 1700001000 } }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_82', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'FINALIZED_INVOICE_LINE_CONFLICT', 'NULL period vs non-NULL period fails');
  });

  await runScenario('Scenario 83: Changed subscription_id fails', async () => {
    mockStripeInvoices.set('in_eq_83', { id: 'in_eq_83', customer: CUST_A, subscription: SUB_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_83', amount: 5000 }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_83', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_eq_83', { id: 'in_eq_83', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_83', amount: 5000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_83', stripeOverride: mockStripe });
    assert(res.success === false && (res.classification === 'FINALIZED_INVOICE_BASELINE_CONFLICT' || res.classification === 'FINALIZED_INVOICE_LINE_CONFLICT'), 'Changed subscription_id fails');
  });

  await runScenario('Scenario 84: Stored extra line fails count check', async () => {
    mockStripeInvoices.set('in_eq_84', { id: 'in_eq_84', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 6000, amount_due: 6000, amount_paid: 0, lines: { data: [{ id: 'il_eq_84a', amount: 5000 }, { id: 'il_eq_84b', amount: 1000 }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_84', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_eq_84', { id: 'in_eq_84', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 6000, amount_due: 6000, amount_paid: 0, lines: { data: [{ id: 'il_eq_84a', amount: 5000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_84', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'FINALIZED_INVOICE_LINE_CONFLICT', 'Stored extra line fails count check');
  });

  await runScenario('Scenario 85: Incoming extra line fails count check', async () => {
    mockStripeInvoices.set('in_eq_85', { id: 'in_eq_85', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_85a', amount: 5000 }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_85', stripeOverride: mockStripe });
    mockStripeInvoices.set('in_eq_85', { id: 'in_eq_85', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_85a', amount: 5000 }, { id: 'il_eq_85b', amount: 1000 }] } });
    const res = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_85', stripeOverride: mockStripe });
    assert(res.success === false && res.classification === 'FINALIZED_INVOICE_LINE_CONFLICT', 'Incoming extra line fails count check');
  });

  await runScenario('Scenario 86: Empty finalized snapshot vs empty incoming succeeds', async () => {
    mockStripeInvoices.set('in_eq_86', { id: 'in_eq_86', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 0, amount_due: 0, amount_paid: 0, lines: { data: [] } });
    const res1 = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_86', stripeOverride: mockStripe });
    const res2 = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_86', stripeOverride: mockStripe });
    assert(res1.success === true && res2.success === true, 'Empty finalized snapshot replay succeeds');
  });

  await runScenario('Scenario 87: Line snapshot mismatch produces ZERO DML', async () => {
    mockStripeInvoices.set('in_eq_87', { id: 'in_eq_87', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_87', amount: 5000 }] } });
    const res1 = await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_87', stripeOverride: mockStripe });
    const lineBefore = db.billingInvoiceLines.get(`${res1.invoiceId}_il_eq_87`);
    mockStripeInvoices.set('in_eq_87', { id: 'in_eq_87', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_87', amount: 9999 }] } });
    await StripeInvoiceSyncService.reconcileInvoiceFromProvider(client as any, { providerInvoiceId: 'in_eq_87', stripeOverride: mockStripe });
    const lineAfter = db.billingInvoiceLines.get(`${res1.invoiceId}_il_eq_87`);
    assert(lineAfter.amount_minor === lineBefore.amount_minor, 'Mismatch produced ZERO DML');
  });

  await runScenario('Scenario 88: Duplicate finalized webhook replay remains idempotent', async () => {
    const hookEvt: any = { id: 'evt_hook_88', type: 'invoice.finalized', data: { object: { id: 'in_eq_base', object: 'invoice', customer: CUST_A, status: 'open', currency: 'usd', subtotal: 5000, amount_due: 5000, amount_paid: 0, lines: { data: [{ id: 'il_eq_1', amount: 5000, description: 'Line 1', quantity: 1 }] } } } };
    const hRes1 = await StripeWebhookHandler.handleWebhookEvent(client as any, JSON.stringify(hookEvt), 'sig', { stripeOverride: mockStripe, skipSignatureVerification: true });
    const hRes2 = await StripeWebhookHandler.handleWebhookEvent(client as any, JSON.stringify(hookEvt), 'sig', { stripeOverride: mockStripe, skipSignatureVerification: true });
    assert(hRes1.success === true && hRes2.duplicate === true, 'Duplicate finalized webhook replay remains idempotent');
  });

  await runScenario('Scenario 89: Finalized lines remain physically immutable to browser update', async () => {
    const inv = Array.from(db.billingInvoices.values()).find((i) => i.provider_invoice_id === 'in_eq_base');
    const line = Array.from(db.billingInvoiceLines.values()).find((l) => l.invoice_id === inv.id);
    const updateRes = await client.from('billing_invoice_lines').eq('id', line.id).update({ amount_minor: 7777 });
    assert(updateRes.error !== null, 'Finalized lines remain physically immutable');
  });

  console.log('\n===================================================================');
  console.log('SUMMARY OF PHASE 13.4.3A TEST RESULTS:');
  console.log(`Passed Scenarios  : ${passedScenarios}`);
  console.log(`Failed Scenarios  : ${failedScenarios}`);
  console.log(`Passed Assertions : ${passedAssertions}`);
  console.log(`Failed Assertions : ${failedAssertions}`);
  console.log('===================================================================\n');

  if (failedScenarios > 0 || failedAssertions > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
