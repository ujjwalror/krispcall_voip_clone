-- ============================================================================
-- PHASE 24C / PHASE 24C.1: DISTRIBUTED TELECOM VELOCITY ENFORCEMENT
-- ADVERSARIAL HARDENING: IDEMPOTENCY / PRIVACY / LEAST PRIVILEGE / LOCK CERTIFICATION
-- LOCAL MIGRATION ONLY - DO NOT APPLY TO PRODUCTION
-- ============================================================================

-- 1. Create table for distributed velocity events (ephemeral anti-abuse ledger)
CREATE TABLE IF NOT EXISTS public.telecom_velocity_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    service_type TEXT NOT NULL CHECK (service_type IN ('voice_outbound', 'sms_outbound', 'mms_outbound')),
    destination_hash TEXT NULL,
    content_hash TEXT NULL,
    idempotency_key TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for rapid sliding-window evaluations
CREATE INDEX IF NOT EXISTS idx_telecom_vel_user_type_created
ON public.telecom_velocity_events(user_id, service_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telecom_vel_org_type_created
ON public.telecom_velocity_events(organization_id, service_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telecom_vel_user_msg_created
ON public.telecom_velocity_events(user_id, created_at DESC)
WHERE service_type IN ('sms_outbound', 'mms_outbound');

CREATE INDEX IF NOT EXISTS idx_telecom_vel_org_msg_created
ON public.telecom_velocity_events(organization_id, created_at DESC)
WHERE service_type IN ('sms_outbound', 'mms_outbound');

CREATE INDEX IF NOT EXISTS idx_telecom_vel_created_at
ON public.telecom_velocity_events(created_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_telecom_vel_idempotency
ON public.telecom_velocity_events(organization_id, user_id, service_type, idempotency_key)
WHERE idempotency_key IS NOT NULL;

-- 2. Security and Privileges: STRICT DATABASE LEAST PRIVILEGE
-- Deny ordinary tenants direct access; service_role has read-only access for diagnostics.
-- All mutations (INSERT/DELETE) occur STRICTLY within SECURITY DEFINER functions.
ALTER TABLE public.telecom_velocity_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.telecom_velocity_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.telecom_velocity_events FROM service_role;
GRANT SELECT ON TABLE public.telecom_velocity_events TO service_role;

-- 3. Atomic Check-and-Consume Function (Hardened for Phase 24C.1)
CREATE OR REPLACE FUNCTION public.check_and_consume_telecom_velocity(
    p_organization_id UUID,
    p_user_id UUID,
    p_service_type TEXT,
    p_destination_hash TEXT DEFAULT NULL,
    p_content_hash TEXT DEFAULT NULL,
    p_idempotency_key TEXT DEFAULT NULL,
    p_consume BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := now();
    v_lock_key_org BIGINT;
    v_lock_key_user BIGINT;
    v_existing_id UUID;
    v_existing_dest_hash TEXT;
    v_existing_content_hash TEXT;
    v_existing_created_at TIMESTAMPTZ;
    v_event_id UUID;
    
    -- Voice Thresholds (Preserving verified current code constants)
    c_user_voice_min CONSTANT INT := 10;
    c_user_voice_hr CONSTANT INT := 60;
    c_org_voice_min CONSTANT INT := 30;
    c_org_voice_hr CONSTANT INT := 200;
    c_diversity_5min CONSTANT INT := 8;

    -- Messaging Thresholds (Preserving verified current code constants)
    c_user_sms_min CONSTANT INT := 10;
    c_user_sms_hr CONSTANT INT := 100;
    c_org_sms_min CONSTANT INT := 60;
    c_org_sms_hr CONSTANT INT := 500;
    c_user_mms_min CONSTANT INT := 5;
    c_dup_content_1min CONSTANT INT := 3;

    -- Counters
    v_count INT;
    v_unique_count INT;
    v_already_present BOOLEAN;
BEGIN
    -- Input Validation & Bounds Checking (Phase 24C.1 Hardening)
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'organization_id is required for velocity enforcement';
    END IF;
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'user_id is required for velocity enforcement';
    END IF;
    IF p_service_type NOT IN ('voice_outbound', 'sms_outbound', 'mms_outbound') THEN
        RAISE EXCEPTION 'Invalid service_type: %', p_service_type;
    END IF;

    IF p_destination_hash IS NOT NULL AND length(p_destination_hash) > 128 THEN
        RAISE EXCEPTION 'p_destination_hash exceeds maximum allowed length of 128 characters';
    END IF;
    IF p_content_hash IS NOT NULL AND length(p_content_hash) > 128 THEN
        RAISE EXCEPTION 'p_content_hash exceeds maximum allowed length of 128 characters';
    END IF;
    IF p_idempotency_key IS NOT NULL AND length(p_idempotency_key) > 128 THEN
        RAISE EXCEPTION 'p_idempotency_key exceeds maximum allowed length of 128 characters';
    END IF;

    -- Tenant Membership Verification (Phase 24C.1): User MUST belong to organization
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
    -- Strict lock ordering: org lock FIRST, then user lock (mathematical deadlock prevention)
    IF p_consume THEN
        v_lock_key_org := ('x' || substr(md5('org:' || p_organization_id::text), 1, 16))::bit(64)::bigint;
        v_lock_key_user := ('x' || substr(md5('user:' || p_user_id::text), 1, 16))::bit(64)::bigint;
        PERFORM pg_advisory_xact_lock(v_lock_key_org);
        PERFORM pg_advisory_xact_lock(v_lock_key_user);
    END IF;

    -- 1. Idempotency Check Bound to Operation Identity (Phase 24C.1 Hardened)
    -- Searches any retained event for this key.
    -- Fails closed if the same key is reused with mismatched operation payload.
    IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
        SELECT id, destination_hash, content_hash, created_at
        INTO v_existing_id, v_existing_dest_hash, v_existing_content_hash, v_existing_created_at
        FROM public.telecom_velocity_events
        WHERE organization_id = p_organization_id
          AND user_id = p_user_id
          AND service_type = p_service_type
          AND idempotency_key = trim(p_idempotency_key)
        LIMIT 1;

        IF FOUND THEN
            -- Verify immutable operation fingerprint matches
            IF coalesce(v_existing_dest_hash, '') != coalesce(NULLIF(trim(p_destination_hash), ''), '') OR
               coalesce(v_existing_content_hash, '') != coalesce(NULLIF(trim(p_content_hash), ''), '') THEN
                RETURN jsonb_build_object(
                    'allowed', false,
                    'limitType', 'idempotency_key_collision',
                    'reason', 'Idempotency key collision: operation payload does not match original authorized operation.'
                );
            END IF;

            -- Evaluate replay window vs retention window
            IF v_existing_created_at >= (v_now - interval '1 hour') THEN
                RETURN jsonb_build_object(
                    'allowed', true,
                    'idempotencyReplayed', true,
                    'eventId', v_existing_id,
                    'createdAt', v_existing_created_at
                );
            ELSE
                -- Retained in database (< 2 hours) but past the 1-hour application replay window
                RETURN jsonb_build_object(
                    'allowed', false,
                    'limitType', 'idempotency_key_expired',
                    'reason', 'Idempotency key has expired. Please submit request with a fresh unique client operation identifier.'
                );
            END IF;
        END IF;
    END IF;

    -- 2. Voice Dimension Evaluations
    IF p_service_type = 'voice_outbound' THEN
        -- 2a. User Voice 1 Minute (10 calls/min)
        SELECT count(*) INTO v_count
        FROM public.telecom_velocity_events
        WHERE user_id = p_user_id
          AND service_type = 'voice_outbound'
          AND created_at >= (v_now - interval '1 minute');

        IF v_count >= c_user_voice_min THEN
            RETURN jsonb_build_object(
                'allowed', false,
                'limitType', 'user_call_velocity',
                'currentRate', v_count,
                'limitThreshold', c_user_voice_min,
                'retryAfterSeconds', 60,
                'reason', format('Exceeded user voice dialing velocity limit (%s/%s calls/min). Rapid dialing throttled.', v_count, c_user_voice_min)
            );
        END IF;

        -- 2b. User Voice 1 Hour (60 calls/hr)
        SELECT count(*) INTO v_count
        FROM public.telecom_velocity_events
        WHERE user_id = p_user_id
          AND service_type = 'voice_outbound'
          AND created_at >= (v_now - interval '1 hour');

        IF v_count >= c_user_voice_hr THEN
            RETURN jsonb_build_object(
                'allowed', false,
                'limitType', 'user_call_velocity',
                'currentRate', v_count,
                'limitThreshold', c_user_voice_hr,
                'retryAfterSeconds', 300,
                'reason', format('Exceeded user hourly voice dialing limit (%s/%s calls/hr).', v_count, c_user_voice_hr)
            );
        END IF;

        -- 2c. Destination Diversity (Robocall / rapid dialing burst detection over rolling 5 minutes)
        IF p_destination_hash IS NOT NULL AND length(trim(p_destination_hash)) > 0 THEN
            SELECT count(DISTINCT destination_hash), bool_or(destination_hash = trim(p_destination_hash))
            INTO v_unique_count, v_already_present
            FROM public.telecom_velocity_events
            WHERE user_id = p_user_id
              AND service_type = 'voice_outbound'
              AND created_at >= (v_now - interval '5 minutes')
              AND destination_hash IS NOT NULL;

            IF v_unique_count >= c_diversity_5min AND NOT coalesce(v_already_present, false) THEN
                RETURN jsonb_build_object(
                    'allowed', false,
                    'limitType', 'destination_diversity',
                    'currentRate', v_unique_count,
                    'limitThreshold', c_diversity_5min,
                    'retryAfterSeconds', 120,
                    'reason', format('Exceeded destination diversity threshold (%s unique numbers in 5 minutes). Rapid automated dialing detected.', v_unique_count)
                );
            END IF;
        END IF;

        -- 2d. Org Voice 1 Minute (30 calls/min)
        SELECT count(*) INTO v_count
        FROM public.telecom_velocity_events
        WHERE organization_id = p_organization_id
          AND service_type = 'voice_outbound'
          AND created_at >= (v_now - interval '1 minute');

        IF v_count >= c_org_voice_min THEN
            RETURN jsonb_build_object(
                'allowed', false,
                'limitType', 'org_call_velocity',
                'currentRate', v_count,
                'limitThreshold', c_org_voice_min,
                'retryAfterSeconds', 60,
                'reason', format('Exceeded organization voice call velocity limit (%s/%s calls/min).', v_count, c_org_voice_min)
            );
        END IF;

        -- 2e. Org Voice 1 Hour (200 calls/hr)
        SELECT count(*) INTO v_count
        FROM public.telecom_velocity_events
        WHERE organization_id = p_organization_id
          AND service_type = 'voice_outbound'
          AND created_at >= (v_now - interval '1 hour');

        IF v_count >= c_org_voice_hr THEN
            RETURN jsonb_build_object(
                'allowed', false,
                'limitType', 'org_call_velocity',
                'currentRate', v_count,
                'limitThreshold', c_org_voice_hr,
                'retryAfterSeconds', 300,
                'reason', format('Exceeded organization hourly voice call limit (%s/%s calls/hr).', v_count, c_org_voice_hr)
            );
        END IF;

    -- 3. Messaging Dimension Evaluations (SMS and MMS)
    ELSIF p_service_type IN ('sms_outbound', 'mms_outbound') THEN
        -- 3a. User Messaging 1 Minute (10 msgs/min)
        SELECT count(*) INTO v_count
        FROM public.telecom_velocity_events
        WHERE user_id = p_user_id
          AND service_type IN ('sms_outbound', 'mms_outbound')
          AND created_at >= (v_now - interval '1 minute');

        IF v_count >= c_user_sms_min THEN
            RETURN jsonb_build_object(
                'allowed', false,
                'limitType', 'user_sms_velocity',
                'currentRate', v_count,
                'limitThreshold', c_user_sms_min,
                'retryAfterSeconds', 60,
                'reason', format('Exceeded user outbound messaging velocity limit (%s/%s msgs/min).', v_count, c_user_sms_min)
            );
        END IF;

        -- 3b. User Messaging 1 Hour (100 msgs/hr)
        SELECT count(*) INTO v_count
        FROM public.telecom_velocity_events
        WHERE user_id = p_user_id
          AND service_type IN ('sms_outbound', 'mms_outbound')
          AND created_at >= (v_now - interval '1 hour');

        IF v_count >= c_user_sms_hr THEN
            RETURN jsonb_build_object(
                'allowed', false,
                'limitType', 'user_sms_velocity',
                'currentRate', v_count,
                'limitThreshold', c_user_sms_hr,
                'retryAfterSeconds', 300,
                'reason', format('Exceeded user hourly messaging limit (%s/%s msgs/hr).', v_count, c_user_sms_hr)
            );
        END IF;

        -- 3c. MMS Burst Limit (5 MMS/min)
        IF p_service_type = 'mms_outbound' THEN
            SELECT count(*) INTO v_count
            FROM public.telecom_velocity_events
            WHERE user_id = p_user_id
              AND service_type = 'mms_outbound'
              AND created_at >= (v_now - interval '1 minute');

            IF v_count >= c_user_mms_min THEN
                RETURN jsonb_build_object(
                    'allowed', false,
                    'limitType', 'mms_burst',
                    'currentRate', v_count,
                    'limitThreshold', c_user_mms_min,
                    'retryAfterSeconds', 60,
                    'reason', format('Exceeded user outbound MMS velocity limit (%s/%s MMS/min).', v_count, c_user_mms_min)
                );
            END IF;
        END IF;

        -- 3d. Duplicate Content Hash (Spam blast detector - 3 identical in 1 minute)
        IF p_content_hash IS NOT NULL AND length(trim(p_content_hash)) > 0 THEN
            SELECT count(*) INTO v_count
            FROM public.telecom_velocity_events
            WHERE user_id = p_user_id
              AND service_type IN ('sms_outbound', 'mms_outbound')
              AND content_hash = trim(p_content_hash)
              AND created_at >= (v_now - interval '1 minute');

            IF v_count >= c_dup_content_1min THEN
                RETURN jsonb_build_object(
                    'allowed', false,
                    'limitType', 'spam_content_burst',
                    'currentRate', v_count,
                    'limitThreshold', c_dup_content_1min,
                    'retryAfterSeconds', 60,
                    'reason', format('Repeated identical message burst detected (%s identical messages in 1 minute). Message throttled as potential spam.', v_count)
                );
            END IF;
        END IF;

        -- 3e. Org Messaging 1 Minute (60 msgs/min)
        SELECT count(*) INTO v_count
        FROM public.telecom_velocity_events
        WHERE organization_id = p_organization_id
          AND service_type IN ('sms_outbound', 'mms_outbound')
          AND created_at >= (v_now - interval '1 minute');

        IF v_count >= c_org_sms_min THEN
            RETURN jsonb_build_object(
                'allowed', false,
                'limitType', 'org_sms_velocity',
                'currentRate', v_count,
                'limitThreshold', c_org_sms_min,
                'retryAfterSeconds', 60,
                'reason', format('Exceeded organization outbound messaging velocity limit (%s/%s msgs/min).', v_count, c_org_sms_min)
            );
        END IF;

        -- 3f. Org Messaging 1 Hour (500 msgs/hr)
        SELECT count(*) INTO v_count
        FROM public.telecom_velocity_events
        WHERE organization_id = p_organization_id
          AND service_type IN ('sms_outbound', 'mms_outbound')
          AND created_at >= (v_now - interval '1 hour');

        IF v_count >= c_org_sms_hr THEN
            RETURN jsonb_build_object(
                'allowed', false,
                'limitType', 'org_sms_velocity',
                'currentRate', v_count,
                'limitThreshold', c_org_sms_hr,
                'retryAfterSeconds', 300,
                'reason', format('Exceeded organization hourly messaging limit (%s/%s msgs/hr).', v_count, c_org_sms_hr)
            );
        END IF;
    END IF;

    -- 4. Capacity allowed! If p_consume = true, insert event row atomically
    IF p_consume THEN
        INSERT INTO public.telecom_velocity_events (
            organization_id,
            user_id,
            service_type,
            destination_hash,
            content_hash,
            idempotency_key,
            created_at
        ) VALUES (
            p_organization_id,
            p_user_id,
            p_service_type,
            NULLIF(trim(p_destination_hash), ''),
            NULLIF(trim(p_content_hash), ''),
            NULLIF(trim(p_idempotency_key), ''),
            v_now
        ) RETURNING id INTO v_event_id;

        RETURN jsonb_build_object(
            'allowed', true,
            'eventId', v_event_id,
            'createdAt', v_now
        );
    ELSE
        RETURN jsonb_build_object(
            'allowed', true,
            'simulatedOnly', true,
            'checkedAt', v_now
        );
    END IF;
END;
$$;

-- 4. Cleanup Function for Ephemeral Retention (older than horizon, default 2 hours)
CREATE OR REPLACE FUNCTION public.cleanup_expired_telecom_velocity_events(
    p_horizon_interval INTERVAL DEFAULT interval '2 hours'
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_deleted_count BIGINT;
BEGIN
    DELETE FROM public.telecom_velocity_events
    WHERE created_at < (now() - p_horizon_interval);
    
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    RETURN v_deleted_count;
END;
$$;

-- 5. Permissions: Narrowly Scoped Execution
REVOKE ALL ON FUNCTION public.check_and_consume_telecom_velocity(UUID, UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_consume_telecom_velocity(UUID, UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO service_role;

REVOKE ALL ON FUNCTION public.cleanup_expired_telecom_velocity_events(INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_telecom_velocity_events(INTERVAL) TO service_role;
