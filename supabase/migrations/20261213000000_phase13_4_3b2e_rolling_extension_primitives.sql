-- ============================================================================
-- PUBLIC SAAS PHASE 13.4.3B.2E — ROLLING EXTENSION & CONTROL PRIMITIVES
-- Date: 2026-12-13
-- Additive migration creating public.telecom_provider_operations lease columns,
-- due-call & lease lookup performance indexes, database-enforced partial UNIQUE
-- invariant for one unresolved extension per session, dedicated fenced voice
-- extension RPC, database-derived rollback RPC, claim/reclaim RPC with leg targeting,
-- and fenced finalization RPC with state transition validation.
-- Configures strict server-only (service_role only) RLS policies and privileges.
-- ============================================================================

BEGIN;

-- 1. Add top-level lease_expires_at column to public.telecom_provider_operations
ALTER TABLE public.telecom_provider_operations
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NULL;

-- 2. Evolve operation_type CHECK constraint on public.telecom_financial_operation_idempotency
ALTER TABLE public.telecom_financial_operation_idempotency
  DROP CONSTRAINT IF EXISTS telecom_financial_operation_idempotency_operation_type_check;

ALTER TABLE public.telecom_financial_operation_idempotency
  ADD CONSTRAINT telecom_financial_operation_idempotency_operation_type_check
  CHECK (operation_type IN ('reservation_create', 'reservation_extend', 'reservation_settle', 'reservation_release', 'usage_reversal', 'reservation_extension_rollback'));

-- 3. Create due-call lookup performance index
CREATE INDEX IF NOT EXISTS idx_telecom_usage_reservations_due_voice
ON public.telecom_usage_reservations(expires_at)
WHERE status = 'active' AND service_type IN ('voice_outbound', 'voice_inbound');

-- 4. Create unresolved provider operation lease lookup index
CREATE INDEX IF NOT EXISTS idx_telecom_provider_ops_unresolved_lease
ON public.telecom_provider_operations(organization_id, internal_usage_id, status, lease_expires_at)
WHERE operation_type = 'call_duration_update';

-- 5. DATABASE-ENFORCED INVARIANT: AT MOST ONE UNRESOLVED EXTENSION WORKFLOW PER ACTIVE SESSION
CREATE UNIQUE INDEX IF NOT EXISTS uq_telecom_provider_ops_one_unresolved_extension
ON public.telecom_provider_operations (organization_id, internal_usage_id)
WHERE operation_type = 'call_duration_update'
  AND status IN ('prepared', 'dispatch_claimed', 'provider_id_known', 'reconciliation_required');

-- 6. Historical RPC: Extend Telecom Usage Reservation (Preserves B.1 compatibility & captures previous_expires_at)
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

  v_prev_expires_at := v_res.expires_at;

  v_req_payload := jsonb_build_object(
    'organization_id', p_organization_id,
    'internal_usage_id', v_clean_usage_id,
    'additional_amount_reserved_minor', p_additional_amount_reserved_minor,
    'previous_expires_at', v_prev_expires_at
  );

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
    'previous_expires_at', v_prev_expires_at,
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

