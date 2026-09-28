-- ====================================================================
-- PUBLIC SAAS PHASE 13.3.3.1 — DURABLE FINANCIAL CAPTURE PRIMITIVES
-- Date: 2026-12-03
-- Establishes durable capture-dispatch tracking fields, immutability triggers,
-- purpose-built RPCs for saga capture claim, payment capture dispatch claim,
-- payment capture confirmation, and commercial saga completion.
-- Strict service_role privilege controls and RLS safety preserved.
-- LOCAL DEFINITION ONLY — DO NOT EXECUTE REMOTELY AUTOMATICALLY.
-- ====================================================================

-- 1. ADD DURABLE CAPTURE-DISPATCH FIELDS TO public.billing_payment_operations
ALTER TABLE public.billing_payment_operations 
ADD COLUMN IF NOT EXISTS capture_dispatch_claimed_at TIMESTAMPTZ NULL;

ALTER TABLE public.billing_payment_operations 
ADD COLUMN IF NOT EXISTS capture_idempotency_key TEXT NULL;


-- 2. IMMUTABILITY TRIGGER FOR CAPTURE DISPATCH FIELDS
CREATE OR REPLACE FUNCTION public.prevent_capture_dispatch_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.capture_dispatch_claimed_at IS NOT NULL AND 
       NEW.capture_dispatch_claimed_at IS DISTINCT FROM OLD.capture_dispatch_claimed_at THEN
        RAISE EXCEPTION 'IMMUTABLE_CAPTURE_DISPATCH_CLAIM: capture_dispatch_claimed_at cannot be altered or cleared once set.' USING ERRCODE = '42883';
    END IF;

    IF OLD.capture_idempotency_key IS NOT NULL AND 
       NEW.capture_idempotency_key IS DISTINCT FROM OLD.capture_idempotency_key THEN
        RAISE EXCEPTION 'IMMUTABLE_CAPTURE_IDEMPOTENCY_KEY: capture_idempotency_key cannot be altered or cleared once set.' USING ERRCODE = '42883';
    END IF;

    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_no_mutation_capture_dispatch'
    ) THEN
        CREATE TRIGGER trg_no_mutation_capture_dispatch
            BEFORE UPDATE ON public.billing_payment_operations
            FOR EACH ROW EXECUTE FUNCTION public.prevent_capture_dispatch_mutation();
    END IF;
END $$;


