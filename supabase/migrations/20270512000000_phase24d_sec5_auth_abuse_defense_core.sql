-- ============================================================================
-- PHASE 24D.SEC-5: DISTRIBUTED AUTHENTICATION ABUSE DEFENSE CORE
-- ATOMIC POSTGRES LIMITER, MULTI-WINDOW COUNTERS, SPRAY SIGNALS & AUDIT EVENTS
-- LOCAL MIGRATION ONLY - DO NOT APPLY REMOTELY TO HOSTED SUPABASE
-- STATUS: LOCAL_MIGRATION_UNAPPLIED
-- ============================================================================

-- 1. Create Dedicated Isolated Schema
CREATE SCHEMA IF NOT EXISTS auth_security;

-- 2. Aggregate Abuse State / Counters Table
CREATE TABLE IF NOT EXISTS auth_security.auth_abuse_counters (
    id BIGSERIAL PRIMARY KEY,
    dimension TEXT NOT NULL CHECK (dimension IN ('SOURCE', 'ACCOUNT_TARGET', 'SOURCE_ACCOUNT_PAIR', 'RECOVERY_RECIPIENT', 'SIGNUP_SOURCE')),
    dimension_key TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('LOGIN', 'SIGNUP', 'PASSWORD_RECOVERY', 'OTP_REQUEST', 'OTP_VERIFY')),
    window_type TEXT NOT NULL CHECK (window_type IN ('SHORT', 'MEDIUM', 'LONG')),
    window_bucket TIMESTAMPTZ NOT NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    failure_count INT NOT NULL DEFAULT 0,
    success_count INT NOT NULL DEFAULT 0,
    first_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_auth_abuse_counters UNIQUE (dimension, dimension_key, action, window_type, window_bucket)
);

CREATE INDEX IF NOT EXISTS idx_auth_abuse_counters_lookup
ON auth_security.auth_abuse_counters (dimension, dimension_key, action, window_type, window_bucket DESC);

CREATE INDEX IF NOT EXISTS idx_auth_abuse_counters_retention
ON auth_security.auth_abuse_counters (window_bucket);

-- 3. Password-Spray / Target Diversity Tracking Table
CREATE TABLE IF NOT EXISTS auth_security.auth_spray_signals (
    id BIGSERIAL PRIMARY KEY,
    source_pseudonym TEXT NOT NULL,
    account_pseudonym TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('LOGIN', 'SIGNUP', 'PASSWORD_RECOVERY', 'OTP_REQUEST', 'OTP_VERIFY')),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempt_count INT NOT NULL DEFAULT 1,
    CONSTRAINT uq_auth_spray_source_target UNIQUE (source_pseudonym, account_pseudonym, action)
);

CREATE INDEX IF NOT EXISTS idx_auth_spray_diversity
ON auth_security.auth_spray_signals (source_pseudonym, action, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_spray_retention
ON auth_security.auth_spray_signals (last_seen_at);

-- 4. Sanitized Security Audit Events Table
CREATE TABLE IF NOT EXISTS auth_security.auth_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL CHECK (event_type IN (
        'AUTH_LOGIN_FAILED',
        'AUTH_LOGIN_CHALLENGE_REQUIRED',
        'AUTH_LOGIN_THROTTLED',
        'AUTH_PASSWORD_SPRAY_SIGNAL',
        'AUTH_CREDENTIAL_STUFFING_SIGNAL',
        'AUTH_RECOVERY_REQUESTED',
        'AUTH_RECOVERY_THROTTLED',
        'AUTH_SIGNUP_THROTTLED',
        'AUTH_PASSWORD_CHANGED',
        'AUTH_SESSION_REVOKED',
        'AUTH_MFA_CHANGED'
    )),
    source_pseudonym TEXT NOT NULL,
    account_pseudonym TEXT NULL,
    action TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('ALLOW', 'CHALLENGE', 'THROTTLE', 'DENY')),
    risk_state TEXT NOT NULL CHECK (risk_state IN ('NORMAL', 'ELEVATED', 'CHALLENGE_REQUIRED', 'TEMPORARILY_THROTTLED')),
    reason TEXT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_event_type
