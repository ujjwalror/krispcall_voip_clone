-- ====================================================================
-- PUBLIC SAAS PHASE 13.4.1 — SUBSCRIPTION SYNC & WEBHOOK CLAIM MIGRATION (HARDENED)
-- Date: 2026-12-06
-- Provides:
-- 1. claim_stripe_webhook_event_for_processing RPC for atomic compare-and-set webhook claiming
-- 2. reconcile_stripe_subscription_atomic RPC for atomic FOR UPDATE subscription sync
-- LOCAL MIGRATION ONLY — SUBJECT TO MANUAL DBA REVIEW.
-- DO NOT EXECUTE REMOTELY AUTOMATICALLY.
-- ====================================================================

-- 1. RPC: Exclusive Webhook Event Claim
CREATE OR REPLACE FUNCTION public.claim_stripe_webhook_event_for_processing(
    p_provider_event_id TEXT,
    p_stale_threshold_seconds INT DEFAULT 300
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_event public.billing_webhook_events;
    v_now TIMESTAMPTZ := NOW();
    v_stale_cutoff TIMESTAMPTZ := NOW() - (p_stale_threshold_seconds || ' seconds')::INTERVAL;
BEGIN
    IF p_provider_event_id IS NULL OR pg_catalog.length(pg_catalog.btrim(p_provider_event_id)) = 0 THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_provider_event_id is required.';
    END IF;

    -- Lock row exclusively
    SELECT * INTO v_event
    FROM public.billing_webhook_events
    WHERE provider = 'stripe' AND provider_event_id = p_provider_event_id
    FOR UPDATE;

    IF v_event IS NULL THEN
        RETURN jsonb_build_object(
            'claimed', false,
            'reason', 'not_found'
        );
    END IF;

    IF v_event.status = 'completed' THEN
        RETURN jsonb_build_object(
            'claimed', false,
            'reason', 'completed',
            'event_id', v_event.id
        );
    END IF;

    -- If currently processing and NOT stale, another worker is actively running
    IF v_event.status = 'processing' AND v_event.processing_started_at IS NOT NULL AND v_event.processing_started_at > v_stale_cutoff THEN
        RETURN jsonb_build_object(
            'claimed', false,
            'reason', 'processing_in_parallel',
            'event_id', v_event.id
        );
    END IF;

    -- Claim event if status is pending, failed, or stale processing
    UPDATE public.billing_webhook_events
    SET status = 'processing',
        processing_started_at = v_now,
        attempt_count = COALESCE(attempt_count, 0) + 1
    WHERE id = v_event.id;

    RETURN jsonb_build_object(
        'claimed', true,
        'event_id', v_event.id,
        'attempt_count', COALESCE(v_event.attempt_count, 0) + 1
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_stripe_webhook_event_for_processing(TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_stripe_webhook_event_for_processing(TEXT, INT) TO service_role;


-- 2. RPC: Atomic Subscription Reconciliation
CREATE OR REPLACE FUNCTION public.reconcile_stripe_subscription_atomic(
    p_organization_id UUID,
    p_provider_subscription_id TEXT,
    p_plan_id UUID,
    p_status TEXT,
    p_current_period_start TIMESTAMPTZ,
    p_current_period_end TIMESTAMPTZ,
    p_cancel_at_period_end BOOLEAN,
    p_canceled_at TIMESTAMPTZ DEFAULT NULL,
    p_ended_at TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_org_exists BOOLEAN;
    v_existing_sub public.organization_subscriptions;
    v_existing_prov_sub public.billing_provider_subscriptions;
    v_sub_id UUID;
    v_result JSONB;
BEGIN
    -- 1. Input validation
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
    END IF;
    IF p_provider_subscription_id IS NULL OR pg_catalog.length(pg_catalog.btrim(p_provider_subscription_id)) = 0 THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_provider_subscription_id is required.';
    END IF;
    IF p_plan_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_plan_id is required.';
    END IF;
    IF p_status IS NULL OR p_status NOT IN ('trialing', 'active', 'past_due', 'canceled', 'expired', 'suspended') THEN
        RAISE EXCEPTION 'INVALID_STATUS: p_status must be a valid status constraint value.';
    END IF;
    IF p_cancel_at_period_end IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_cancel_at_period_end is required.';
    END IF;

    -- Period validation: active/trialing/past_due require non-null period timestamps
    IF p_status IN ('active', 'trialing', 'past_due') THEN
        IF p_current_period_start IS NULL OR p_current_period_end IS NULL THEN
            RAISE EXCEPTION 'INVALID_PERIOD: Active/trialing/past_due subscriptions require non-null period start and end timestamps.' USING ERRCODE = '22023';
        END IF;
    END IF;

    -- Period validation: end must be >= start if both present
    IF p_current_period_start IS NOT NULL AND p_current_period_end IS NOT NULL THEN
        IF p_current_period_end < p_current_period_start THEN
            RAISE EXCEPTION 'INVALID_PERIOD: p_current_period_end (%) cannot be earlier than p_current_period_start (%).', p_current_period_end, p_current_period_start USING ERRCODE = '22023';
        END IF;
    END IF;

    -- 2. Lock organization record to serialize concurrent updates & verify existence
    PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ORGANIZATION_NOT_FOUND: Organization % does not exist.', p_organization_id USING ERRCODE = 'P0002';
    END IF;

    -- 3. Lock existing provider subscription mapping if present
    SELECT * INTO v_existing_prov_sub
    FROM public.billing_provider_subscriptions
    WHERE provider = 'stripe' AND provider_subscription_id = p_provider_subscription_id
    FOR UPDATE;

    IF v_existing_prov_sub IS NOT NULL THEN
        -- Verify existing mapping matches target organization_subscription
        SELECT * INTO v_existing_sub
        FROM public.organization_subscriptions
        WHERE id = v_existing_prov_sub.organization_subscription_id
        FOR UPDATE;

        IF v_existing_sub IS NOT NULL AND v_existing_sub.organization_id <> p_organization_id THEN
            RAISE EXCEPTION 'SUBSCRIPTION_MAPPING_CONFLICT: Provider subscription belongs to a different organization.' USING ERRCODE = '23505';
        END IF;
    ELSE
        -- Select existing subscription for organization if present
        SELECT * INTO v_existing_sub
        FROM public.organization_subscriptions
        WHERE organization_id = p_organization_id
        FOR UPDATE;
    END IF;

    -- 4. Out-of-order / Stale Event & Terminal Resurrection Check
    IF v_existing_sub IS NOT NULL THEN
        -- If incoming current_period_start is strictly before existing current_period_start
        IF v_existing_sub.current_period_start IS NOT NULL AND p_current_period_start IS NOT NULL AND p_current_period_start < v_existing_sub.current_period_start THEN
            RETURN jsonb_build_object(
                'success', false,
                'code', 'OUT_OF_ORDER_STALE_EVENT',
                'message', 'Incoming current_period_start is older than existing current_period_start.',
                'organization_subscription_id', v_existing_sub.id
            );
        END IF;

        -- Terminal Resurrection Guard: internally terminal subscription (ended_at IS NOT NULL OR status = 'canceled') cannot resurrect to active in-place
        IF (v_existing_sub.ended_at IS NOT NULL OR v_existing_sub.status = 'canceled') AND p_status IN ('active', 'trialing', 'past_due') THEN
            RETURN jsonb_build_object(
                'success', false,
                'code', 'TERMINAL_RESURRECTION_PROHIBITED',
                'message', 'Cannot resurrect an internally terminal subscription to active in-place. Reconciliation required.',
                'organization_subscription_id', v_existing_sub.id
            );
        END IF;
    END IF;

    -- 5. Perform atomic UPSERT on organization_subscriptions
    IF v_existing_sub IS NOT NULL THEN
        UPDATE public.organization_subscriptions
        SET plan_id = p_plan_id,
            status = p_status,
            current_period_start = COALESCE(p_current_period_start, current_period_start),
            current_period_end = COALESCE(p_current_period_end, current_period_end),
            cancel_at_period_end = p_cancel_at_period_end,
            canceled_at = CASE
                WHEN p_status IN ('active', 'trialing') THEN NULL
                ELSE COALESCE(p_canceled_at, canceled_at)
            END,
            ended_at = CASE
                WHEN p_status IN ('active', 'trialing', 'past_due') THEN NULL
                ELSE COALESCE(p_ended_at, ended_at)
            END,
            updated_at = NOW()
        WHERE id = v_existing_sub.id
        RETURNING id INTO v_sub_id;
    ELSE
        INSERT INTO public.organization_subscriptions (
            organization_id, plan_id, status, current_period_start,
            current_period_end, cancel_at_period_end, canceled_at, ended_at
        ) VALUES (
            p_organization_id, p_plan_id, p_status, p_current_period_start,
            p_current_period_end, p_cancel_at_period_end, p_canceled_at, p_ended_at
        )
        RETURNING id INTO v_sub_id;
    END IF;

    -- 6. Perform non-reassigning idempotent update on billing_provider_subscriptions
    IF v_existing_prov_sub IS NOT NULL THEN
        IF v_existing_prov_sub.organization_subscription_id <> v_sub_id THEN
            RAISE EXCEPTION 'SUBSCRIPTION_MAPPING_CONFLICT: Provider subscription is already mapped to a different internal subscription.' USING ERRCODE = '23505';
        END IF;
        UPDATE public.billing_provider_subscriptions
        SET updated_at = NOW()
        WHERE id = v_existing_prov_sub.id;
    ELSE
        INSERT INTO public.billing_provider_subscriptions (
            organization_subscription_id, provider, provider_subscription_id, updated_at
        ) VALUES (
            v_sub_id, 'stripe', p_provider_subscription_id, NOW()
        );
    END IF;

    -- Return full result object
    SELECT jsonb_build_object(
        'success', true,
        'organization_subscription_id', v_sub_id,
        'organization_id', p_organization_id,
        'status', p_status,
        'plan_id', p_plan_id,
        'provider_subscription_id', p_provider_subscription_id
    ) INTO v_result;

    RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reconcile_stripe_subscription_atomic(
    UUID, TEXT, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reconcile_stripe_subscription_atomic(
    UUID, TEXT, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ
) TO service_role;
