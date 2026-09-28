-- ====================================================================
-- PUBLIC SAAS PHASE 13.3.3.3 — NARROW FINANCIAL RECONCILIATION PRIMITIVES
-- Date: 2026-12-04
-- Establishes purpose-built, narrow SQL RPC primitives for persisting
-- durable commercial saga recovery transitions:
-- 1. mark_commercial_saga_financial_reconciliation (capture_pending -> financial_reconciliation_required)
-- 2. mark_commercial_saga_manual_review (capture_pending/financial_reconciliation_required -> manual_review_required)
-- 3. complete_commercial_saga_after_capture (extended to allow financial_reconciliation_required -> completed)
--
-- SECURITY CONTRACT:
-- Strict service_role privileges only. Revoked from PUBLIC, anon, authenticated.
-- Row-level FOR UPDATE locking, tenant verification, fixed search_path.
-- Zero telecom mutations, zero arbitrary caller state parameter.
-- LOCAL DEFINITION ONLY — DO NOT EXECUTE REMOTELY AUTOMATICALLY.
-- ====================================================================

-- 1. RPC — MARK COMMERCIAL SAGA FINANCIAL RECONCILIATION REQUIRED
CREATE OR REPLACE FUNCTION public.mark_commercial_saga_financial_reconciliation(
    p_saga_id UUID,
    p_organization_id UUID,
    p_reason TEXT
) RETURNS public.commercial_number_purchase_sagas
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_saga public.commercial_number_purchase_sagas;
    v_reason TEXT;
