-- ============================================================================
-- PHASE 24D.SEC-7B.1: MARKETPLACE SEARCH DISTRIBUTED DEFENSE & SAFE CACHE
-- ATOMIC POSTGRES RATE LIMITER & DISTRIBUTED INVENTORY SEARCH CACHE
-- LOCAL & CI COMPLIANT MIGRATION
-- ============================================================================

-- 1. Create table for distributed marketplace search velocity events
CREATE TABLE IF NOT EXISTS public.marketplace_search_velocity_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for sliding-window evaluations
CREATE INDEX IF NOT EXISTS idx_mkt_search_vel_user_created
ON public.marketplace_search_velocity_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mkt_search_vel_org_created
ON public.marketplace_search_velocity_events(organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mkt_search_vel_created_at
ON public.marketplace_search_velocity_events(created_at);

-- 2. Security and Privileges: STRICT DATABASE LEAST PRIVILEGE
ALTER TABLE public.marketplace_search_velocity_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.marketplace_search_velocity_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.marketplace_search_velocity_events FROM service_role;
GRANT SELECT ON TABLE public.marketplace_search_velocity_events TO service_role;

-- 3. Create table for distributed inventory search cache (L2 cross-instance cache)
CREATE TABLE IF NOT EXISTS public.marketplace_inventory_search_cache (
    cache_key TEXT PRIMARY KEY,
    query_hash TEXT NOT NULL,
    numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
    has_more BOOLEAN NOT NULL DEFAULT false,
    continuation_token TEXT NULL,
    pricing_audit JSONB NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mkt_search_cache_expires
ON public.marketplace_inventory_search_cache(expires_at);

ALTER TABLE public.marketplace_inventory_search_cache ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.marketplace_inventory_search_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.marketplace_inventory_search_cache TO service_role;

-- 4. Atomic Check-and-Consume Function for Marketplace Search Velocity
CREATE OR REPLACE FUNCTION public.check_and_consume_marketplace_search_velocity(
    p_organization_id UUID,
    p_user_id UUID,
    p_user_limit INT DEFAULT 15,
    p_org_limit INT DEFAULT 60,
    p_window_seconds INT DEFAULT 60,
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
    v_oldest_user_ts TIMESTAMPTZ;
    v_retry_after INT := 60;
BEGIN
    -- Input Validation & Bounds Checking
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'organization_id is required for marketplace search velocity enforcement';
    END IF;
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'user_id is required for marketplace search velocity enforcement';
    END IF;

    IF p_user_limit <= 0 OR p_user_limit > 500 THEN
        p_user_limit := 15;
    END IF;
    IF p_org_limit <= 0 OR p_org_limit > 2000 THEN
        p_org_limit := 60;
    END IF;
    IF p_window_seconds <= 0 OR p_window_seconds > 3600 THEN
        p_window_seconds := 60;
    END IF;

    v_window_interval := (p_window_seconds || ' seconds')::interval;
    v_window_start := v_now - v_window_interval;

    -- Tenant Membership Verification: User MUST belong to organization
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_user_id AND organization_id = p_organization_id
    ) THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'limitType', 'unauthorized_tenant_membership',
            'reason', format('User %s does not belong to organization %s or does not exist.', p_user_id, p_organization_id)
        );
    END IF;

    -- Acquire deterministic transaction-scoped advisory locks to serialize concurrent checks
    -- Strict lock ordering: org lock FIRST, then user lock (deadlock prevention)
    IF p_consume THEN
        v_lock_key_org := ('x' || substr(md5('mkt_org:' || p_organization_id::text), 1, 16))::bit(64)::bigint;
        v_lock_key_user := ('x' || substr(md5('mkt_user:' || p_user_id::text), 1, 16))::bit(64)::bigint;
        PERFORM pg_advisory_xact_lock(v_lock_key_org);
        PERFORM pg_advisory_xact_lock(v_lock_key_user);
    END IF;

    -- 1. User Velocity Check (default: 15 searches / 60 seconds)
    SELECT count(*), min(created_at) INTO v_user_count, v_oldest_user_ts
    FROM public.marketplace_search_velocity_events
    WHERE user_id = p_user_id
      AND created_at >= v_window_start;

    IF v_user_count >= p_user_limit THEN
        IF v_oldest_user_ts IS NOT NULL THEN
            v_retry_after := GREATEST(1, CEIL(EXTRACT(EPOCH FROM ((v_oldest_user_ts + v_window_interval) - v_now)))::INT);
        END IF;

        RETURN jsonb_build_object(
            'allowed', false,
            'limitType', 'user_search_velocity',
            'currentRate', v_user_count,
            'limitThreshold', p_user_limit,
            'retryAfterSeconds', v_retry_after,
            'reason', format('Exceeded user marketplace search velocity limit (%s/%s searches per %ss). Rapid search throttled.', v_user_count, p_user_limit, p_window_seconds)
        );
    END IF;

    -- 2. Organization Velocity Check (default: 60 searches / 60 seconds)
    SELECT count(*) INTO v_org_count
    FROM public.marketplace_search_velocity_events
    WHERE organization_id = p_organization_id
      AND created_at >= v_window_start;

    IF v_org_count >= p_org_limit THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'limitType', 'org_search_velocity',
            'currentRate', v_org_count,
            'limitThreshold', p_org_limit,
            'retryAfterSeconds', 60,
            'reason', format('Exceeded organization marketplace search velocity limit (%s/%s searches per %ss). Organization search throttled.', v_org_count, p_org_limit, p_window_seconds)
        );
    END IF;

    -- 3. Consume Capacity
    IF p_consume THEN
        INSERT INTO public.marketplace_search_velocity_events (
            organization_id,
            user_id,
            created_at
        ) VALUES (
            p_organization_id,
            p_user_id,
            v_now
        );
    END IF;

    RETURN jsonb_build_object(
        'allowed', true,
        'currentRate', v_user_count + 1,
        'limitThreshold', p_user_limit
    );
END;
$$;

-- 5. Cleanup Function for Expired Search Events & Cache Records
CREATE OR REPLACE FUNCTION public.cleanup_expired_marketplace_search_events(
    p_horizon_interval INTERVAL DEFAULT interval '1 hour'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_deleted_events INT;
    v_deleted_cache INT;
BEGIN
    DELETE FROM public.marketplace_search_velocity_events
    WHERE created_at < (now() - p_horizon_interval);
    GET DIAGNOSTICS v_deleted_events = ROW_COUNT;

    DELETE FROM public.marketplace_inventory_search_cache
    WHERE expires_at <= now();
    GET DIAGNOSTICS v_deleted_cache = ROW_COUNT;

    RETURN jsonb_build_object(
        'deletedEvents', v_deleted_events,
        'deletedCacheRecords', v_deleted_cache
    );
END;
$$;

-- 6. Grants
REVOKE ALL ON FUNCTION public.check_and_consume_marketplace_search_velocity FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_consume_marketplace_search_velocity TO service_role;

REVOKE ALL ON FUNCTION public.cleanup_expired_marketplace_search_events FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_marketplace_search_events TO service_role;
