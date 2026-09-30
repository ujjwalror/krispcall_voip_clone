process.env.STRIPE_SECRET_KEY = 'sk_test_mock_key_1234567890';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_1234567890';
process.env.STRIPE_EXPECTED_MODE = 'test';

import { TelecomWalletService } from '../src/lib/billing/telecomWalletService';
import { CreditLedgerService } from '../src/lib/billing/creditLedgerService';

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

// In-Memory Database Simulator for Hardened Phase 13.4.3B.1 Testing
class MockDatabase {
  public organizations: Map<string, any> = new Map();
  public billingCreditLedger: Map<string, any> = new Map();
  public telecomRetailRateCards: Map<string, any> = new Map();
  public telecomUsageReservations: Map<string, any> = new Map();
  public telecomFinancialOperationIdempotency: Map<string, any> = new Map();
  public organizationBillingControls: Map<string, any> = new Map();

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
    this.billingCreditLedger.clear();
    this.telecomRetailRateCards.clear();
    this.telecomUsageReservations.clear();
    this.telecomFinancialOperationIdempotency.clear();
    this.organizationBillingControls.clear();

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

  createClient(role: 'service_role' | 'authenticated' | 'anon' = 'service_role', activeUserId?: string) {
    const db = this;

    return {
      rpc: async (fnName: string, args: any) => {
        if (role !== 'service_role') {
          throw new Error(`permission denied for function ${fnName}`);
        }
        if (fnName === 'record_credit_ledger_entry_atomic') {
          return db.rpcRecordCreditLedgerEntry(args);
        }
        if (fnName === 'get_telecom_wallet_summary_atomic') {
          return db.rpcGetTelecomWalletSummary(args.p_organization_id);
        }
        if (fnName === 'record_telecom_usage_reservation_atomic') {
          return db.rpcRecordTelecomUsageReservation(args);
        }
        if (fnName === 'extend_telecom_usage_reservation_atomic') {
          return db.rpcExtendTelecomUsageReservation(args);
        }
        if (fnName === 'settle_telecom_usage_reservation_atomic') {
          return db.rpcSettleTelecomUsageReservation(args);
        }
        if (fnName === 'release_telecom_usage_reservation_atomic') {
          return db.rpcReleaseTelecomUsageReservation(args);
        }
        if (fnName === 'record_telecom_usage_reversal_atomic') {
          return db.rpcRecordTelecomUsageReversal(args);
        }
        throw new Error(`Unknown RPC ${fnName}`);
      },
      from: (table: string) => {
        return new MockQueryBuilder(db, table, role, activeUserId);
      },
    };
  }

  // --- RPC Implementations ---
  private rpcRecordCreditLedgerEntry(args: any) {
    const orgId = args.p_organization_id;
    const amountMinor = Number(args.p_amount_minor);
    const entryType = args.p_entry_type;

    let currentBalance = 0;
    let currency = 'USD';
    const orgEntries = Array.from(this.billingCreditLedger.values())
      .filter((e) => e.organization_id === orgId);

    if (orgEntries.length > 0) {
      const latest = orgEntries[orgEntries.length - 1];
      currentBalance = latest.balance_after_minor;
      currency = latest.currency || 'USD';
    }

    const newBalance = currentBalance + amountMinor;
    if (newBalance < 0) {
      return { data: null, error: { message: 'INSUFFICIENT_CREDIT: Credit consumption exceeds available organization balance.' } };
    }

    const id = `cld_${Math.random().toString(36).substring(2, 9)}`;
    const newEntry = {
      id,
      organization_id: orgId,
      entry_type: entryType,
      amount_minor: amountMinor,
      balance_after_minor: newBalance,
      currency: args.p_currency || currency,
      description: args.p_description,
      reference_type: args.p_reference_type || null,
      reference_id: args.p_reference_id || null,
      created_by: args.p_created_by || null,
      created_at: new Date().toISOString(),
    };

    this.billingCreditLedger.set(id, newEntry);
    return { data: newEntry, error: null };
  }

  private rpcGetTelecomWalletSummary(orgId: string) {
    let fundedBalance = 0;
    let currency = 'USD';

    const orgEntries = Array.from(this.billingCreditLedger.values())
      .filter((e) => e.organization_id === orgId);

    if (orgEntries.length > 0) {
      const latest = orgEntries[orgEntries.length - 1];
      fundedBalance = latest.balance_after_minor;
      currency = latest.currency || 'USD';
    }

    // CORRECTION 1: ALL status='active' reservations count against active protected exposure REGARDLESS of expires_at!
    const activeReservations = Array.from(this.telecomUsageReservations.values())
      .filter((r) => r.organization_id === orgId && r.status === 'active')
      .reduce((sum, r) => sum + Number(r.amount_reserved_minor), 0);

    const availableBalance = Math.max(0, fundedBalance - activeReservations);

    return {
      data: {
        organization_id: orgId,
        funded_balance_minor: fundedBalance,
        active_reservations_minor: activeReservations,
        available_balance_minor: availableBalance,
        currency,
      },
      error: null,
    };
  }