BEGIN
    IF p_saga_id IS NULL OR p_organization_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_saga_id and p_organization_id are required.' USING ERRCODE = '22023';
    END IF;

    v_reason := COALESCE(pg_catalog.btrim(p_reason), 'Financial reconciliation required.');

    -- Row locking FOR UPDATE
    SELECT * INTO v_saga
    FROM public.commercial_number_purchase_sagas
    WHERE id = p_saga_id
    FOR UPDATE;

    IF v_saga IS NULL THEN
        RAISE EXCEPTION 'SAGA_NOT_FOUND: Commercial saga % does not exist.', p_saga_id USING ERRCODE = 'P0002';
    END IF;

    -- Strict tenant organization check
    IF v_saga.organization_id <> p_organization_id THEN
        RAISE EXCEPTION 'TENANT_MISMATCH: Commercial saga % does not belong to organization %.',
            p_saga_id, p_organization_id USING ERRCODE = '42501';
    END IF;

    -- Idempotent return if already in financial_reconciliation_required
    IF v_saga.state = 'financial_reconciliation_required' THEN
        RETURN v_saga;
    END IF;

    -- Strict source state check: MUST be capture_pending
    IF v_saga.state <> 'capture_pending' THEN
        RAISE EXCEPTION 'INVALID_SAGA_STATE_TRANSITION: Saga % is in state %, expected capture_pending.',
            p_saga_id, v_saga.state USING ERRCODE = '55000';
    END IF;

    -- Persist financial reconciliation state
    UPDATE public.commercial_number_purchase_sagas
    SET state = 'financial_reconciliation_required',
        failure_code = 'FINANCIAL_RECONCILIATION_REQUIRED',
        failure_message = v_reason,
        reconciliation_metadata = v_saga.reconciliation_metadata || pg_catalog.jsonb_build_object(
            'last_reconciled_at', pg_catalog.now(),
            'financial_reconciliation_reason', v_reason
        ),
        updated_at = pg_catalog.now()
    WHERE id = p_saga_id
    RETURNING * INTO v_saga;

    RETURN v_saga;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_commercial_saga_financial_reconciliation(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_commercial_saga_financial_reconciliation(UUID, UUID, TEXT) TO service_role;


-- 2. RPC — MARK COMMERCIAL SAGA MANUAL REVIEW REQUIRED
CREATE OR REPLACE FUNCTION public.mark_commercial_saga_manual_review(
    p_saga_id UUID,
    p_organization_id UUID,
    p_reason TEXT
) RETURNS public.commercial_number_purchase_sagas
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_saga public.commercial_number_purchase_sagas;
    v_reason TEXT;
BEGIN
    IF p_saga_id IS NULL OR p_organization_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_saga_id and p_organization_id are required.' USING ERRCODE = '22023';
    END IF;

    v_reason := COALESCE(pg_catalog.btrim(p_reason), 'Manual review required.');

    -- Row locking FOR UPDATE
    SELECT * INTO v_saga
    FROM public.commercial_number_purchase_sagas
    WHERE id = p_saga_id
    FOR UPDATE;

    IF v_saga IS NULL THEN
        RAISE EXCEPTION 'SAGA_NOT_FOUND: Commercial saga % does not exist.', p_saga_id USING ERRCODE = 'P0002';
    END IF;

    -- Strict tenant organization check
    IF v_saga.organization_id <> p_organization_id THEN
        RAISE EXCEPTION 'TENANT_MISMATCH: Commercial saga % does not belong to organization %.',
            p_saga_id, p_organization_id USING ERRCODE = '42501';
    END IF;

    -- Idempotent return if already in manual_review_required
    IF v_saga.state = 'manual_review_required' THEN
        RETURN v_saga;
    END IF;

    -- Strict allowed source states: capture_pending OR financial_reconciliation_required
    IF v_saga.state NOT IN ('capture_pending', 'financial_reconciliation_required') THEN
        RAISE EXCEPTION 'INVALID_SAGA_STATE_TRANSITION: Saga % is in state %, expected capture_pending or financial_reconciliation_required.',
            p_saga_id, v_saga.state USING ERRCODE = '55000';
    END IF;

    -- Persist manual review state
    UPDATE public.commercial_number_purchase_sagas
    SET state = 'manual_review_required',
        failure_code = 'MANUAL_REVIEW_REQUIRED',
        failure_message = v_reason,
        reconciliation_metadata = v_saga.reconciliation_metadata || pg_catalog.jsonb_build_object(
            'last_reconciled_at', pg_catalog.now(),
            'manual_review_reason', v_reason
        ),
        updated_at = pg_catalog.now()
    WHERE id = p_saga_id
    RETURNING * INTO v_saga;

    RETURN v_saga;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_commercial_saga_manual_review(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_commercial_saga_manual_review(UUID, UUID, TEXT) TO service_role;


-- 3. RPC — COMPLETE COMMERCIAL SAGA AFTER CAPTURE (EXTENDED SOURCE STATES)
-- Narrowly extends complete_commercial_saga_after_capture to permit completion from
-- EITHER capture_pending OR financial_reconciliation_required when payment is authoritatively captured.
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

    -- Row locking FOR UPDATE
    SELECT * INTO v_saga
    FROM public.commercial_number_purchase_sagas
    WHERE id = p_saga_id
    FOR UPDATE;

    IF v_saga IS NULL THEN
        RAISE EXCEPTION 'SAGA_NOT_FOUND: Commercial saga % does not exist.', p_saga_id USING ERRCODE = 'P0002';
    END IF;

    -- Strict tenant organization check
    IF v_saga.organization_id <> p_organization_id THEN
        RAISE EXCEPTION 'TENANT_MISMATCH: Commercial saga % does not belong to organization %.',
            p_saga_id, p_organization_id USING ERRCODE = '42501';
    END IF;

    -- Idempotent return if already completed
    IF v_saga.state = 'completed' THEN
        RETURN v_saga;
    END IF;

    -- Strict allowed source states: capture_pending OR financial_reconciliation_required
    IF v_saga.state NOT IN ('capture_pending', 'financial_reconciliation_required') THEN
        RAISE EXCEPTION 'INVALID_SAGA_STATE_TRANSITION: Saga % is in state %, expected capture_pending or financial_reconciliation_required.',
            p_saga_id, v_saga.state USING ERRCODE = '55000';
    END IF;

    -- Atomically transition to completed
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
