-- ============================================================================
-- PHASE 13.4.3C STAGE C.6D.4A: DURABLE TWILIO VOICE PRICING SYNC ENGINE
-- Isolated Forward-Only Migration (Remediated for Stage C.6D.4A Audit)
-- DO NOT APPLY REMOTELY AUTOMATICALLY — USER MANDATED MANUAL SQL REVIEW
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Atomic Versioned Wholesale Pricing Cache Upsert Function
-- Guarantees concurrency safety via advisory xact locking, out-of-order observation
-- protection, version preservation, freshness window validation, and idempotency.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_provider_voice_pricing_record_atomic(
    p_provider_account_id TEXT DEFAULT 'default',
    p_provider_key TEXT DEFAULT 'twilio',
    p_service_type TEXT DEFAULT 'voice_outbound',
    p_direction TEXT DEFAULT 'outbound',
    p_iso_country VARCHAR(2) DEFAULT 'US',
    p_destination_prefix TEXT DEFAULT '*',
    p_origination_prefix TEXT DEFAULT '*',
    p_number_type TEXT DEFAULT NULL,
    p_currency VARCHAR(3) DEFAULT 'USD',
    p_current_price_micro BIGINT DEFAULT 0,
    p_base_price_micro BIGINT DEFAULT NULL,
    p_price_unit TEXT DEFAULT 'minute',
    p_billing_increment_seconds INTEGER DEFAULT 60,
    p_min_chargeable_units INTEGER DEFAULT 1,
    p_fetched_at TIMESTAMPTZ DEFAULT now(),
    p_soft_stale_at TIMESTAMPTZ DEFAULT now(),
    p_hard_expires_at TIMESTAMPTZ DEFAULT now(),
    p_source_api_version TEXT DEFAULT 'v2',
    p_pricing_fingerprint TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_account TEXT := COALESCE(NULLIF(TRIM(p_provider_account_id), ''), 'default');
    v_clean_provider TEXT := LOWER(COALESCE(NULLIF(TRIM(p_provider_key), ''), 'twilio'));
    v_clean_country VARCHAR(2) := UPPER(COALESCE(NULLIF(TRIM(p_iso_country), ''), 'US'));
    v_clean_dest TEXT := COALESCE(NULLIF(TRIM(p_destination_prefix), ''), '*');
    v_clean_orig TEXT := COALESCE(NULLIF(TRIM(p_origination_prefix), ''), '*');
    v_clean_num_type TEXT := NULLIF(TRIM(p_number_type), '');
    v_clean_currency VARCHAR(3) := UPPER(COALESCE(NULLIF(TRIM(p_currency), ''), 'USD'));

    v_existing_id UUID;
    v_existing_price BIGINT;
    v_existing_base BIGINT;
    v_existing_version INT;
    v_existing_fetched_at TIMESTAMPTZ;
    v_new_version INT;
BEGIN
    -- 1. Input validations
    IF p_current_price_micro < 0 THEN
        RAISE EXCEPTION 'INVALID_WHOLESALE_PRICE: current_price_micro cannot be negative (%)', p_current_price_micro;
    END IF;

    IF p_base_price_micro IS NOT NULL AND p_base_price_micro < 0 THEN
        RAISE EXCEPTION 'INVALID_BASE_PRICE: base_price_micro cannot be negative (%)', p_base_price_micro;
    END IF;

    IF p_fetched_at > p_soft_stale_at OR p_soft_stale_at > p_hard_expires_at THEN
        RAISE EXCEPTION 'INVALID_FRESHNESS_WINDOW: Timestamps must satisfy fetched_at <= soft_stale_at <= hard_expires_at';
    END IF;

    -- 2. Deterministic Transaction Advisory Lock on Complete Pricing Key
    -- Prevents first-insert concurrency race conditions between parallel sync workers
    PERFORM pg_advisory_xact_lock(
        hashtext('pricing_key:' || v_clean_account || ':' || v_clean_provider || ':' || p_service_type || ':' || p_direction || ':' || v_clean_country || ':' || v_clean_dest || ':' || v_clean_orig || ':' || COALESCE(v_clean_num_type, 'any'))
    );

    -- 3. Lock active pricing record for complete pricing key (if exists)
    SELECT id, current_price_micro, base_price_micro, version, fetched_at
    INTO v_existing_id, v_existing_price, v_existing_base, v_existing_version, v_existing_fetched_at
    FROM public.provider_voice_pricing_cache
    WHERE provider_account_id = v_clean_account
      AND provider_key = v_clean_provider
      AND service_type = p_service_type
      AND direction = p_direction
      AND iso_country = v_clean_country
      AND destination_prefix = v_clean_dest
      AND COALESCE(origination_prefix, '*') = v_clean_orig
      AND COALESCE(number_type, 'any') = COALESCE(v_clean_num_type, 'any')
      AND is_active = true
    FOR UPDATE;

    IF FOUND THEN
        -- Out-of-Order Provider Observation Protection:
        -- If active record was fetched from a NEWER provider observation (fetched_at > p_fetched_at), ignore older observation.
        IF v_existing_fetched_at > p_fetched_at THEN
            RETURN jsonb_build_object(
                'status', 'out_of_order_skipped',
                'record_id', v_existing_id,
                'version', v_existing_version,
                'price_changed', false,
                'reason', 'Active record is newer than input observation'
            );
        END IF;

        -- Case A: Idempotent Refresh (Price is unchanged)
        IF v_existing_price = p_current_price_micro AND (v_existing_base IS NOT DISTINCT FROM p_base_price_micro) THEN
            UPDATE public.provider_voice_pricing_cache
            SET fetched_at = p_fetched_at,
                soft_stale_at = p_soft_stale_at,
                hard_expires_at = p_hard_expires_at,
                pricing_fingerprint = p_pricing_fingerprint,
                updated_at = now()
            WHERE id = v_existing_id;

            RETURN jsonb_build_object(
                'status', 'refreshed',
                'record_id', v_existing_id,
                'version', v_existing_version,
                'price_changed', false
            );
        ELSE
            -- Case B: Price Changed -> Versioning
            -- Mark previous active version inactive
            UPDATE public.provider_voice_pricing_cache
            SET is_active = false,
                updated_at = now()
            WHERE id = v_existing_id;

            v_new_version := v_existing_version + 1;

            -- Insert new active version
            INSERT INTO public.provider_voice_pricing_cache (
                provider_account_id,
                provider_key,
                service_type,
                direction,
                iso_country,
                destination_prefix,
                origination_prefix,
                number_type,
                currency,
                current_price_micro,
                base_price_micro,
                price_unit,
                billing_increment_seconds,
                min_chargeable_units,
                fetched_at,
                soft_stale_at,
                hard_expires_at,
                is_active,
                version,
                source_api_version,
                pricing_fingerprint
            ) VALUES (
                v_clean_account,
                v_clean_provider,
                p_service_type,
                p_direction,
                v_clean_country,
                v_clean_dest,
                v_clean_orig,
                v_clean_num_type,
                v_clean_currency,
                p_current_price_micro,
                p_base_price_micro,
                p_price_unit,
                p_billing_increment_seconds,
                p_min_chargeable_units,
                p_fetched_at,
                p_soft_stale_at,
                p_hard_expires_at,
                true,
                v_new_version,
                p_source_api_version,
                p_pricing_fingerprint
            );

            RETURN jsonb_build_object(
                'status', 'versioned',
                'version', v_new_version,
                'prior_version', v_existing_version,
                'price_changed', true
            );
        END IF;
    ELSE
        -- Case C: New Pricing Record Insertion
        INSERT INTO public.provider_voice_pricing_cache (
            provider_account_id,
            provider_key,
            service_type,
            direction,
            iso_country,
            destination_prefix,
            origination_prefix,
            number_type,
            currency,
            current_price_micro,
            base_price_micro,
            price_unit,
            billing_increment_seconds,
            min_chargeable_units,
            fetched_at,
            soft_stale_at,
            hard_expires_at,
            is_active,
            version,
            source_api_version,
            pricing_fingerprint
        ) VALUES (
            v_clean_account,
            v_clean_provider,
            p_service_type,
            p_direction,
            v_clean_country,
            v_clean_dest,
            v_clean_orig,
            v_clean_num_type,
            v_clean_currency,
            p_current_price_micro,
            p_base_price_micro,
            p_price_unit,
            p_billing_increment_seconds,
            p_min_chargeable_units,
            p_fetched_at,
            p_soft_stale_at,
            p_hard_expires_at,
            true,
            1,
            p_source_api_version,
            p_pricing_fingerprint
        );

        RETURN jsonb_build_object(
            'status', 'inserted',
            'version', 1,
            'price_changed', false
        );
    END IF;
END;
$$;

-- Security Grants: Strictly service_role internal
REVOKE ALL ON FUNCTION public.upsert_provider_voice_pricing_record_atomic FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_provider_voice_pricing_record_atomic TO service_role;


-- ----------------------------------------------------------------------------
-- 2. Scope-Isolated Authoritative Rate Retirement Function
-- Safely deactivates missing rates ONLY when an entire authoritative scope completes.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retire_missing_provider_voice_pricing_records_atomic(
    p_provider_account_id TEXT DEFAULT 'default',
    p_provider_key TEXT DEFAULT 'twilio',
    p_service_type TEXT DEFAULT 'voice_outbound',
    p_direction TEXT DEFAULT 'outbound',
    p_iso_country VARCHAR(2) DEFAULT 'US',
    p_observed_fingerprints TEXT[] DEFAULT '{}'::TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_account TEXT := COALESCE(NULLIF(TRIM(p_provider_account_id), ''), 'default');
    v_clean_provider TEXT := LOWER(COALESCE(NULLIF(TRIM(p_provider_key), ''), 'twilio'));
    v_clean_country VARCHAR(2) := UPPER(COALESCE(NULLIF(TRIM(p_iso_country), ''), 'US'));
    v_retired_count INT := 0;
BEGIN
    UPDATE public.provider_voice_pricing_cache
    SET is_active = false,
        updated_at = now()
    WHERE provider_account_id = v_clean_account
      AND provider_key = v_clean_provider
      AND service_type = p_service_type
      AND direction = p_direction
      AND iso_country = v_clean_country
      AND is_active = true
      AND (pricing_fingerprint IS NULL OR NOT (pricing_fingerprint = ANY(p_observed_fingerprints)));

    GET DIAGNOSTICS v_retired_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'success', true,
        'retired_count', v_retired_count
    );
END;
$$;

-- Security Grants: Strictly service_role internal
REVOKE ALL ON FUNCTION public.retire_missing_provider_voice_pricing_records_atomic FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retire_missing_provider_voice_pricing_records_atomic TO service_role;


-- ----------------------------------------------------------------------------
-- 3. Atomic Sync Run Logging Function
-- Durable audit log recording for synchronization runs with full diagnostic details
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_provider_voice_price_sync_run_atomic(
    p_provider_account_id TEXT DEFAULT 'default',
    p_provider_key TEXT DEFAULT 'twilio',
    p_iso_country VARCHAR(2) DEFAULT 'US',
    p_started_at TIMESTAMPTZ DEFAULT now(),
    p_completed_at TIMESTAMPTZ DEFAULT now(),
    p_status TEXT DEFAULT 'completed',
    p_records_observed INTEGER DEFAULT 0,
    p_records_inserted INTEGER DEFAULT 0,
    p_records_updated INTEGER DEFAULT 0,
    p_records_versioned INTEGER DEFAULT 0,
    p_error_classification TEXT DEFAULT NULL,
    p_sanitized_diagnostics JSONB DEFAULT '{}'::jsonb,
    p_fingerprint TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_sync_id UUID;
BEGIN
    INSERT INTO public.provider_voice_price_sync_runs (
        provider_account_id,
        provider_key,
        iso_country,
        started_at,
        completed_at,
        status,
        records_observed,
        records_inserted,
        records_updated,
        records_versioned,
        error_classification,
        sanitized_diagnostics,
        fingerprint
    ) VALUES (
        COALESCE(NULLIF(TRIM(p_provider_account_id), ''), 'default'),
        LOWER(COALESCE(NULLIF(TRIM(p_provider_key), ''), 'twilio')),
        UPPER(COALESCE(NULLIF(TRIM(p_iso_country), ''), 'US')),
        p_started_at,
        p_completed_at,
        p_status,
        p_records_observed,
        p_records_inserted,
        p_records_updated,
        p_records_versioned,
        p_error_classification,
        p_sanitized_diagnostics,
        p_fingerprint
    ) RETURNING id INTO v_sync_id;

    RETURN jsonb_build_object(
        'success', true,
        'sync_run_id', v_sync_id
    );
END;
$$;

-- Security Grants: Strictly service_role internal
REVOKE ALL ON FUNCTION public.record_provider_voice_price_sync_run_atomic FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_provider_voice_price_sync_run_atomic TO service_role;