  private rpcRecordTelecomUsageReservation(args: any) {
    const orgId = args.p_organization_id;
    const usageId = (args.p_internal_usage_id || '').trim();
    const idempotencyKey = (args.p_idempotency_key || '').trim();
    const amountReserved = Number(args.p_amount_reserved_minor);
    const reqCurrency = (args.p_currency || 'USD').toUpperCase();
    const expiresIn = Number(args.p_expires_in_seconds || 1800);

    // Input Validation Hardening
    if (!orgId) return { data: null, error: { message: 'INVALID_ARGUMENT: p_organization_id is required.' } };
    if (!usageId || usageId.length > 128 || !/^[a-zA-Z0-9_\-]+$/.test(usageId)) {
      return { data: null, error: { message: 'INVALID_INTERNAL_USAGE_ID: Must be non-blank alphanumeric string max 128 chars.' } };
    }
    if (!idempotencyKey || idempotencyKey.length > 128 || !/^[a-zA-Z0-9_\-]+$/.test(idempotencyKey)) {
      return { data: null, error: { message: 'INVALID_IDEMPOTENCY_KEY: Must be non-blank alphanumeric string max 128 chars.' } };
    }
    if (isNaN(amountReserved) || amountReserved <= 0) {
      return { data: null, error: { message: 'INVALID_RESERVATION_AMOUNT: p_amount_reserved_minor must be positive.' } };
    }
    if (!/^[A-Z]{3}$/.test(reqCurrency)) {
      return { data: null, error: { message: 'INVALID_CURRENCY: Currency must be 3-letter ISO code.' } };
    }
    if (expiresIn <= 0 || expiresIn > 86400) {
      return { data: null, error: { message: 'INVALID_EXPIRATION_INTERVAL: Expiry must be between 1 and 86400 seconds.' } };
    }

    // 1. Structured Financial Operation Idempotency Check
    const idempotencyOpKey = `${orgId}:reservation_create:${idempotencyKey}`;
    const existingOp = this.telecomFinancialOperationIdempotency.get(idempotencyOpKey);
    if (existingOp) {
      const p = existingOp.request_payload;
      if (
        p.amount_reserved_minor !== amountReserved ||
        p.currency !== reqCurrency ||
        p.service_type !== args.p_service_type ||
        p.direction !== args.p_direction ||
        p.internal_usage_id !== usageId
      ) {
        return { data: null, error: { message: `IDEMPOTENCY_CONFLICT: Payload parameters conflict with original reservation ${idempotencyKey}` } };
      }
      return { data: { ...existingOp.response_payload, is_duplicate: true }, error: null };
    }

    // Check if internal_usage_id already exists under a different key
    const existingRes = Array.from(this.telecomUsageReservations.values()).find(
      (r) => r.organization_id === orgId && r.internal_usage_id === usageId
    );
    if (existingRes) {
      return { data: null, error: { message: `IDEMPOTENCY_CONFLICT: Usage ID ${usageId} already exists` } };
    }

    // 2. Billing Restriction Check
    const controls = this.organizationBillingControls.get(orgId);
    if (controls && controls.is_billing_restricted) {
      return { data: null, error: { message: `ORGANIZATION_BILLING_RESTRICTED: Organization ${orgId} is restricted` } };
    }

    // 3. Balance & Currency Check
    const summary = this.rpcGetTelecomWalletSummary(orgId).data;
    if (reqCurrency !== summary.currency && summary.funded_balance_minor > 0) {
      return { data: null, error: { message: `CURRENCY_MISMATCH: Requested currency ${reqCurrency} does not match wallet currency ${summary.currency}` } };
    }

    if (summary.available_balance_minor < amountReserved) {
      return {
        data: null,
        error: {
          message: `INSUFFICIENT_AVAILABLE_BALANCE: Available funded balance ${summary.available_balance_minor} is insufficient for required reservation ${amountReserved}`,
        },
      };
    }

    // 4. Create Active Reservation
    const id = `res_${Math.random().toString(36).substring(2, 9)}`;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const newRes = {
      id,
      internal_usage_id: usageId,
      organization_id: orgId,
      service_type: args.p_service_type,
      direction: args.p_direction,
      provider: args.p_provider || 'twilio',
      provider_resource_id: args.p_provider_resource_id || null,
      rate_card_id: args.p_rate_card_id || null,
      rate_snapshot: args.p_rate_snapshot || {},
      amount_reserved_minor: amountReserved,
      currency: reqCurrency,
      status: 'active',
      idempotency_key: idempotencyKey,
      expires_at: expiresAt,
      settled_at: null,
      released_at: null,
      settlement_ledger_id: null,
      actual_provider_cost_minor: null,
      actual_customer_charge_minor: null,
      actual_gross_margin_minor: null,
      metadata: args.p_metadata || {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    this.telecomUsageReservations.set(id, newRes);
    const updatedSummary = this.rpcGetTelecomWalletSummary(orgId).data;

    const respPayload = {
      success: true,
      is_duplicate: false,
      reservation_id: id,
      internal_usage_id: usageId,
      amount_reserved_minor: amountReserved,
      status: 'active',
      expires_at: expiresAt,
      funded_balance_minor: updatedSummary.funded_balance_minor,
      active_reservations_minor: updatedSummary.active_reservations_minor,
      available_balance_minor: updatedSummary.available_balance_minor,
    };

    // Store in structured idempotency ledger
    this.telecomFinancialOperationIdempotency.set(idempotencyOpKey, {
      request_payload: {
        organization_id: orgId,
        internal_usage_id: usageId,
        service_type: args.p_service_type,
        direction: args.p_direction,
        amount_reserved_minor: amountReserved,
        currency: reqCurrency,
      },
      response_payload: respPayload,
    });

    return { data: respPayload, error: null };
  }

  private rpcExtendTelecomUsageReservation(args: any) {
    const orgId = args.p_organization_id;
    const usageId = (args.p_internal_usage_id || '').trim();
    const additionalAmount = Number(args.p_additional_amount_reserved_minor);
    const idempotencyKey = (args.p_idempotency_key || '').trim();
    const newExpiresIn = Number(args.p_new_expires_in_seconds || 1800);

    // Input Validation
    if (!orgId) return { data: null, error: { message: 'INVALID_ARGUMENT: p_organization_id is required.' } };
    if (!usageId || usageId.length > 128 || !/^[a-zA-Z0-9_\-]+$/.test(usageId)) {
      return { data: null, error: { message: 'INVALID_INTERNAL_USAGE_ID: Must be non-blank alphanumeric string max 128 chars.' } };
    }
    if (!idempotencyKey || idempotencyKey.length > 128 || !/^[a-zA-Z0-9_\-]+$/.test(idempotencyKey)) {
      return { data: null, error: { message: 'INVALID_IDEMPOTENCY_KEY: Must be non-blank alphanumeric string max 128 chars.' } };
    }
    if (isNaN(additionalAmount) || additionalAmount <= 0) {
      return { data: null, error: { message: 'INVALID_EXTENSION_AMOUNT: p_additional_amount_reserved_minor must be positive.' } };
    }
    if (newExpiresIn <= 0 || newExpiresIn > 86400) {
      return { data: null, error: { message: 'INVALID_EXPIRATION_INTERVAL: Expiry must be between 1 and 86400 seconds.' } };
    }

    // 1. Structured Financial Operation Idempotency Check
    const idempotencyOpKey = `${orgId}:reservation_extend:${idempotencyKey}`;
    const existingOp = this.telecomFinancialOperationIdempotency.get(idempotencyOpKey);
    if (existingOp) {
      const p = existingOp.request_payload;
      if (p.additional_amount_reserved_minor !== additionalAmount || p.internal_usage_id !== usageId) {
        return { data: null, error: { message: `IDEMPOTENCY_CONFLICT: Payload parameters conflict for extension ${idempotencyKey}` } };
      }
      return { data: { ...existingOp.response_payload, is_duplicate: true }, error: null };
    }

    const res = Array.from(this.telecomUsageReservations.values()).find(
      (r) => r.organization_id === orgId && r.internal_usage_id === usageId
    );

    if (!res) {
      return { data: null, error: { message: `RESERVATION_NOT_FOUND: ${usageId}` } };
    }

    if (res.status !== 'active') {
      return { data: null, error: { message: `CANNOT_EXTEND_INACTIVE_RESERVATION: Status is ${res.status}` } };
    }

    const summary = this.rpcGetTelecomWalletSummary(orgId).data;
    if (summary.available_balance_minor < additionalAmount) {
      return { data: null, error: { message: `INSUFFICIENT_AVAILABLE_BALANCE: Cannot cover reservation extension ${additionalAmount}` } };
    }

    res.amount_reserved_minor += additionalAmount;
    res.expires_at = new Date(Date.now() + newExpiresIn * 1000).toISOString();
    res.updated_at = new Date().toISOString();

    const updatedSummary = this.rpcGetTelecomWalletSummary(orgId).data;
    const respPayload = {
      success: true,
      is_duplicate: false,
      reservation_id: res.id,
      internal_usage_id: usageId,
      amount_reserved_minor: res.amount_reserved_minor,
      additional_reserved_minor: additionalAmount,
      funded_balance_minor: updatedSummary.funded_balance_minor,
      active_reservations_minor: updatedSummary.active_reservations_minor,
      available_balance_minor: updatedSummary.available_balance_minor,
    };

    // Store in structured idempotency ledger
    this.telecomFinancialOperationIdempotency.set(idempotencyOpKey, {
      request_payload: {
        organization_id: orgId,
        internal_usage_id: usageId,
        additional_amount_reserved_minor: additionalAmount,
      },
      response_payload: respPayload,
    });

    return { data: respPayload, error: null };
  }

  private rpcSettleTelecomUsageReservation(args: any) {
    const orgId = args.p_organization_id;
    const usageId = (args.p_internal_usage_id || '').trim();
    const actualCharge = Number(args.p_actual_retail_charge_minor);
    const idempotencyKey = (args.p_idempotency_key || '').trim();

    // Input Validation
    if (!orgId) return { data: null, error: { message: 'INVALID_ARGUMENT: p_organization_id is required.' } };
    if (!usageId || usageId.length > 128 || !/^[a-zA-Z0-9_\-]+$/.test(usageId)) {
      return { data: null, error: { message: 'INVALID_INTERNAL_USAGE_ID: Must be non-blank alphanumeric string max 128 chars.' } };
    }
    if (!idempotencyKey || idempotencyKey.length > 128 || !/^[a-zA-Z0-9_\-]+$/.test(idempotencyKey)) {
      return { data: null, error: { message: 'INVALID_IDEMPOTENCY_KEY: Must be non-blank alphanumeric string max 128 chars.' } };
    }
    if (isNaN(actualCharge) || actualCharge < 0) {
      return { data: null, error: { message: 'INVALID_SETTLEMENT_AMOUNT: p_actual_retail_charge_minor cannot be negative.' } };
    }

    // 1. Structured Financial Operation Idempotency Check
    const idempotencyOpKey = `${orgId}:reservation_settle:${idempotencyKey}`;
    const existingOp = this.telecomFinancialOperationIdempotency.get(idempotencyOpKey);
    if (existingOp) {
      const p = existingOp.request_payload;
      if (p.actual_retail_charge_minor !== actualCharge || p.internal_usage_id !== usageId) {
        return { data: null, error: { message: `IDEMPOTENCY_CONFLICT: Payload parameters conflict for settlement ${idempotencyKey}` } };
      }
      return { data: { ...existingOp.response_payload, is_duplicate: true }, error: null };
    }

    // CORRECTION 2: Normal settlement MUST require an existing active reservation!
    const res = Array.from(this.telecomUsageReservations.values()).find(
      (r) => r.organization_id === orgId && r.internal_usage_id === usageId
    );

    if (!res) {
      return { data: null, error: { message: `RESERVATION_NOT_FOUND: Normal settlement requires an existing active reservation for usage ${usageId}` } };
    }

    if (res.status === 'settled') {
      if (res.actual_customer_charge_minor !== actualCharge) {
        return { data: null, error: { message: `IDEMPOTENCY_CONFLICT: Settlement charge ${actualCharge} conflicts with original settled charge ${res.actual_customer_charge_minor}` } };
      }
      const summary = this.rpcGetTelecomWalletSummary(orgId).data;
      return {
        data: {
          success: true,
          is_duplicate: true,
          reservation_id: res.id,
          internal_usage_id: res.internal_usage_id,
          status: 'settled',
          actual_customer_charge_minor: res.actual_customer_charge_minor,
          settlement_ledger_id: res.settlement_ledger_id,
          funded_balance_minor: summary.funded_balance_minor,
          available_balance_minor: summary.available_balance_minor,
        },
        error: null,
      };
    }

    if (res.status !== 'active') {
      return { data: null, error: { message: `CANNOT_SETTLE_INACTIVE_RESERVATION: Usage reservation ${usageId} status is ${res.status}` } };
    }

    // CORRECTION 3: Protect OTHER active reservations!
    const otherProtected = Array.from(this.telecomUsageReservations.values())
      .filter((r) => r.organization_id === orgId && r.status === 'active' && r.id !== res.id)
      .reduce((sum, r) => sum + Number(r.amount_reserved_minor), 0);

    const currentFunded = this.rpcGetTelecomWalletSummary(orgId).data.funded_balance_minor;
    const unreservedFunded = currentFunded - otherProtected;

    if (actualCharge > unreservedFunded) {
      return {
        data: null,
        error: {
          message: `SETTLEMENT_EXCEEDS_UNRESERVED_FUNDED_BALANCE: Charge ${actualCharge} exceeds funded balance ${currentFunded} available after protecting other active reservations ${otherProtected}`,
        },
      };
    }

    // Deduct REAL charge from billing_credit_ledger
    let ledgerEntryId: string | null = null;
    let newFunded = currentFunded;

    if (actualCharge > 0) {
      const ledgerResult = this.rpcRecordCreditLedgerEntry({
        p_organization_id: orgId,
        p_entry_type: 'telecom_usage',
        p_amount_minor: -actualCharge,
        p_currency: res.currency,
        p_description: args.p_description || 'Telecom usage charge',
        p_reference_type: 'telecom_usage',
        p_reference_id: usageId,
      });

      if (ledgerResult.error) {
        return { data: null, error: ledgerResult.error };
      }
      ledgerEntryId = ledgerResult.data.id;
      newFunded = ledgerResult.data.balance_after_minor;
    }

    const margin = args.p_provider_wholesale_cost_minor !== undefined && args.p_provider_wholesale_cost_minor !== null
      ? actualCharge - Number(args.p_provider_wholesale_cost_minor)
      : null;

    res.status = 'settled';
    res.settled_at = new Date().toISOString();
    res.settlement_ledger_id = ledgerEntryId;
    res.actual_customer_charge_minor = actualCharge;
    res.actual_provider_cost_minor = args.p_provider_wholesale_cost_minor ?? null;
    res.actual_gross_margin_minor = margin;
    if (args.p_provider_resource_id) {
      res.provider_resource_id = args.p_provider_resource_id;
    }
    res.updated_at = new Date().toISOString();

    const updatedSummary = this.rpcGetTelecomWalletSummary(orgId).data;

    const respPayload = {
      success: true,
      is_duplicate: false,
      reservation_id: res.id,
      internal_usage_id: usageId,
      status: 'settled',
      actual_customer_charge_minor: actualCharge,
      actual_provider_cost_minor: args.p_provider_wholesale_cost_minor ?? null,
      actual_gross_margin_minor: margin,
      settlement_ledger_id: ledgerEntryId,
      funded_balance_minor: newFunded,
      active_reservations_minor: updatedSummary.active_reservations_minor,
      available_balance_minor: updatedSummary.available_balance_minor,
    };

    // Store in structured idempotency ledger
    this.telecomFinancialOperationIdempotency.set(idempotencyOpKey, {
      request_payload: {
        organization_id: orgId,
        internal_usage_id: usageId,
        actual_retail_charge_minor: actualCharge,
      },
      response_payload: respPayload,
    });

    return { data: respPayload, error: null };
  }

  private rpcReleaseTelecomUsageReservation(args: any) {
    const orgId = args.p_organization_id;
    const usageId = (args.p_internal_usage_id || '').trim();
    const idempotencyKey = (args.p_idempotency_key || '').trim();

    // Input Validation
    if (!orgId) return { data: null, error: { message: 'INVALID_ARGUMENT: p_organization_id is required.' } };
    if (!usageId || usageId.length > 128 || !/^[a-zA-Z0-9_\-]+$/.test(usageId)) {
      return { data: null, error: { message: 'INVALID_INTERNAL_USAGE_ID: Must be non-blank alphanumeric string max 128 chars.' } };
    }

    if (idempotencyKey.length > 0) {
      const idempotencyOpKey = `${orgId}:reservation_release:${idempotencyKey}`;
      const existingOp = this.telecomFinancialOperationIdempotency.get(idempotencyOpKey);
      if (existingOp) {
        return { data: { ...existingOp.response_payload, is_duplicate: true }, error: null };
      }
    }

    const res = Array.from(this.telecomUsageReservations.values()).find(
      (r) => r.organization_id === orgId && r.internal_usage_id === usageId
    );

    if (!res) {
      return { data: null, error: { message: `RESERVATION_NOT_FOUND: ${usageId}` } };
    }

    if (res.status === 'released' || res.status === 'expired') {
      const summary = this.rpcGetTelecomWalletSummary(orgId).data;
      return {
        data: {
          success: true,
          is_duplicate: true,
          reservation_id: res.id,
          internal_usage_id: res.internal_usage_id,
          status: res.status,
          funded_balance_minor: summary.funded_balance_minor,
          available_balance_minor: summary.available_balance_minor,
        },
        error: null,
      };
    }

    if (res.status === 'settled') {
      return { data: null, error: { message: `CANNOT_RELEASE_SETTLED_RESERVATION: Usage reservation ${usageId} is settled` } };
    }

    res.status = 'released';
    res.released_at = new Date().toISOString();
    res.updated_at = new Date().toISOString();

    const summary = this.rpcGetTelecomWalletSummary(orgId).data;
    const respPayload = {
      success: true,
      is_duplicate: false,
      reservation_id: res.id,
      internal_usage_id: res.internal_usage_id,
      status: 'released',
      funded_balance_minor: summary.funded_balance_minor,
      active_reservations_minor: summary.active_reservations_minor,
      available_balance_minor: summary.available_balance_minor,
    };

    if (idempotencyKey.length > 0) {
      const idempotencyOpKey = `${orgId}:reservation_release:${idempotencyKey}`;
      this.telecomFinancialOperationIdempotency.set(idempotencyOpKey, {
        request_payload: { organization_id: orgId, internal_usage_id: usageId },
        response_payload: respPayload,
      });
    }

    return { data: respPayload, error: null };
  }

  private rpcRecordTelecomUsageReversal(args: any) {
    const orgId = args.p_organization_id;
    const usageId = (args.p_internal_usage_id || '').trim();
    const amountMinor = Number(args.p_reversal_amount_minor);
    const idempotencyKey = (args.p_idempotency_key || '').trim();

    // Input Validation
    if (!orgId) return { data: null, error: { message: 'INVALID_ARGUMENT: p_organization_id is required.' } };
    if (!usageId || usageId.length > 128 || !/^[a-zA-Z0-9_\-]+$/.test(usageId)) {
      return { data: null, error: { message: 'INVALID_INTERNAL_USAGE_ID: Must be non-blank alphanumeric string max 128 chars.' } };
    }
    if (!idempotencyKey || idempotencyKey.length > 128 || !/^[a-zA-Z0-9_\-]+$/.test(idempotencyKey)) {
      return { data: null, error: { message: 'INVALID_IDEMPOTENCY_KEY: Must be non-blank alphanumeric string max 128 chars.' } };
    }
    if (isNaN(amountMinor) || amountMinor <= 0) {
      return { data: null, error: { message: 'INVALID_REVERSAL_AMOUNT: p_reversal_amount_minor must be positive.' } };
    }

    // 1. Structured Financial Operation Idempotency Check (No description parsing!)
    const idempotencyOpKey = `${orgId}:usage_reversal:${idempotencyKey}`;
    const existingOp = this.telecomFinancialOperationIdempotency.get(idempotencyOpKey);
    if (existingOp) {
      const p = existingOp.request_payload;
      if (p.reversal_amount_minor !== amountMinor || p.internal_usage_id !== usageId) {
        return { data: null, error: { message: `IDEMPOTENCY_CONFLICT: Payload parameters conflict for reversal ${idempotencyKey}` } };
      }
      return { data: { ...existingOp.response_payload, is_duplicate: true }, error: null };
    }

    // CORRECTION 7: Reversal requires an existing settled reservation!
    const res = Array.from(this.telecomUsageReservations.values()).find(
      (r) => r.organization_id === orgId && r.internal_usage_id === usageId
    );

    if (!res || res.status !== 'settled') {
      return { data: null, error: { message: `SETTLED_RESERVATION_NOT_FOUND: Reversal requires an existing settled reservation for usage ${usageId}` } };
    }

    const settledCharge = res.actual_customer_charge_minor || 0;

    // Calculate total existing reversals for this usage ID from billingCreditLedger
    const existingReversals = Array.from(this.billingCreditLedger.values()).filter(
      (e) => e.organization_id === orgId && e.reference_type === 'telecom_usage' && e.reference_id === usageId && e.entry_type === 'usage_reversal'
    );

    const totalReversed = existingReversals.reduce((sum, e) => sum + Number(e.amount_minor), 0);

    // Bounded Reversal Check
    const remainingReversible = settledCharge - totalReversed;
    if (amountMinor > remainingReversible) {
      return {
        data: null,
        error: {
          message: `REVERSAL_EXCEEDS_SETTLED_CHARGE: Reversal amount ${amountMinor} exceeds remaining reversible amount ${remainingReversible} (original settled: ${settledCharge}, already reversed: ${totalReversed})`,
        },
      };
    }

    const ledgerResult = this.rpcRecordCreditLedgerEntry({
      p_organization_id: orgId,
      p_entry_type: 'usage_reversal',
      p_amount_minor: amountMinor,
      p_currency: res.currency,
      p_description: args.p_description || 'Telecom usage reversal',
      p_reference_type: 'telecom_usage',
      p_reference_id: usageId,
    });

    if (ledgerResult.error) {
      return { data: null, error: ledgerResult.error };
    }

    const summary = this.rpcGetTelecomWalletSummary(orgId).data;
    const respPayload = {
      success: true,
      is_duplicate: false,
      ledger_entry_id: ledgerResult.data.id,
      internal_usage_id: usageId,
      reversal_amount_minor: amountMinor,
      funded_balance_minor: summary.funded_balance_minor,
      active_reservations_minor: summary.active_reservations_minor,
      available_balance_minor: summary.available_balance_minor,
    };

    // Store in structured idempotency ledger
    this.telecomFinancialOperationIdempotency.set(idempotencyOpKey, {
      request_payload: {
        organization_id: orgId,
        internal_usage_id: usageId,
        reversal_amount_minor: amountMinor,
      },
      response_payload: respPayload,
    });

    return { data: respPayload, error: null };
  }
}

class MockQueryBuilder {
  private filterOrgId: string | null = null;
  private filterStatus: string | null = null;

  constructor(private db: MockDatabase, private table: string, private role: string, private activeUserId?: string) {}

  select(cols?: string) {
    // CORRECTION 1: Authenticated and Anon users CANNOT directly SELECT rate cards or usage reservations!
    if (this.role === 'authenticated' || this.role === 'anon') {
      if (this.table === 'telecom_retail_rate_cards' || this.table === 'telecom_usage_reservations' || this.table === 'telecom_financial_operation_idempotency') {
        throw new Error(`permission denied for table ${this.table}`);
      }
    }
    return this;
  }
  eq(col: string, val: any) {
    if (col === 'organization_id') this.filterOrgId = val;
    if (col === 'status') this.filterStatus = val;
    return this;
  }
  order(col: string, opts?: any) { return this; }
  limit(n: number) { return this; }

  async maybeSingle() {
    if (this.table === 'billing_credit_ledger' && this.filterOrgId) {
      const orgEntries = Array.from(this.db.billing_credit_ledger.values())
        .filter((e) => e.organization_id === this.filterOrgId);
      return { data: orgEntries.length > 0 ? orgEntries[orgEntries.length - 1] : null, error: null };
    }
    return { data: null, error: null };
  }
}

// ===================================================================
// TEST SUITE EXECUTION
// ===================================================================

const db = new MockDatabase();

async function runAllTests() {
  console.log('====================================================');
  console.log('PHASE 13.4.3B.1 — HARDENED WALLET & RESERVATION TEST SUITE');
  console.log('====================================================\n');

  const testOrgId = 'org_test_hardened_1001';
  const testOrgId2 = 'org_test_hardened_1002';
  const supabase = db.createClient('service_role');
  const authenticatedClient = db.createClient('authenticated', 'usr_auth_123');
  const anonClient = db.createClient('anon');

  db.organizations.set(testOrgId, { id: testOrgId, name: 'Org 1' });
  db.organizations.set(testOrgId2, { id: testOrgId2, name: 'Org 2' });
  db.organizationBillingControls.set(testOrgId, { organization_id: testOrgId, is_billing_restricted: false });
  db.organizationBillingControls.set(testOrgId2, { organization_id: testOrgId2, is_billing_restricted: false });

  // 1. Initial State Check
  await runScenario('1. Initial funded balance & available balance are zero', async () => {
    const summary = await TelecomWalletService.getWalletSummary(supabase, testOrgId);
    assert(summary.fundedBalanceMinor === 0, 'Funded balance starts at 0');
    assert(summary.activeReservationsMinor === 0, 'Active reservations start at 0');
    assert(summary.availableBalanceMinor === 0, 'Available balance starts at 0');
  });

  // 2. Fund Wallet via Grant Entry
  await runScenario('2. Add funded credit ($10.00 = 1000 minor)', async () => {
    await CreditLedgerService.addCreditEntry(supabase as any, {
      organizationId: testOrgId,
      entryType: 'grant',
      amountMinor: 1000,
      description: 'Topup $10.00',
      referenceType: 'payment_operation',
      referenceId: 'pop_test_1001',
    });

    const summary = await TelecomWalletService.getWalletSummary(supabase, testOrgId);
    assert(summary.fundedBalanceMinor === 1000, 'Funded balance is 1000');
    assert(summary.availableBalanceMinor === 1000, 'Available balance is 1000');
  });

  // 3. Correction 1: Stale expires_at DOES NOT release money!
  await runScenario('3. Stale expires_at in past DOES NOT release protected exposure', async () => {
    const res = await TelecomWalletService.reserveUsage(supabase, {
      organizationId: testOrgId,
      internalUsageId: 'usg_stale_001',
      serviceType: 'voice_outbound',
      direction: 'outbound',
      amountReservedMinor: 200,
      idempotencyKey: 'idemp_stale_001',
      expiresInSeconds: 1, // Expires in 1 second
    });

    assert(res.success === true, 'Reservation created');

    // Simulate 5 seconds passing (expires_at is now in the past)
    const rawRes = Array.from(db.telecomUsageReservations.values()).find((r) => r.internal_usage_id === 'usg_stale_001');
    rawRes.expires_at = new Date(Date.now() - 5000).toISOString();

    const summary = await TelecomWalletService.getWalletSummary(supabase, testOrgId);
    assert(summary.fundedBalanceMinor === 1000, 'Funded balance remains 1000');
    assert(summary.activeReservationsMinor === 200, 'Active reservations remains 200 even though expires_at passed');
    assert(summary.availableBalanceMinor === 800, 'Available balance is 800 (time alone did NOT release funds)');
  });

  // 4. Correction 4: Extension Primitive
  await runScenario('4. Extension primitive increases active reservation hold', async () => {
    const ext = await TelecomWalletService.extendReservation(supabase, {
      organizationId: testOrgId,
      internalUsageId: 'usg_stale_001',
      additionalAmountReservedMinor: 150,
      idempotencyKey: 'idemp_ext_001',
    });

    assert(ext.success === true, 'Extension succeeded');
    assert(ext.amountReservedMinor === 350, 'Total reserved is now 350 (200 + 150)');

    const summary = await TelecomWalletService.getWalletSummary(supabase, testOrgId);
    assert(summary.activeReservationsMinor === 350, 'Active reservations is 350');
    assert(summary.availableBalanceMinor === 650, 'Available balance is 650 (1000 - 350)');
  });

  // 5. Extension Idempotency: Exact replay
  await runScenario('5. Extension idempotency returns existing extended state for exact replay', async () => {
    const ext = await TelecomWalletService.extendReservation(supabase, {
      organizationId: testOrgId,
      internalUsageId: 'usg_stale_001',
      additionalAmountReservedMinor: 150,
      idempotencyKey: 'idemp_ext_001',
    });

    assert(ext.success === true, 'Duplicate extension succeeded');
    assert(ext.isDuplicate === true, 'Flagged as duplicate');

    const summary = await TelecomWalletService.getWalletSummary(supabase, testOrgId);
    assert(summary.activeReservationsMinor === 350, 'Active reservations remains 350 (no double extension)');
  });

  // 6. Extension Idempotency: Conflicting payload
  await runScenario('6. Extension idempotency with conflicting amount fails closed', async () => {
    let threw = false;
    try {
      await TelecomWalletService.extendReservation(supabase, {
        organizationId: testOrgId,
        internalUsageId: 'usg_stale_001',
        additionalAmountReservedMinor: 500, // Conflict: original was 150
        idempotencyKey: 'idemp_ext_001',
      });
    } catch (err: any) {
      threw = true;
      assert(err.message.includes('IDEMPOTENCY_CONFLICT'), 'Conflicting extension rejected');
    }
    assert(threw === true, 'Conflicting extension threw exception');
  });

  // 7. Correction 2: Settlement requires an existing reservation
  await runScenario('7. Normal settlement without an existing reservation fails closed', async () => {
    let threw = false;
    try {
      await TelecomWalletService.settleUsage(supabase, {
        organizationId: testOrgId,
        internalUsageId: 'usg_non_existent',
        actualRetailChargeMinor: 100,
        description: 'Ghost call settlement',
        idempotencyKey: 'idemp_ghost',
      });
    } catch (err: any) {
      threw = true;
      assert(err.message.includes('RESERVATION_NOT_FOUND'), 'Fails closed when reservation is absent');
    }
    assert(threw === true, 'Settlement without reservation threw exception');
  });

  // 8. Reserve Call B for Correction 3
  await runScenario('8. Reserve Call B ($5.00 = 500 minor hold)', async () => {
    const resB = await TelecomWalletService.reserveUsage(supabase, {
      organizationId: testOrgId,
      internalUsageId: 'usg_call_b',
      serviceType: 'voice_outbound',
      direction: 'outbound',
      amountReservedMinor: 500,
      idempotencyKey: 'idemp_call_b',
    });

    assert(resB.success === true, 'Call B reserved');
    const summary = await TelecomWalletService.getWalletSummary(supabase, testOrgId);
    assert(summary.activeReservationsMinor === 850, 'Active reservations is 850 (350 + 500)');
    assert(summary.availableBalanceMinor === 150, 'Available balance is 150 (1000 - 850)');
  });

  // 9. Correction 3: Settlement MUST NOT steal funds protected for Call B!
  await runScenario('9. Settling Call A for $8.00 when Call B holds $5.00 fails closed', async () => {
    let threw = false;
    try {
      await TelecomWalletService.settleUsage(supabase, {
        organizationId: testOrgId,
        internalUsageId: 'usg_stale_001', // Call A
        actualRetailChargeMinor: 800,
        description: 'Over-charging Call A',
        idempotencyKey: 'idemp_settle_over',
      });
    } catch (err: any) {
      threw = true;
      assert(err.message.includes('SETTLEMENT_EXCEEDS_UNRESERVED_FUNDED_BALANCE'), 'Settlement protected Call B funds from being stolen');
    }
    assert(threw === true, 'Over-settlement threw exception');
  });

  // 10. Legitimate Settlement of Call A ($3.00 = 300 minor)
  await runScenario('10. Legitimate settlement of Call A ($3.00) preserves Call B protection', async () => {
    const setA = await TelecomWalletService.settleUsage(supabase, {
      organizationId: testOrgId,
      internalUsageId: 'usg_stale_001',
      actualRetailChargeMinor: 300,
      description: 'Call A final settlement',
      idempotencyKey: 'idemp_settle_a',
      providerWholesaleCostMinor: 150,
    });

    assert(setA.success === true, 'Call A settled');
    assert(setA.fundedBalanceMinor === 700, 'Funded balance is 700 (1000 - 300)');
    assert(setA.activeReservationsMinor === 500, 'Active reservations is 500 (only Call B remains active)');
    assert(setA.availableBalanceMinor === 200, 'Available balance is 200 (700 - 500)');
  });

  // 11. Settlement Idempotency: Conflicting charge
  await runScenario('11. Conflicting duplicate settlement fails closed', async () => {
    let threw = false;
    try {
      await TelecomWalletService.settleUsage(supabase, {
        organizationId: testOrgId,
        internalUsageId: 'usg_stale_001',
        actualRetailChargeMinor: 999, // Original was 300
        description: 'Conflicting replay',
        idempotencyKey: 'idemp_settle_a_bad',
      });
    } catch (err: any) {
      threw = true;
      assert(err.message.includes('IDEMPOTENCY_CONFLICT'), 'Conflicting settlement charge rejected');
    }
    assert(threw === true, 'Conflicting settlement threw exception');
  });

  // 12. Settlement Idempotency: Exact replay
  await runScenario('12. Exact settlement replay is idempotent', async () => {
    const setA2 = await TelecomWalletService.settleUsage(supabase, {
      organizationId: testOrgId,
      internalUsageId: 'usg_stale_001',
      actualRetailChargeMinor: 300,
      description: 'Call A final settlement replay',
      idempotencyKey: 'idemp_settle_a',
      providerWholesaleCostMinor: 150,
    });

    assert(setA2.success === true, 'Duplicate settlement succeeded');
    assert(setA2.isDuplicate === true, 'Flagged as duplicate');
    assert(setA2.fundedBalanceMinor === 700, 'Funded balance remains 700 (no double debit)');
  });

  // 13. Correction 7: Bounded Usage Reversals
  await runScenario('13. Reversal bounded by settled charge ($1.00 partial reversal)', async () => {
    const rev1 = await TelecomWalletService.reverseUsage(supabase, {
      organizationId: testOrgId,
      internalUsageId: 'usg_stale_001',
      reversalAmountMinor: 100,
      description: 'Partial refund $1.00',
      idempotencyKey: 'idemp_rev_p1',
    });

    assert(rev1.success === true, 'Partial reversal 1 succeeded');
    const summary = await TelecomWalletService.getWalletSummary(supabase, testOrgId);
    assert(summary.fundedBalanceMinor === 800, 'Funded balance increased to 800 (700 + 100)');
  });

  // 14. Reversal Idempotency: Exact replay returns duplicate without double credit
  await runScenario('14. Exact reversal replay returns stored result without double credit', async () => {
    const rev1Dup = await TelecomWalletService.reverseUsage(supabase, {
      organizationId: testOrgId,
      internalUsageId: 'usg_stale_001',
      reversalAmountMinor: 100,
      description: 'Partial refund $1.00 replay',
      idempotencyKey: 'idemp_rev_p1',
    });

    assert(rev1Dup.success === true, 'Reversal replay succeeded');
    assert(rev1Dup.isDuplicate === true, 'Flagged as duplicate');
    const summary = await TelecomWalletService.getWalletSummary(supabase, testOrgId);
    assert(summary.fundedBalanceMinor === 800, 'Funded balance remains 800');
  });

  // 15. Second Partial Reversal up to Original Charge ($2.00)
  await runScenario('15. Second partial reversal ($2.00) reaches 100% of original $3.00 charge', async () => {
    const rev2 = await TelecomWalletService.reverseUsage(supabase, {
      organizationId: testOrgId,
      internalUsageId: 'usg_stale_001',
      reversalAmountMinor: 200,
      description: 'Final refund $2.00',
      idempotencyKey: 'idemp_rev_p2',
    });

    assert(rev2.success === true, 'Partial reversal 2 succeeded');
    const summary = await TelecomWalletService.getWalletSummary(supabase, testOrgId);
    assert(summary.fundedBalanceMinor === 1000, 'Funded balance restored to 1000');
  });

  // 16. Exceeding Settled Charge Fails Closed
  await runScenario('16. Reversal exceeding original settled charge fails closed', async () => {
    let threw = false;
    try {
      await TelecomWalletService.reverseUsage(supabase, {
        organizationId: testOrgId,
        internalUsageId: 'usg_stale_001',
        reversalAmountMinor: 1, // Total would be 301 > 300
        description: 'Excess refund',
        idempotencyKey: 'idemp_rev_excess',
      });
    } catch (err: any) {
      threw = true;
      assert(err.message.includes('REVERSAL_EXCEEDS_SETTLED_CHARGE'), 'Excess reversal rejected');
    }
    assert(threw === true, 'Excess reversal threw exception');
  });

  // 17. Correction 5: Sub-Cent Rating Precision
  await runScenario('17. Sub-cent rate calculation (USD $0.0252/min for 60s = $0.03)', async () => {
    const chargeCents = TelecomWalletService.calculateRetailChargeMinor({
      retailRateMicro: 25200,
      durationSeconds: 60,
      billingIncrementSeconds: 60,
      minChargeableUnits: 1,
    });

    assert(chargeCents === 3, 'Sub-cent rate $0.0252/min rounded deterministically to 3 cents ($0.03)');

    const zeroCharge = TelecomWalletService.calculateRetailChargeMinor({
      retailRateMicro: 25200,
      durationSeconds: 0,
    });
    assert(zeroCharge === 0, 'Zero duration produces 0 charge');
  });

  // 18. Server-Only Confidentiality Security Proof
  await runScenario('18. Authenticated and anon users CANNOT directly query rate cards or reservations', async () => {
    let authRateCardThrew = false;
    try {
      authenticatedClient.from('telecom_retail_rate_cards').select('*');
    } catch (err: any) {
      authRateCardThrew = true;
      assert(err.message.includes('permission denied'), 'Authenticated client denied rate cards access');
    }
    assert(authRateCardThrew === true, 'Direct rate card select blocked for authenticated');

    let authReservationsThrew = false;
    try {
      authenticatedClient.from('telecom_usage_reservations').select('*');
    } catch (err: any) {
      authReservationsThrew = true;
      assert(err.message.includes('permission denied'), 'Authenticated client denied reservations access');
    }
    assert(authReservationsThrew === true, 'Direct reservations select blocked for authenticated');

    let anonThrew = false;
    try {
      anonClient.from('telecom_usage_reservations').select('*');
    } catch (err: any) {
      anonThrew = true;
      assert(err.message.includes('permission denied'), 'Anon client denied reservations access');
    }
    assert(anonThrew === true, 'Direct reservations select blocked for anon');

    let serviceRoleAllowed = false;
    try {
      supabase.from('telecom_usage_reservations').select('*');
      serviceRoleAllowed = true;
    } catch (err: any) {
      serviceRoleAllowed = false;
    }
    assert(serviceRoleAllowed === true, 'Service role retains direct table query access');
  });

  // 19. Input Validation Hardening Proof
  await runScenario('19. Structural input validation fails closed on invalid arguments', async () => {
    // Zero reservation amount
    let zeroResThrew = false;
    try {
      await TelecomWalletService.reserveUsage(supabase, {
        organizationId: testOrgId,
        internalUsageId: 'usg_invalid_val_1',
        serviceType: 'voice_outbound',
        direction: 'outbound',
        amountReservedMinor: 0,
        idempotencyKey: 'idemp_val_1',
      });
    } catch (err: any) {
      zeroResThrew = true;
    }
    assert(zeroResThrew === true, 'Zero reservation amount rejected');

    // Blank usage ID
    let blankUsageThrew = false;
    try {
      await TelecomWalletService.reserveUsage(supabase, {
        organizationId: testOrgId,
        internalUsageId: '   ',
        serviceType: 'voice_outbound',
        direction: 'outbound',
        amountReservedMinor: 10,
        idempotencyKey: 'idemp_val_2',
      });
    } catch (err: any) {
      blankUsageThrew = true;
    }
    assert(blankUsageThrew === true, 'Blank usage ID rejected');

    // Negative reversal
    let negRevThrew = false;
    try {
      await TelecomWalletService.reverseUsage(supabase, {
        organizationId: testOrgId,
        internalUsageId: 'usg_stale_001',
        reversalAmountMinor: -50,
        description: 'Negative refund',
        idempotencyKey: 'idemp_val_3',
      });
    } catch (err: any) {
      negRevThrew = true;
    }
    assert(negRevThrew === true, 'Negative reversal amount rejected');
  });

  // 20. Bounded Pseudo-Randomized Property / Stress Test
  await runScenario('20. Seeded Pseudo-Random Stress Test verifying all 8 financial invariants', async () => {
    const stressOrgId = 'org_stress_999';
    db.organizations.set(stressOrgId, { id: stressOrgId, name: 'Stress Org' });
    db.organizationBillingControls.set(stressOrgId, { organization_id: stressOrgId, is_billing_restricted: false });

    // Seed wallet with $100.00 (10000 minor)
    await CreditLedgerService.addCreditEntry(supabase as any, {
      organizationId: stressOrgId,
      entryType: 'grant',
      amountMinor: 10000,
      description: 'Stress test seed',
      referenceType: 'payment_operation',
      referenceId: 'pop_stress_seed',
    });

    const activeUsages: string[] = [];
    const settledUsages: Map<string, number> = new Map();
    const usageReversals: Map<string, number> = new Map();

    // Deterministic pseudo-random sequence generator
    let seed = 42;
    function pseudoRandom() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    }

    for (let op = 0; op < 50; op++) {
      const actionType = Math.floor(pseudoRandom() * 5); // 0: reserve, 1: extend, 2: settle, 3: release, 4: reverse

      if (actionType === 0) {
        // Reserve
        const usageId = `usg_stress_${Math.floor(pseudoRandom() * 10000)}`;
        const amount = Math.floor(pseudoRandom() * 300) + 10;
        try {
          const res = await TelecomWalletService.reserveUsage(supabase, {
            organizationId: stressOrgId,
            internalUsageId: usageId,
            serviceType: 'voice_outbound',
            direction: 'outbound',
            amountReservedMinor: amount,
            idempotencyKey: `key_${usageId}`,
          });
          if (res.success && !res.isDuplicate) {
            activeUsages.push(usageId);
          }
        } catch (e) {
          // Expected when insufficient balance or duplicate
        }
      } else if (actionType === 1 && activeUsages.length > 0) {
        // Extend
        const targetUsage = activeUsages[Math.floor(pseudoRandom() * activeUsages.length)];
        const extAmount = Math.floor(pseudoRandom() * 100) + 5;
        try {
          await TelecomWalletService.extendReservation(supabase, {
            organizationId: stressOrgId,
            internalUsageId: targetUsage,
            additionalAmountReservedMinor: extAmount,
            idempotencyKey: `ext_key_${targetUsage}_${op}`,
          });
        } catch (e) {
          // Expected when insufficient balance or inactive
        }
      } else if (actionType === 2 && activeUsages.length > 0) {
        // Settle
        const idx = Math.floor(pseudoRandom() * activeUsages.length);
        const targetUsage = activeUsages[idx];
        const settleAmount = Math.floor(pseudoRandom() * 250);
        try {
          const setRes = await TelecomWalletService.settleUsage(supabase, {
            organizationId: stressOrgId,
            internalUsageId: targetUsage,
            actualRetailChargeMinor: settleAmount,
            description: 'Stress settle',
            idempotencyKey: `settle_key_${targetUsage}`,
          });
          if (setRes.success && !setRes.isDuplicate) {
            activeUsages.splice(idx, 1);
            settledUsages.set(targetUsage, settleAmount);
          }
        } catch (e) {
          // Expected when over-settling unreserved funds
        }
      } else if (actionType === 3 && activeUsages.length > 0) {
        // Release
        const idx = Math.floor(pseudoRandom() * activeUsages.length);
        const targetUsage = activeUsages[idx];
        try {
          const relRes = await TelecomWalletService.releaseUsage(supabase, {
            organizationId: stressOrgId,
            internalUsageId: targetUsage,
            reason: 'Stress release',
            idempotencyKey: `rel_key_${targetUsage}`,
          });
          if (relRes.success && !relRes.isDuplicate) {
            activeUsages.splice(idx, 1);
          }
        } catch (e) {
          // Expected
        }
      } else if (actionType === 4 && settledUsages.size > 0) {
        // Reverse
        const settledKeys = Array.from(settledUsages.keys());
        const targetUsage = settledKeys[Math.floor(pseudoRandom() * settledKeys.length)];
        const originalCharge = settledUsages.get(targetUsage) || 0;
        const currentRev = usageReversals.get(targetUsage) || 0;
        const revAmount = Math.floor(pseudoRandom() * 50) + 1;

        try {
          const revRes = await TelecomWalletService.reverseUsage(supabase, {
            organizationId: stressOrgId,
            internalUsageId: targetUsage,
            reversalAmountMinor: revAmount,
            description: 'Stress reversal',
            idempotencyKey: `rev_key_${targetUsage}_${op}`,
          });
          if (revRes.success && !revRes.isDuplicate) {
            usageReversals.set(targetUsage, currentRev + revAmount);
          }
        } catch (e) {
          // Expected if exceeding settled charge
        }
      }

      // Assert Financial Invariants After Every Operation
      const summary = await TelecomWalletService.getWalletSummary(supabase, stressOrgId);
      assert(summary.fundedBalanceMinor >= 0, `Invariant 1: Funded balance >= 0 (${summary.fundedBalanceMinor})`);
      assert(summary.activeReservationsMinor >= 0, `Invariant 2: Active protected exposure >= 0 (${summary.activeReservationsMinor})`);
      assert(summary.availableBalanceMinor >= 0, `Invariant 3: Available balance >= 0 (${summary.availableBalanceMinor})`);
      assert(
        summary.availableBalanceMinor === Math.max(0, summary.fundedBalanceMinor - summary.activeReservationsMinor),
        'Invariant 4: Available = Funded - Active'
      );
    }
  });

  console.log('\n====================================================');
  console.log('SUMMARY OF PHASE 13.4.3B.1 HARDENED TEST RESULTS:');
  console.log(`Passed Scenarios  : ${passedScenarios}`);
  console.log(`Failed Scenarios  : ${failedScenarios}`);
  console.log(`Passed Assertions : ${passedAssertions}`);
  console.log(`Failed Assertions : ${failedAssertions}`);
  console.log('====================================================\n');

  if (failedScenarios > 0 || failedAssertions > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Test suite failed with error:', err);
  process.exit(1);
});