-- 3. RPC — CLAIM COMMERCIAL SAGA FOR CAPTURE (ownership_confirmed -> capture_pending)
CREATE OR REPLACE FUNCTION public.claim_commercial_saga_for_capture(
    p_saga_id UUID,
    p_organization_id UUID
) RETURNS public.commercial_number_purchase_sagas
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_saga public.commercial_number_purchase_sagas;
BEGIN
    IF p_saga_id IS NULL OR p_organization_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_saga_id and p_organization_id are required.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_saga
    FROM public.commercial_number_purchase_sagas
    WHERE id = p_saga_id
    FOR UPDATE;

    IF v_saga IS NULL THEN
        RAISE EXCEPTION 'SAGA_NOT_FOUND: Commercial saga % does not exist.', p_saga_id USING ERRCODE = 'P0002';
    END IF;

    IF v_saga.organization_id <> p_organization_id THEN
        RAISE EXCEPTION 'TENANT_MISMATCH: Commercial saga % does not belong to organization %.',
            p_saga_id, p_organization_id USING ERRCODE = '42501';
    END IF;

    IF v_saga.state = 'capture_pending' THEN
        RAISE EXCEPTION 'SAGA_ALREADY_CAPTURE_CLAIMED: Commercial saga % is already in capture_pending state.',
            p_saga_id USING ERRCODE = '55001';
    END IF;

    IF v_saga.state <> 'ownership_confirmed' THEN
        RAISE EXCEPTION 'INVALID_SAGA_STATE_TRANSITION: Saga % is in state %, expected ownership_confirmed.',
            p_saga_id, v_saga.state USING ERRCODE = '55000';
    END IF;

    UPDATE public.commercial_number_purchase_sagas
    SET state = 'capture_pending',
        attempt_count = v_saga.attempt_count + 1,
        updated_at = pg_catalog.now()
    WHERE id = p_saga_id
    RETURNING * INTO v_saga;

    RETURN v_saga;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_commercial_saga_for_capture(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_commercial_saga_for_capture(UUID, UUID) TO service_role;


-- 4. RPC — CLAIM PAYMENT CAPTURE DISPATCH (authorized -> capture_pending)
CREATE OR REPLACE FUNCTION public.claim_payment_capture_dispatch(
    p_payment_op_id UUID,
    p_organization_id UUID,
    p_saga_id UUID
) RETURNS public.billing_payment_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_op public.billing_payment_operations;
    v_saga public.commercial_number_purchase_sagas;
BEGIN
    IF p_payment_op_id IS NULL OR p_organization_id IS NULL OR p_saga_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_payment_op_id, p_organization_id, and p_saga_id are required.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_op
    FROM public.billing_payment_operations
    WHERE id = p_payment_op_id
    FOR UPDATE;

    IF v_op IS NULL THEN
        RAISE EXCEPTION 'PAYMENT_OP_NOT_FOUND: Operation % does not exist.', p_payment_op_id USING ERRCODE = 'P0002';
    END IF;

    IF v_op.organization_id <> p_organization_id THEN
        RAISE EXCEPTION 'TENANT_MISMATCH: Payment operation % does not belong to organization %.',
            p_payment_op_id, p_organization_id USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_saga
    FROM public.commercial_number_purchase_sagas
    WHERE id = p_saga_id;

    IF v_saga IS NULL THEN
        RAISE EXCEPTION 'SAGA_NOT_FOUND: Commercial saga % does not exist.', p_saga_id USING ERRCODE = 'P0002';
    END IF;

    IF v_saga.payment_operation_id <> p_payment_op_id THEN
        RAISE EXCEPTION 'SAGA_PAYMENT_LINK_MISMATCH: Saga % payment_operation_id % does not match operation %.',
            p_saga_id, v_saga.payment_operation_id, p_payment_op_id USING ERRCODE = '42883';
    END IF;

    IF v_saga.organization_id <> p_organization_id THEN
        RAISE EXCEPTION 'TENANT_MISMATCH: Commercial saga % organization % does not match operation organization %.',
            p_saga_id, v_saga.organization_id, p_organization_id USING ERRCODE = '42501';
    END IF;

    IF v_saga.state <> 'capture_pending' THEN
        RAISE EXCEPTION 'INVALID_SAGA_STATE: Linked commercial saga % is in state %, expected capture_pending.',
            p_saga_id, v_saga.state USING ERRCODE = '55000';
    END IF;

    IF v_op.capture_dispatch_claimed_at IS NOT NULL OR v_op.capture_idempotency_key IS NOT NULL THEN
        RAISE EXCEPTION 'CAPTURE_DISPATCH_ALREADY_CLAIMED: Payment operation % capture dispatch has already been claimed.',
            p_payment_op_id USING ERRCODE = '55001';
    END IF;

    IF v_op.status <> 'authorized' THEN
        RAISE EXCEPTION 'INVALID_PAYMENT_STATE_TRANSITION: Payment operation % is in status %, expected authorized.',
            p_payment_op_id, v_op.status USING ERRCODE = '55000';
    END IF;

    UPDATE public.billing_payment_operations
    SET status = 'capture_pending',
        capture_dispatch_claimed_at = pg_catalog.now(),
        capture_idempotency_key = 'cap_pi_' || p_payment_op_id::text,
        updated_at = pg_catalog.now()
    WHERE id = p_payment_op_id
    RETURNING * INTO v_op;

    RETURN v_op;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_payment_capture_dispatch(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payment_capture_dispatch(UUID, UUID, UUID) TO service_role;


-- 5. RPC — CONFIRM PAYMENT CAPTURED (capture_pending -> captured)
CREATE OR REPLACE FUNCTION public.confirm_payment_captured(
    p_payment_op_id UUID,
    p_organization_id UUID,
    p_provider_payment_id TEXT
) RETURNS public.billing_payment_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_op public.billing_payment_operations;
BEGIN
    IF p_payment_op_id IS NULL OR p_organization_id IS NULL OR p_provider_payment_id IS NULL OR pg_catalog.length(pg_catalog.btrim(p_provider_payment_id)) = 0 THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_payment_op_id, p_organization_id, and non-empty p_provider_payment_id are required.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_op
    FROM public.billing_payment_operations
    WHERE id = p_payment_op_id
    FOR UPDATE;

    IF v_op IS NULL THEN
        RAISE EXCEPTION 'PAYMENT_OP_NOT_FOUND: Operation % does not exist.', p_payment_op_id USING ERRCODE = 'P0002';
    END IF;

    IF v_op.organization_id <> p_organization_id THEN
        RAISE EXCEPTION 'TENANT_MISMATCH: Payment operation % does not belong to organization %.',
            p_payment_op_id, p_organization_id USING ERRCODE = '42501';
    END IF;

    IF v_op.provider_payment_id IS NOT NULL AND v_op.provider_payment_id <> p_provider_payment_id THEN
        RAISE EXCEPTION 'PROVIDER_PAYMENT_ID_MISMATCH: Supplied provider_payment_id % does not match registered provider_payment_id %.',
            p_provider_payment_id, v_op.provider_payment_id USING ERRCODE = '42883';
    END IF;

    -- Idempotent return if already captured AND provider identity matches
    IF v_op.status = 'captured' THEN
        IF v_op.provider_payment_id IS NULL OR v_op.provider_payment_id = p_provider_payment_id THEN
            RETURN v_op;
        ELSE
            RAISE EXCEPTION 'PROVIDER_PAYMENT_ID_MISMATCH: Operation is captured under different provider identity.' USING ERRCODE = '42883';
        END IF;
    END IF;

    IF v_op.capture_dispatch_claimed_at IS NULL THEN
        RAISE EXCEPTION 'CAPTURE_DISPATCH_NOT_CLAIMED: Payment operation % must have capture dispatch claimed before confirming capture.',
            p_payment_op_id USING ERRCODE = '55000';
    END IF;

    IF v_op.status <> 'capture_pending' THEN
        RAISE EXCEPTION 'INVALID_PAYMENT_STATE_TRANSITION: Payment operation % is in status %, expected capture_pending.',
            p_payment_op_id, v_op.status USING ERRCODE = '55000';
    END IF;

    UPDATE public.billing_payment_operations
    SET status = 'captured',
        provider_payment_id = COALESCE(v_op.provider_payment_id, p_provider_payment_id),
        updated_at = pg_catalog.now()
    WHERE id = p_payment_op_id
    RETURNING * INTO v_op;

    RETURN v_op;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.confirm_payment_captured(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_payment_captured(UUID, UUID, TEXT) TO service_role;


-- 6. RPC — COMPLETE COMMERCIAL SAGA AFTER CAPTURE (capture_pending -> completed)
CREATE OR REPLACE FUNCTION public.complete_commercial_saga_after_capture(
    p_saga_id UUID,
    p_organization_id UUID
) RETURNS public.commercial_number_purchase_sagas
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_saga public.commercial_number_purchase_sagas;
BEGIN
    IF p_saga_id IS NULL OR p_organization_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_saga_id and p_organization_id are required.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_saga
    FROM public.commercial_number_purchase_sagas
    WHERE id = p_saga_id
    FOR UPDATE;

    IF v_saga IS NULL THEN
        RAISE EXCEPTION 'SAGA_NOT_FOUND: Commercial saga % does not exist.', p_saga_id USING ERRCODE = 'P0002';
    END IF;

    IF v_saga.organization_id <> p_organization_id THEN
        RAISE EXCEPTION 'TENANT_MISMATCH: Commercial saga % does not belong to organization %.',
            p_saga_id, p_organization_id USING ERRCODE = '42501';
    END IF;

    -- Idempotent return if already completed
    IF v_saga.state = 'completed' THEN
        RETURN v_saga;
    END IF;

    IF v_saga.state <> 'capture_pending' THEN
        RAISE EXCEPTION 'INVALID_SAGA_STATE_TRANSITION: Saga % is in state %, expected capture_pending.',
            p_saga_id, v_saga.state USING ERRCODE = '55000';
    END IF;

    UPDATE public.commercial_number_purchase_sagas
    SET state = 'completed',
        completed_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    WHERE id = p_saga_id
    RETURNING * INTO v_saga;

    RETURN v_saga;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_commercial_saga_after_capture(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_commercial_saga_after_capture(UUID, UUID) TO service_role;
