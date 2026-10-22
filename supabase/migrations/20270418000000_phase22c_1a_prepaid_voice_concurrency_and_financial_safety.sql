-- ==============================================================================
-- PHASE 22C-1A: PREPAID VOICE CONCURRENCY AND FINANCIAL SAFETY REMEDIATION
-- LOCAL MIGRATION ONLY — DO NOT APPLY TO REMOTE/PRODUCTION DATABASE
-- ==============================================================================

-- Redefine record_telecom_usage_reservation_atomic to enforce organization-level
-- concurrent voice call limits inside the serialized database transaction boundary.
-- This guarantees that two parallel requests cannot race past the concurrency limit.

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
  v_max_concurrent_calls INT := 5;
  v_active_voice_count INT := 0;
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
  IF length(v_clean_usage_id) = 0 OR length(v_clean_usage_id) > 128 OR v_clean_usage_id !~ '^[a-zA-Z0-9:_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_INTERNAL_USAGE_ID: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF length(v_clean_idempotency) = 0 OR length(v_clean_idempotency) > 128 OR v_clean_idempotency !~ '^[a-zA-Z0-9:_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: Must be non-blank alphanumeric string max 128 chars.';
  END IF;
  IF p_amount_reserved_minor <= 0 THEN
    RAISE EXCEPTION 'INVALID_RESERVATION_AMOUNT: p_amount_reserved_minor must be positive.';
  END IF;
  IF p_expires_in_seconds <= 0 OR p_expires_in_seconds > 86400 THEN
    RAISE EXCEPTION 'INVALID_EXPIRATION_INTERVAL: p_expires_in_seconds must be between 1 and 86400.';
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

  -- Deterministic Row Locking Strategy: Lock organization row first to serialize financial and concurrency mutations
  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  -- 1. Check Structured Idempotency Ledger
  SELECT * INTO v_existing_op
  FROM public.telecom_financial_operation_idempotency
  WHERE organization_id = p_organization_id
    AND operation_type = 'reservation_create'
    AND idempotency_key = v_clean_idempotency;

  IF v_existing_op.id IS NOT NULL THEN
    IF v_existing_op.request_payload->>'amount_reserved_minor' <> p_amount_reserved_minor::TEXT OR
       v_existing_op.request_payload->>'internal_usage_id' <> v_clean_usage_id THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Payload parameters conflict for reservation %', v_clean_idempotency;
    END IF;

    v_resp_payload := v_existing_op.response_payload || jsonb_build_object('is_duplicate', true);
    RETURN v_resp_payload;
  END IF;

  -- 2. Check for Duplicate Internal Usage ID
  SELECT * INTO v_existing_res
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id AND internal_usage_id = v_clean_usage_id;

  IF v_existing_res.id IS NOT NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Usage ID % already exists with reservation %', v_clean_usage_id, v_existing_res.id;
  END IF;

  -- 3. Check billing restriction status and concurrent voice call limit
  SELECT is_billing_restricted, COALESCE(max_concurrent_voice_calls, 5)
  INTO v_is_restricted, v_max_concurrent_calls
  FROM public.organization_billing_controls
  WHERE organization_id = p_organization_id;

  IF v_is_restricted IS TRUE THEN
    RAISE EXCEPTION 'ORGANIZATION_BILLING_RESTRICTED: Organization % is currently restricted from telecom usage', p_organization_id;
  END IF;

  -- 4. Atomic Concurrency Gate: Enforce concurrent active voice call limit inside locked transaction
  IF p_service_type IN ('voice_outbound', 'voice_inbound') THEN
    SELECT COUNT(*) INTO v_active_voice_count
    FROM public.telecom_usage_reservations
    WHERE organization_id = p_organization_id
      AND status = 'active'
      AND service_type IN ('voice_outbound', 'voice_inbound');

    IF v_active_voice_count >= v_max_concurrent_calls THEN
      RAISE EXCEPTION 'CONCURRENT_CALL_LIMIT_EXCEEDED: Organization % has reached its concurrent active voice call limit (%/%)',
        p_organization_id, v_active_voice_count, v_max_concurrent_calls
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- 5. Calculate Funded Balance & Active Reservations
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

  -- 6. Fail-Closed Available Balance Validation
  IF v_available_balance < p_amount_reserved_minor THEN
    RAISE EXCEPTION 'INSUFFICIENT_AVAILABLE_BALANCE: Available funded balance % (funded: %, reserved: %) is insufficient for required reservation %',
      v_available_balance, v_funded_balance, v_active_reservations, p_amount_reserved_minor USING ERRCODE = '23514';
  END IF;

  -- 7. Insert new active reservation
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

  -- 8. Persist Structured Idempotency Entry
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
