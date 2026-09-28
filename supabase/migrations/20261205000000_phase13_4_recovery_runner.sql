-- ====================================================================
-- PUBLIC SAAS PHASE 13.3.4 — RECOVERY RUNNER & LEASE FENCING PRIMITIVES
-- Date: 2026-12-05
-- Establishes durable operational recovery fields, partial discovery index,
-- lease-claiming RPC with UUID token fencing, and safe recovery outcome recording RPC.
-- Strictly service_role executable, zero payment capture or telecom mutations.
-- LOCAL DEFINITION ONLY — DO NOT EXECUTE REMOTELY AUTOMATICALLY.
-- ====================================================================

-- 1. ADD DURABLE RECOVERY FIELDS TO public.commercial_number_purchase_sagas
ALTER TABLE public.commercial_number_purchase_sagas
ADD COLUMN IF NOT EXISTS recovery_attempt_count INT NOT NULL DEFAULT 0 CHECK (recovery_attempt_count >= 0),
ADD COLUMN IF NOT EXISTS recovery_started_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS next_recovery_retry_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS recovery_lease_until TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS recovery_lease_token UUID NULL;


-- 2. PARTIAL DISCOVERY INDEX FOR STALE RECOVERY RUNNER SCANNING
CREATE INDEX IF NOT EXISTS idx_commercial_sagas_recovery_runner_discovery
ON public.commercial_number_purchase_sagas (next_recovery_retry_at ASC, updated_at ASC)
WHERE state IN ('capture_pending', 'financial_reconciliation_required');


-- 3. RPC — CLAIM COMMERCIAL SAGA RECOVERY (WITH LEASE TOKEN FENCING)
CREATE OR REPLACE FUNCTION public.claim_commercial_saga_recovery(
    p_saga_id UUID,
    p_organization_id UUID,
    p_lease_seconds INT DEFAULT 60
) RETURNS public.commercial_number_purchase_sagas
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_saga public.commercial_number_purchase_sagas;
    v_lease_duration INT;
    v_token UUID;
    v_now TIMESTAMPTZ;
BEGIN
    IF p_saga_id IS NULL OR p_organization_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_saga_id and p_organization_id are required.' USING ERRCODE = '22023';
    END IF;

    v_lease_duration := LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 10), 600);
    v_token := gen_random_uuid();
    v_now := pg_catalog.now();

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

    IF v_saga.state NOT IN ('capture_pending', 'financial_reconciliation_required') THEN
        RAISE EXCEPTION 'INVALID_SAGA_STATE: Saga % is in state %, expected capture_pending or financial_reconciliation_required.',
            p_saga_id, v_saga.state USING ERRCODE = '55000';
    END IF;

    -- Active lease check: If recovery_lease_until IS NOT NULL and in the future, return NULL (lease lost)
    IF v_saga.recovery_lease_until IS NOT NULL AND v_saga.recovery_lease_until > v_now THEN
        RETURN NULL;
    END IF;

    -- Atomically acquire lease, assign unique lease token, increment attempt count, set recovery_started_at if NULL
    UPDATE public.commercial_number_purchase_sagas
    SET recovery_attempt_count = v_saga.recovery_attempt_count + 1,
        recovery_started_at = COALESCE(v_saga.recovery_started_at, v_now),
        recovery_lease_until = v_now + (v_lease_duration || ' seconds')::interval,
        recovery_lease_token = v_token,
        reconciliation_metadata = v_saga.reconciliation_metadata || pg_catalog.jsonb_build_object(
            'last_recovery_attempt_at', v_now
        ),
        updated_at = v_now
    WHERE id = p_saga_id
    RETURNING * INTO v_saga;

    RETURN v_saga;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_commercial_saga_recovery(UUID, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_commercial_saga_recovery(UUID, UUID, INT) TO service_role;


-- 4. RPC — RECORD COMMERCIAL SAGA RECOVERY OUTCOME (WITH TOKEN FENCING)
CREATE OR REPLACE FUNCTION public.record_commercial_saga_recovery_outcome(
    p_saga_id UUID,
    p_organization_id UUID,
    p_lease_token UUID,
    p_classification TEXT,
    p_stripe_status TEXT,
    p_next_retry_at TIMESTAMPTZ
) RETURNS public.commercial_number_purchase_sagas
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_saga public.commercial_number_purchase_sagas;
BEGIN
    IF p_saga_id IS NULL OR p_organization_id IS NULL OR p_lease_token IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_saga_id, p_organization_id, and p_lease_token are required.' USING ERRCODE = '22023';
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

    -- TOKEN FENCING CHECK: If caller's lease_token does not match stored recovery_lease_token, ignore stale worker update!
    IF v_saga.recovery_lease_token IS DISTINCT FROM p_lease_token THEN
        RETURN v_saga;
    END IF;

    -- Permitted states check
    IF v_saga.state NOT IN ('capture_pending', 'financial_reconciliation_required', 'completed', 'manual_review_required') THEN
        RAISE EXCEPTION 'INVALID_SAGA_STATE: Saga % is in state %, not eligible for recovery outcome recording.',
            p_saga_id, v_saga.state USING ERRCODE = '55000';
    END IF;

    -- Terminal / Manual review states clear lease and scheduling completely
    IF v_saga.state IN ('completed', 'manual_review_required') THEN
        UPDATE public.commercial_number_purchase_sagas
        SET recovery_lease_until = NULL,
            recovery_lease_token = NULL,
            next_recovery_retry_at = NULL,
            updated_at = pg_catalog.now()
        WHERE id = p_saga_id
        RETURNING * INTO v_saga;

        RETURN v_saga;
    END IF;

    -- Eligible recovery states update metadata, set calculated next_recovery_retry_at, and clear active lease
    UPDATE public.commercial_number_purchase_sagas
    SET recovery_lease_until = NULL,
        recovery_lease_token = NULL,
        next_recovery_retry_at = p_next_retry_at,
        reconciliation_metadata = v_saga.reconciliation_metadata || pg_catalog.jsonb_build_object(
            'last_recovery_outcome_at', pg_catalog.now(),
            'last_classification', COALESCE(p_classification, 'UNKNOWN'),
            'last_stripe_status', COALESCE(p_stripe_status, 'UNKNOWN')
        ),
        updated_at = pg_catalog.now()
    WHERE id = p_saga_id
    RETURNING * INTO v_saga;

    RETURN v_saga;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_commercial_saga_recovery_outcome(UUID, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_commercial_saga_recovery_outcome(UUID, UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
