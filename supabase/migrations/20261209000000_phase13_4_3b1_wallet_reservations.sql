-- ============================================================================
-- PUBLIC SAAS PHASE 13.4.3B.1 — FINAL HARDENED WALLET LEDGER, USAGE RESERVATION & RETAIL RATING
-- Date: 2026-12-09
-- Evolves public.billing_credit_ledger constraints, creates public.telecom_retail_rate_cards,
-- public.telecom_usage_reservations, and public.telecom_financial_operation_idempotency.
-- Configures strict server-only (service_role only) direct database security policies,
-- hardened SECURITY DEFINER search paths (public, pg_temp), durable structured financial idempotency,
-- and atomic wallet reservation/extension/settlement/release/reversal RPCs.
-- ============================================================================

BEGIN;

-- 1. Safely evolve public.billing_credit_ledger check constraints
ALTER TABLE public.billing_credit_ledger
  DROP CONSTRAINT IF EXISTS billing_credit_ledger_entry_type_check;

ALTER TABLE public.billing_credit_ledger
  ADD CONSTRAINT billing_credit_ledger_entry_type_check
  CHECK (entry_type IN ('grant', 'consumption', 'expiration', 'adjustment', 'usage_reversal', 'telecom_usage', 'auto_recharge'));

ALTER TABLE public.billing_credit_ledger
  DROP CONSTRAINT IF EXISTS billing_credit_ledger_reference_type_check;

ALTER TABLE public.billing_credit_ledger
  ADD CONSTRAINT billing_credit_ledger_reference_type_check
  CHECK (reference_type IS NULL OR reference_type IN ('payment_operation', 'invoice', 'admin_action', 'promo', 'telecom_usage', 'auto_recharge'));

