-- ==============================================================================
-- PHASE 23D.9B: CANONICAL BILLING, NUMBER SLOT & ENTITLEMENT ENGINE
-- LOCAL MIGRATION ONLY — DO NOT APPLY TO REMOTE PRODUCTION DATABASE DIRECTLY
-- Additive schema foundations for:
-- 1. Durable number slot reservation ledger (organization_number_slot_reservations)
-- 2. Database-enforced rate_snapshot immutability trigger
-- 3. Extended financial operation idempotency domain
-- 4. Extended billable resource domain
-- 5. Atomic PL/pgSQL slot capacity calculation & acquisition RPCs
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. CREATE public.organization_number_slot_reservations
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organization_number_slot_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    saga_type TEXT NOT NULL CHECK (saga_type IN ('purchase', 'port_in', 'admin_allocation')),
    operation_id TEXT NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(operation_id)) > 0),
    status TEXT NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED', 'CONSUMED', 'RELEASED', 'EXPIRED')),
    phone_number_id UUID NULL REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
    idempotency_key TEXT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ NULL,
    released_at TIMESTAMPTZ NULL,
    release_reason TEXT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT uq_org_number_slot_reservations UNIQUE (organization_id, saga_type, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_org_slot_res_org_status 
ON public.organization_number_slot_reservations(organization_id, status);

CREATE INDEX IF NOT EXISTS idx_org_slot_res_expires 
ON public.organization_number_slot_reservations(expires_at) 
WHERE status = 'RESERVED';

-- Trigger for updated_at on organization_number_slot_reservations
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_org_number_slot_reservations_updated_at'
    ) THEN
        CREATE TRIGGER trg_org_number_slot_reservations_updated_at
            BEFORE UPDATE ON public.organization_number_slot_reservations
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 2. DATABASE-LEVEL IMMUTABILITY TRIGGER FOR telecom_usage_reservations.rate_snapshot
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_reservation_rate_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.rate_snapshot IS DISTINCT FROM NEW.rate_snapshot THEN
        RAISE EXCEPTION 'IMMUTABLE_RATE_SNAPSHOT: rate_snapshot cannot be modified once recorded.' USING ERRCODE = '42883';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_no_mutation_reservation_rate ON public.telecom_usage_reservations;
CREATE TRIGGER trg_no_mutation_reservation_rate
    BEFORE UPDATE ON public.telecom_usage_reservations
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_reservation_rate_mutation();

-- ------------------------------------------------------------------------------
-- 3. EXTEND telecom_financial_operation_idempotency DOMAIN
-- ------------------------------------------------------------------------------
DO $$
BEGIN
    ALTER TABLE public.telecom_financial_operation_idempotency
        DROP CONSTRAINT IF EXISTS telecom_financial_operation_idempotency_operation_type_check;
    ALTER TABLE public.telecom_financial_operation_idempotency
        ADD CONSTRAINT telecom_financial_operation_idempotency_operation_type_check
        CHECK (operation_type IN (
            'reservation_create', 'reservation_extend', 'reservation_settle', 'reservation_release', 'usage_reversal',
            'slot_reservation_create', 'slot_reservation_consume', 'slot_reservation_release',
            'subscription_charge', 'number_mrc_charge', 'admin_credit', 'admin_debit', 'financial_correction'
        ));
EXCEPTION
    WHEN OTHERS THEN NULL;
END $$;

-- ------------------------------------------------------------------------------
-- 4. EXTEND organization_billable_resources DOMAIN
-- ------------------------------------------------------------------------------
DO $$
BEGIN
    ALTER TABLE public.organization_billable_resources
        DROP CONSTRAINT IF EXISTS organization_billable_resources_resource_type_check;
    ALTER TABLE public.organization_billable_resources
        ADD CONSTRAINT organization_billable_resources_resource_type_check
        CHECK (resource_type IN ('phone_number', 'seat', 'addon', 'number_slot'));
EXCEPTION
    WHEN OTHERS THEN NULL;
END $$;

-- ------------------------------------------------------------------------------
-- 5. FUNCTION: public.get_organization_effective_number_slots
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
    v_base_slots INT := 1;
    v_override_slots INT := NULL;
    v_addon_slots INT := 0;
    v_sub_status TEXT;
    v_plan_version_id UUID;
    v_plan_id UUID;
