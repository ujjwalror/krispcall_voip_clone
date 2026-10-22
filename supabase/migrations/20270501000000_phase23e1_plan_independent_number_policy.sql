-- ==============================================================================
-- PHASE 23E.1: PLAN-INDEPENDENT NUMBER OWNERSHIP & BILLING POLICY REFACTOR
-- LOCAL MIGRATION ONLY — DO NOT APPLY TO REMOTE PRODUCTION DATABASE DIRECTLY
-- 
-- Canonical Business Policy Changes:
-- 1. SaaS subscription plans (Starter/Pro/Business) MUST NOT impose an ordinary
--    plan-based maximum on how many telephone numbers an organization can own.
-- 2. Telephone numbers are independently recurring billable telecom resources.
-- 3. Number acquisition concurrency, operational slot reservations, and idempotency
--    are fully preserved for race safety and resource accounting.
-- 4. Extensible 5-tier deterministic number retail markup policy engine (default 30%).
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. REFACTOR: public.get_organization_effective_number_slots
-- Remove SaaS plan-based number quantity ceilings.
-- Baseline plan capacity is unconstrained (NULL: Not Applicable).
-- Explicit non-plan risk/admin overrides remain enforceable.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_organization_effective_number_slots(
    p_organization_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_override_slots INT := NULL;
    v_addon_slots INT := 0;
    v_sub_status TEXT;
BEGIN
    IF p_organization_id IS NULL THEN
        RETURN 0;
    END IF;

    -- 1. Inspect subscription status
    SELECT status
    INTO v_sub_status
    FROM public.organization_subscriptions
    WHERE organization_id = p_organization_id;

    -- If subscription is canceled, expired, or suspended without grace, capacity drops to 0
    IF v_sub_status IS NOT NULL AND v_sub_status IN ('canceled', 'expired', 'suspended') THEN
        RETURN 0;
    END IF;

    -- 2. Check for active, non-expired administrative/risk override
    -- Allows explicit anti-fraud, KYC, or operational velocity ceilings separate from SaaS plans
    SELECT numeric_value::INT
    INTO v_override_slots
    FROM public.organization_entitlement_overrides
    WHERE organization_id = p_organization_id
      AND feature_code IN ('number.risk_limit', 'number.max_active')
      AND enabled = true
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY (CASE WHEN feature_code = 'number.risk_limit' THEN 1 ELSE 2 END), created_at DESC
    LIMIT 1;

    -- 3. If an explicit administrative/risk override is active, apply add-ons and enforce the ceiling
    IF v_override_slots IS NOT NULL THEN
        SELECT COALESCE(COUNT(*)::INT, 0)
        INTO v_addon_slots
        FROM public.organization_billable_resources
        WHERE organization_id = p_organization_id
          AND resource_type = 'number_slot'
          AND status = 'active';

        RETURN GREATEST(0, v_override_slots + v_addon_slots);
    END IF;

    -- Phase 23E.1A: SaaS subscription plans do NOT impose a telephone-number ownership limit.
    -- Canonical semantic: PLAN NUMBER OWNERSHIP CAPACITY = NOT APPLICABLE (NULL).
    -- Unconstrained organizations return NULL, indicating no commercial ceiling.
    RETURN NULL;
END;
$$;

-- ------------------------------------------------------------------------------
-- 2. REFACTOR: public.acquire_number_slot_reservation_atomic
-- Preserves advisory xact locking, operational idempotency, and in-flight reservation
-- accounting while operating on plan-independent capacity.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.acquire_number_slot_reservation_atomic(
    p_organization_id UUID,
    p_saga_type TEXT,
    p_operation_id TEXT,
    p_ttl_seconds INT DEFAULT 900
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_existing RECORD;
    v_effective_capacity INT := NULL;
    v_consumed_slots INT := 0;
    v_active_reservations INT := 0;
    v_new_reservation_id UUID;
    v_expires_at TIMESTAMPTZ;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_organization_id is required.';
    END IF;
    IF p_saga_type IS NULL OR p_saga_type NOT IN ('purchase', 'port_in', 'admin_allocation') THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_saga_type must be purchase, port_in, or admin_allocation.';
    END IF;
    IF p_operation_id IS NULL OR pg_catalog.length(pg_catalog.btrim(p_operation_id)) = 0 THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_operation_id is required.';
    END IF;

    -- 1. Check existing reservation for this exact source operation (Idempotency)
    SELECT * INTO v_existing
    FROM public.organization_number_slot_reservations
    WHERE organization_id = p_organization_id
      AND saga_type = p_saga_type
      AND operation_id = p_operation_id
    FOR UPDATE;

    IF v_existing.id IS NOT NULL THEN
        IF v_existing.status = 'RESERVED' AND (
            v_existing.expires_at > NOW()
            OR (v_existing.saga_type = 'port_in' AND EXISTS (
                SELECT 1 FROM public.number_port_operations npo 
                WHERE npo.id::text = v_existing.operation_id 
                  AND npo.canonical_state IN ('SUBMISSION_PENDING', 'SUBMITTED', 'FOC_RECEIVED', 'TRANSFER_SCHEDULED', 'TRANSFER_IN_PROGRESS', 'PROVIDER_OUTCOME_UNKNOWN')
            ))
            OR (v_existing.saga_type = 'purchase' AND EXISTS (
                SELECT 1 FROM public.provider_number_operations pno 
                WHERE (pno.id::text = v_existing.operation_id OR pno.idempotency_key = v_existing.operation_id) 
                  AND pno.canonical_state IN ('PROVIDER_DISPATCH_PENDING', 'PROVIDER_DISPATCHED', 'PROVIDER_OUTCOME_UNKNOWN')
            ))
        ) THEN
            RETURN jsonb_build_object(
                'success', true,
                'is_idempotent_duplicate', true,
                'reservation_id', v_existing.id,
                'status', v_existing.status,
                'expires_at', v_existing.expires_at
            );
        ELSIF v_existing.status = 'CONSUMED' THEN
            RETURN jsonb_build_object(
                'success', true,
                'is_idempotent_duplicate', true,
                'reservation_id', v_existing.id,
                'status', v_existing.status,
                'consumed_at', v_existing.consumed_at
            );
        END IF;
    END IF;

    -- 2. Serialize concurrent capacity decisions for this organization via advisory lock & row lock
    PERFORM pg_advisory_xact_lock(hashtext('slot_cap_' || p_organization_id::text));
    PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ORGANIZATION_NOT_FOUND: Organization % does not exist.', p_organization_id USING ERRCODE = 'P0002';
    END IF;

    -- 3. Calculate effective slot capacity (plan-independent, NULL if unconstrained)
    v_effective_capacity := public.get_organization_effective_number_slots(p_organization_id);

    -- 4. Count consumed slots (phone_numbers where ownership_state = 'OWNED')
    SELECT COUNT(*)::INT INTO v_consumed_slots
    FROM public.phone_numbers
    WHERE organization_id = p_organization_id
      AND ownership_state = 'OWNED';

    -- 5. Count active unexpired reservations (or uncompleted in-flight operations past TTL)
    SELECT COUNT(*)::INT INTO v_active_reservations
    FROM public.organization_number_slot_reservations
    WHERE organization_id = p_organization_id
      AND status = 'RESERVED'
      AND (
          expires_at > NOW()
          OR (saga_type = 'port_in' AND EXISTS (
              SELECT 1 FROM public.number_port_operations npo 
              WHERE npo.id::text = operation_id 
                AND npo.canonical_state IN ('SUBMISSION_PENDING', 'SUBMITTED', 'FOC_RECEIVED', 'TRANSFER_SCHEDULED', 'TRANSFER_IN_PROGRESS', 'PROVIDER_OUTCOME_UNKNOWN')
          ))
          OR (saga_type = 'purchase' AND EXISTS (
              SELECT 1 FROM public.provider_number_operations pno 
              WHERE (pno.id::text = operation_id OR pno.idempotency_key = operation_id) 
                AND pno.canonical_state IN ('PROVIDER_DISPATCH_PENDING', 'PROVIDER_DISPATCHED', 'PROVIDER_OUTCOME_UNKNOWN')
          ))
      )
      AND NOT (saga_type = p_saga_type AND operation_id = p_operation_id);

    -- 6. Operational & Risk Capacity Authorization Check
    -- Enforce ceiling ONLY when an explicit administrative/risk capacity limit exists (v_effective_capacity IS NOT NULL)
    IF v_effective_capacity IS NOT NULL AND (v_consumed_slots + v_active_reservations) >= v_effective_capacity THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'INSUFFICIENT_NUMBER_SLOTS',
            'message', 'Organization has reached maximum operational phone number capacity limit.',
            'effective_capacity', v_effective_capacity,
            'consumed_slots', v_consumed_slots,
            'active_reservations', v_active_reservations
        );
    END IF;

    -- 7. Persist slot reservation
    v_expires_at := NOW() + (p_ttl_seconds || ' seconds')::INTERVAL;

    INSERT INTO public.organization_number_slot_reservations (
        organization_id, saga_type, operation_id, status, expires_at
    ) VALUES (
        p_organization_id, p_saga_type, p_operation_id, 'RESERVED', v_expires_at
    )
    ON CONFLICT (organization_id, saga_type, operation_id)
    DO UPDATE SET
        status = 'RESERVED',
        expires_at = v_expires_at,
        released_at = NULL,
        release_reason = NULL,
        updated_at = NOW()
    RETURNING id INTO v_new_reservation_id;

    -- 8. Record in financial operation idempotency ledger
    INSERT INTO public.telecom_financial_operation_idempotency (
        organization_id,
        operation_type,
        idempotency_key,
        internal_usage_id,
        request_payload,
        response_payload
    ) VALUES (
        p_organization_id,
        'slot_reservation_create',
        'slot_' || p_saga_type || '_' || p_operation_id,
        'slot_' || p_saga_type || '_' || p_operation_id,
        jsonb_build_object('saga_type', p_saga_type, 'operation_id', p_operation_id, 'ttl_seconds', p_ttl_seconds),
        jsonb_build_object('reservation_id', v_new_reservation_id, 'expires_at', v_expires_at)
    )
    ON CONFLICT (organization_id, operation_type, idempotency_key) DO NOTHING;

    RETURN jsonb_build_object(
        'success', true,
        'reservation_id', v_new_reservation_id,
        'status', 'RESERVED',
        'expires_at', v_expires_at,
        'effective_capacity', v_effective_capacity,
        'consumed_slots', v_consumed_slots,
        'active_reservations', v_active_reservations + 1,
        'remaining_slots', CASE WHEN v_effective_capacity IS NOT NULL THEN GREATEST(0, v_effective_capacity - (v_consumed_slots + v_active_reservations + 1)) ELSE NULL END
    );
END;
$$;

-- ------------------------------------------------------------------------------
-- 3. CREATE public.telecom_number_markup_policies
-- Extensible 5-tier deterministic retail markup policy table.
-- Default markup = 30% (3000 basis points).
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telecom_number_markup_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_name TEXT NOT NULL,
    precedence_level TEXT NOT NULL CHECK (precedence_level IN ('specific_resource', 'number_type_scoped', 'country_scoped', 'provider_scoped', 'global_default')),
    provider TEXT NULL,
    country_code VARCHAR(2) NULL CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
    number_type TEXT NULL CHECK (number_type IS NULL OR number_type IN ('local', 'mobile', 'toll_free', 'national')),
    phone_number_e164 TEXT NULL CHECK (phone_number_e164 IS NULL OR phone_number_e164 ~ '^\+[1-9]\d{1,14}$'),
    markup_bps INT NOT NULL DEFAULT 3000 CHECK (markup_bps >= 0),
    fixed_surcharge_minor INT NOT NULL DEFAULT 0 CHECK (fixed_surcharge_minor >= 0),
    retail_floor_minor INT NOT NULL DEFAULT 0 CHECK (retail_floor_minor >= 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    version INT NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    effective_to TIMESTAMPTZ NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telecom_markup_policies_lookup
ON public.telecom_number_markup_policies (is_active, precedence_level, currency);

-- Seed global default 30% markup policy
INSERT INTO public.telecom_number_markup_policies (
    rule_name, precedence_level, markup_bps, fixed_surcharge_minor, retail_floor_minor, currency, version, is_active
) VALUES (
    'Global Default 30% Number Markup', 'global_default', 3000, 0, 0, 'USD', 1, TRUE
)
ON CONFLICT DO NOTHING;

-- RLS & Grants for telecom_number_markup_policies
ALTER TABLE public.telecom_number_markup_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telecom_number_markup_policies FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.telecom_number_markup_policies TO authenticated;
GRANT ALL ON public.telecom_number_markup_policies TO service_role;

DROP POLICY IF EXISTS "authenticated_select_markup_policies" ON public.telecom_number_markup_policies;
CREATE POLICY "authenticated_select_markup_policies" ON public.telecom_number_markup_policies
    FOR SELECT TO authenticated USING (is_active = TRUE);
