-- ============================================================================
-- PUBLIC SAAS PHASE 13.4.3C SUBPHASE C.4E.DB — FINANCIAL LIFECYCLE DATABASE FOUNDATION
-- Date: 2026-12-20
-- Builds local database foundation for provider account portability, refund authorizations,
-- refund execution, dispute tracking, aggregate financial risk holds, and account debt recovery.
-- LOCAL MIGRATION ONLY — SUBJECT TO MANUAL DBA REVIEW. DO NOT EXECUTE REMOTELY AUTOMATICALLY.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Create public.billing_provider_accounts table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_provider_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(provider)) > 0),
    provider_account_reference TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(provider_account_reference)) > 0),
    environment TEXT NOT NULL DEFAULT 'test' CHECK (environment IN ('test', 'live')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    retired_at TIMESTAMPTZ NULL,
    CONSTRAINT uq_billing_provider_accounts_ref UNIQUE (provider, provider_account_reference, environment)
);

CREATE INDEX IF NOT EXISTS idx_billing_provider_accounts_lookup 
ON public.billing_provider_accounts (provider, environment, status);

-- Seed initial internal provider account for current Stripe test context
-- ID: 00000000-0000-0000-0000-000000000001
INSERT INTO public.billing_provider_accounts (
    id, provider, provider_account_reference, environment, status
) VALUES (
    '00000000-0000-0000-0000-000000000001'::uuid,
    'stripe',
    'stripe_primary_test',
    'test',
    'active'
) ON CONFLICT (provider, provider_account_reference, environment) DO NOTHING;


-- ----------------------------------------------------------------------------
-- 2. Extend existing payment tables with provider_account_id & money breakdown
-- ----------------------------------------------------------------------------

-- Add provider_account_id & money breakdown to billing_payment_operations
ALTER TABLE public.billing_payment_operations 
ADD COLUMN IF NOT EXISTS provider_account_id UUID REFERENCES public.billing_provider_accounts(id) ON DELETE RESTRICT,
ADD COLUMN IF NOT EXISTS gross_charge_minor BIGINT NULL CHECK (gross_charge_minor IS NULL OR gross_charge_minor >= 0),
ADD COLUMN IF NOT EXISTS credit_value_minor BIGINT NULL CHECK (credit_value_minor IS NULL OR credit_value_minor >= 0);

UPDATE public.billing_payment_operations 
SET provider_account_id = '00000000-0000-0000-0000-000000000001'::uuid 
WHERE provider_account_id IS NULL;

UPDATE public.billing_payment_operations 
SET gross_charge_minor = amount_minor,
    credit_value_minor = amount_minor 
WHERE operation_type = 'credit_topup' AND gross_charge_minor IS NULL;

ALTER TABLE public.billing_payment_operations 
ALTER COLUMN provider_account_id SET NOT NULL;

-- Add provider_account_id to billing_webhook_events
ALTER TABLE public.billing_webhook_events 
ADD COLUMN IF NOT EXISTS provider_account_id UUID REFERENCES public.billing_provider_accounts(id) ON DELETE RESTRICT;

UPDATE public.billing_webhook_events 
SET provider_account_id = '00000000-0000-0000-0000-000000000001'::uuid 
WHERE provider_account_id IS NULL;

ALTER TABLE public.billing_webhook_events 
ALTER COLUMN provider_account_id SET NOT NULL;

-- Add provider_account_id to billing_provider_customers
ALTER TABLE public.billing_provider_customers 
ADD COLUMN IF NOT EXISTS provider_account_id UUID REFERENCES public.billing_provider_accounts(id) ON DELETE RESTRICT;

UPDATE public.billing_provider_customers 
SET provider_account_id = '00000000-0000-0000-0000-000000000001'::uuid 
WHERE provider_account_id IS NULL;

ALTER TABLE public.billing_provider_customers 
ALTER COLUMN provider_account_id SET NOT NULL;


-- ----------------------------------------------------------------------------
-- 3. Provider-scoped partial unique indexes & constraints
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payment_ops_unique_provider_account_payment_id 
ON public.billing_payment_operations (provider_account_id, provider_payment_id) 
WHERE provider_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_webhook_events_unique_provider_account_event_id 
ON public.billing_webhook_events (provider_account_id, provider_event_id) 
WHERE provider_event_id IS NOT NULL;