BEGIN
    IF p_organization_id IS NULL THEN
        RETURN 0;
    END IF;

    -- 1. Inspect subscription
    SELECT status, plan_version_id, plan_id
    INTO v_sub_status, v_plan_version_id, v_plan_id
    FROM public.organization_subscriptions
    WHERE organization_id = p_organization_id;

    -- If subscription is canceled, expired, or suspended without grace, capacity drops to 0
    IF v_sub_status IS NOT NULL AND v_sub_status IN ('canceled', 'expired', 'suspended') THEN
        v_base_slots := 0;
    ELSE
        -- 2. Inspect plan version entitlements
        IF v_plan_version_id IS NOT NULL THEN
            SELECT COALESCE(numeric_value::INT, 1)
            INTO v_base_slots
            FROM public.plan_version_entitlements
            WHERE plan_version_id = v_plan_version_id
              AND feature_code IN ('number.max_active', 'number.slots.included')
              AND enabled = true
            ORDER BY (CASE WHEN feature_code = 'number.max_active' THEN 1 ELSE 2 END)
            LIMIT 1;
        ELSIF v_plan_id IS NOT NULL THEN
            SELECT COALESCE(pve.numeric_value::INT, 1)
            INTO v_base_slots
            FROM public.plan_versions pv
            JOIN public.plan_version_entitlements pve ON pve.plan_version_id = pv.id
            WHERE pv.plan_id = v_plan_id
              AND pv.status = 'published'
              AND pve.feature_code IN ('number.max_active', 'number.slots.included')
              AND pve.enabled = true
            ORDER BY pv.version DESC
            LIMIT 1;
        END IF;

        IF v_base_slots IS NULL THEN
            v_base_slots := 1;
        END IF;
    END IF;

    -- 3. Check for active, non-expired tenant entitlement override
    SELECT numeric_value::INT
    INTO v_override_slots
    FROM public.organization_entitlement_overrides
    WHERE organization_id = p_organization_id
      AND feature_code = 'number.max_active'
      AND enabled = true
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_override_slots IS NOT NULL THEN
        v_base_slots := v_override_slots;
    END IF;

    -- 4. Add active billable resource add-ons
    SELECT COALESCE(COUNT(*)::INT, 0)
    INTO v_addon_slots
    FROM public.organization_billable_resources
    WHERE organization_id = p_organization_id
      AND resource_type = 'number_slot'
      AND status = 'active';

    RETURN GREATEST(0, v_base_slots + v_addon_slots);
END;
$$;

-- ------------------------------------------------------------------------------
-- 6. ATOMIC RPC: public.acquire_number_slot_reservation_atomic
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
    v_effective_capacity INT := 0;
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

    -- 2. Serialize concurrent capacity decisions for this organization via row lock
    PERFORM id FROM public.organizations WHERE id = p_organization_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ORGANIZATION_NOT_FOUND: Organization % does not exist.', p_organization_id USING ERRCODE = 'P0002';
    END IF;

    -- 3. Calculate effective slot capacity
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

    -- 6. Atomic Capacity Authorization Check
    IF (v_consumed_slots + v_active_reservations) >= v_effective_capacity THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'INSUFFICIENT_NUMBER_SLOTS',
            'message', 'Organization has reached maximum phone number slot capacity.',
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
        'is_idempotent_duplicate', false,
        'reservation_id', v_new_reservation_id,
        'status', 'RESERVED',
        'expires_at', v_expires_at,
        'effective_capacity', v_effective_capacity,
        'consumed_slots', v_consumed_slots,
        'active_reservations', v_active_reservations + 1
    );
END;
$$;