-- 2. Create public.telecom_retail_rate_cards table (Authoritative Retail Rating Engine - Service Role Only)
CREATE TABLE IF NOT EXISTS public.telecom_retail_rate_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rate_code TEXT NOT NULL UNIQUE CHECK (pg_catalog.length(pg_catalog.btrim(rate_code)) > 0 AND rate_code ~ '^[a-zA-Z0-9_\-]+$'),
    service_type TEXT NOT NULL CHECK (service_type IN ('voice_outbound', 'voice_inbound', 'sms_outbound', 'sms_inbound', 'mms_outbound', 'mms_inbound', 'other')),
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    destination_pattern TEXT NOT NULL DEFAULT '*' CHECK (pg_catalog.length(pg_catalog.btrim(destination_pattern)) > 0),
    destination_name TEXT NOT NULL DEFAULT 'Standard Rate',
    retail_rate_micro BIGINT NOT NULL CHECK (retail_rate_micro >= 0), -- 1 cent = 10000 micro-units (e.g. $0.0252/min = 25200)
    wholesale_cost_micro BIGINT NOT NULL DEFAULT 0 CHECK (wholesale_cost_micro >= 0), -- Internal wholesale estimate (Service-Role Only)
    unit_type TEXT NOT NULL DEFAULT 'minute' CHECK (unit_type IN ('minute', 'message', 'event')),
    billing_increment_seconds INT NOT NULL DEFAULT 60 CHECK (billing_increment_seconds > 0),
    min_chargeable_units INT NOT NULL DEFAULT 1 CHECK (min_chargeable_units >= 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    effective_start_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    effective_end_at TIMESTAMPTZ NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS idx_telecom_retail_rate_cards_lookup
ON public.telecom_retail_rate_cards(service_type, direction, is_active, destination_pattern);

-- Trigger for updated_at on telecom_retail_rate_cards
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_telecom_retail_rate_cards_updated_at'
    ) THEN
        CREATE TRIGGER trg_telecom_retail_rate_cards_updated_at
            BEFORE UPDATE ON public.telecom_retail_rate_cards
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- 3. Create public.telecom_usage_reservations table (Active Exposure Hold Tracking - Service Role Only)
CREATE TABLE IF NOT EXISTS public.telecom_usage_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    internal_usage_id TEXT NOT NULL UNIQUE CHECK (pg_catalog.length(pg_catalog.btrim(internal_usage_id)) > 0 AND pg_catalog.length(internal_usage_id) <= 128 AND internal_usage_id ~ '^[a-zA-Z0-9_\-]+$'),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    service_type TEXT NOT NULL CHECK (service_type IN ('voice_outbound', 'voice_inbound', 'sms_outbound', 'sms_inbound', 'mms_outbound', 'mms_inbound', 'other')),
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    provider TEXT NOT NULL DEFAULT 'twilio' CHECK (pg_catalog.length(pg_catalog.btrim(provider)) > 0 AND provider ~ '^[a-zA-Z0-9_\-]+$'),
    provider_resource_id TEXT NULL,
    rate_card_id UUID NULL REFERENCES public.telecom_retail_rate_cards(id) ON DELETE SET NULL,
    rate_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    amount_reserved_minor BIGINT NOT NULL CHECK (amount_reserved_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled', 'released', 'expired')),
    idempotency_key TEXT NOT NULL UNIQUE CHECK (pg_catalog.length(pg_catalog.btrim(idempotency_key)) > 0 AND pg_catalog.length(idempotency_key) <= 128 AND idempotency_key ~ '^[a-zA-Z0-9_\-]+$'),
    expires_at TIMESTAMPTZ NOT NULL,
    settled_at TIMESTAMPTZ NULL,
    released_at TIMESTAMPTZ NULL,
    settlement_ledger_id UUID NULL REFERENCES public.billing_credit_ledger(id) ON DELETE SET NULL,
    actual_provider_cost_minor BIGINT NULL CHECK (actual_provider_cost_minor IS NULL OR actual_provider_cost_minor >= 0),
    actual_customer_charge_minor BIGINT NULL CHECK (actual_customer_charge_minor IS NULL OR actual_customer_charge_minor >= 0),
    actual_gross_margin_minor BIGINT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS idx_telecom_usage_reservations_org_status
ON public.telecom_usage_reservations(organization_id, status);

CREATE INDEX IF NOT EXISTS idx_telecom_usage_reservations_provider_res
ON public.telecom_usage_reservations(provider, provider_resource_id)
WHERE provider_resource_id IS NOT NULL;

-- Trigger for updated_at on telecom_usage_reservations
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_telecom_usage_reservations_updated_at'
    ) THEN
        CREATE TRIGGER trg_telecom_usage_reservations_updated_at
            BEFORE UPDATE ON public.telecom_usage_reservations
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- 4. Create public.telecom_financial_operation_idempotency table (Durable Structured Financial Operations Ledger)
CREATE TABLE IF NOT EXISTS public.telecom_financial_operation_idempotency (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    operation_type TEXT NOT NULL CHECK (operation_type IN ('reservation_create', 'reservation_extend', 'reservation_settle', 'reservation_release', 'usage_reversal')),
    idempotency_key TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(idempotency_key)) > 0 AND pg_catalog.length(idempotency_key) <= 128 AND idempotency_key ~ '^[a-zA-Z0-9_\-]+$'),
    internal_usage_id TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(internal_usage_id)) > 0 AND pg_catalog.length(internal_usage_id) <= 128 AND internal_usage_id ~ '^[a-zA-Z0-9_\-]+$'),
    request_payload JSONB NOT NULL,
    response_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT uq_telecom_fin_op_idempotency UNIQUE (organization_id, operation_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_telecom_fin_op_idempotency_usage
ON public.telecom_financial_operation_idempotency (organization_id, internal_usage_id, operation_type);

-- 5. SERVER-ONLY CONFIDENTIALITY SECURITY MODEL
-- Rate cards, usage reservations, and financial operation idempotency tables are STRICTLY service_role server-only!
ALTER TABLE public.telecom_retail_rate_cards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telecom_retail_rate_cards FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.telecom_retail_rate_cards TO service_role;

ALTER TABLE public.telecom_usage_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telecom_usage_reservations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.telecom_usage_reservations TO service_role;

ALTER TABLE public.telecom_financial_operation_idempotency ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telecom_financial_operation_idempotency FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.telecom_financial_operation_idempotency TO service_role;

DROP POLICY IF EXISTS "authenticated_select_telecom_usage_reservations" ON public.telecom_usage_reservations;

-- 6. Atomic RPC: Get Authoritative Telecom Wallet Summary
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

  -- 2. Fetch sum of ALL active usage reservations (Time does NOT silently release money!)
  SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_active_reservations
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id
    AND status = 'active';

  -- 3. Calculate Available Funded Balance
  v_available_balance := GREATEST(0, v_funded_balance - v_active_reservations);

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'funded_balance_minor', v_funded_balance,
    'active_reservations_minor', v_active_reservations,
    'available_balance_minor', v_available_balance,
    'currency', v_currency
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_telecom_wallet_summary_atomic(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_telecom_wallet_summary_atomic(UUID) TO service_role;

-- 7. Atomic RPC: Record Telecom Usage Reservation (Pre-Usage Exposure Control)
CREATE OR REPLACE FUNCTION public.record_telecom_usage_reservation_atomic(
  p_organization_id UUID,
  p_internal_usage_id TEXT,
  p_service_type TEXT,
  p_direction TEXT,
  p_amount_reserved_minor BIGINT,
  p_idempotency_key TEXT,
  p_expires_in_seconds INT DEFAULT 1800,
  p_currency TEXT DEFAULT 'USD',
  p_provider TEXT DEFAULT 'twilio',
  p_provider_resource_id TEXT DEFAULT NULL,
  p_rate_card_id UUID DEFAULT NULL,
  p_rate_snapshot JSONB DEFAULT '{}'::jsonb,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clean_usage_id TEXT;
  v_clean_idempotency TEXT;
  v_clean_currency TEXT;
  v_clean_provider TEXT;
  v_existing_op public.telecom_financial_operation_idempotency;
  v_existing_res public.telecom_usage_reservations;
  v_funded_balance BIGINT := 0;
  v_wallet_currency TEXT := 'USD';
  v_active_reservations BIGINT := 0;
  v_available_balance BIGINT := 0;
  v_is_restricted BOOLEAN := FALSE;
  v_new_res public.telecom_usage_reservations;
  v_expires_at TIMESTAMPTZ;
  v_req_payload JSONB;
  v_resp_payload JSONB;
BEGIN
  v_clean_usage_id := pg_catalog.btrim(COALESCE(p_internal_usage_id, ''));
  v_clean_idempotency := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));
  v_clean_currency := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_currency, 'USD')));
  v_clean_provider := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_provider, 'twilio')));

  -- Input Validation Hardening
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;
  IF length(v_clean_usage_id) = 0 OR length(v_clean_usage_id) > 128 OR v_clean_usage_id !~ '^[a-zA-Z0-9_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_INTERNAL_USAGE_ID: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF length(v_clean_idempotency) = 0 OR length(v_clean_idempotency) > 128 OR v_clean_idempotency !~ '^[a-zA-Z0-9_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF p_amount_reserved_minor <= 0 THEN
    RAISE EXCEPTION 'INVALID_RESERVATION_AMOUNT: p_amount_reserved_minor must be positive.';
  END IF;
  IF v_clean_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'INVALID_CURRENCY: Currency must be 3-letter ISO code.';
  END IF;
  IF p_service_type NOT IN ('voice_outbound', 'voice_inbound', 'sms_outbound', 'sms_inbound', 'mms_outbound', 'mms_inbound', 'other') THEN
    RAISE EXCEPTION 'INVALID_SERVICE_TYPE: % is not supported.', p_service_type;
  END IF;
  IF p_direction NOT IN ('inbound', 'outbound') THEN
    RAISE EXCEPTION 'INVALID_DIRECTION: % is not supported.', p_direction;
  END IF;
  IF p_expires_in_seconds <= 0 OR p_expires_in_seconds > 86400 THEN
    RAISE EXCEPTION 'INVALID_EXPIRATION_INTERVAL: Expiry must be between 1 and 86400 seconds.';
  END IF;

  v_req_payload := jsonb_build_object(
    'organization_id', p_organization_id,
    'internal_usage_id', v_clean_usage_id,
    'service_type', p_service_type,
    'direction', p_direction,
    'amount_reserved_minor', p_amount_reserved_minor,
    'currency', v_clean_currency,
    'provider', v_clean_provider
  );

  -- Lock organization row
  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  -- 1. Check Durable Structured Financial Operation Idempotency
  SELECT * INTO v_existing_op
  FROM public.telecom_financial_operation_idempotency
  WHERE organization_id = p_organization_id
    AND operation_type = 'reservation_create'
    AND idempotency_key = v_clean_idempotency;

  IF v_existing_op.id IS NOT NULL THEN
    IF v_existing_op.request_payload->>'amount_reserved_minor' <> p_amount_reserved_minor::TEXT OR
       v_existing_op.request_payload->>'currency' <> v_clean_currency OR
       v_existing_op.request_payload->>'service_type' <> p_service_type OR
       v_existing_op.request_payload->>'direction' <> p_direction OR
       v_existing_op.request_payload->>'internal_usage_id' <> v_clean_usage_id THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Payload parameters conflict with original reservation %', v_clean_idempotency;
    END IF;

    v_resp_payload := v_existing_op.response_payload || jsonb_build_object('is_duplicate', true);
    RETURN v_resp_payload;
  END IF;

  -- 2. Check if internal_usage_id exists under different key or params
  SELECT * INTO v_existing_res
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id AND internal_usage_id = v_clean_usage_id;

  IF v_existing_res.id IS NOT NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Usage ID % already exists with reservation %', v_clean_usage_id, v_existing_res.id;
  END IF;

  -- 3. Check billing restriction status
  SELECT is_billing_restricted INTO v_is_restricted
  FROM public.organization_billing_controls
  WHERE organization_id = p_organization_id;

  IF v_is_restricted IS TRUE THEN
    RAISE EXCEPTION 'ORGANIZATION_BILLING_RESTRICTED: Organization % is currently restricted from telecom usage', p_organization_id;
  END IF;

  -- 4. Calculate Funded Balance & Active Reservations
  SELECT balance_after_minor, currency INTO v_funded_balance, v_wallet_currency
  FROM public.billing_credit_ledger
  WHERE organization_id = p_organization_id
  ORDER BY created_at DESC, id DESC LIMIT 1;

  v_funded_balance := COALESCE(v_funded_balance, 0);
  v_wallet_currency := COALESCE(v_wallet_currency, 'USD');

  IF v_clean_currency <> v_wallet_currency THEN
    RAISE EXCEPTION 'CURRENCY_MISMATCH: Requested currency % does not match wallet currency %', v_clean_currency, v_wallet_currency;
  END IF;

  SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_active_reservations
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id
    AND status = 'active';

  v_available_balance := v_funded_balance - v_active_reservations;

  -- 5. Fail-Closed Available Balance Validation
  IF v_available_balance < p_amount_reserved_minor THEN
    RAISE EXCEPTION 'INSUFFICIENT_AVAILABLE_BALANCE: Available funded balance % (funded: %, reserved: %) is insufficient for required reservation %',
      v_available_balance, v_funded_balance, v_active_reservations, p_amount_reserved_minor USING ERRCODE = '23514';
  END IF;

  -- 6. Insert new active reservation
  v_expires_at := pg_catalog.now() + (p_expires_in_seconds || ' seconds')::interval;

  INSERT INTO public.telecom_usage_reservations (
    internal_usage_id, organization_id, service_type, direction, provider,
    provider_resource_id, rate_card_id, rate_snapshot, amount_reserved_minor,
    currency, status, idempotency_key, expires_at, metadata
  ) VALUES (
    v_clean_usage_id, p_organization_id, p_service_type, p_direction, v_clean_provider,
    p_provider_resource_id, p_rate_card_id, COALESCE(p_rate_snapshot, '{}'::jsonb), p_amount_reserved_minor,
    v_clean_currency, 'active', v_clean_idempotency, v_expires_at, COALESCE(p_metadata, '{}'::jsonb)
  ) RETURNING * INTO v_new_res;

  v_active_reservations := v_active_reservations + p_amount_reserved_minor;

  v_resp_payload := jsonb_build_object(
    'success', true,
    'is_duplicate', false,
    'reservation_id', v_new_res.id,
    'internal_usage_id', v_new_res.internal_usage_id,
    'amount_reserved_minor', v_new_res.amount_reserved_minor,
    'status', v_new_res.status,
    'expires_at', v_new_res.expires_at,
    'funded_balance_minor', v_funded_balance,
    'active_reservations_minor', v_active_reservations,
    'available_balance_minor', GREATEST(0, v_funded_balance - v_active_reservations)
  );

  -- 7. Persist Structured Idempotency Entry
  INSERT INTO public.telecom_financial_operation_idempotency (
    organization_id, operation_type, idempotency_key, internal_usage_id, request_payload, response_payload
  ) VALUES (
    p_organization_id, 'reservation_create', v_clean_idempotency, v_clean_usage_id, v_req_payload, v_resp_payload
  );

  RETURN v_resp_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.record_telecom_usage_reservation_atomic(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, INT, TEXT, TEXT, TEXT, UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_telecom_usage_reservation_atomic(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, INT, TEXT, TEXT, TEXT, UUID, JSONB, JSONB) TO service_role;

-- 8. Atomic RPC: Extend Telecom Usage Reservation (CORRECTION 4: Exposure Increase Primitive)
CREATE OR REPLACE FUNCTION public.extend_telecom_usage_reservation_atomic(
  p_organization_id UUID,
  p_internal_usage_id TEXT,
  p_additional_amount_reserved_minor BIGINT,
  p_idempotency_key TEXT,
  p_new_expires_in_seconds INT DEFAULT 1800
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clean_usage_id TEXT;
  v_clean_idempotency TEXT;
  v_existing_op public.telecom_financial_operation_idempotency;
  v_res public.telecom_usage_reservations;
  v_funded_balance BIGINT := 0;
  v_active_reservations BIGINT := 0;
  v_available_balance BIGINT := 0;
  v_new_amount BIGINT;
  v_req_payload JSONB;
  v_resp_payload JSONB;
BEGIN
  v_clean_usage_id := pg_catalog.btrim(COALESCE(p_internal_usage_id, ''));
  v_clean_idempotency := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;
  IF length(v_clean_usage_id) = 0 OR length(v_clean_usage_id) > 128 OR v_clean_usage_id !~ '^[a-zA-Z0-9_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_INTERNAL_USAGE_ID: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF length(v_clean_idempotency) = 0 OR length(v_clean_idempotency) > 128 OR v_clean_idempotency !~ '^[a-zA-Z0-9_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF p_additional_amount_reserved_minor <= 0 THEN
    RAISE EXCEPTION 'INVALID_EXTENSION_AMOUNT: p_additional_amount_reserved_minor must be positive.';
  END IF;
  IF p_new_expires_in_seconds <= 0 OR p_new_expires_in_seconds > 86400 THEN
    RAISE EXCEPTION 'INVALID_EXPIRATION_INTERVAL: Expiry must be between 1 and 86400 seconds.';
  END IF;

  v_req_payload := jsonb_build_object(
    'organization_id', p_organization_id,
    'internal_usage_id', v_clean_usage_id,
    'additional_amount_reserved_minor', p_additional_amount_reserved_minor
  );

  -- Lock organization row
  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  -- 1. Check Structured Idempotency Ledger
  SELECT * INTO v_existing_op
  FROM public.telecom_financial_operation_idempotency
  WHERE organization_id = p_organization_id
    AND operation_type = 'reservation_extend'
    AND idempotency_key = v_clean_idempotency;

  IF v_existing_op.id IS NOT NULL THEN
    IF v_existing_op.request_payload->>'additional_amount_reserved_minor' <> p_additional_amount_reserved_minor::TEXT OR
       v_existing_op.request_payload->>'internal_usage_id' <> v_clean_usage_id THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Payload parameters conflict for extension %', v_clean_idempotency;
    END IF;

    v_resp_payload := v_existing_op.response_payload || jsonb_build_object('is_duplicate', true);
    RETURN v_resp_payload;
  END IF;

  -- 2. Fetch target active reservation
  SELECT * INTO v_res
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id AND internal_usage_id = v_clean_usage_id;

  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'RESERVATION_NOT_FOUND: Usage reservation % not found for organization %', v_clean_usage_id, p_organization_id;
  END IF;

  IF v_res.status <> 'active' THEN
    RAISE EXCEPTION 'CANNOT_EXTEND_INACTIVE_RESERVATION: Usage reservation % has status %', v_clean_usage_id, v_res.status;
  END IF;

  -- 3. Calculate Available Funded Balance
  SELECT balance_after_minor INTO v_funded_balance
  FROM public.billing_credit_ledger
  WHERE organization_id = p_organization_id
  ORDER BY created_at DESC, id DESC LIMIT 1;
  v_funded_balance := COALESCE(v_funded_balance, 0);

  SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_active_reservations
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id AND status = 'active';

  v_available_balance := v_funded_balance - v_active_reservations;

  IF v_available_balance < p_additional_amount_reserved_minor THEN
    RAISE EXCEPTION 'INSUFFICIENT_AVAILABLE_BALANCE: Available funded balance % is insufficient for extension %',
      v_available_balance, p_additional_amount_reserved_minor USING ERRCODE = '23514';
  END IF;

  -- 4. Atomically extend active reservation
  v_new_amount := v_res.amount_reserved_minor + p_additional_amount_reserved_minor;

  UPDATE public.telecom_usage_reservations
  SET amount_reserved_minor = v_new_amount,
      expires_at = pg_catalog.now() + (p_new_expires_in_seconds || ' seconds')::interval,
      updated_at = pg_catalog.now()
  WHERE id = v_res.id;

  v_active_reservations := v_active_reservations + p_additional_amount_reserved_minor;

  v_resp_payload := jsonb_build_object(
    'success', true,
    'is_duplicate', false,
    'reservation_id', v_res.id,
    'internal_usage_id', v_res.internal_usage_id,
    'amount_reserved_minor', v_new_amount,
    'additional_reserved_minor', p_additional_amount_reserved_minor,
    'funded_balance_minor', v_funded_balance,
    'active_reservations_minor', v_active_reservations,
    'available_balance_minor', GREATEST(0, v_funded_balance - v_active_reservations)
  );

  -- 5. Persist Structured Idempotency Entry
  INSERT INTO public.telecom_financial_operation_idempotency (
    organization_id, operation_type, idempotency_key, internal_usage_id, request_payload, response_payload
  ) VALUES (
    p_organization_id, 'reservation_extend', v_clean_idempotency, v_clean_usage_id, v_req_payload, v_resp_payload
  );

  RETURN v_resp_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.extend_telecom_usage_reservation_atomic(UUID, TEXT, BIGINT, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.extend_telecom_usage_reservation_atomic(UUID, TEXT, BIGINT, TEXT, INT) TO service_role;

-- 9. Atomic RPC: Settle Telecom Usage Reservation (CORRECTIONS 2 & 3: Settlement Safety)
CREATE OR REPLACE FUNCTION public.settle_telecom_usage_reservation_atomic(
  p_organization_id UUID,
  p_internal_usage_id TEXT,
  p_actual_retail_charge_minor BIGINT,
  p_idempotency_key TEXT,
  p_provider_wholesale_cost_minor BIGINT DEFAULT NULL,
  p_provider_resource_id TEXT DEFAULT NULL,
  p_description TEXT DEFAULT 'Telecom usage settlement'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clean_usage_id TEXT;
  v_clean_idempotency TEXT;
  v_existing_op public.telecom_financial_operation_idempotency;
  v_res public.telecom_usage_reservations;
  v_funded_balance BIGINT := 0;
  v_other_protected BIGINT := 0;
  v_max_chargeable BIGINT := 0;
  v_new_funded BIGINT := 0;
  v_ledger_id UUID := NULL;
  v_gross_margin BIGINT := NULL;
  v_active_reservations BIGINT := 0;
  v_req_payload JSONB;
  v_resp_payload JSONB;
BEGIN
  v_clean_usage_id := pg_catalog.btrim(COALESCE(p_internal_usage_id, ''));
  v_clean_idempotency := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;
  IF length(v_clean_usage_id) = 0 OR length(v_clean_usage_id) > 128 OR v_clean_usage_id !~ '^[a-zA-Z0-9_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_INTERNAL_USAGE_ID: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF length(v_clean_idempotency) = 0 OR length(v_clean_idempotency) > 128 OR v_clean_idempotency !~ '^[a-zA-Z0-9_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF p_actual_retail_charge_minor < 0 THEN
    RAISE EXCEPTION 'INVALID_SETTLEMENT_AMOUNT: p_actual_retail_charge_minor cannot be negative.';
  END IF;
  IF p_provider_wholesale_cost_minor IS NOT NULL AND p_provider_wholesale_cost_minor < 0 THEN
    RAISE EXCEPTION 'INVALID_WHOLESALE_COST: p_provider_wholesale_cost_minor cannot be negative.';
  END IF;

  v_req_payload := jsonb_build_object(
    'organization_id', p_organization_id,
    'internal_usage_id', v_clean_usage_id,
    'actual_retail_charge_minor', p_actual_retail_charge_minor
  );

  -- Lock organization row
  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  -- 1. Check Structured Idempotency Ledger
  SELECT * INTO v_existing_op
  FROM public.telecom_financial_operation_idempotency
  WHERE organization_id = p_organization_id
    AND operation_type = 'reservation_settle'
    AND idempotency_key = v_clean_idempotency;

  IF v_existing_op.id IS NOT NULL THEN
    IF v_existing_op.request_payload->>'actual_retail_charge_minor' <> p_actual_retail_charge_minor::TEXT OR
       v_existing_op.request_payload->>'internal_usage_id' <> v_clean_usage_id THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Payload parameters conflict for settlement %', v_clean_idempotency;
    END IF;

    v_resp_payload := v_existing_op.response_payload || jsonb_build_object('is_duplicate', true);
    RETURN v_resp_payload;
  END IF;

  -- 2. CORRECTION 2: Normal settlement MUST require an existing active reservation
  SELECT * INTO v_res
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id AND internal_usage_id = v_clean_usage_id;

  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'RESERVATION_NOT_FOUND: Normal settlement requires an existing active reservation for usage %', v_clean_usage_id;
  END IF;

  IF v_res.status = 'settled' THEN
    IF v_res.actual_customer_charge_minor <> p_actual_retail_charge_minor THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Settlement charge % conflicts with original settled charge %',
        p_actual_retail_charge_minor, v_res.actual_customer_charge_minor;
    END IF;

    SELECT balance_after_minor INTO v_funded_balance
    FROM public.billing_credit_ledger
    WHERE organization_id = p_organization_id
    ORDER BY created_at DESC, id DESC LIMIT 1;
    v_funded_balance := COALESCE(v_funded_balance, 0);

    SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_active_reservations
    FROM public.telecom_usage_reservations
    WHERE organization_id = p_organization_id AND status = 'active';

    RETURN jsonb_build_object(
      'success', true,
      'is_duplicate', true,
      'reservation_id', v_res.id,
      'internal_usage_id', v_res.internal_usage_id,
      'status', 'settled',
      'actual_customer_charge_minor', v_res.actual_customer_charge_minor,
      'settlement_ledger_id', v_res.settlement_ledger_id,
      'funded_balance_minor', v_funded_balance,
      'active_reservations_minor', v_active_reservations,
      'available_balance_minor', GREATEST(0, v_funded_balance - v_active_reservations)
    );
  END IF;

  IF v_res.status <> 'active' THEN
    RAISE EXCEPTION 'CANNOT_SETTLE_INACTIVE_RESERVATION: Usage reservation % status is %', v_clean_usage_id, v_res.status;
  END IF;

  -- 3. CORRECTION 3: Settlement MUST NOT steal funds protected for OTHER active reservations
  SELECT balance_after_minor INTO v_funded_balance
  FROM public.billing_credit_ledger
  WHERE organization_id = p_organization_id
  ORDER BY created_at DESC, id DESC LIMIT 1;
  v_funded_balance := COALESCE(v_funded_balance, 0);

  SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_other_protected
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id
    AND status = 'active'
    AND id <> v_res.id;

  v_max_chargeable := v_funded_balance - v_other_protected;

  IF p_actual_retail_charge_minor > v_max_chargeable THEN
    RAISE EXCEPTION 'SETTLEMENT_EXCEEDS_UNRESERVED_FUNDED_BALANCE: Charge % exceeds funded balance % available after protecting other active reservations %',
      p_actual_retail_charge_minor, v_funded_balance, v_other_protected USING ERRCODE = '23514';
  END IF;

  -- 4. Deduct finalized retail charge from billing_credit_ledger if > 0
  IF p_actual_retail_charge_minor > 0 THEN
    v_new_funded := v_funded_balance - p_actual_retail_charge_minor;

    INSERT INTO public.billing_credit_ledger (
      organization_id, entry_type, amount_minor, balance_after_minor,
      currency, description, reference_type, reference_id
    ) VALUES (
      p_organization_id, 'telecom_usage', -p_actual_retail_charge_minor, v_new_funded,
      v_res.currency, COALESCE(p_description, 'Telecom usage charge'), 'telecom_usage', v_clean_usage_id
    ) RETURNING id INTO v_ledger_id;
  ELSE
    v_new_funded := v_funded_balance;
  END IF;

  IF p_provider_wholesale_cost_minor IS NOT NULL THEN
    v_gross_margin := p_actual_retail_charge_minor - p_provider_wholesale_cost_minor;
  END IF;

  -- 5. Transition reservation status to settled
  UPDATE public.telecom_usage_reservations
  SET status = 'settled',
      settled_at = pg_catalog.now(),
      settlement_ledger_id = v_ledger_id,
      actual_customer_charge_minor = p_actual_retail_charge_minor,
      actual_provider_cost_minor = p_provider_wholesale_cost_minor,
      actual_gross_margin_minor = v_gross_margin,
      provider_resource_id = COALESCE(p_provider_resource_id, provider_resource_id),
      updated_at = pg_catalog.now()
  WHERE id = v_res.id;

  SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_active_reservations
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id AND status = 'active';

  v_resp_payload := jsonb_build_object(
    'success', true,
    'is_duplicate', false,
    'reservation_id', v_res.id,
    'internal_usage_id', v_res.internal_usage_id,
    'status', 'settled',
    'actual_customer_charge_minor', p_actual_retail_charge_minor,
    'actual_provider_cost_minor', p_provider_wholesale_cost_minor,
    'actual_gross_margin_minor', v_gross_margin,
    'settlement_ledger_id', v_ledger_id,
    'funded_balance_minor', v_new_funded,
    'active_reservations_minor', v_active_reservations,
    'available_balance_minor', GREATEST(0, v_new_funded - v_active_reservations)
  );

  -- 6. Persist Structured Idempotency Entry
  INSERT INTO public.telecom_financial_operation_idempotency (
    organization_id, operation_type, idempotency_key, internal_usage_id, request_payload, response_payload
  ) VALUES (
    p_organization_id, 'reservation_settle', v_clean_idempotency, v_clean_usage_id, v_req_payload, v_resp_payload
  );

  RETURN v_resp_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_telecom_usage_reservation_atomic(UUID, TEXT, BIGINT, TEXT, BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_telecom_usage_reservation_atomic(UUID, TEXT, BIGINT, TEXT, BIGINT, TEXT, TEXT) TO service_role;

-- 10. Atomic RPC: Release Telecom Usage Reservation
CREATE OR REPLACE FUNCTION public.release_telecom_usage_reservation_atomic(
  p_organization_id UUID,
  p_internal_usage_id TEXT,
  p_reason TEXT DEFAULT 'Normal release',
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clean_usage_id TEXT;
  v_clean_idempotency TEXT;
  v_existing_op public.telecom_financial_operation_idempotency;
  v_res public.telecom_usage_reservations;
  v_funded_balance BIGINT := 0;
  v_active_reservations BIGINT := 0;
  v_req_payload JSONB;
  v_resp_payload JSONB;
BEGIN
  v_clean_usage_id := pg_catalog.btrim(COALESCE(p_internal_usage_id, ''));
  v_clean_idempotency := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;
  IF length(v_clean_usage_id) = 0 OR length(v_clean_usage_id) > 128 OR v_clean_usage_id !~ '^[a-zA-Z0-9_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_INTERNAL_USAGE_ID: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF length(v_clean_idempotency) > 128 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: Exceeds maximum length of 128 chars.';
  END IF;

  -- Lock organization row
  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  -- 1. Check Structured Idempotency Ledger if key provided
  IF length(v_clean_idempotency) > 0 THEN
    v_req_payload := jsonb_build_object(
      'organization_id', p_organization_id,
      'internal_usage_id', v_clean_usage_id,
      'reason', COALESCE(p_reason, 'Normal release')
    );

    SELECT * INTO v_existing_op
    FROM public.telecom_financial_operation_idempotency
    WHERE organization_id = p_organization_id
      AND operation_type = 'reservation_release'
      AND idempotency_key = v_clean_idempotency;

    IF v_existing_op.id IS NOT NULL THEN
      v_resp_payload := v_existing_op.response_payload || jsonb_build_object('is_duplicate', true);
      RETURN v_resp_payload;
    END IF;
  END IF;

  -- 2. Fetch reservation
  SELECT * INTO v_res
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id AND internal_usage_id = v_clean_usage_id;

  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'RESERVATION_NOT_FOUND: Usage reservation % not found for organization %', v_clean_usage_id, p_organization_id;
  END IF;

  SELECT balance_after_minor INTO v_funded_balance
  FROM public.billing_credit_ledger
  WHERE organization_id = p_organization_id
  ORDER BY created_at DESC, id DESC LIMIT 1;
  v_funded_balance := COALESCE(v_funded_balance, 0);

  IF v_res.status IN ('released', 'expired') THEN
    SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_active_reservations
    FROM public.telecom_usage_reservations
    WHERE organization_id = p_organization_id AND status = 'active';

    RETURN jsonb_build_object(
      'success', true,
      'is_duplicate', true,
      'reservation_id', v_res.id,
      'internal_usage_id', v_res.internal_usage_id,
      'status', v_res.status,
      'funded_balance_minor', v_funded_balance,
      'active_reservations_minor', v_active_reservations,
      'available_balance_minor', GREATEST(0, v_funded_balance - v_active_reservations)
    );
  END IF;

  IF v_res.status = 'settled' THEN
    RAISE EXCEPTION 'CANNOT_RELEASE_SETTLED_RESERVATION: Usage reservation % is settled', v_clean_usage_id;
  END IF;

  -- 3. Release active reservation hold (Zero wallet debit/credit!)
  UPDATE public.telecom_usage_reservations
  SET status = 'released',
      released_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  WHERE id = v_res.id;

  SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_active_reservations
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id AND status = 'active';

  v_resp_payload := jsonb_build_object(
    'success', true,
    'is_duplicate', false,
    'reservation_id', v_res.id,
    'internal_usage_id', v_res.internal_usage_id,
    'status', 'released',
    'funded_balance_minor', v_funded_balance,
    'active_reservations_minor', v_active_reservations,
    'available_balance_minor', GREATEST(0, v_funded_balance - v_active_reservations)
  );

  -- 4. Persist Structured Idempotency Entry if key provided
  IF length(v_clean_idempotency) > 0 THEN
    INSERT INTO public.telecom_financial_operation_idempotency (
      organization_id, operation_type, idempotency_key, internal_usage_id, request_payload, response_payload
    ) VALUES (
      p_organization_id, 'reservation_release', v_clean_idempotency, v_clean_usage_id, v_req_payload, v_resp_payload
    );
  END IF;

  RETURN v_resp_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.release_telecom_usage_reservation_atomic(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_telecom_usage_reservation_atomic(UUID, TEXT, TEXT, TEXT) TO service_role;

-- 11. Atomic RPC: Record Telecom Usage Reversal (CORRECTION 7: Bounded Reversals & Structured Idempotency)
CREATE OR REPLACE FUNCTION public.record_telecom_usage_reversal_atomic(
  p_organization_id UUID,
  p_internal_usage_id TEXT,
  p_reversal_amount_minor BIGINT,
  p_idempotency_key TEXT,
  p_description TEXT DEFAULT 'Telecom usage reversal'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clean_usage_id TEXT;
  v_clean_idempotency TEXT;
  v_existing_op public.telecom_financial_operation_idempotency;
  v_res public.telecom_usage_reservations;
  v_settled_charge BIGINT := 0;
  v_total_reversed BIGINT := 0;
  v_remaining_reversible BIGINT := 0;
  v_funded_balance BIGINT := 0;
  v_new_funded BIGINT := 0;
  v_ledger_id UUID;
  v_active_reservations BIGINT := 0;
  v_req_payload JSONB;
  v_resp_payload JSONB;
BEGIN
  v_clean_usage_id := pg_catalog.btrim(COALESCE(p_internal_usage_id, ''));
  v_clean_idempotency := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;
  IF length(v_clean_usage_id) = 0 OR length(v_clean_usage_id) > 128 OR v_clean_usage_id !~ '^[a-zA-Z0-9_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_INTERNAL_USAGE_ID: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF length(v_clean_idempotency) = 0 OR length(v_clean_idempotency) > 128 OR v_clean_idempotency !~ '^[a-zA-Z0-9_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF p_reversal_amount_minor <= 0 THEN
    RAISE EXCEPTION 'INVALID_REVERSAL_AMOUNT: p_reversal_amount_minor must be positive.';
  END IF;

  v_req_payload := jsonb_build_object(
    'organization_id', p_organization_id,
    'internal_usage_id', v_clean_usage_id,
    'reversal_amount_minor', p_reversal_amount_minor
  );

  -- Lock organization row
  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  -- 1. Check Structured Idempotency Ledger
  SELECT * INTO v_existing_op
  FROM public.telecom_financial_operation_idempotency
  WHERE organization_id = p_organization_id
    AND operation_type = 'usage_reversal'
    AND idempotency_key = v_clean_idempotency;

  IF v_existing_op.id IS NOT NULL THEN
    IF v_existing_op.request_payload->>'reversal_amount_minor' <> p_reversal_amount_minor::TEXT OR
       v_existing_op.request_payload->>'internal_usage_id' <> v_clean_usage_id THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Payload parameters conflict for reversal %', v_clean_idempotency;
    END IF;

    v_resp_payload := v_existing_op.response_payload || jsonb_build_object('is_duplicate', true);
    RETURN v_resp_payload;
  END IF;

  -- 2. Fetch original settled usage reservation
  SELECT * INTO v_res
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id AND internal_usage_id = v_clean_usage_id;

  IF v_res.id IS NULL OR v_res.status <> 'settled' THEN
    RAISE EXCEPTION 'SETTLED_RESERVATION_NOT_FOUND: Reversal requires an existing settled reservation for usage %', v_clean_usage_id;
  END IF;

  v_settled_charge := COALESCE(v_res.actual_customer_charge_minor, 0);

  -- 3. Calculate total existing reversals for this internal_usage_id
  SELECT COALESCE(SUM(amount_minor), 0) INTO v_total_reversed
  FROM public.billing_credit_ledger
  WHERE organization_id = p_organization_id
    AND reference_type = 'telecom_usage'
    AND reference_id = v_clean_usage_id
    AND entry_type = 'usage_reversal';

  -- 4. Bounded Reversal Guardrail: cumulative reversals MUST NOT exceed settled customer charge
  v_remaining_reversible := v_settled_charge - v_total_reversed;
  IF p_reversal_amount_minor > v_remaining_reversible THEN
    RAISE EXCEPTION 'REVERSAL_EXCEEDS_SETTLED_CHARGE: Reversal amount % exceeds remaining reversible amount % (original settled: %, already reversed: %)',
      p_reversal_amount_minor, v_remaining_reversible, v_settled_charge, v_total_reversed USING ERRCODE = '23514';
  END IF;

  -- 5. Record Reversal Credit Entry in Ledger (No text parsing for idempotency!)
  SELECT balance_after_minor INTO v_funded_balance
  FROM public.billing_credit_ledger
  WHERE organization_id = p_organization_id
  ORDER BY created_at DESC, id DESC LIMIT 1;
  v_funded_balance := COALESCE(v_funded_balance, 0);

  v_new_funded := v_funded_balance + p_reversal_amount_minor;

  INSERT INTO public.billing_credit_ledger (
    organization_id, entry_type, amount_minor, balance_after_minor,
    currency, description, reference_type, reference_id
  ) VALUES (
    p_organization_id, 'usage_reversal', p_reversal_amount_minor, v_new_funded,
    v_res.currency, COALESCE(p_description, 'Telecom usage reversal'), 'telecom_usage', v_clean_usage_id
  ) RETURNING id INTO v_ledger_id;

  SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_active_reservations
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id AND status = 'active';

  v_resp_payload := jsonb_build_object(
    'success', true,
    'is_duplicate', false,
    'ledger_entry_id', v_ledger_id,
    'internal_usage_id', v_res.internal_usage_id,
    'reversal_amount_minor', p_reversal_amount_minor,
    'funded_balance_minor', v_new_funded,
    'active_reservations_minor', v_active_reservations,
    'available_balance_minor', GREATEST(0, v_new_funded - v_active_reservations)
  );

  -- 6. Persist Structured Idempotency Entry
  INSERT INTO public.telecom_financial_operation_idempotency (
    organization_id, operation_type, idempotency_key, internal_usage_id, request_payload, response_payload
  ) VALUES (
    p_organization_id, 'usage_reversal', v_clean_idempotency, v_clean_usage_id, v_req_payload, v_resp_payload
  );

  RETURN v_resp_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.record_telecom_usage_reversal_atomic(UUID, TEXT, BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_telecom_usage_reversal_atomic(UUID, TEXT, BIGINT, TEXT, TEXT) TO service_role;

COMMIT;