DO $$ 
BEGIN 
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_billing_provider_customers_org_account'
    ) THEN 
        ALTER TABLE public.billing_provider_customers 
        ADD CONSTRAINT uq_billing_provider_customers_org_account UNIQUE (organization_id, provider_account_id); 
    END IF; 
END $$;


-- ----------------------------------------------------------------------------
-- 4. Create public.billing_refund_requests table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_refund_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    payment_operation_id UUID NOT NULL REFERENCES public.billing_payment_operations(id) ON DELETE RESTRICT,
    requested_amount_minor BIGINT NOT NULL CHECK (requested_amount_minor > 0),
    approved_amount_minor BIGINT NOT NULL CHECK (approved_amount_minor >= 0),
    approved_credit_value_reversal_minor BIGINT NOT NULL CHECK (approved_credit_value_reversal_minor >= 0),
    currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    approving_actor_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    decision_reason TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(decision_reason)) > 0),
    policy_version TEXT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS idx_billing_refund_requests_org ON public.billing_refund_requests(organization_id);
CREATE INDEX IF NOT EXISTS idx_billing_refund_requests_op ON public.billing_refund_requests(payment_operation_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_billing_refund_requests_updated_at'
    ) THEN
        CREATE TRIGGER trg_billing_refund_requests_updated_at
            BEFORE UPDATE ON public.billing_refund_requests
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 5. Create public.billing_payment_refunds table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_payment_refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    payment_operation_id UUID NOT NULL REFERENCES public.billing_payment_operations(id) ON DELETE RESTRICT,
    refund_request_id UUID NULL REFERENCES public.billing_refund_requests(id) ON DELETE SET NULL,
    provider_account_id UUID NOT NULL REFERENCES public.billing_provider_accounts(id) ON DELETE RESTRICT,
    provider_refund_id TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(provider_refund_id)) > 0),
    currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    provider_refund_minor BIGINT NOT NULL CHECK (provider_refund_minor > 0),
    credit_value_reversal_minor BIGINT NOT NULL CHECK (credit_value_reversal_minor >= 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'reconciliation_required')),
    failure_code TEXT NULL,
    failure_message TEXT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT uq_billing_payment_refunds_provider_id UNIQUE (provider_account_id, provider_refund_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_payment_refunds_org ON public.billing_payment_refunds(organization_id);
CREATE INDEX IF NOT EXISTS idx_billing_payment_refunds_op ON public.billing_payment_refunds(payment_operation_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_billing_payment_refunds_updated_at'
    ) THEN
        CREATE TRIGGER trg_billing_payment_refunds_updated_at
            BEFORE UPDATE ON public.billing_payment_refunds
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 6. Create public.billing_payment_disputes table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_payment_disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    payment_operation_id UUID NOT NULL REFERENCES public.billing_payment_operations(id) ON DELETE RESTRICT,
    provider_account_id UUID NOT NULL REFERENCES public.billing_provider_accounts(id) ON DELETE RESTRICT,
    provider_dispute_id TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(provider_dispute_id)) > 0),
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    status TEXT NOT NULL DEFAULT 'needs_response' CHECK (status IN ('warning_needs_response', 'warning_under_review', 'needs_response', 'under_review', 'won', 'lost', 'charge_refunded')),
    reason TEXT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT uq_billing_payment_disputes_provider_id UNIQUE (provider_account_id, provider_dispute_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_payment_disputes_org ON public.billing_payment_disputes(organization_id);
CREATE INDEX IF NOT EXISTS idx_billing_payment_disputes_op ON public.billing_payment_disputes(payment_operation_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_billing_payment_disputes_updated_at'
    ) THEN
        CREATE TRIGGER trg_billing_payment_disputes_updated_at
            BEFORE UPDATE ON public.billing_payment_disputes
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 7. Create public.billing_financial_holds table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_financial_holds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    reference_type TEXT NOT NULL CHECK (reference_type IN ('dispute', 'refund_pending', 'compliance_review', 'manual_risk_hold')),
    reference_id TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(reference_id)) > 0),
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'settled')),
    reason TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(reason)) > 0),
    released_at TIMESTAMPTZ NULL,
    settled_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_financial_holds_active_ref 