ON auth_security.auth_audit_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_audit_source
ON auth_security.auth_audit_events (source_pseudonym, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_audit_account
ON auth_security.auth_audit_events (account_pseudonym, created_at DESC)
WHERE account_pseudonym IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_auth_audit_retention
ON auth_security.auth_audit_events (created_at);

-- 5. Strict Schema Isolation & Privileges (Least Privilege)
REVOKE ALL ON SCHEMA auth_security FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA auth_security TO service_role;

ALTER TABLE auth_security.auth_abuse_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_security.auth_spray_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_security.auth_audit_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE auth_security.auth_abuse_counters FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE auth_security.auth_spray_signals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE auth_security.auth_audit_events FROM PUBLIC, anon, authenticated;

-- Direct mutations restricted even from service_role; modifications occur strictly inside SECURITY DEFINER functions
REVOKE ALL ON TABLE auth_security.auth_abuse_counters FROM service_role;
REVOKE ALL ON TABLE auth_security.auth_spray_signals FROM service_role;
REVOKE ALL ON TABLE auth_security.auth_audit_events FROM service_role;

GRANT SELECT ON TABLE auth_security.auth_abuse_counters TO service_role;
GRANT SELECT ON TABLE auth_security.auth_spray_signals TO service_role;
GRANT SELECT, INSERT ON TABLE auth_security.auth_audit_events TO service_role;

-- 6. Authoritative Atomic Attempt Evaluation Function
CREATE OR REPLACE FUNCTION auth_security.record_and_evaluate_auth_attempt(
    p_source_pseudonym TEXT,
    p_account_pseudonym TEXT,
    p_action TEXT,
    p_policy JSONB,
    p_outcome TEXT DEFAULT 'ATTEMPT',
    p_now TIMESTAMPTZ DEFAULT now(),
    p_pair_pseudonym TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth_security, pg_temp
AS $$
DECLARE
    v_pair_pseudonym TEXT := NULL;
    v_short_window_sec INT;
    v_med_window_sec INT;
    v_long_window_sec INT;
    v_spray_window_sec INT;
    
    -- Thresholds from policy
    v_source_short_limit INT;
    v_source_med_limit INT;
    v_source_long_limit INT;
    v_account_short_challenge INT;
    v_account_short_throttle INT;
    v_account_med_limit INT;
    v_account_long_limit INT;
    v_pair_short_limit INT;
    v_pair_med_limit INT;
    v_spray_diversity_limit INT;

    -- Evaluated Counts
    v_source_short_attempts INT := 0;
    v_source_med_attempts INT := 0;
    v_source_long_attempts INT := 0;
    v_account_short_attempts INT := 0;
    v_account_med_attempts INT := 0;
    v_account_long_attempts INT := 0;
    v_pair_short_attempts INT := 0;
    v_pair_med_attempts INT := 0;
    v_spray_diversity_count INT := 0;

    -- Progressive State Decision
    v_decision TEXT := 'ALLOW';
    v_state TEXT := 'NORMAL';
    v_reason TEXT := 'within_limits';
    v_retry_after INT := 0;

    -- Loop variables for dimension updates
    r_dim RECORD;
    v_win_sec INT;
    v_cur_bucket TIMESTAMPTZ;
    v_prev_bucket TIMESTAMPTZ;
    v_cur_attempts INT;
    v_cur_failures INT;
    v_cur_successes INT;
    v_prev_attempts INT;
    v_weight NUMERIC;
    v_effective_attempts INT;
BEGIN
    -- 1. Input Validation
    IF p_source_pseudonym IS NULL OR p_source_pseudonym !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Invalid source_pseudonym: must be 64-character lowercase hex string';
    END IF;

    IF p_account_pseudonym IS NOT NULL AND p_account_pseudonym !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Invalid account_pseudonym: must be 64-character lowercase hex string';
    END IF;

    IF p_action NOT IN ('LOGIN', 'SIGNUP', 'PASSWORD_RECOVERY', 'OTP_REQUEST', 'OTP_VERIFY') THEN
        RAISE EXCEPTION 'Invalid action: %', p_action;
    END IF;

    IF p_outcome NOT IN ('ATTEMPT', 'FAILURE', 'SUCCESS') THEN
        RAISE EXCEPTION 'Invalid outcome: %', p_outcome;
    END IF;

    IF p_policy IS NULL THEN
        RAISE EXCEPTION 'Policy configuration is required for evaluation';
    END IF;

    -- 2. Extract Policy Parameters
    v_short_window_sec := COALESCE((p_policy->>'short_window_seconds')::int, 60);
    v_med_window_sec := COALESCE((p_policy->>'medium_window_seconds')::int, 900);
    v_long_window_sec := COALESCE((p_policy->>'long_window_seconds')::int, 86400);
    v_spray_window_sec := COALESCE((p_policy->>'spray_window_seconds')::int, 900);

    v_source_short_limit := COALESCE((p_policy->>'source_short_limit')::int, 2147483647);
    v_source_med_limit := COALESCE((p_policy->>'source_medium_limit')::int, 2147483647);
    v_source_long_limit := COALESCE((p_policy->>'source_long_limit')::int, 2147483647);

    v_account_short_challenge := COALESCE((p_policy->>'account_short_challenge_limit')::int, 2147483647);
    v_account_short_throttle := COALESCE((p_policy->>'account_short_throttle_limit')::int, 2147483647);
    v_account_med_limit := COALESCE((p_policy->>'account_medium_limit')::int, 2147483647);
    v_account_long_limit := COALESCE((p_policy->>'account_long_limit')::int, 2147483647);

    v_pair_short_limit := COALESCE((p_policy->>'pair_short_limit')::int, 2147483647);
    v_pair_med_limit := COALESCE((p_policy->>'pair_medium_limit')::int, 2147483647);

    v_spray_diversity_limit := COALESCE((p_policy->>'spray_diversity_limit')::int, 2147483647);

    -- 3. Assign or Compute Deterministic Pair Key if Account Target is Present
    IF p_pair_pseudonym IS NOT NULL THEN
        v_pair_pseudonym := p_pair_pseudonym;
    ELSIF p_account_pseudonym IS NOT NULL THEN
        v_pair_pseudonym := encode(sha256((p_source_pseudonym || ':' || p_account_pseudonym)::bytea), 'hex');
    END IF;

    -- 4. Atomic Multi-Window Dimension Updates with STRICT LEXICOGRAPHICAL LOCK ORDER
    -- Order: ACCOUNT_TARGET -> SOURCE -> SOURCE_ACCOUNT_PAIR
    -- Guarantees zero deadlock across concurrent transactions updating overlapping dimensions.
    FOR r_dim IN
        SELECT dim, d_key, win_type,
               CASE win_type
                   WHEN 'SHORT' THEN v_short_window_sec
                   WHEN 'MEDIUM' THEN v_med_window_sec
                   WHEN 'LONG' THEN v_long_window_sec
               END AS win_sec
        FROM (
            SELECT 'ACCOUNT_TARGET' AS dim, p_account_pseudonym AS d_key WHERE p_account_pseudonym IS NOT NULL
            UNION ALL
            SELECT 'SOURCE' AS dim, p_source_pseudonym AS d_key
            UNION ALL
            SELECT 'SOURCE_ACCOUNT_PAIR' AS dim, v_pair_pseudonym AS d_key WHERE v_pair_pseudonym IS NOT NULL
        ) d
        CROSS JOIN (
            SELECT 'SHORT' AS win_type
            UNION ALL
            SELECT 'MEDIUM' AS win_type
            UNION ALL
            SELECT 'LONG' AS win_type
        ) w
        ORDER BY dim ASC, d_key ASC, win_type ASC
    LOOP
        v_win_sec := r_dim.win_sec;
        v_cur_bucket := to_timestamp(floor(extract(epoch from p_now) / v_win_sec) * v_win_sec);
        v_prev_bucket := v_cur_bucket - (v_win_sec || ' seconds')::interval;

        -- Atomic UPSERT on bucketed counter row
        INSERT INTO auth_security.auth_abuse_counters (
            dimension, dimension_key, action, window_type, window_bucket,
            attempt_count, failure_count, success_count, first_attempt_at, last_attempt_at, updated_at
        ) VALUES (
            r_dim.dim, r_dim.d_key, p_action, r_dim.win_type, v_cur_bucket,
            1, -- Every attempt (evaluated, failed, or successful) counts as an attempt
            CASE WHEN p_outcome = 'FAILURE' THEN 1 ELSE 0 END,
            CASE WHEN p_outcome = 'SUCCESS' THEN 1 ELSE 0 END,
            p_now, p_now, p_now
        )
        ON CONFLICT (dimension, dimension_key, action, window_type, window_bucket)
        DO UPDATE SET
            attempt_count = auth_abuse_counters.attempt_count + EXCLUDED.attempt_count,
            failure_count = auth_abuse_counters.failure_count + EXCLUDED.failure_count,
            success_count = auth_abuse_counters.success_count + EXCLUDED.success_count,
            last_attempt_at = EXCLUDED.last_attempt_at,
            updated_at = EXCLUDED.updated_at
        RETURNING attempt_count, failure_count, success_count
        INTO v_cur_attempts, v_cur_failures, v_cur_successes;

        -- Query previous bucket to compute weighted sliding-window estimate
        SELECT attempt_count INTO v_prev_attempts
        FROM auth_security.auth_abuse_counters
        WHERE dimension = r_dim.dim
          AND dimension_key = r_dim.d_key
          AND action = p_action
          AND window_type = r_dim.win_type
          AND window_bucket = v_prev_bucket;

        v_weight := extract(epoch from (p_now - v_cur_bucket)) / v_win_sec;
        v_effective_attempts := v_cur_attempts + floor(COALESCE(v_prev_attempts, 0) * (1.0 - v_weight));

        -- Assign to appropriate dimension / window counter variable
        IF r_dim.dim = 'SOURCE' THEN
            IF r_dim.win_type = 'SHORT' THEN v_source_short_attempts := v_effective_attempts;
            ELSIF r_dim.win_type = 'MEDIUM' THEN v_source_med_attempts := v_effective_attempts;
            ELSIF r_dim.win_type = 'LONG' THEN v_source_long_attempts := v_effective_attempts;
            END IF;
        ELSIF r_dim.dim = 'ACCOUNT_TARGET' THEN
            IF r_dim.win_type = 'SHORT' THEN v_account_short_attempts := v_effective_attempts;
            ELSIF r_dim.win_type = 'MEDIUM' THEN v_account_med_attempts := v_effective_attempts;
            ELSIF r_dim.win_type = 'LONG' THEN v_account_long_attempts := v_effective_attempts;
            END IF;
        ELSIF r_dim.dim = 'SOURCE_ACCOUNT_PAIR' THEN
            IF r_dim.win_type = 'SHORT' THEN v_pair_short_attempts := v_effective_attempts;
            ELSIF r_dim.win_type = 'MEDIUM' THEN v_pair_med_attempts := v_effective_attempts;
            END IF;
        END IF;
    END LOOP;

    -- 5. Spray Tracking (Target Diversity per Source)
    -- Executed while holding the SOURCE row lock, serializing concurrent spray transactions from the same source
    IF p_account_pseudonym IS NOT NULL AND p_outcome IN ('ATTEMPT', 'FAILURE') THEN
        INSERT INTO auth_security.auth_spray_signals (
            source_pseudonym, account_pseudonym, action, first_seen_at, last_seen_at, attempt_count
        ) VALUES (
            p_source_pseudonym, p_account_pseudonym, p_action, p_now, p_now, 1
        )
        ON CONFLICT (source_pseudonym, account_pseudonym, action)
        DO UPDATE SET
            last_seen_at = EXCLUDED.last_seen_at,
            attempt_count = auth_spray_signals.attempt_count + 1;

        SELECT count(DISTINCT account_pseudonym)
        INTO v_spray_diversity_count
        FROM auth_security.auth_spray_signals
        WHERE source_pseudonym = p_source_pseudonym
          AND action = p_action
          AND last_seen_at >= (p_now - (v_spray_window_sec || ' seconds')::interval);
    END IF;

    -- 6. Progressive Decision & Escalation Machinery
    -- Note: Successful auth does not blindly clear history, but allows login if within limits.
    
    -- Dimension check A: Source-Account Pair (attacker guessing on victim account)
    IF v_pair_short_attempts >= v_pair_short_limit THEN
        v_decision := 'THROTTLE';
        v_state := 'TEMPORARILY_THROTTLED';
        v_reason := 'pair_short_limit_exceeded';
        v_retry_after := v_short_window_sec;
    -- Dimension check B: Source Velocity (attacker rotating targets from single IP)
    ELSIF v_source_short_attempts >= v_source_short_limit THEN
        v_decision := 'THROTTLE';
        v_state := 'TEMPORARILY_THROTTLED';
        v_reason := 'source_short_limit_exceeded';
        v_retry_after := v_short_window_sec;
    ELSIF v_source_med_attempts >= v_source_med_limit THEN
        v_decision := 'THROTTLE';
        v_state := 'TEMPORARILY_THROTTLED';
        v_reason := 'source_medium_limit_exceeded';
        v_retry_after := v_med_window_sec;
    -- Dimension check C: Password Spray Signal (single source targeting many distinct accounts)
    ELSIF v_spray_diversity_count >= v_spray_diversity_limit THEN
        v_decision := 'CHALLENGE';
        v_state := 'CHALLENGE_REQUIRED';
        v_reason := 'password_spray_detected';
    -- Dimension check D: Account Target Distributed Velocity (botnet targeting one account)
    -- Invariant AUTH-ABUSE-003: Never permanently lock victim account. Escalate to CHALLENGE or progressive THROTTLE.
    ELSIF v_account_short_attempts >= v_account_short_throttle THEN
        v_decision := 'THROTTLE';
        v_state := 'TEMPORARILY_THROTTLED';
        v_reason := 'account_short_throttle_exceeded';
        v_retry_after := v_short_window_sec;
    ELSIF v_account_short_attempts >= v_account_short_challenge THEN
        v_decision := 'CHALLENGE';
        v_state := 'CHALLENGE_REQUIRED';
        v_reason := 'account_short_challenge_exceeded';
    ELSIF v_account_med_attempts >= v_account_med_limit THEN
        v_decision := 'CHALLENGE';
        v_state := 'CHALLENGE_REQUIRED';
        v_reason := 'account_medium_challenge_exceeded';
    ELSE
        v_decision := 'ALLOW';
        v_state := 'NORMAL';
        v_reason := 'within_limits';
    END IF;

    -- 7. Audit Event Recording (Emitted on Escalations & Throttle Events)
    IF v_decision IN ('CHALLENGE', 'THROTTLE', 'DENY') THEN
        INSERT INTO auth_security.auth_audit_events (
            event_type, source_pseudonym, account_pseudonym, action, decision, risk_state, reason, metadata, created_at
        ) VALUES (
            CASE
                WHEN v_reason = 'password_spray_detected' THEN 'AUTH_PASSWORD_SPRAY_SIGNAL'
                WHEN v_decision = 'CHALLENGE' THEN 'AUTH_LOGIN_CHALLENGE_REQUIRED'
                WHEN v_decision = 'THROTTLE' THEN 'AUTH_LOGIN_THROTTLED'
                ELSE 'AUTH_LOGIN_THROTTLED'
            END,
            p_source_pseudonym,
            p_account_pseudonym,
            p_action,
            v_decision,
            v_state,
            v_reason,
            jsonb_build_object(
                'spray_count', v_spray_diversity_count,
                'source_short', v_source_short_attempts,
                'source_med', v_source_med_attempts,
                'account_short', v_account_short_attempts,
                'account_med', v_account_med_attempts,
                'pair_short', v_pair_short_attempts,
                'retry_after', v_retry_after
            ),
            p_now
        );
    END IF;

    -- 8. Return Comprehensive Result Payload
    RETURN jsonb_build_object(
        'decision', v_decision,
        'state', v_state,
        'reason', v_reason,
        'retry_after_seconds', v_retry_after,
        'counters', jsonb_build_object(
            'source_short', v_source_short_attempts,
            'source_med', v_source_med_attempts,
            'source_long', v_source_long_attempts,
            'account_short', v_account_short_attempts,
            'account_med', v_account_med_attempts,
            'account_long', v_account_long_attempts,
            'pair_short', v_pair_short_attempts,
            'pair_med', v_pair_med_attempts,
            'spray_diversity', v_spray_diversity_count
        )
    );
END;
$$;

-- Revoke execute from PUBLIC and grant strictly to service_role
REVOKE ALL ON FUNCTION auth_security.record_and_evaluate_auth_attempt(TEXT, TEXT, TEXT, JSONB, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION auth_security.record_and_evaluate_auth_attempt(TEXT, TEXT, TEXT, JSONB, TEXT, TIMESTAMPTZ, TEXT) TO service_role;

-- 7. Policy-Driven Retention Cleanup Function
CREATE OR REPLACE FUNCTION auth_security.cleanup_auth_abuse_records(
    p_counter_retention INTERVAL,
    p_spray_retention INTERVAL,
    p_audit_retention INTERVAL,
    p_now TIMESTAMPTZ DEFAULT now()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth_security, pg_temp
AS $$
DECLARE
    v_counters_deleted INT;
    v_spray_deleted INT;
    v_audit_deleted INT;
BEGIN
    DELETE FROM auth_security.auth_abuse_counters
    WHERE window_bucket < (p_now - p_counter_retention);
    GET DIAGNOSTICS v_counters_deleted = ROW_COUNT;

    DELETE FROM auth_security.auth_spray_signals
    WHERE last_seen_at < (p_now - p_spray_retention);
    GET DIAGNOSTICS v_spray_deleted = ROW_COUNT;

    DELETE FROM auth_security.auth_audit_events
    WHERE created_at < (p_now - p_audit_retention);
    GET DIAGNOSTICS v_audit_deleted = ROW_COUNT;

    RETURN jsonb_build_object(
        'counters_deleted', v_counters_deleted,
        'spray_deleted', v_spray_deleted,
        'audit_deleted', v_audit_deleted
    );
END;
$$;

REVOKE ALL ON FUNCTION auth_security.cleanup_auth_abuse_records(INTERVAL, INTERVAL, INTERVAL, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION auth_security.cleanup_auth_abuse_records(INTERVAL, INTERVAL, INTERVAL, TIMESTAMPTZ) TO service_role;