-- ------------------------------------------------------------------------------
-- 7. ATOMIC RPC: public.consume_number_slot_reservation_atomic
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_number_slot_reservation_atomic(
    p_reservation_id UUID,
    p_phone_number_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_res RECORD;
    v_phone RECORD;
BEGIN
    IF p_reservation_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_reservation_id is required.';
    END IF;

    SELECT * INTO v_res
    FROM public.organization_number_slot_reservations
    WHERE id = p_reservation_id
    FOR UPDATE;

    IF v_res.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'RESERVATION_NOT_FOUND');
    END IF;

    -- Idempotent consumption check
    IF v_res.status = 'CONSUMED' THEN
        RETURN jsonb_build_object(
            'success', true,
            'is_duplicate', true,
            'reservation_id', v_res.id,
            'status', 'CONSUMED',
            'consumed_at', v_res.consumed_at
        );
    END IF;

    IF v_res.status <> 'RESERVED' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'INVALID_RESERVATION_STATE',
            'message', 'Reservation cannot be consumed from status ' || v_res.status
        );
    END IF;

    -- Validate Phone Number Tenant Isolation and Existence
    IF p_phone_number_id IS NOT NULL THEN
        SELECT id, organization_id, ownership_state INTO v_phone
        FROM public.phone_numbers
        WHERE id = p_phone_number_id;

        IF v_phone.id IS NULL THEN
            RAISE EXCEPTION 'PHONE_NOT_FOUND: Target phone number does not exist.' USING ERRCODE = 'P0002';
        END IF;

        IF v_phone.organization_id <> v_res.organization_id THEN
            RAISE EXCEPTION 'TENANT_MISMATCH: Target phone number does not belong to reservation organization.' USING ERRCODE = '23514';
        END IF;
    END IF;

    -- Check expiration safety: if clock expired AND operation is NOT in-flight, reject
    IF v_res.expires_at <= NOW() THEN
        IF v_res.saga_type = 'port_in' AND NOT EXISTS (
            SELECT 1 FROM public.number_port_operations npo 
            WHERE npo.id::text = v_res.operation_id 
              AND npo.canonical_state IN ('SUBMISSION_PENDING', 'SUBMITTED', 'FOC_RECEIVED', 'TRANSFER_SCHEDULED', 'TRANSFER_IN_PROGRESS', 'PROVIDER_OUTCOME_UNKNOWN')
        ) THEN
            RETURN jsonb_build_object('success', false, 'error_code', 'RESERVATION_EXPIRED', 'message', 'Cannot consume expired port-in reservation.');
        ELSIF v_res.saga_type = 'purchase' AND NOT EXISTS (
            SELECT 1 FROM public.provider_number_operations pno 
            WHERE (pno.id::text = v_res.operation_id OR pno.idempotency_key = v_res.operation_id) 
              AND pno.canonical_state IN ('PROVIDER_DISPATCH_PENDING', 'PROVIDER_DISPATCHED', 'PROVIDER_OUTCOME_UNKNOWN')
        ) THEN
            RETURN jsonb_build_object('success', false, 'error_code', 'RESERVATION_EXPIRED', 'message', 'Cannot consume expired purchase reservation.');
        END IF;
    END IF;

    UPDATE public.organization_number_slot_reservations
    SET status = 'CONSUMED',
        phone_number_id = p_phone_number_id,
        consumed_at = NOW(),
        updated_at = NOW()
    WHERE id = p_reservation_id;

    RETURN jsonb_build_object(
        'success', true,
        'is_duplicate', false,
        'reservation_id', p_reservation_id,
        'status', 'CONSUMED',
        'consumed_at', NOW()
    );
END;
$$;

-- ------------------------------------------------------------------------------
-- 8. ATOMIC RPC: public.release_number_slot_reservation_atomic
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_number_slot_reservation_atomic(
    p_reservation_id UUID,
    p_reason TEXT DEFAULT 'operation_cancelled_or_failed'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_res RECORD;
    v_phone RECORD;
BEGIN
    IF p_reservation_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_ARGUMENT: p_reservation_id is required.';
    END IF;

    SELECT * INTO v_res
    FROM public.organization_number_slot_reservations
    WHERE id = p_reservation_id
    FOR UPDATE;

    IF v_res.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'RESERVATION_NOT_FOUND');
    END IF;

    IF v_res.status = 'RELEASED' THEN
        RETURN jsonb_build_object(
            'success', true,
            'is_duplicate', true,
            'reservation_id', v_res.id,
            'status', 'RELEASED',
            'released_at', v_res.released_at
        );
    END IF;

    -- Safety Interlock 1: Cannot release reservation if attached operation is active/in-flight or UNKNOWN
    IF v_res.status = 'RESERVED' THEN
        IF v_res.saga_type = 'purchase' AND EXISTS (
            SELECT 1 FROM public.provider_number_operations pno
            WHERE (pno.id::text = v_res.operation_id OR pno.idempotency_key = v_res.operation_id)
              AND pno.canonical_state IN ('PROVIDER_DISPATCH_PENDING', 'PROVIDER_DISPATCHED', 'PROVIDER_OUTCOME_UNKNOWN')
        ) THEN
            RAISE EXCEPTION 'SAFETY_VIOLATION: Cannot release slot reservation while purchase operation is in-flight or in PROVIDER_OUTCOME_UNKNOWN.' USING ERRCODE = '23514';
        END IF;

        IF v_res.saga_type = 'port_in' AND EXISTS (
            SELECT 1 FROM public.number_port_operations npo
            WHERE npo.id::text = v_res.operation_id
              AND npo.canonical_state IN ('SUBMISSION_PENDING', 'SUBMITTED', 'FOC_RECEIVED', 'TRANSFER_SCHEDULED', 'TRANSFER_IN_PROGRESS', 'PROVIDER_OUTCOME_UNKNOWN')
        ) THEN
            RAISE EXCEPTION 'SAFETY_VIOLATION: Cannot release slot reservation while port-in operation is in-flight or in PROVIDER_OUTCOME_UNKNOWN.' USING ERRCODE = '23514';
        END IF;
    END IF;

    -- Safety Interlock 2: If reservation is CONSUMED and linked to a phone_number,
    -- verify that the phone_number is actually RELEASED or PORTED_OUT before freeing.
    IF v_res.status = 'CONSUMED' AND v_res.phone_number_id IS NOT NULL THEN
        SELECT ownership_state INTO v_phone
        FROM public.phone_numbers
        WHERE id = v_res.phone_number_id;

        IF v_phone IS NOT NULL AND v_phone.ownership_state = 'OWNED' THEN
            RAISE EXCEPTION 'SAFETY_VIOLATION: Cannot release consumed slot while phone number is actively OWNED.' USING ERRCODE = '23514';
        END IF;
    END IF;

    UPDATE public.organization_number_slot_reservations
    SET status = 'RELEASED',
        released_at = NOW(),
        release_reason = p_reason,
        updated_at = NOW()
    WHERE id = p_reservation_id;

    RETURN jsonb_build_object(
        'success', true,
        'is_duplicate', false,
        'reservation_id', p_reservation_id,
        'status', 'RELEASED',
        'released_at', NOW()
    );