-- 7. Dedicated B.2E Fenced Voice Extension RPC
CREATE OR REPLACE FUNCTION public.extend_telecom_voice_reservation_fenced_atomic(
  p_organization_id UUID,
  p_operation_id UUID,
  p_dispatch_token TEXT,
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
  v_clean_dispatch_token TEXT;
  v_op public.telecom_provider_operations;
BEGIN
  v_clean_usage_id := pg_catalog.btrim(COALESCE(p_internal_usage_id, ''));
  v_clean_dispatch_token := pg_catalog.btrim(COALESCE(p_dispatch_token, ''));

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_operation_id is required.';
  END IF;
  IF length(v_clean_dispatch_token) = 0 THEN
    RAISE EXCEPTION 'INVALID_DISPATCH_TOKEN: Fencing dispatch token is required.';
  END IF;
  IF length(v_clean_usage_id) = 0 THEN
    RAISE EXCEPTION 'INVALID_INTERNAL_USAGE_ID: p_internal_usage_id is required.';
  END IF;

  -- Lock organization row
  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  -- 1. FENCING CHECK: Verify provider operation and active dispatch token
  SELECT * INTO v_op
  FROM public.telecom_provider_operations
  WHERE id = p_operation_id AND organization_id = p_organization_id;

  IF v_op.id IS NULL THEN
    RAISE EXCEPTION 'PROVIDER_OPERATION_NOT_FOUND: Operation % not found for org %', p_operation_id, p_organization_id;
  END IF;

  IF v_op.internal_usage_id <> v_clean_usage_id THEN
    RAISE EXCEPTION 'OPERATION_USAGE_MISMATCH: Operation usage % does not match requested usage %', v_op.internal_usage_id, v_clean_usage_id;
  END IF;

  IF v_op.operation_type <> 'call_duration_update' THEN
    RAISE EXCEPTION 'INVALID_OPERATION_TYPE: Operation type % is not call_duration_update', v_op.operation_type;
  END IF;

  IF v_op.status NOT IN ('prepared', 'dispatch_claimed', 'provider_id_known', 'reconciliation_required') THEN
    RAISE EXCEPTION 'CANNOT_EXTEND_TERMINAL_OPERATION: Operation status is %', v_op.status;
  END IF;

  IF v_op.dispatch_token IS NULL OR v_op.dispatch_token <> v_clean_dispatch_token THEN
    RAISE EXCEPTION 'STALE_FENCING_TOKEN: Dispatch token % does not match active lease token %',
      v_clean_dispatch_token, COALESCE(v_op.dispatch_token, 'NULL') USING ERRCODE = '23514';
  END IF;

  -- 2. Fencing passed! Perform atomic wallet extension by invoking canonical B.1 RPC
  RETURN public.extend_telecom_usage_reservation_atomic(
    p_organization_id,
    v_clean_usage_id,
    p_additional_amount_reserved_minor,
    p_idempotency_key,
    p_new_expires_in_seconds
  );
END;
$$;

REVOKE ALL ON FUNCTION public.extend_telecom_voice_reservation_fenced_atomic(UUID, UUID, TEXT, TEXT, BIGINT, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.extend_telecom_voice_reservation_fenced_atomic(UUID, UUID, TEXT, TEXT, BIGINT, TEXT, INT) TO service_role;

-- 8. Atomic RPC: Rollback Telecom Usage Reservation Extension (Database-Derived & Fenced Compensation)
CREATE OR REPLACE FUNCTION public.rollback_telecom_usage_reservation_extension_atomic(
  p_organization_id UUID,
  p_operation_id UUID,
  p_dispatch_token TEXT,
  p_target_extension_idempotency_key TEXT,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clean_idempotency TEXT;
  v_clean_target_ext TEXT;
  v_clean_dispatch_token TEXT;
  v_op public.telecom_provider_operations;
  v_existing_op public.telecom_financial_operation_idempotency;
  v_ext_op public.telecom_financial_operation_idempotency;
  v_latest_ext_key TEXT;
  v_res public.telecom_usage_reservations;
  v_delta BIGINT;
  v_prev_expires_at TIMESTAMPTZ;
  v_new_amount BIGINT;
  v_funded_balance BIGINT := 0;
  v_active_reservations BIGINT := 0;
  v_req_payload JSONB;
  v_resp_payload JSONB;
BEGIN
  v_clean_idempotency := pg_catalog.btrim(COALESCE(p_idempotency_key, ''));
  v_clean_target_ext := pg_catalog.btrim(COALESCE(p_target_extension_idempotency_key, ''));
  v_clean_dispatch_token := pg_catalog.btrim(COALESCE(p_dispatch_token, ''));

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_operation_id is required.';
  END IF;
  IF length(v_clean_dispatch_token) = 0 THEN
    RAISE EXCEPTION 'INVALID_DISPATCH_TOKEN: Fencing dispatch token is required.';
  END IF;
  IF length(v_clean_target_ext) = 0 THEN
    RAISE EXCEPTION 'INVALID_TARGET_EXTENSION_KEY: p_target_extension_idempotency_key is required.';
  END IF;
  IF length(v_clean_idempotency) = 0 OR length(v_clean_idempotency) > 128 OR v_clean_idempotency !~ '^[a-zA-Z0-9_\-]+$' THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: Must be non-blank alphanumeric string max 128 chars.';
  END IF;

  -- Lock organization row
  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  -- 1. FENCING CHECK: Verify provider operation and dispatch token ownership
  SELECT * INTO v_op
  FROM public.telecom_provider_operations
  WHERE id = p_operation_id AND organization_id = p_organization_id;

  IF v_op.id IS NULL THEN
    RAISE EXCEPTION 'PROVIDER_OPERATION_NOT_FOUND: Operation % not found for org %', p_operation_id, p_organization_id;
  END IF;

  IF v_op.dispatch_token IS NULL OR v_op.dispatch_token <> v_clean_dispatch_token THEN
    RAISE EXCEPTION 'STALE_FENCING_TOKEN: Dispatch token % does not match active lease token %',
      v_clean_dispatch_token, COALESCE(v_op.dispatch_token, 'NULL') USING ERRCODE = '23514';
  END IF;

  -- 2. Check Rollback Idempotency
  SELECT * INTO v_existing_op
  FROM public.telecom_financial_operation_idempotency
  WHERE organization_id = p_organization_id
    AND operation_type = 'reservation_extension_rollback'
    AND idempotency_key = v_clean_idempotency;

  IF v_existing_op.id IS NOT NULL THEN
    v_resp_payload := v_existing_op.response_payload || jsonb_build_object('is_duplicate', true);
    RETURN v_resp_payload;
  END IF;

  -- 3. Load target extension idempotency record to derive delta and previous boundary
  SELECT * INTO v_ext_op
  FROM public.telecom_financial_operation_idempotency
  WHERE organization_id = p_organization_id
    AND operation_type = 'reservation_extend'
    AND idempotency_key = v_clean_target_ext;

  IF v_ext_op.id IS NULL THEN
    RAISE EXCEPTION 'TARGET_EXTENSION_NOT_FOUND: Extension % not found for org %', v_clean_target_ext, p_organization_id;
  END IF;

  IF v_ext_op.internal_usage_id <> v_op.internal_usage_id THEN
    RAISE EXCEPTION 'EXTENSION_USAGE_MISMATCH: Target extension % usage % does not match operation usage %',
      v_clean_target_ext, v_ext_op.internal_usage_id, v_op.internal_usage_id;
  END IF;

  -- 4. Check Exactly-Once Compensation for Target Extension
  IF EXISTS (
    SELECT 1 FROM public.telecom_financial_operation_idempotency
    WHERE organization_id = p_organization_id
      AND operation_type = 'reservation_extension_rollback'
      AND request_payload->>'target_extension_idempotency_key' = v_clean_target_ext
  ) THEN
    RAISE EXCEPTION 'EXTENSION_ALREADY_ROLLED_BACK: Extension % has already been compensated', v_clean_target_ext;
  END IF;

  -- 5. Stale Rollback Check: Verify target extension is the LATEST extension for this usage ID
  SELECT idempotency_key INTO v_latest_ext_key
  FROM public.telecom_financial_operation_idempotency
  WHERE organization_id = p_organization_id
    AND internal_usage_id = v_op.internal_usage_id
    AND operation_type = 'reservation_extend'
  ORDER BY created_at DESC, id DESC LIMIT 1;

  IF v_latest_ext_key <> v_clean_target_ext THEN
    RAISE EXCEPTION 'STALE_ROLLBACK_REJECTED: Target extension % is not the latest extension (% exists)',
      v_clean_target_ext, v_latest_ext_key;
  END IF;

  -- 6. Load target active reservation
  SELECT * INTO v_res
  FROM public.telecom_usage_reservations
  WHERE organization_id = p_organization_id AND internal_usage_id = v_op.internal_usage_id;

  IF v_res.id IS NULL THEN
    RAISE EXCEPTION 'RESERVATION_NOT_FOUND: Usage reservation % not found', v_op.internal_usage_id;
  END IF;

  IF v_res.status <> 'active' THEN
    RAISE EXCEPTION 'CANNOT_ROLLBACK_INACTIVE_RESERVATION: Usage reservation % status is %', v_op.internal_usage_id, v_res.status;
  END IF;

  -- 7. Derive monetary delta and previous expiry from target extension record
  v_delta := (v_ext_op.response_payload->>'additional_reserved_minor')::BIGINT;
  IF v_delta IS NULL OR v_delta <= 0 THEN
    v_delta := (v_ext_op.request_payload->>'additional_amount_reserved_minor')::BIGINT;
  END IF;

  IF v_delta IS NULL OR v_delta <= 0 THEN
    RAISE EXCEPTION 'INVALID_EXTENSION_DELTA: Could not derive valid extension delta from extension %', v_clean_target_ext;
  END IF;

  IF v_res.amount_reserved_minor < v_delta THEN
    RAISE EXCEPTION 'INVALID_ROLLBACK_AMOUNT: Rollback delta % exceeds current reserved amount %',
      v_delta, v_res.amount_reserved_minor;
  END IF;

  v_prev_expires_at := (v_ext_op.request_payload->>'previous_expires_at')::TIMESTAMPTZ;
  IF v_prev_expires_at IS NULL THEN
    v_prev_expires_at := (v_ext_op.response_payload->>'previous_expires_at')::TIMESTAMPTZ;
  END IF;

  -- 8. Execute atomic partial decrement while LEAVING RESERVATION ACTIVE
  v_new_amount := v_res.amount_reserved_minor - v_delta;

  UPDATE public.telecom_usage_reservations
  SET amount_reserved_minor = v_new_amount,
      expires_at = COALESCE(v_prev_expires_at, expires_at),
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

  v_req_payload := jsonb_build_object(
    'organization_id', p_organization_id,
    'operation_id', p_operation_id,
    'dispatch_token', v_clean_dispatch_token,
    'target_extension_idempotency_key', v_clean_target_ext,
    'internal_usage_id', v_op.internal_usage_id,
    'rolled_back_delta_minor', v_delta,
    'restored_expires_at', v_prev_expires_at
  );

  v_resp_payload := jsonb_build_object(
    'success', true,
    'is_duplicate', false,
    'reservation_id', v_res.id,
    'internal_usage_id', v_res.internal_usage_id,
    'status', 'active',
    'amount_reserved_minor', v_new_amount,
    'rolled_back_delta_minor', v_delta,
    'restored_expires_at', v_prev_expires_at,
    'funded_balance_minor', v_funded_balance,
    'active_reservations_minor', v_active_reservations,
    'available_balance_minor', GREATEST(0, v_funded_balance - v_active_reservations)
  );

  -- 9. Persist Idempotency Entry
  INSERT INTO public.telecom_financial_operation_idempotency (
    organization_id, operation_type, idempotency_key, internal_usage_id, request_payload, response_payload
  ) VALUES (
    p_organization_id, 'reservation_extension_rollback', v_clean_idempotency, v_op.internal_usage_id, v_req_payload, v_resp_payload
  );

  RETURN v_resp_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.rollback_telecom_usage_reservation_extension_atomic(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rollback_telecom_usage_reservation_extension_atomic(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;

-- 9. Atomic RPC: Claim Next Due Call Extension (Durable Lease, Reclaim Logic & Leg Targeting)
CREATE OR REPLACE FUNCTION public.claim_next_due_call_extension_atomic(
  p_worker_id TEXT,
  p_due_before_timestamp TIMESTAMPTZ,
  p_lease_duration_seconds INT DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clean_worker TEXT;
  v_res public.telecom_usage_reservations;
  v_comp public.telecom_usage_components;
  v_existing_op public.telecom_provider_operations;
  v_seq INT := 1;
  v_idempotency_key TEXT;
  v_dispatch_token TEXT;
  v_lease_expires_at TIMESTAMPTZ;
  v_target_call_sid TEXT;
  v_op_id UUID;
BEGIN
  v_clean_worker := pg_catalog.btrim(COALESCE(p_worker_id, ''));

  IF length(v_clean_worker) = 0 THEN
    RAISE EXCEPTION 'INVALID_WORKER_ID: p_worker_id is required.';
  END IF;
  IF p_due_before_timestamp IS NULL THEN
    RAISE EXCEPTION 'INVALID_DUE_TIMESTAMP: p_due_before_timestamp is required.';
  END IF;
  IF p_lease_duration_seconds <= 0 OR p_lease_duration_seconds > 300 THEN
    RAISE EXCEPTION 'INVALID_LEASE_INTERVAL: Lease duration must be between 1 and 300 seconds.';
  END IF;

  -- 1. Select the oldest due active voice reservation using FOR UPDATE SKIP LOCKED
  SELECT * INTO v_res
  FROM public.telecom_usage_reservations
  WHERE status = 'active'
    AND service_type IN ('voice_outbound', 'voice_inbound')
    AND expires_at <= p_due_before_timestamp
  ORDER BY expires_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_res.id IS NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'NO_DUE_CALLS');
  END IF;

  -- 2. Fetch linked provider component and select direction-specific provider resource ID
  SELECT * INTO v_comp
  FROM public.telecom_usage_components
  WHERE organization_id = v_res.organization_id
    AND internal_usage_id = v_res.internal_usage_id
  LIMIT 1;

  IF v_comp.component_id IS NULL THEN
    RAISE EXCEPTION 'LINKED_COMPONENT_NOT_FOUND: No component linked to usage %', v_res.internal_usage_id;
  END IF;

  IF v_res.service_type = 'voice_outbound' THEN
    v_target_call_sid := pg_catalog.btrim(COALESCE(v_comp.child_provider_resource_id, ''));
    IF length(v_target_call_sid) = 0 THEN
      RAISE EXCEPTION 'MISSING_OUTBOUND_CHILD_CALLSID: Outbound voice usage % lacks child PSTN DialCallSid', v_res.internal_usage_id;
    END IF;
  ELSIF v_res.service_type = 'voice_inbound' THEN
    v_target_call_sid := pg_catalog.btrim(COALESCE(v_comp.parent_provider_resource_id, ''));
    IF length(v_target_call_sid) = 0 THEN
      RAISE EXCEPTION 'MISSING_INBOUND_PARENT_CALLSID: Inbound voice usage % lacks parent PSTN CallSid', v_res.internal_usage_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'UNSUPPORTED_SERVICE_TYPE: Service type % is not supported for voice extensions', v_res.service_type;
  END IF;

  -- 3. Check for existing UNRESOLVED provider operation for this active session
  SELECT * INTO v_existing_op
  FROM public.telecom_provider_operations
  WHERE organization_id = v_res.organization_id
    AND internal_usage_id = v_res.internal_usage_id
    AND operation_type = 'call_duration_update'
    AND status IN ('prepared', 'dispatch_claimed', 'provider_id_known', 'reconciliation_required')
  ORDER BY created_at DESC, id DESC LIMIT 1;

  v_dispatch_token := 'token_' || gen_random_uuid()::text;
  v_lease_expires_at := pg_catalog.now() + (p_lease_duration_seconds || ' seconds')::interval;

  -- 4. CASE A: Unresolved operation DOES exist
  IF v_existing_op.id IS NOT NULL THEN
    -- Check if existing lease is healthy (owned by active worker)
    IF v_existing_op.lease_expires_at IS NOT NULL AND v_existing_op.lease_expires_at > pg_catalog.now() THEN
      -- Healthy active lease! Runner skips this call.
      RETURN jsonb_build_object('claimed', false, 'reason', 'ACTIVE_LEASE_OWNED_BY_ANOTHER_WORKER', 'existing_op_id', v_existing_op.id);
    END IF;

    -- Expired lease! RECLAIM SAME SEQUENCE OPERATION (Do NOT create sequence N+1)
    UPDATE public.telecom_provider_operations
    SET status = 'dispatch_claimed',
        dispatch_token = v_dispatch_token,
        lease_expires_at = v_lease_expires_at,
        attempt_count = attempt_count + 1,
        metadata = metadata || jsonb_build_object('last_reclaimed_by', v_clean_worker, 'reclaimed_at', pg_catalog.now()),
        updated_at = pg_catalog.now()
    WHERE id = v_existing_op.id;

    RETURN jsonb_build_object(
      'claimed', true,
      'is_reclaim', true,
      'operation_id', v_existing_op.id,
      'organization_id', v_res.organization_id,
      'internal_usage_id', v_res.internal_usage_id,
      'session_id', v_comp.session_id,
      'component_id', v_comp.component_id,
      'service_type', v_res.service_type,
      'direction', v_res.direction,
      'provider', v_res.provider,
      'provider_resource_id', v_target_call_sid,
      'current_amount_reserved_minor', v_res.amount_reserved_minor,
      'current_expires_at', v_res.expires_at,
      'sequence_number', COALESCE((v_existing_op.metadata->>'sequence_number')::int, 1),
      'idempotency_key', v_existing_op.idempotency_key,
      'dispatch_token', v_dispatch_token,
      'lease_expires_at', v_lease_expires_at
    );
  END IF;

  -- 5. CASE B: No unresolved operation exists -> Create NEW Sequence N+1 Operation
  SELECT COALESCE(MAX((metadata->>'sequence_number')::int), 0) + 1 INTO v_seq
  FROM public.telecom_provider_operations
  WHERE organization_id = v_res.organization_id
    AND internal_usage_id = v_res.internal_usage_id
    AND operation_type = 'call_duration_update';

  v_idempotency_key := 'ext_' || v_res.internal_usage_id || '_seq_' || v_seq;

  INSERT INTO public.telecom_provider_operations (
    organization_id, session_id, component_id, internal_usage_id,
    provider, operation_type, idempotency_key, request_fingerprint,
    provider_resource_id, status, dispatch_token, lease_expires_at, metadata
  ) VALUES (
    v_res.organization_id, v_comp.session_id, v_comp.component_id, v_res.internal_usage_id,
    v_res.provider, 'call_duration_update', v_idempotency_key, 'fp_' || v_idempotency_key,
    v_target_call_sid, 'dispatch_claimed', v_dispatch_token, v_lease_expires_at,
    jsonb_build_object('sequence_number', v_seq, 'claimed_by', v_clean_worker)
  ) RETURNING id INTO v_op_id;

  RETURN jsonb_build_object(
    'claimed', true,
    'is_reclaim', false,
    'operation_id', v_op_id,
    'organization_id', v_res.organization_id,
    'internal_usage_id', v_res.internal_usage_id,
    'session_id', v_comp.session_id,
    'component_id', v_comp.component_id,
    'service_type', v_res.service_type,
    'direction', v_res.direction,
    'provider', v_res.provider,
    'provider_resource_id', v_target_call_sid,
    'current_amount_reserved_minor', v_res.amount_reserved_minor,
    'current_expires_at', v_res.expires_at,
    'sequence_number', v_seq,
    'idempotency_key', v_idempotency_key,
    'dispatch_token', v_dispatch_token,
    'lease_expires_at', v_lease_expires_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_due_call_extension_atomic(TEXT, TIMESTAMPTZ, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_due_call_extension_atomic(TEXT, TIMESTAMPTZ, INT) TO service_role;

-- 10. Atomic RPC: Finalize Telecom Provider Operation (Fenced State Transition with Compensation Ordering Validation)
CREATE OR REPLACE FUNCTION public.finalize_telecom_provider_operation_atomic(
  p_organization_id UUID,
  p_operation_id UUID,
  p_dispatch_token TEXT,
  p_new_status TEXT,
  p_last_error JSONB DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clean_dispatch_token TEXT;
  v_op public.telecom_provider_operations;
  v_updated_rows INT;
  v_has_uncompensated_ext BOOLEAN := FALSE;
BEGIN
  v_clean_dispatch_token := pg_catalog.btrim(COALESCE(p_dispatch_token, ''));

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
  END IF;
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_operation_id is required.';
  END IF;
  IF length(v_clean_dispatch_token) = 0 THEN
    RAISE EXCEPTION 'INVALID_DISPATCH_TOKEN: Fencing dispatch token is required.';
  END IF;
  IF p_new_status NOT IN ('confirmed_created', 'confirmed_absent', 'failed', 'reconciliation_required') THEN
    RAISE EXCEPTION 'INVALID_FINAL_STATUS: Status % is not a valid operation status.', p_new_status;
  END IF;

  -- Lock organization row
  PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;

  -- Verify operation exists for org
  SELECT * INTO v_op
  FROM public.telecom_provider_operations
  WHERE id = p_operation_id AND organization_id = p_organization_id;

  IF v_op.id IS NULL THEN
    RAISE EXCEPTION 'PROVIDER_OPERATION_NOT_FOUND: Operation % not found for org %', p_operation_id, p_organization_id;
  END IF;

  -- COMPENSATION ORDERING CHECK: If transitioning to terminal failed/confirmed_absent, check if an uncompensated financial extension exists
  IF p_new_status IN ('failed', 'confirmed_absent') AND v_op.operation_type = 'call_duration_update' THEN
    IF EXISTS (
      SELECT 1 FROM public.telecom_financial_operation_idempotency e
      WHERE e.organization_id = p_organization_id
        AND e.operation_type = 'reservation_extend'
        AND e.idempotency_key = v_op.idempotency_key
        AND NOT EXISTS (
          SELECT 1 FROM public.telecom_financial_operation_idempotency r
          WHERE r.organization_id = p_organization_id
            AND r.operation_type = 'reservation_extension_rollback'
            AND r.request_payload->>'target_extension_idempotency_key' = v_op.idempotency_key
        )
    ) THEN
      -- Uncompensated financial extension exists! Transition to reconciliation_required instead of terminal failed to prevent sequence N+1
      RAISE EXCEPTION 'COMPENSATION_REQUIRED_BEFORE_TERMINAL_FINALIZATION: Operation % has uncompensated financial extension %. Execute rollback before terminal finalization.',
        v_op.id, v_op.idempotency_key USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Execute fenced status transition
  UPDATE public.telecom_provider_operations
  SET status = p_new_status,
      lease_expires_at = NULL,
      last_error = COALESCE(p_last_error, last_error),
      metadata = metadata || COALESCE(p_metadata, '{}'::jsonb),
      updated_at = pg_catalog.now()
  WHERE id = p_operation_id
    AND organization_id = p_organization_id
    AND dispatch_token = v_clean_dispatch_token;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

  IF v_updated_rows = 0 THEN
    RAISE EXCEPTION 'STALE_FENCING_TOKEN: Worker dispatch token % does not match active lease token %',
      v_clean_dispatch_token, COALESCE(v_op.dispatch_token, 'NULL') USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'operation_id', p_operation_id,
    'status', p_new_status,
    'finalized_at', pg_catalog.now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_telecom_provider_operation_atomic(UUID, UUID, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_telecom_provider_operation_atomic(UUID, UUID, TEXT, TEXT, JSONB, JSONB) TO service_role;

COMMIT;
