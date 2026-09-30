-- supabase/migrations/20261215000000_phase13_4_3b2e_identifier_grammar_remediation.sql
-- Phase 13.4.3B.2E Identifier Grammar Remediation Migration (Corrected Signatures & Explicit REVOKE/GRANT Arguments)
-- Additive migration updating validation regex for internal_usage_id in financial RPCs
-- to allow canonical colon-delimited identifiers (e.g. "call:outbound:<dbCallId>")
-- with pattern ^[a-zA-Z0-9:_\-]+$ while preserving exact production signatures,
-- search_path, SECURITY DEFINER, RLS, length limits, idempotency, and service-role privileges.

BEGIN;

-- 1. Redefine create_telecom_usage_reservation_atomic
CREATE OR REPLACE FUNCTION public.create_telecom_usage_reservation_atomic(
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

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;
  IF length(v_clean_usage_id) = 0 OR length(v_clean_usage_id) > 128 OR v_clean_usage_id !~ '^[a-zA-Z0-9:_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_INTERNAL_USAGE_ID: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF length(v_clean_idempotency) = 0 OR length(v_clean_idempotency) > 128 OR v_clean_idempotency !~ '^[a-zA-Z0-9:_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF p_service_type IS NULL OR p_service_type NOT IN ('voice_outbound', 'voice_inbound', 'sms_outbound', 'mms_outbound') THEN
    RAISE EXCEPTION 'INVALID_SERVICE_TYPE: Service type % is unsupported.', p_service_type;
  END IF;
  IF p_direction IS NULL OR p_direction NOT IN ('inbound', 'outbound') THEN
    RAISE EXCEPTION 'INVALID_DIRECTION: Direction must be inbound or outbound.';
  END IF;
  IF p_amount_reserved_minor <= 0 THEN
    RAISE EXCEPTION 'INVALID_RESERVATION_AMOUNT: p_amount_reserved_minor must be positive.';
  END IF;
  IF p_expires_in_seconds <= 0 OR p_expires_in_seconds > 86400 THEN
    RAISE EXCEPTION 'INVALID_EXPIRATION_INTERVAL: Expiry must be between 1 and 86400 seconds.';
  END IF;

  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  SELECT is_restricted INTO v_is_restricted
  FROM public.organizations WHERE id = p_organization_id;

  IF v_is_restricted IS TRUE THEN
    RAISE EXCEPTION 'ORGANIZATION_RESTRICTED: Organization % is suspended or restricted.', p_organization_id USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_existing_op
  FROM public.telecom_financial_operation_idempotency
  WHERE organization_id = p_organization_id
    AND operation_type = 'reservation_create'
    AND idempotency_key = v_clean_idempotency;

  IF v_existing_op.id IS NOT NULL THEN
    IF v_existing_op.request_payload->>'amount_reserved_minor' <> p_amount_reserved_minor::TEXT OR
       v_existing_op.request_payload->>'internal_usage_id' <> v_clean_usage_id THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Payload parameters conflict for key %', v_clean_idempotency;
    END IF;
    RETURN v_existing_op.response_payload || jsonb_build_object('is_duplicate', true);
  END IF;

  SELECT * INTO v_existing_res
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id
    AND internal_usage_id = v_clean_usage_id
    AND status = 'active';

  IF v_existing_res.id IS NOT NULL THEN
    RAISE EXCEPTION 'ACTIVE_RESERVATION_EXISTS: Active reservation % already exists for internal usage %',
      v_existing_res.id, v_clean_usage_id USING ERRCODE = '23505';
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

  SELECT balance_after_minor, currency INTO v_funded_balance, v_wallet_currency
  FROM public.billing_credit_ledger
  WHERE organization_id = p_organization_id
  ORDER BY created_at DESC, id DESC LIMIT 1;

  v_funded_balance := COALESCE(v_funded_balance, 0);
  v_wallet_currency := COALESCE(v_wallet_currency, 'USD');

  IF v_clean_currency <> v_wallet_currency THEN
    RAISE EXCEPTION 'CURRENCY_MISMATCH: Reservation currency % does not match wallet currency %',
      v_clean_currency, v_wallet_currency;
  END IF;

  SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_active_reservations
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id AND status = 'active';

  v_available_balance := v_funded_balance - v_active_reservations;

  IF v_available_balance < p_amount_reserved_minor THEN
    RAISE EXCEPTION 'INSUFFICIENT_AVAILABLE_BALANCE: Available funded balance % is insufficient for reservation %',
      v_available_balance, p_amount_reserved_minor USING ERRCODE = '23514';
  END IF;

  v_expires_at := pg_catalog.now() + (p_expires_in_seconds || ' seconds')::interval;

  INSERT INTO public.telecom_usage_reservations (
    organization_id, internal_usage_id, service_type, direction, provider,
    provider_resource_id, rate_card_id, rate_snapshot, amount_reserved_minor,
    currency, status, idempotency_key, expires_at, metadata
  ) VALUES (
    p_organization_id, v_clean_usage_id, p_service_type, p_direction, v_clean_provider,
    p_provider_resource_id, p_rate_card_id, COALESCE(p_rate_snapshot, '{}'::jsonb), p_amount_reserved_minor,
    v_clean_currency, 'active', v_clean_idempotency, v_expires_at, COALESCE(p_metadata, '{}'::jsonb)
  ) RETURNING * INTO v_new_res;

  v_res_id := v_new_res.id;
  v_active_reservations := v_active_reservations + p_amount_reserved_minor;

  v_resp_payload := jsonb_build_object(
    'success', true,
    'is_duplicate', false,
    'reservation_id', v_res_id,
    'internal_usage_id', v_clean_usage_id,
    'amount_reserved_minor', p_amount_reserved_minor,
    'expires_at', v_expires_at,
    'funded_balance_minor', v_funded_balance,
    'active_reservations_minor', v_active_reservations,
    'available_balance_minor', GREATEST(0, v_funded_balance - v_active_reservations)
  );

  INSERT INTO public.telecom_financial_operation_idempotency (
    organization_id, operation_type, idempotency_key, internal_usage_id, request_payload, response_payload
  ) VALUES (
    p_organization_id, 'reservation_create', v_clean_idempotency, v_clean_usage_id, v_req_payload, v_resp_payload
  );

  RETURN v_resp_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.create_telecom_usage_reservation_atomic(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, INT, TEXT, TEXT, TEXT, UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_telecom_usage_reservation_atomic(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, INT, TEXT, TEXT, TEXT, UUID, JSONB, JSONB) TO service_role;

-- 2. Redefine extend_telecom_usage_reservation_atomic
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
  v_prev_expires_at TIMESTAMPTZ;
  v_req_payload JSONB;
  v_resp_payload JSONB;
BEGIN
  v_clean_usage_id := pg_catalog.btrim(COALESCE(p_internal_usage_id, ''));
  v_clean_idempotency := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;
  IF length(v_clean_usage_id) = 0 OR length(v_clean_usage_id) > 128 OR v_clean_usage_id !~ '^[a-zA-Z0-9:_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_INTERNAL_USAGE_ID: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF length(v_clean_idempotency) = 0 OR length(v_clean_idempotency) > 128 OR v_clean_idempotency !~ '^[a-zA-Z0-9:_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF p_additional_amount_reserved_minor <= 0 THEN
    RAISE EXCEPTION 'INVALID_EXTENSION_AMOUNT: p_additional_amount_reserved_minor must be positive.';
  END IF;
  IF p_new_expires_in_seconds <= 0 OR p_new_expires_in_seconds > 86400 THEN
    RAISE EXCEPTION 'INVALID_EXPIRATION_INTERVAL: Expiry must be between 1 and 86400 seconds.';
  END IF;

  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

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
    RETURN v_existing_op.response_payload || jsonb_build_object('is_duplicate', true);
  END IF;

  SELECT * INTO v_res
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id
    AND internal_usage_id = v_clean_usage_id
    AND status = 'active'
  FOR UPDATE;

  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'ACTIVE_RESERVATION_NOT_FOUND: No active reservation found for internal usage %', v_clean_usage_id;
  END IF;

  v_prev_expires_at := v_res.expires_at;

  v_req_payload := jsonb_build_object(
    'organization_id', p_organization_id,
    'internal_usage_id', v_clean_usage_id,
    'additional_amount_reserved_minor', p_additional_amount_reserved_minor,
    'previous_expires_at', v_prev_expires_at
  );

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
    'previous_expires_at', v_prev_expires_at,
    'funded_balance_minor', v_funded_balance,
    'active_reservations_minor', v_active_reservations,
    'available_balance_minor', GREATEST(0, v_funded_balance - v_active_reservations)
  );

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

-- 3. Redefine settle_telecom_usage_reservation_atomic (Matching exact 7-parameter production signature)
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
  v_new_funded BIGINT := 0;
  v_active_reservations BIGINT := 0;
  v_ledger_id UUID;
  v_margin BIGINT := NULL;
  v_req_payload JSONB;
  v_resp_payload JSONB;
BEGIN
  v_clean_usage_id := pg_catalog.btrim(COALESCE(p_internal_usage_id, ''));
  v_clean_idempotency := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;
  IF length(v_clean_usage_id) = 0 OR length(v_clean_usage_id) > 128 OR v_clean_usage_id !~ '^[a-zA-Z0-9:_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_INTERNAL_USAGE_ID: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF length(v_clean_idempotency) = 0 OR length(v_clean_idempotency) > 128 OR v_clean_idempotency !~ '^[a-zA-Z0-9:_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF p_actual_retail_charge_minor < 0 THEN
    RAISE EXCEPTION 'INVALID_CUSTOMER_CHARGE: p_actual_retail_charge_minor cannot be negative.';
  END IF;

  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

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
    RETURN v_existing_op.response_payload || jsonb_build_object('is_duplicate', true);
  END IF;

  SELECT * INTO v_res
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id
    AND internal_usage_id = v_clean_usage_id
    AND status = 'active'
  FOR UPDATE;

  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'ACTIVE_RESERVATION_NOT_FOUND: No active reservation found for internal usage %', v_clean_usage_id;
  END IF;

  IF p_actual_retail_charge_minor > v_res.amount_reserved_minor THEN
    RAISE EXCEPTION 'SETTLEMENT_EXCEEDS_RESERVATION: Settlement charge % exceeds reserved exposure %',
      p_actual_retail_charge_minor, v_res.amount_reserved_minor USING ERRCODE = '23514';
  END IF;

  v_req_payload := jsonb_build_object(
    'organization_id', p_organization_id,
    'internal_usage_id', v_clean_usage_id,
    'actual_retail_charge_minor', p_actual_retail_charge_minor,
    'provider_wholesale_cost_minor', p_provider_wholesale_cost_minor,
    'provider_resource_id', p_provider_resource_id,
    'amount_reserved_minor', v_res.amount_reserved_minor
  );

  SELECT balance_after_minor INTO v_funded_balance
  FROM public.billing_credit_ledger
  WHERE organization_id = p_organization_id
  ORDER BY created_at DESC, id DESC LIMIT 1;
  v_funded_balance := COALESCE(v_funded_balance, 0);

  IF p_actual_retail_charge_minor > 0 THEN
    v_new_funded := v_funded_balance - p_actual_retail_charge_minor;
    INSERT INTO public.billing_credit_ledger (
      organization_id, entry_type, amount_minor, balance_after_minor, currency,
      description, reference_type, reference_id
    ) VALUES (
      p_organization_id, 'telecom_usage', -p_actual_retail_charge_minor, v_new_funded,
      v_res.currency, COALESCE(p_description, 'Telecom usage settlement'),
      'telecom_reservation', v_res.id::text
    ) RETURNING id INTO v_ledger_id;
  ELSE
    v_new_funded := v_funded_balance;
    v_ledger_id := NULL;
  END IF;

  IF p_provider_wholesale_cost_minor IS NOT NULL THEN
    v_margin := p_actual_retail_charge_minor - p_provider_wholesale_cost_minor;
  END IF;

  UPDATE public.telecom_usage_reservations
  SET status = 'settled',
      settled_at = pg_catalog.now(),
      settlement_ledger_id = v_ledger_id,
      actual_customer_charge_minor = p_actual_retail_charge_minor,
      actual_provider_cost_minor = p_provider_wholesale_cost_minor,
      actual_gross_margin_minor = v_margin,
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
    'ledger_id', v_ledger_id,
    'internal_usage_id', v_clean_usage_id,
    'amount_reserved_minor', v_res.amount_reserved_minor,
    'actual_customer_charge_minor', p_actual_retail_charge_minor,
    'actual_provider_cost_minor', p_provider_wholesale_cost_minor,
    'actual_gross_margin_minor', v_margin,
    'funded_balance_minor', v_new_funded,
    'active_reservations_minor', v_active_reservations,
    'available_balance_minor', GREATEST(0, v_new_funded - v_active_reservations)
  );

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

-- 4. Redefine release_telecom_usage_reservation_atomic
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
  IF length(v_clean_usage_id) = 0 OR length(v_clean_usage_id) > 128 OR v_clean_usage_id !~ '^[a-zA-Z0-9:_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_INTERNAL_USAGE_ID: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF length(v_clean_idempotency) > 0 AND (length(v_clean_idempotency) > 128 OR v_clean_idempotency !~ '^[a-zA-Z0-9:_\-]+$') THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: Must be non-blank alphanumeric string max 128 chars.';
  END IF;

  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  IF length(v_clean_idempotency) > 0 THEN
    SELECT * INTO v_existing_op
    FROM public.telecom_financial_operation_idempotency
    WHERE organization_id = p_organization_id
      AND operation_type = 'reservation_release'
      AND idempotency_key = v_clean_idempotency;

    IF v_existing_op.id IS NOT NULL THEN
      RETURN v_existing_op.response_payload || jsonb_build_object('is_duplicate', true);
    END IF;
  END IF;

  SELECT * INTO v_res
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id
    AND internal_usage_id = v_clean_usage_id
    AND status = 'active'
  FOR UPDATE;

  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'ACTIVE_RESERVATION_NOT_FOUND: No active reservation found for internal usage %', v_clean_usage_id;
  END IF;

  v_req_payload := jsonb_build_object(
    'organization_id', p_organization_id,
    'internal_usage_id', v_clean_usage_id,
    'released_amount_minor', v_res.amount_reserved_minor,
    'release_reason', p_reason
  );

  UPDATE public.telecom_usage_reservations
  SET status = 'released',
      released_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  WHERE id = v_res.id;

  SELECT balance_after_minor INTO v_funded_balance
  FROM public.billing_credit_ledger
  WHERE organization_id = p_organization_id
  ORDER BY created_at DESC, id DESC LIMIT 1;
  v_funded_balance := COALESCE(v_funded_balance, 0);

  SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_active_reservations
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id AND status = 'active';

  v_resp_payload := jsonb_build_object(
    'success', true,
    'is_duplicate', false,
    'reservation_id', v_res.id,
    'internal_usage_id', v_clean_usage_id,
    'released_amount_minor', v_res.amount_reserved_minor,
    'funded_balance_minor', v_funded_balance,
    'active_reservations_minor', v_active_reservations,
    'available_balance_minor', GREATEST(0, v_funded_balance - v_active_reservations)
  );

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

-- 5. Redefine reverse_telecom_usage_atomic
CREATE OR REPLACE FUNCTION public.reverse_telecom_usage_atomic(
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
  v_active_reservations BIGINT := 0;
  v_ledger_id UUID;
  v_req_payload JSONB;
  v_resp_payload JSONB;
BEGIN
  v_clean_usage_id := pg_catalog.btrim(COALESCE(p_internal_usage_id, ''));
  v_clean_idempotency := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;
  IF length(v_clean_usage_id) = 0 OR length(v_clean_usage_id) > 128 OR v_clean_usage_id !~ '^[a-zA-Z0-9:_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_INTERNAL_USAGE_ID: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF length(v_clean_idempotency) = 0 OR length(v_clean_idempotency) > 128 OR v_clean_idempotency !~ '^[a-zA-Z0-9:_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF p_reversal_amount_minor <= 0 THEN
    RAISE EXCEPTION 'INVALID_REVERSAL_AMOUNT: p_reversal_amount_minor must be positive.';
  END IF;

  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  SELECT * INTO v_existing_op
  FROM public.telecom_financial_operation_idempotency
  WHERE organization_id = p_organization_id
    AND operation_type = 'usage_reversal'
    AND idempotency_key = v_clean_idempotency;

  IF v_existing_op.id IS NOT NULL THEN
    RETURN v_existing_op.response_payload || jsonb_build_object('is_duplicate', true);
  END IF;

  SELECT * INTO v_res
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id
    AND internal_usage_id = v_clean_usage_id
    AND status = 'settled'
  FOR UPDATE;

  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'SETTLED_RESERVATION_NOT_FOUND: No settled reservation found for internal usage %', v_clean_usage_id;
  END IF;

  v_settled_charge := COALESCE(v_res.actual_customer_charge_minor, 0);

  SELECT COALESCE(SUM((response_payload->>'reversal_amount_minor')::BIGINT), 0) INTO v_total_reversed
  FROM public.telecom_financial_operation_idempotency
  WHERE organization_id = p_organization_id
    AND operation_type = 'usage_reversal'
    AND internal_usage_id = v_clean_usage_id;

  v_remaining_reversible := v_settled_charge - v_total_reversed;

  IF p_reversal_amount_minor > v_remaining_reversible THEN
    RAISE EXCEPTION 'REVERSAL_EXCEEDS_CHARGE: Requested reversal % exceeds remaining reversible balance %',
      p_reversal_amount_minor, v_remaining_reversible USING ERRCODE = '23514';
  END IF;

  v_req_payload := jsonb_build_object(
    'organization_id', p_organization_id,
    'internal_usage_id', v_clean_usage_id,
    'reversal_amount_minor', p_reversal_amount_minor,
    'reversal_reason', COALESCE(p_description, 'Telecom usage reversal')
  );

  SELECT balance_after_minor INTO v_funded_balance
  FROM public.billing_credit_ledger
  WHERE organization_id = p_organization_id
  ORDER BY created_at DESC, id DESC LIMIT 1;
  v_funded_balance := COALESCE(v_funded_balance, 0);

  v_new_funded := v_funded_balance + p_reversal_amount_minor;

  INSERT INTO public.billing_credit_ledger (
    organization_id, entry_type, amount_minor, balance_after_minor, currency,
    description, reference_type, reference_id
  ) VALUES (
    p_organization_id, 'usage_reversal', p_reversal_amount_minor, v_new_funded,
    v_res.currency, COALESCE(p_description, 'Telecom usage reversal'),
    'telecom_reservation', v_res.id::text
  ) RETURNING id INTO v_ledger_id;

  SELECT COALESCE(SUM(amount_reserved_minor), 0) INTO v_active_reservations
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id AND status = 'active';

  v_resp_payload := jsonb_build_object(
    'success', true,
    'is_duplicate', false,
    'reservation_id', v_res.id,
    'ledger_id', v_ledger_id,
    'internal_usage_id', v_clean_usage_id,
    'reversal_amount_minor', p_reversal_amount_minor,
    'funded_balance_minor', v_new_funded,
    'active_reservations_minor', v_active_reservations,
    'available_balance_minor', GREATEST(0, v_new_funded - v_active_reservations)
  );

  INSERT INTO public.telecom_financial_operation_idempotency (
    organization_id, operation_type, idempotency_key, internal_usage_id, request_payload, response_payload
  ) VALUES (
    p_organization_id, 'usage_reversal', v_clean_idempotency, v_clean_usage_id, v_req_payload, v_resp_payload
  );

  RETURN v_resp_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_telecom_usage_atomic(UUID, TEXT, BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_telecom_usage_atomic(UUID, TEXT, BIGINT, TEXT, TEXT) TO service_role;

COMMIT;
