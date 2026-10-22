-- ============================================================================
-- PHASE 24D.SEC-7F: PRE-VPS REMAINING SECURITY HARDENING
-- M-01 / M-02 / L-01 / L-02 / L-03 / L-04
-- + DISTRIBUTED NUMBER-PURCHASE VELOCITY DEFENSE
--
-- Purely additive and idempotent. Zero destructive drops. Safe for local & CI.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

-- ============================================================================
-- 1. L-01: DURABLE SECURITY AUDIT EVENTS TABLE (telecom_security_events)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.telecom_security_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE SET NULL,
    provider_account_id UUID NULL REFERENCES public.telecom_provider_accounts(id) ON DELETE SET NULL,
    rule_id TEXT NOT NULL,
    service TEXT NULL,
    intent TEXT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telecom_sec_events_org_created
ON public.telecom_security_events(organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telecom_sec_events_rule_created
ON public.telecom_security_events(rule_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telecom_sec_events_created_at
ON public.telecom_security_events(created_at DESC);

ALTER TABLE public.telecom_security_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.telecom_security_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.telecom_security_events TO service_role;


-- ============================================================================
-- 2. L-03: OBSERVABLE BILLABLE RESOURCE RECONCILIATION FLAGGING
-- Add additive column to provider_number_operations for unswallowed billing errors
-- ============================================================================
ALTER TABLE public.provider_number_operations
ADD COLUMN IF NOT EXISTS billing_reconciliation_required BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_provider_num_ops_billing_recon
ON public.provider_number_operations(billing_reconciliation_required)
WHERE billing_reconciliation_required = true;


-- ============================================================================
-- 3. L-04: DISTRIBUTED ANTI-REPLAY SESSION NONCES (telecom_session_nonces)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.telecom_session_nonces (
    nonce_hash TEXT PRIMARY KEY,
    organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    operation TEXT NOT NULL,
    consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telecom_nonces_expires
ON public.telecom_session_nonces(expires_at);

ALTER TABLE public.telecom_session_nonces ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.telecom_session_nonces FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.telecom_session_nonces TO service_role;

-- Atomic Nonce Consumption RPC
CREATE OR REPLACE FUNCTION public.consume_telecom_session_nonce(
    p_nonce_hash TEXT,
    p_organization_id UUID,
    p_operation TEXT,
    p_expires_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := now();
    v_existing public.telecom_session_nonces;
BEGIN
    -- 1. Input Validation
    IF p_nonce_hash IS NULL OR length(btrim(p_nonce_hash)) < 16 THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'INVALID_NONCE_HASH',
            'errorMessage', 'Cryptographic nonce hash is required (min length 16).'
        );
    END IF;

    IF p_expires_at <= v_now THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'EXPIRED_SESSION_NONCE',
            'errorMessage', 'Session authorization nonce has already expired.'
        );
    END IF;

    -- 2. Check if already consumed (Replay Detection)
    SELECT * INTO v_existing
    FROM public.telecom_session_nonces
    WHERE nonce_hash = p_nonce_hash;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'SESSION_NONCE_REPLAY_DETECTED',
            'errorMessage', 'Privileged session nonce has already been consumed (replay prohibited).'
        );
    END IF;

    -- 3. Atomic Insert with Conflict Protection
    BEGIN
        INSERT INTO public.telecom_session_nonces (
            nonce_hash,
            organization_id,
            operation,
            consumed_at,
            expires_at
        ) VALUES (
            p_nonce_hash,
            p_organization_id,
            p_operation,
            v_now,
            p_expires_at
        );
    EXCEPTION WHEN unique_violation THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'SESSION_NONCE_REPLAY_DETECTED',
            'errorMessage', 'Privileged session nonce consumed concurrently by another instance.'
        );
    END;

    -- 4. Bounded passive cleanup: Prune nonces expired over 7 days ago
    DELETE FROM public.telecom_session_nonces
    WHERE expires_at < (v_now - INTERVAL '7 days');

    RETURN jsonb_build_object(
        'allowed', true,
        'consumedAt', v_now
    );
END;
$$;

REVOKE ALL ON FUNCTION public.consume_telecom_session_nonce FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_telecom_session_nonce TO service_role;