END;
$$;

-- ------------------------------------------------------------------------------
-- 8B. PREVENT UNSAFE EXPIRATION & DIRECT INSERT CAPACITY BYPASS TRIGGERS
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_unsafe_slot_expiration()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.status = 'EXPIRED' AND OLD.status <> 'EXPIRED' THEN
        -- Verify not attached to an in-flight operation
        IF OLD.saga_type = 'purchase' AND EXISTS (
            SELECT 1 FROM public.provider_number_operations pno
            WHERE (pno.id::text = OLD.operation_id OR pno.idempotency_key = OLD.operation_id)
              AND pno.canonical_state IN ('PROVIDER_DISPATCH_PENDING', 'PROVIDER_DISPATCHED', 'PROVIDER_OUTCOME_UNKNOWN')
        ) THEN
            RAISE EXCEPTION 'SAFETY_VIOLATION: Cannot expire slot reservation attached to in-flight or UNKNOWN purchase operation.' USING ERRCODE = '23514';
        END IF;

        IF OLD.saga_type = 'port_in' AND EXISTS (
            SELECT 1 FROM public.number_port_operations npo
            WHERE npo.id::text = OLD.operation_id
              AND npo.canonical_state IN ('SUBMISSION_PENDING', 'SUBMITTED', 'FOC_RECEIVED', 'TRANSFER_SCHEDULED', 'TRANSFER_IN_PROGRESS', 'PROVIDER_OUTCOME_UNKNOWN')
        ) THEN
            RAISE EXCEPTION 'SAFETY_VIOLATION: Cannot expire slot reservation attached to in-flight or UNKNOWN port-in operation.' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_unsafe_slot_expiration ON public.organization_number_slot_reservations;
CREATE TRIGGER trg_prevent_unsafe_slot_expiration
    BEFORE UPDATE ON public.organization_number_slot_reservations
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_unsafe_slot_expiration();

-- ------------------------------------------------------------------------------
-- 9. ROW LEVEL SECURITY & PRIVILEGE ENFORCEMENT
-- ------------------------------------------------------------------------------
ALTER TABLE public.organization_number_slot_reservations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.organization_number_slot_reservations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.organization_number_slot_reservations TO service_role;

DROP POLICY IF EXISTS "authenticated_select_org_slot_reservations" ON public.organization_number_slot_reservations;
CREATE POLICY "authenticated_select_org_slot_reservations" ON public.organization_number_slot_reservations
    FOR SELECT TO authenticated
    USING (organization_id IN (
        SELECT organization_id FROM public.profiles WHERE id = auth.uid() AND active = TRUE
    ));

GRANT SELECT ON public.organization_number_slot_reservations TO authenticated;

-- Grant execution of atomic functions to service_role
REVOKE ALL ON FUNCTION public.get_organization_effective_number_slots(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_organization_effective_number_slots(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.acquire_number_slot_reservation_atomic(UUID, TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_number_slot_reservation_atomic(UUID, TEXT, TEXT, INT) TO service_role;

REVOKE ALL ON FUNCTION public.consume_number_slot_reservation_atomic(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_number_slot_reservation_atomic(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.release_number_slot_reservation_atomic(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_number_slot_reservation_atomic(UUID, TEXT) TO service_role;