ON public.billing_financial_holds(organization_id, reference_type, reference_id) 
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_billing_financial_holds_org_status 
ON public.billing_financial_holds(organization_id, status);


-- ----------------------------------------------------------------------------
-- 8. Create public.billing_account_debts table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_account_debts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    reference_type TEXT NOT NULL CHECK (reference_type IN ('refund_uncovered', 'dispute_lost_uncovered', 'manual_adjustment')),
    reference_id TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(reference_id)) > 0),
    original_amount_minor BIGINT NOT NULL CHECK (original_amount_minor > 0),
    outstanding_amount_minor BIGINT NOT NULL CHECK (outstanding_amount_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'satisfied', 'written_off')),
    reason TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(reason)) > 0),
    satisfied_at TIMESTAMPTZ NULL,
    written_off_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT uq_billing_account_debts_ref UNIQUE (organization_id, reference_type, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_account_debts_org_status 
ON public.billing_account_debts(organization_id, status);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_billing_account_debts_updated_at'
    ) THEN
        CREATE TRIGGER trg_billing_account_debts_updated_at
            BEFORE UPDATE ON public.billing_account_debts
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;


-- ----------------------------------------------------------------------------
-- 9. Update public.get_telecom_wallet_summary_atomic RPC
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_telecom_wallet_summary_atomic(
  p_organization_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_funded_balance BIGINT := 0;
  v_active_reservations BIGINT := 0;
  v_active_holds BIGINT := 0;
  v_available_balance BIGINT := 0;
  v_currency TEXT := 'USD';
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;

  -- Lock organization row for consistent balance reading
  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  -- 1. Fetch latest funded balance from billing_credit_ledger
  SELECT balance_after_minor, currency INTO v_funded_balance, v_currency
  FROM public.billing_credit_ledger
  WHERE organization_id = p_organization_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  v_funded_balance := COALESCE(v_funded_balance, 0);
  v_currency := COALESCE(v_currency, 'USD');

  -- 2. Fetch sum of ALL active usage reservations
  SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_active_reservations
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id
    AND status = 'active';

  -- 3. Fetch sum of ALL active financial risk holds
  SELECT COALESCE(SUM(amount_minor), 0) INTO v_active_holds
  FROM public.billing_financial_holds
  WHERE organization_id = p_organization_id
    AND status = 'active';

  -- 4. Calculate Available Spendable Balance (clamped non-negative)
  v_available_balance := GREATEST(0, v_funded_balance - v_active_reservations - v_active_holds);

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'funded_balance_minor', v_funded_balance,
    'active_reservations_minor', v_active_reservations,
    'active_holds_minor', v_active_holds,
    'available_balance_minor', v_available_balance,
    'currency', v_currency
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_telecom_wallet_summary_atomic(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_telecom_wallet_summary_atomic(UUID) TO service_role;


-- ----------------------------------------------------------------------------
-- 10. Atomic SECURITY DEFINER RPC: Process Refund Reversal
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_refund_reversal_atomic(
  p_payment_operation_id UUID,
  p_provider_account_id UUID,
  p_provider_refund_id TEXT,
  p_provider_refund_minor BIGINT,
  p_credit_value_reversal_minor BIGINT,
  p_currency TEXT,
  p_provider_event_id TEXT DEFAULT NULL,
  p_refund_request_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_op public.billing_payment_operations;
  v_refund public.billing_payment_refunds;
  v_clean_provider_refund_id TEXT;
  v_clean_currency TEXT;
  v_current_balance BIGINT := 0;
  v_active_reservations BIGINT := 0;
  v_active_holds BIGINT := 0;
  v_available_spendable BIGINT := 0;
  v_reversal_from_wallet BIGINT := 0;
  v_uncovered_debt BIGINT := 0;
  v_new_balance BIGINT := 0;
  v_ledger_id UUID := NULL;
  v_refund_row_id UUID := NULL;
  v_debt_id UUID := NULL;
  v_new_status TEXT := 'refunded';
BEGIN
  v_clean_provider_refund_id := pg_catalog.btrim(COALESCE(p_provider_refund_id, ''));
  v_clean_currency := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_currency, 'USD')));

  IF p_payment_operation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_payment_operation_id is required.';
  END IF;
  IF p_provider_account_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_provider_account_id is required.';
  END IF;
  IF length(v_clean_provider_refund_id) = 0 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_provider_refund_id is required.';
  END IF;
  IF p_provider_refund_minor <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: p_provider_refund_minor must be positive.';
  END IF;
  IF p_credit_value_reversal_minor < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: p_credit_value_reversal_minor cannot be negative.';
  END IF;

  -- 1. Check idempotency on billing_payment_refunds
  SELECT * INTO v_refund
  FROM public.billing_payment_refunds
  WHERE provider_account_id = p_provider_account_id
    AND provider_refund_id = v_clean_provider_refund_id;

  IF v_refund.id IS NOT NULL AND v_refund.status = 'succeeded' THEN
    SELECT balance_after_minor INTO v_current_balance
    FROM public.billing_credit_ledger
    WHERE organization_id = v_refund.organization_id
    ORDER BY created_at DESC, id DESC
    LIMIT 1;

    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'refund_id', v_refund.id,
      'payment_operation_id', v_refund.payment_operation_id,
      'provider_refund_minor', v_refund.provider_refund_minor,
      'credit_value_reversal_minor', v_refund.credit_value_reversal_minor,
      'balance_after_minor', COALESCE(v_current_balance, 0),
      'status', 'succeeded'
    );
  END IF;

  -- 2. Lock payment operation row
  SELECT * INTO v_op
  FROM public.billing_payment_operations
  WHERE id = p_payment_operation_id
  FOR UPDATE;

  IF v_op.id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_OPERATION_NOT_FOUND: Payment operation % does not exist.', p_payment_operation_id;
  END IF;

  IF v_op.currency <> v_clean_currency THEN
    RAISE EXCEPTION 'CURRENCY_MISMATCH: Refund currency % does not match operation currency %.',
      v_clean_currency, v_op.currency;
  END IF;

  -- 3. Lock organization for wallet calculations
  PERFORM id FROM public.organizations WHERE id = v_op.organization_id FOR UPDATE;

  -- 4. Calculate available spendable wallet balance
  SELECT balance_after_minor INTO v_current_balance
  FROM public.billing_credit_ledger
  WHERE organization_id = v_op.organization_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  v_current_balance := COALESCE(v_current_balance, 0);

  SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_active_reservations
  FROM public.telecom_usage_reservations
  WHERE organization_id = v_op.organization_id AND status = 'active';

  SELECT COALESCE(SUM(amount_minor), 0) INTO v_active_holds
  FROM public.billing_financial_holds
  WHERE organization_id = v_op.organization_id AND status = 'active';

  v_available_spendable := GREATEST(0, v_current_balance - v_active_reservations - v_active_holds);

  -- 5. Calculate Reversal vs Debt split
  v_reversal_from_wallet := LEAST(v_available_spendable, p_credit_value_reversal_minor);
  v_uncovered_debt := p_credit_value_reversal_minor - v_reversal_from_wallet;

  -- 6. Insert credit ledger reversal if spendable credits available
  IF v_reversal_from_wallet > 0 THEN
    v_new_balance := v_current_balance - v_reversal_from_wallet;

    INSERT INTO public.billing_credit_ledger (
      organization_id, entry_type, amount_minor, balance_after_minor,
      currency, description, reference_type, reference_id
    ) VALUES (
      v_op.organization_id, 'reversal', -v_reversal_from_wallet, v_new_balance,
      v_op.currency, 'Refund credit reversal', 'payment_operation', v_op.id::text
    ) RETURNING id INTO v_ledger_id;
  ELSE
    v_new_balance := v_current_balance;
  END IF;

  -- 7. Insert account debt if uncovered exposure exists
  IF v_uncovered_debt > 0 THEN
    INSERT INTO public.billing_account_debts (
      organization_id, reference_type, reference_id,
      original_amount_minor, outstanding_amount_minor, currency, status, reason
    ) VALUES (
      v_op.organization_id, 'refund_uncovered', v_clean_provider_refund_id,
      v_uncovered_debt, v_uncovered_debt, v_op.currency, 'active', 'Refund credit reversal exceeded available spendable wallet balance'
    )
    ON CONFLICT (organization_id, reference_type, reference_id) DO UPDATE
    SET outstanding_amount_minor = EXCLUDED.outstanding_amount_minor,
        updated_at = NOW()
    RETURNING id INTO v_debt_id;
  END IF;

  -- 8. Upsert billing_payment_refunds
  INSERT INTO public.billing_payment_refunds (
    organization_id, payment_operation_id, refund_request_id, provider_account_id,
    provider_refund_id, currency, provider_refund_minor, credit_value_reversal_minor, status
  ) VALUES (
    v_op.organization_id, v_op.id, p_refund_request_id, p_provider_account_id,
    v_clean_provider_refund_id, v_clean_currency, p_provider_refund_minor, p_credit_value_reversal_minor, 'succeeded'
  )
  ON CONFLICT (provider_account_id, provider_refund_id) DO UPDATE
  SET status = 'succeeded',
      updated_at = NOW()
  RETURNING id INTO v_refund_row_id;

  -- 9. Update Payment Operation status
  IF p_provider_refund_minor < COALESCE(v_op.gross_charge_minor, v_op.amount_minor) THEN
    v_new_status := 'partially_refunded';
  ELSE
    v_new_status := 'refunded';
  END IF;

  UPDATE public.billing_payment_operations
  SET status = v_new_status,
      updated_at = NOW()
  WHERE id = v_op.id;

  -- 10. Update refund request if attached
  IF p_refund_request_id IS NOT NULL THEN
    UPDATE public.billing_refund_requests
    SET status = 'executed',
        updated_at = NOW()
    WHERE id = p_refund_request_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'refund_id', v_refund_row_id,
    'payment_operation_id', v_op.id,
    'ledger_entry_id', v_ledger_id,
    'debt_id', v_debt_id,
    'provider_refund_minor', p_provider_refund_minor,
    'credit_value_reversal_minor', p_credit_value_reversal_minor,
    'reversed_from_wallet_minor', v_reversal_from_wallet,
    'uncovered_debt_minor', v_uncovered_debt,
    'balance_after_minor', v_new_balance,
    'status', 'succeeded'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.process_refund_reversal_atomic(UUID, UUID, TEXT, BIGINT, BIGINT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_refund_reversal_atomic(UUID, UUID, TEXT, BIGINT, BIGINT, TEXT, TEXT, UUID) TO service_role;


-- ----------------------------------------------------------------------------
-- 11. Atomic SECURITY DEFINER RPC: Process Dispute Risk Hold & Settlement
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_dispute_hold_atomic(
  p_payment_operation_id UUID,
  p_provider_account_id UUID,
  p_provider_dispute_id TEXT,
  p_dispute_amount_minor BIGINT,
  p_currency TEXT,
  p_action TEXT, -- 'PLACE_HOLD', 'RELEASE_HOLD', 'SETTLE_LOST'
  p_dispute_status TEXT DEFAULT 'needs_response',
  p_reason TEXT DEFAULT 'Chargeback/Dispute opened',
  p_provider_event_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_op public.billing_payment_operations;
  v_dispute public.billing_payment_disputes;
  v_clean_dispute_id TEXT;
  v_clean_currency TEXT;
  v_current_balance BIGINT := 0;
  v_active_reservations BIGINT := 0;
  v_active_holds BIGINT := 0;
  v_available_spendable BIGINT := 0;
  v_reversal_from_wallet BIGINT := 0;
  v_uncovered_debt BIGINT := 0;
  v_new_balance BIGINT := 0;
  v_dispute_row_id UUID := NULL;
  v_hold_id UUID := NULL;
  v_debt_id UUID := NULL;
  v_ledger_id UUID := NULL;
BEGIN
  v_clean_dispute_id := pg_catalog.btrim(COALESCE(p_provider_dispute_id, ''));
  v_clean_currency := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_currency, 'USD')));

  IF p_payment_operation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_payment_operation_id is required.';
  END IF;
  IF p_provider_account_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_provider_account_id is required.';
  END IF;
  IF length(v_clean_dispute_id) = 0 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_provider_dispute_id is required.';
  END IF;
  IF p_dispute_amount_minor <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: p_dispute_amount_minor must be positive.';
  END IF;
  IF p_action NOT IN ('PLACE_HOLD', 'RELEASE_HOLD', 'SETTLE_LOST') THEN
    RAISE EXCEPTION 'INVALID_ACTION: p_action must be PLACE_HOLD, RELEASE_HOLD, or SETTLE_LOST.';
  END IF;

  -- Lock payment operation row
  SELECT * INTO v_op
  FROM public.billing_payment_operations
  WHERE id = p_payment_operation_id
  FOR UPDATE;

  IF v_op.id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_OPERATION_NOT_FOUND: Payment operation % does not exist.', p_payment_operation_id;
  END IF;

  -- Lock organization for financial calculations
  PERFORM id FROM public.organizations WHERE id = v_op.organization_id FOR UPDATE;

  -- 1. Upsert dispute tracking record
  INSERT INTO public.billing_payment_disputes (
    organization_id, payment_operation_id, provider_account_id, provider_dispute_id,
    amount_minor, currency, status, reason
  ) VALUES (
    v_op.organization_id, v_op.id, p_provider_account_id, v_clean_dispute_id,
    p_dispute_amount_minor, v_clean_currency, p_dispute_status, p_reason
  )
  ON CONFLICT (provider_account_id, provider_dispute_id) DO UPDATE
  SET status = EXCLUDED.status,
      reason = EXCLUDED.reason,
      updated_at = NOW()
  RETURNING id INTO v_dispute_row_id;

  -- 2. Execute Action
  IF p_action = 'PLACE_HOLD' THEN
    -- Place active financial hold if not already present
    INSERT INTO public.billing_financial_holds (
      organization_id, reference_type, reference_id, amount_minor, currency, status, reason
    ) VALUES (
      v_op.organization_id, 'dispute', v_clean_dispute_id, p_dispute_amount_minor, v_clean_currency, 'active', p_reason
    )
    ON CONFLICT (organization_id, reference_type, reference_id) WHERE status = 'active' DO NOTHING
    RETURNING id INTO v_hold_id;

    RETURN jsonb_build_object(
      'success', true,
      'action', 'PLACE_HOLD',
      'dispute_id', v_dispute_row_id,
      'hold_id', v_hold_id,
      'status', p_dispute_status
    );

  ELSIF p_action = 'RELEASE_HOLD' THEN
    -- Release active financial hold when dispute is won
    UPDATE public.billing_financial_holds
    SET status = 'released',
        released_at = NOW()
    WHERE organization_id = v_op.organization_id
      AND reference_type = 'dispute'
      AND reference_id = v_clean_dispute_id
      AND status = 'active';

    RETURN jsonb_build_object(
      'success', true,
      'action', 'RELEASE_HOLD',
      'dispute_id', v_dispute_row_id,
      'status', 'won'
    );

  ELSIF p_action = 'SETTLE_LOST' THEN
    -- Calculate available spendable balance
    SELECT balance_after_minor INTO v_current_balance
    FROM public.billing_credit_ledger
    WHERE organization_id = v_op.organization_id
    ORDER BY created_at DESC, id DESC
    LIMIT 1;

    v_current_balance := COALESCE(v_current_balance, 0);

    SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_active_reservations
    FROM public.telecom_usage_reservations
    WHERE organization_id = v_op.organization_id AND status = 'active';

    -- Exclude this dispute's hold when calculating active holds for available balance
    SELECT COALESCE(SUM(amount_minor), 0) INTO v_active_holds
    FROM public.billing_financial_holds
    WHERE organization_id = v_op.organization_id
      AND status = 'active'
      AND reference_id <> v_clean_dispute_id;

    v_available_spendable := GREATEST(0, v_current_balance - v_active_reservations - v_active_holds);
    v_reversal_from_wallet := LEAST(v_available_spendable, p_dispute_amount_minor);
    v_uncovered_debt := p_dispute_amount_minor - v_reversal_from_wallet;

    -- Reverse available wallet balance
    IF v_reversal_from_wallet > 0 THEN
      v_new_balance := v_current_balance - v_reversal_from_wallet;

      INSERT INTO public.billing_credit_ledger (
        organization_id, entry_type, amount_minor, balance_after_minor,
        currency, description, reference_type, reference_id
      ) VALUES (
        v_op.organization_id, 'reversal', -v_reversal_from_wallet, v_new_balance,
        v_op.currency, 'Lost dispute credit reversal', 'payment_operation', v_op.id::text
      ) RETURNING id INTO v_ledger_id;
    ELSE
      v_new_balance := v_current_balance;
    END IF;

    -- Create debt for remaining uncovered exposure
    IF v_uncovered_debt > 0 THEN
      INSERT INTO public.billing_account_debts (
        organization_id, reference_type, reference_id,
        original_amount_minor, outstanding_amount_minor, currency, status, reason
      ) VALUES (
        v_op.organization_id, 'dispute_lost_uncovered', v_clean_dispute_id,
        v_uncovered_debt, v_uncovered_debt, v_op.currency, 'active', 'Lost dispute credit reversal exceeded available spendable balance'
      )
      ON CONFLICT (organization_id, reference_type, reference_id) DO UPDATE
      SET outstanding_amount_minor = EXCLUDED.outstanding_amount_minor,
          updated_at = NOW()
      RETURNING id INTO v_debt_id;
    END IF;

    -- Settle financial hold
    UPDATE public.billing_financial_holds
    SET status = 'settled',
        settled_at = NOW()
    WHERE organization_id = v_op.organization_id
      AND reference_type = 'dispute'
      AND reference_id = v_clean_dispute_id;

    RETURN jsonb_build_object(
      'success', true,
      'action', 'SETTLE_LOST',
      'dispute_id', v_dispute_row_id,
      'ledger_entry_id', v_ledger_id,
      'debt_id', v_debt_id,
      'reversed_from_wallet_minor', v_reversal_from_wallet,
      'uncovered_debt_minor', v_uncovered_debt,
      'balance_after_minor', v_new_balance,
      'status', 'lost'
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.process_dispute_hold_atomic(UUID, UUID, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_dispute_hold_atomic(UUID, UUID, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;


-- ----------------------------------------------------------------------------
-- 12. Enable Row Level Security (RLS) & Security Policies
-- ----------------------------------------------------------------------------
ALTER TABLE public.billing_provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_refund_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payment_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payment_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_financial_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_account_debts ENABLE ROW LEVEL SECURITY;

-- Customer Authenticated Read Access for Refund Requests
DROP POLICY IF EXISTS "authenticated_select_billing_refund_requests" ON public.billing_refund_requests;
CREATE POLICY "authenticated_select_billing_refund_requests" 
ON public.billing_refund_requests 
FOR SELECT 
TO authenticated 
USING (
  organization_id IN (
    SELECT m.organization_id 
    FROM public.user_organization_memberships m 
    WHERE m.user_id = auth.uid()
  )
);

-- Service Role Full Access Policies
DROP POLICY IF EXISTS "service_role_all_billing_provider_accounts" ON public.billing_provider_accounts;
CREATE POLICY "service_role_all_billing_provider_accounts" ON public.billing_provider_accounts FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_billing_refund_requests" ON public.billing_refund_requests;
CREATE POLICY "service_role_all_billing_refund_requests" ON public.billing_refund_requests FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_billing_payment_refunds" ON public.billing_payment_refunds;
CREATE POLICY "service_role_all_billing_payment_refunds" ON public.billing_payment_refunds FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_billing_payment_disputes" ON public.billing_payment_disputes;
CREATE POLICY "service_role_all_billing_payment_disputes" ON public.billing_payment_disputes FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_billing_financial_holds" ON public.billing_financial_holds;
CREATE POLICY "service_role_all_billing_financial_holds" ON public.billing_financial_holds FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_billing_account_debts" ON public.billing_account_debts;
CREATE POLICY "service_role_all_billing_account_debts" ON public.billing_account_debts FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