-- ============================================================================
-- 4. M-02: ATOMIC PROVIDER DISPATCH TRANSITION RPC
-- Single atomic DB state change from pre-dispatch state to PROVIDER_DISPATCHED
-- ============================================================================
CREATE OR REPLACE FUNCTION public.transition_purchase_op_to_dispatched(
    p_operation_id UUID,
    p_organization_id UUID,
    p_provider_account_id UUID,
    p_quote_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_op public.provider_number_operations;
    v_now TIMESTAMPTZ := now();
BEGIN
    -- 1. Row Lock with Tenant Predicate
    SELECT * INTO v_op
    FROM public.provider_number_operations
    WHERE id = p_operation_id AND organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'OPERATION_NOT_FOUND: Purchase operation % for organization % not found.',
            p_operation_id, p_organization_id USING ERRCODE = '22000';
    END IF;

    -- 2. Concurrency & Expected-Current-State Semantics:
    -- Cannot dispatch from terminal or already dispatched states
    IF v_op.canonical_state = 'PROVIDER_DISPATCHED' THEN
        RAISE EXCEPTION 'ALREADY_DISPATCHED: Operation % has already been dispatched to carrier.',
            p_operation_id USING ERRCODE = '23505';
    END IF;

    IF v_op.canonical_state IN ('CONFIRMED', 'PROVIDER_OUTCOME_UNKNOWN', 'RECONCILIATION_REQUIRED', 'MANUAL_REVIEW_REQUIRED') THEN
        RAISE EXCEPTION 'INVALID_DISPATCH_TRANSITION: Operation % is already in post-dispatch state %.',
            p_operation_id, v_op.canonical_state USING ERRCODE = '22000';
    END IF;

    IF v_op.canonical_state = 'FAILED' THEN
        RAISE EXCEPTION 'OPERATION_FAILED: Operation % has already failed and cannot be dispatched.',
            p_operation_id USING ERRCODE = '22000';
    END IF;

    -- 3. Atomic Single Transition directly to PROVIDER_DISPATCHED
    UPDATE public.provider_number_operations
    SET canonical_state = 'PROVIDER_DISPATCHED',
        status = 'in_progress',
        provider_account_id = p_provider_account_id,
        quote_id = COALESCE(p_quote_id, quote_id),
        started_at = COALESCE(started_at, v_now),
        dispatched_at = v_now,
        attempt_count = COALESCE(attempt_count, 0) + 1,
        updated_at = v_now
    WHERE id = p_operation_id AND organization_id = p_organization_id
    RETURNING * INTO v_op;

    RETURN to_jsonb(v_op);
END;
$$;

REVOKE ALL ON FUNCTION public.transition_purchase_op_to_dispatched FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_purchase_op_to_dispatched TO service_role;


-- ============================================================================
-- 5. SEC-7B: DISTRIBUTED NUMBER-PURCHASE VELOCITY DEFENSE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.telecom_number_purchase_velocity_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    phone_number_e164 TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mkt_purch_vel_org_created
ON public.telecom_number_purchase_velocity_events(organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mkt_purch_vel_user_created
ON public.telecom_number_purchase_velocity_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mkt_purch_vel_created_at
ON public.telecom_number_purchase_velocity_events(created_at);

ALTER TABLE public.telecom_number_purchase_velocity_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.telecom_number_purchase_velocity_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.telecom_number_purchase_velocity_events TO service_role;

-- Atomic Check-and-Consume Function for Number Purchase Velocity
CREATE OR REPLACE FUNCTION public.check_and_consume_number_purchase_velocity(
    p_organization_id UUID,
    p_user_id UUID,
    p_phone_number_e164 TEXT,
    p_idempotency_key TEXT,
    p_user_limit INT DEFAULT 3,
    p_org_limit INT DEFAULT 5,
    p_window_seconds INT DEFAULT 600,
    p_consume BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := now();
    v_window_interval INTERVAL;
    v_window_start TIMESTAMPTZ;
    v_lock_key_org BIGINT;
    v_lock_key_user BIGINT;
    v_user_count INT;
    v_org_count INT;
    v_inflight_count INT;
    v_oldest_user_ts TIMESTAMPTZ;
    v_oldest_org_ts TIMESTAMPTZ;
    v_retry_after INT := 600;
BEGIN
    -- 1. Input Validation
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'organization_id is required for purchase velocity enforcement';
    END IF;
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'user_id is required for purchase velocity enforcement';
    END IF;

    IF p_user_limit <= 0 OR p_user_limit > 100 THEN
        p_user_limit := 3;
    END IF;
    IF p_org_limit <= 0 OR p_org_limit > 500 THEN
        p_org_limit := 5;
    END IF;
    IF p_window_seconds <= 0 OR p_window_seconds > 86400 THEN
        p_window_seconds := 600;
    END IF;

    v_window_interval := (p_window_seconds || ' seconds')::interval;
    v_window_start := v_now - v_window_interval;

    -- 2. Tenant Membership Verification: User MUST belong to organization
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_user_id AND organization_id = p_organization_id
    ) THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'limitType', 'unauthorized_tenant_membership',
            'reason', format('User %s does not belong to organization %s or profile not found.', p_user_id, p_organization_id)
        );
    END IF;

    -- 3. Deterministic Transaction Advisory Locks: org lock FIRST, user lock SECOND (prevent deadlock)
    IF p_consume THEN
        v_lock_key_org := ('x' || substr(md5('purch_org:' || p_organization_id::text), 1, 16))::bit(64)::bigint;
        v_lock_key_user := ('x' || substr(md5('purch_user:' || p_user_id::text), 1, 16))::bit(64)::bigint;
        PERFORM pg_advisory_xact_lock(v_lock_key_org);
        PERFORM pg_advisory_xact_lock(v_lock_key_user);
    END IF;

    -- 4. In-Flight Concurrency Check: Active In-Flight Purchase Locks for the Organization
    SELECT count(*) INTO v_inflight_count
    FROM public.provider_number_operations
    WHERE organization_id = p_organization_id
      AND operation_type = 'purchase_number'
      AND status IN ('pending', 'in_progress');

    IF v_inflight_count >= 1 THEN
        -- Allow if replaying the exact same idempotency_key (safe retry)
        IF p_idempotency_key IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.provider_number_operations
            WHERE organization_id = p_organization_id
              AND idempotency_key = p_idempotency_key
        ) THEN
            -- Safe idempotent replay, continue through velocity check
            NULL;
        ELSE
            RETURN jsonb_build_object(
                'allowed', false,
                'limitType', 'concurrent_inflight_purchase_limit',
                'currentRate', v_inflight_count,
                'limitThreshold', 1,
                'retryAfterSeconds', 15,
                'reason', 'Another phone number purchase is currently in-flight for this organization. Please wait for it to complete.'
            );
        END IF;
    END IF;

    -- 5. User Purchase Velocity Check (default: 3 / 10m)
    SELECT count(*), min(created_at) INTO v_user_count, v_oldest_user_ts
    FROM public.telecom_number_purchase_velocity_events
    WHERE user_id = p_user_id
      AND created_at >= v_window_start;

    IF v_user_count >= p_user_limit THEN
        IF v_oldest_user_ts IS NOT NULL THEN
            v_retry_after := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_oldest_user_ts + v_window_interval - v_now)))::INT);
        END IF;

        RETURN jsonb_build_object(
            'allowed', false,
            'limitType', 'user_purchase_velocity_limit',
            'currentRate', v_user_count,
            'limitThreshold', p_user_limit,
            'retryAfterSeconds', v_retry_after,
            'reason', format('User purchase velocity limit exceeded (%s attempts in %s seconds). Retry in %s seconds.', v_user_count, p_window_seconds, v_retry_after)
        );
    END IF;

    -- 6. Organization Purchase Velocity Check (default: 5 / 10m)
    SELECT count(*), min(created_at) INTO v_org_count, v_oldest_org_ts
    FROM public.telecom_number_purchase_velocity_events
    WHERE organization_id = p_organization_id
      AND created_at >= v_window_start;

    IF v_org_count >= p_org_limit THEN
        IF v_oldest_org_ts IS NOT NULL THEN
            v_retry_after := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_oldest_org_ts + v_window_interval - v_now)))::INT);
        END IF;

        RETURN jsonb_build_object(
            'allowed', false,
            'limitType', 'org_purchase_velocity_limit',
            'currentRate', v_org_count,
            'limitThreshold', p_org_limit,
            'retryAfterSeconds', v_retry_after,
            'reason', format('Organization purchase velocity limit exceeded (%s attempts in %s seconds). Retry in %s seconds.', v_org_count, p_window_seconds, v_retry_after)
        );
    END IF;

    -- 7. Consume Token / Record Event
    IF p_consume THEN
        INSERT INTO public.telecom_number_purchase_velocity_events (
            organization_id,
            user_id,
            phone_number_e164,
            idempotency_key,
            created_at
        ) VALUES (
            p_organization_id,
            p_user_id,
            COALESCE(p_phone_number_e164, 'unknown'),
            COALESCE(p_idempotency_key, 'unknown'),
            v_now
        );
    END IF;

    RETURN jsonb_build_object(
        'allowed', true,
        'limitType', 'within_limits',
        'currentRate', v_user_count + CASE WHEN p_consume THEN 1 ELSE 0 END,
        'limitThreshold', p_user_limit,
        'retryAfterSeconds', 0,
        'reason', 'Purchase request velocity authorized.'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.check_and_consume_number_purchase_velocity FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_consume_number_purchase_velocity TO service_role;
