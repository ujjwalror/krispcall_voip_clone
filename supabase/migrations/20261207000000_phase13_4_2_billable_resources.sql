-- ====================================================================
-- PUBLIC SAAS PHASE 13.4.2 — ATOMIC BILLABLE RESOURCE RECONCILIATION RPC
-- Date: 2026-12-07
-- Provides atomic reconciliation of seats and phone numbers into
-- public.organization_billable_resources and public.billable_resource_price_versions.
-- LOCAL MIGRATION ONLY — SUBJECT TO MANUAL DBA REVIEW.
-- DO NOT EXECUTE REMOTELY AUTOMATICALLY.
-- ====================================================================

CREATE OR REPLACE FUNCTION public.reconcile_organization_billable_resources_atomic(
    p_organization_id UUID,
    p_seat_unit_price_minor BIGINT DEFAULT NULL,
    p_seat_currency TEXT DEFAULT 'USD',
    p_seat_billing_interval TEXT DEFAULT 'monthly',
    p_phone_prices JSONB DEFAULT '[]'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_sub_plan_id UUID;
    v_included_seats BIGINT := 0;
    v_active_seat_count BIGINT := 0;
    v_overage_seat_count BIGINT := 0;
    v_seat_retail_minor BIGINT := 0;

    v_seat_res public.organization_billable_resources;
    v_seat_res_id UUID;
    v_active_pv public.billable_resource_price_versions;

    v_phone_rec RECORD;
    v_phone_res public.organization_billable_resources;
    v_phone_res_id UUID;
    v_phone_price_item JSONB;
    v_phone_retail_minor BIGINT;
    v_phone_currency TEXT;
    v_phone_price_found BOOLEAN;
    v_total_active_resources BIGINT := 0;
    v_total_phone_retail_minor BIGINT := 0;

    -- Array structure to hold validated phone number state before DML phase
    v_validated_phones JSONB := '[]'::jsonb;
    v_val_item JSONB;
    v_i INT;

    v_now TIMESTAMPTZ := NOW();
    v_result JSONB;
BEGIN
    -- ====================================================================
    -- 1. READ-ONLY INPUT & ENTITLEMENT VALIDATION PHASE (BEFORE ANY DML)
    -- ====================================================================

    -- 1A. Validate Input Parameters
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
    END IF;

    IF p_seat_unit_price_minor IS NOT NULL AND p_seat_unit_price_minor < 0 THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'INVALID_ARGUMENT',
            'message', 'p_seat_unit_price_minor cannot be negative.'
        );
    END IF;

    IF p_seat_currency IS NULL OR length(trim(p_seat_currency)) = 0 THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'INVALID_ARGUMENT',
            'message', 'p_seat_currency cannot be empty.'
        );
    END IF;

    IF p_seat_billing_interval NOT IN ('monthly', 'annual') THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'INVALID_ARGUMENT',
            'message', pg_catalog.format('Invalid billing interval: %s. Allowed: monthly, annual.', p_seat_billing_interval)
        );
    END IF;

    -- 1B. Lock organization record to serialize concurrent updates & verify existence
    PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ORGANIZATION_NOT_FOUND: Organization % does not exist.', p_organization_id USING ERRCODE = 'P0002';
    END IF;

    -- 1C. Resolve target plan and included seats entitlement
    SELECT plan_id INTO v_sub_plan_id
    FROM public.organization_subscriptions
    WHERE organization_id = p_organization_id;

    IF v_sub_plan_id IS NOT NULL THEN
        SELECT COALESCE(o.numeric_value, pe.numeric_value, 0)::BIGINT INTO v_included_seats
        FROM public.plan_entitlements pe
        LEFT JOIN public.organization_entitlement_overrides o
          ON o.organization_id = p_organization_id
         AND o.feature_code = 'team.seats.included'
         AND (o.expires_at IS NULL OR o.expires_at > v_now)
        WHERE pe.plan_id = v_sub_plan_id
          AND pe.feature_code = 'team.seats.included';

        IF v_included_seats IS NULL THEN
            v_included_seats := 0;
        END IF;
    END IF;

    -- 1D. Count current active seats (active profiles)
    SELECT COUNT(*)::BIGINT INTO v_active_seat_count
    FROM public.profiles
    WHERE organization_id = p_organization_id AND active = TRUE;

    v_overage_seat_count := GREATEST(0, v_active_seat_count - v_included_seats);

    -- 1E. Validate Seat Overage Price availability if overage > 0
    IF v_overage_seat_count > 0 THEN
        IF p_seat_unit_price_minor IS NULL THEN
            RETURN jsonb_build_object(
                'success', false,
                'code', 'SEAT_OVERAGE_PRICE_UNCONFIGURED',
                'message', 'Workspace has overage seats but no authoritative seat price is configured for plan.',
                'active_seats', v_active_seat_count,
                'included_seats', v_included_seats,
                'overage_seats', v_overage_seat_count
            );
        END IF;
    END IF;

    -- 1F. Validate Phone Numbers prices (READ-ONLY PASS BEFORE ANY DML)
    FOR v_phone_rec IN
        SELECT id, phone_number, status
        FROM public.phone_numbers
        WHERE organization_id = p_organization_id
    LOOP
        IF v_phone_rec.status IN ('active', 'disabled') THEN
            v_phone_price_found := FALSE;
            v_phone_retail_minor := NULL;
            v_phone_currency := p_seat_currency;

            -- RULE 1: Check if an EXISTING ACTIVE billable resource already exists.
            -- If so, its existing contracted price MUST BE PRESERVED. Routine sync MUST NOT reprice existing resources.
            SELECT * INTO v_phone_res
            FROM public.organization_billable_resources
            WHERE organization_id = p_organization_id
              AND resource_type = 'phone_number'
              AND resource_id = v_phone_rec.id::text
              AND status = 'active';

            IF v_phone_res IS NOT NULL AND v_phone_res.contracted_retail_minor IS NOT NULL THEN
                v_phone_retail_minor := v_phone_res.contracted_retail_minor;
                v_phone_currency := COALESCE(v_phone_res.currency, p_seat_currency);
                v_phone_price_found := TRUE;
            ELSE
                -- RULE 2: Initial activation for NEW phone resource. Use pre-resolved purchase-time price array.
                IF p_phone_prices IS NOT NULL AND jsonb_array_length(p_phone_prices) > 0 THEN
                    FOR v_phone_price_item IN SELECT * FROM jsonb_array_elements(p_phone_prices)
                    LOOP
                        IF v_phone_price_item->>'phone_number_id' = v_phone_rec.id::text OR v_phone_price_item->>'phone_number' = v_phone_rec.phone_number THEN
                            v_phone_price_found := TRUE;
                            v_phone_retail_minor := (v_phone_price_item->>'monthly_retail_minor')::BIGINT;
                            v_phone_currency := COALESCE(v_phone_price_item->>'currency', p_seat_currency);
                            EXIT;
                        END IF;
                    END LOOP;
                END IF;
            END IF;

            -- FAIL CLOSED BEFORE ANY DML IF ANY ACTIVE PHONE PRICE IS UNRESOLVED
            IF NOT v_phone_price_found OR v_phone_retail_minor IS NULL THEN
                RETURN jsonb_build_object(
                    'success', false,
                    'code', 'PHONE_RETAIL_PRICE_UNRESOLVED',
                    'message', pg_catalog.format('Phone number %s (ID: %s) has no authoritative retail price configured.', v_phone_rec.phone_number, v_phone_rec.id),
                    'phone_number_id', v_phone_rec.id,
                    'phone_number', v_phone_rec.phone_number
                );
            END IF;

            -- Stash validated phone item for mutation phase
            v_validated_phones := v_validated_phones || jsonb_build_object(
                'id', v_phone_rec.id::text,
                'phone_number', v_phone_rec.phone_number,
                'status', v_phone_rec.status,
                'retail_minor', v_phone_retail_minor,
                'currency', v_phone_currency,
                'action', 'bill'
            );
        ELSIF v_phone_rec.status = 'released' THEN
            v_validated_phones := v_validated_phones || jsonb_build_object(
                'id', v_phone_rec.id::text,
                'phone_number', v_phone_rec.phone_number,
                'status', v_phone_rec.status,
                'action', 'terminate'
            );
        END IF;
    END LOOP;

    -- ====================================================================
    -- 2. MUTATION PHASE (ENTIRE ORGANIZATION PASSED VALIDATION CLEANLY)
    -- ====================================================================

    -- 2A. Mutate Seat Billable Resource
    SELECT * INTO v_seat_res
    FROM public.organization_billable_resources
    WHERE organization_id = p_organization_id
      AND resource_type = 'seat'
      AND resource_id = 'seat_overage'
      AND status = 'active'
    FOR UPDATE;

    IF v_overage_seat_count > 0 THEN
        v_seat_retail_minor := v_overage_seat_count * p_seat_unit_price_minor;

        IF v_seat_res IS NOT NULL THEN
            v_seat_res_id := v_seat_res.id;

            UPDATE public.organization_billable_resources
            SET contracted_retail_minor = v_seat_retail_minor,
                currency = p_seat_currency,
                billing_interval = p_seat_billing_interval,
                metadata = jsonb_build_object(
                    'active_seats', v_active_seat_count,
                    'included_seats', v_included_seats,
                    'overage_seats', v_overage_seat_count,
                    'unit_price_minor', p_seat_unit_price_minor
                ),
                updated_at = v_now
            WHERE id = v_seat_res_id;

            SELECT * INTO v_active_pv
            FROM public.billable_resource_price_versions
            WHERE billable_resource_id = v_seat_res_id
              AND effective_end_at IS NULL
            FOR UPDATE;

            IF v_active_pv IS NULL THEN
                INSERT INTO public.billable_resource_price_versions (
                    billable_resource_id, contracted_retail_minor, currency,
                    effective_start_at, effective_end_at, change_reason
                ) VALUES (
                    v_seat_res_id, v_seat_retail_minor, p_seat_currency,
                    v_now, NULL, 'INITIAL_PRICE_VERSION'
                );
            ELSIF v_active_pv.contracted_retail_minor <> v_seat_retail_minor OR v_active_pv.currency <> p_seat_currency THEN
                UPDATE public.billable_resource_price_versions
                SET effective_end_at = v_now
                WHERE id = v_active_pv.id;

                INSERT INTO public.billable_resource_price_versions (
                    billable_resource_id, contracted_retail_minor, currency,
                    effective_start_at, effective_end_at, change_reason
                ) VALUES (
                    v_seat_res_id, v_seat_retail_minor, p_seat_currency,
                    v_now, NULL, 'SEAT_QUANTITY_OR_PRICE_CHANGE'
                );
            END IF;
        ELSE
            INSERT INTO public.organization_billable_resources (
                organization_id, resource_type, resource_id, billing_interval,
                contracted_retail_minor, currency, status, effective_start_at,
                metadata, created_at, updated_at
            ) VALUES (
                p_organization_id, 'seat', 'seat_overage', p_seat_billing_interval,
                v_seat_retail_minor, p_seat_currency, 'active', v_now,
                jsonb_build_object(
                    'active_seats', v_active_seat_count,
                    'included_seats', v_included_seats,
                    'overage_seats', v_overage_seat_count,
                    'unit_price_minor', p_seat_unit_price_minor
                ), v_now, v_now
            ) RETURNING id INTO v_seat_res_id;

            INSERT INTO public.billable_resource_price_versions (
                billable_resource_id, contracted_retail_minor, currency,
                effective_start_at, effective_end_at, change_reason
            ) VALUES (
                v_seat_res_id, v_seat_retail_minor, p_seat_currency,
                v_now, NULL, 'INITIAL_PRICE_VERSION'
            );
        END IF;

        v_total_active_resources := v_total_active_resources + 1;
    ELSE
        -- No overage seats: terminate active seat overage resource if present
        IF v_seat_res IS NOT NULL THEN
            UPDATE public.organization_billable_resources
            SET status = 'terminated',
                effective_end_at = v_now,
                updated_at = v_now
            WHERE id = v_seat_res.id;

            UPDATE public.billable_resource_price_versions
            SET effective_end_at = v_now
            WHERE billable_resource_id = v_seat_res.id
              AND effective_end_at IS NULL;
        END IF;
    END IF;

    -- 2B. Mutate Phone Number Billable Resources
    IF jsonb_array_length(v_validated_phones) > 0 THEN
        FOR v_i IN 0..jsonb_array_length(v_validated_phones) - 1 LOOP
            v_val_item := v_validated_phones->v_i;

            SELECT * INTO v_phone_res
            FROM public.organization_billable_resources
            WHERE organization_id = p_organization_id
              AND resource_type = 'phone_number'
              AND resource_id = v_val_item->>'id'
              AND status = 'active'
            FOR UPDATE;

            IF v_val_item->>'action' = 'bill' THEN
                v_phone_retail_minor := (v_val_item->>'retail_minor')::BIGINT;
                v_phone_currency := v_val_item->>'currency';

                IF v_phone_res IS NOT NULL THEN
                    v_phone_res_id := v_phone_res.id;

                    UPDATE public.organization_billable_resources
                    SET contracted_retail_minor = v_phone_retail_minor,
                        currency = v_phone_currency,
                        updated_at = v_now
                    WHERE id = v_phone_res_id;

                    SELECT * INTO v_active_pv
                    FROM public.billable_resource_price_versions
                    WHERE billable_resource_id = v_phone_res_id
                      AND effective_end_at IS NULL
                    FOR UPDATE;

                    IF v_active_pv IS NULL THEN
                        INSERT INTO public.billable_resource_price_versions (
                            billable_resource_id, contracted_retail_minor, currency,
                            effective_start_at, effective_end_at, change_reason
                        ) VALUES (
                            v_phone_res_id, v_phone_retail_minor, v_phone_currency,
                            v_now, NULL, 'INITIAL_PRICE_VERSION'
                        );
                    ELSIF v_active_pv.contracted_retail_minor <> v_phone_retail_minor OR v_active_pv.currency <> v_phone_currency THEN
                        UPDATE public.billable_resource_price_versions
                        SET effective_end_at = v_now
                        WHERE id = v_active_pv.id;

                        INSERT INTO public.billable_resource_price_versions (
                            billable_resource_id, contracted_retail_minor, currency,
                            effective_start_at, effective_end_at, change_reason
                        ) VALUES (
                            v_phone_res_id, v_phone_retail_minor, v_phone_currency,
                            v_now, NULL, 'PHONE_PRICE_UPDATE'
                        );
                    END IF;
                ELSE
                    INSERT INTO public.organization_billable_resources (
                        organization_id, resource_type, resource_id, billing_interval,
                        contracted_retail_minor, currency, status, effective_start_at,
                        metadata, created_at, updated_at
                    ) VALUES (
                        p_organization_id, 'phone_number', v_val_item->>'id', 'monthly',
                        v_phone_retail_minor, v_phone_currency, 'active', v_now,
                        jsonb_build_object('phone_number', v_val_item->>'phone_number', 'phone_status', v_val_item->>'status'),
                        v_now, v_now
                    ) RETURNING id INTO v_phone_res_id;

                    INSERT INTO public.billable_resource_price_versions (
                        billable_resource_id, contracted_retail_minor, currency,
                        effective_start_at, effective_end_at, change_reason
                    ) VALUES (
                        v_phone_res_id, v_phone_retail_minor, v_phone_currency,
                        v_now, NULL, 'INITIAL_PRICE_VERSION'
                    );
                END IF;

                v_total_active_resources := v_total_active_resources + 1;
                v_total_phone_retail_minor := v_total_phone_retail_minor + v_phone_retail_minor;
            ELSIF v_val_item->>'action' = 'terminate' THEN
                IF v_phone_res IS NOT NULL THEN
                    UPDATE public.organization_billable_resources
                    SET status = 'terminated',
                        effective_end_at = v_now,
                        updated_at = v_now
                    WHERE id = v_phone_res.id;

                    UPDATE public.billable_resource_price_versions
                    SET effective_end_at = v_now
                    WHERE billable_resource_id = v_phone_res.id
                      AND effective_end_at IS NULL;
                END IF;
            END IF;
        END LOOP;
    END IF;

    -- Return full result summary
    SELECT jsonb_build_object(
        'success', true,
        'organization_id', p_organization_id,
        'active_seats', v_active_seat_count,
        'included_seats', v_included_seats,
        'overage_seats', v_overage_seat_count,
        'seat_billable_retail_minor', v_seat_retail_minor,
        'active_numbers_count', (
            SELECT COUNT(*)::BIGINT FROM public.phone_numbers WHERE organization_id = p_organization_id AND status IN ('active', 'disabled')
        ),
        'phone_billable_retail_minor', v_total_phone_retail_minor,
        'total_active_resources', v_total_active_resources
    ) INTO v_result;

    RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reconcile_organization_billable_resources_atomic(
    UUID, BIGINT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reconcile_organization_billable_resources_atomic(
    UUID, BIGINT, TEXT, TEXT, JSONB
) TO service_role;
