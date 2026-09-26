-- ====================================================================
-- MIGRATION: PHASE 12.3 PROVISIONAL DISPATCH RPC & COST COLUMNS
-- Date: 2026-11-03
-- Adds execution cost tracking fields, capacity serialization advisory locking,
-- atomic pending creation with capacity enforcement, atomic dispatch claim RPC functions,
-- and authoritative capability persistence during reconciliation.
-- DO NOT EXECUTE REMOTELY AUTOMATICALLY — Subject to manual user review.
-- ====================================================================

-- 1. Add execution provider cost tracking columns to provider_number_operations
ALTER TABLE public.provider_number_operations 
ADD COLUMN IF NOT EXISTS execution_provider_cost_minor BIGINT NULL,
ADD COLUMN IF NOT EXISTS execution_provider_cost_currency VARCHAR(3) NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_execution_provider_cost_minor_non_negative'
    ) THEN
        ALTER TABLE public.provider_number_operations 
        ADD CONSTRAINT check_execution_provider_cost_minor_non_negative 
        CHECK (execution_provider_cost_minor IS NULL OR execution_provider_cost_minor >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_execution_provider_cost_currency_format'
    ) THEN
        ALTER TABLE public.provider_number_operations 
        ADD CONSTRAINT check_execution_provider_cost_currency_format 
        CHECK (execution_provider_cost_currency IS NULL OR execution_provider_cost_currency ~ '^[A-Z]{3}$');
    END IF;
END $$;

-- 2. Atomic Purchase Operation Pending Creation RPC Function (Hardened SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.create_purchase_op_pending(
    p_organization_id UUID,
    p_phone_number_e164 TEXT,
    p_country_code TEXT,
    p_number_type TEXT,
    p_idempotency_key TEXT,
    p_request_fingerprint TEXT,
    p_retail_amount_minor INT,
    p_retail_currency TEXT,
    p_provider_cost_minor INT,
    p_provider_cost_currency TEXT,
    p_pricing_source TEXT,
    p_pricing_policy_id UUID DEFAULT NULL,
    p_gross_margin_minor INT DEFAULT NULL,
    p_price_snapshot_payload JSONB DEFAULT NULL,
    p_compliance_profile_id UUID DEFAULT NULL,
    p_regulatory_bundle_sid TEXT DEFAULT NULL,
    p_regulatory_provisioning_context JSONB DEFAULT NULL,
    p_max_capacity_limit INT DEFAULT NULL
) RETURNS public.provider_number_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_existing public.provider_number_operations;
    v_new_op public.provider_number_operations;
    v_computed_gross_margin INT;
    v_owned_count INT;
    v_inflight_count INT;
BEGIN
    -- 1. Acquire organization capacity serialization lock
    PERFORM pg_advisory_xact_lock(hashtext('org_number_capacity:' || p_organization_id::text));

    -- 2. Check existing idempotency key for organization FIRST (safe replay before capacity calculation)
    SELECT * INTO v_existing 
    FROM public.provider_number_operations 
    WHERE organization_id = p_organization_id AND idempotency_key = p_idempotency_key;

    IF FOUND THEN
        IF v_existing.request_fingerprint <> p_request_fingerprint THEN
            RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Request fingerprint does not match existing idempotency key.' USING ERRCODE = '23505';
        END IF;
        RETURN v_existing;
    END IF;

    -- 3. Fail closed if server-authoritative capacity limit is missing or non-positive
    IF p_max_capacity_limit IS NULL OR p_max_capacity_limit <= 0 THEN
        RAISE EXCEPTION 'INVALID_CAPACITY_LIMIT: Server-authoritative line capacity limit is required and must be greater than zero.' USING ERRCODE = '23505';
    END IF;

    -- 4. Check active capacity limits against server-authoritative allowance
    SELECT COUNT(*) INTO v_owned_count 
    FROM public.phone_numbers 
    WHERE organization_id = p_organization_id AND status IN ('active', 'inactive', 'suspended');

    SELECT COUNT(*) INTO v_inflight_count 
    FROM public.provider_number_operations 
    WHERE organization_id = p_organization_id 
      AND operation_type = 'purchase_number' 
      AND status IN ('pending', 'in_progress', 'reconciliation_required', 'manual_review_required');

    IF (v_owned_count + v_inflight_count) >= p_max_capacity_limit THEN
        RAISE EXCEPTION 'CAPACITY_LIMIT_EXCEEDED: Organization number capacity limit reached (% owned + % in-flight >= % limit).', 
            v_owned_count, v_inflight_count, p_max_capacity_limit 
            USING ERRCODE = '23505';
    END IF;

    -- 5. Check active ownership in phone_numbers
    IF EXISTS (
        SELECT 1 FROM public.phone_numbers 
        WHERE phone_number = p_phone_number_e164 AND status IN ('active', 'inactive', 'suspended')
    ) THEN
        RAISE EXCEPTION 'NUMBER_ALREADY_OWNED: The requested phone number is already owned on the platform.' USING ERRCODE = '23505';
    END IF;

    -- 6. Check active purchase lock in provider_number_operations
    IF EXISTS (
        SELECT 1 FROM public.provider_number_operations
        WHERE phone_number_e164 = p_phone_number_e164 
          AND operation_type = 'purchase_number' 
          AND status IN ('pending', 'in_progress', 'reconciliation_required', 'manual_review_required')
    ) THEN
        RAISE EXCEPTION 'ACTIVE_PURCHASE_LOCK_EXISTS: Another operation is actively processing this phone number.' USING ERRCODE = '23505';
    END IF;

    v_computed_gross_margin := COALESCE(p_gross_margin_minor, p_retail_amount_minor - p_provider_cost_minor);

    -- 7. Insert new operation record in 'pending' status
    INSERT INTO public.provider_number_operations (
        organization_id, operation_type, provider, phone_number_e164, number_type, country_code,
        status, idempotency_key, request_fingerprint, retail_amount_minor, retail_currency,
        provider_cost_minor, provider_cost_currency, pricing_source, pricing_policy_id,
        gross_margin_minor, price_snapshot_payload, compliance_profile_id, regulatory_bundle_sid,
        regulatory_provisioning_context, attempt_count, started_at
    ) VALUES (
        p_organization_id, 'purchase_number', 'twilio', p_phone_number_e164, p_number_type, p_country_code,
        'pending', p_idempotency_key, p_request_fingerprint, p_retail_amount_minor, p_retail_currency,
        p_provider_cost_minor, p_provider_cost_currency, p_pricing_source, p_pricing_policy_id,
        v_computed_gross_margin, p_price_snapshot_payload, p_compliance_profile_id, p_regulatory_bundle_sid,
        p_regulatory_provisioning_context, 0, NULL
    ) RETURNING * INTO v_new_op;

    RETURN v_new_op;
END;
$$;

-- Explicitly revoke execution on create_purchase_op_pending from all client roles
REVOKE EXECUTE ON FUNCTION public.create_purchase_op_pending(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INT, TEXT, INT, TEXT, TEXT, UUID, INT, JSONB, UUID, TEXT, JSONB, INT
) FROM PUBLIC, anon, authenticated;

-- Grant execution strictly to service_role
GRANT EXECUTE ON FUNCTION public.create_purchase_op_pending(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INT, TEXT, INT, TEXT, TEXT, UUID, INT, JSONB, UUID, TEXT, JSONB, INT
) TO service_role;

-- 3. Atomic Dispatch Claim RPC Function with Tenant Predicate (Hardened SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.claim_purchase_op_dispatch(
    p_operation_id UUID,
    p_organization_id UUID
) RETURNS public.provider_number_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_op public.provider_number_operations;
BEGIN
    -- 1. Select row with FOR UPDATE lock matching BOTH operation_id AND organization_id
    SELECT * INTO v_op 
    FROM public.provider_number_operations 
    WHERE id = p_operation_id 
      AND organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'CLAIM_FAILED: Operation % for organization % does not exist.', p_operation_id, p_organization_id USING ERRCODE = '22000';
    END IF;

    IF v_op.status <> 'pending' THEN
        RAISE EXCEPTION 'CLAIM_FAILED: Operation % is in state % and cannot be claimed for dispatch.', p_operation_id, v_op.status USING ERRCODE = '22000';
    END IF;

    -- 2. Atomically transition to in_progress and increment attempt_count
    UPDATE public.provider_number_operations
    SET status = 'in_progress',
        started_at = NOW(),
        attempt_count = v_op.attempt_count + 1,
        updated_at = NOW()
    WHERE id = p_operation_id AND organization_id = p_organization_id
    RETURNING * INTO v_op;

    RETURN v_op;
END;
$$;

-- Explicitly revoke execution on claim_purchase_op_dispatch from all client roles
REVOKE EXECUTE ON FUNCTION public.claim_purchase_op_dispatch(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- Grant execution strictly to service_role
GRANT EXECUTE ON FUNCTION public.claim_purchase_op_dispatch(UUID, UUID) TO service_role;

-- 4. Authoritative Capability Reconciliation Function Override (Hardened SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.reconcile_provider_number_purchase_v2(
    p_operation_id UUID,
    p_provider_resource_id TEXT,
    p_provider_status TEXT DEFAULT 'active'
) RETURNS public.provider_number_operations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_op public.provider_number_operations;
    v_phone_id UUID;
    v_cap_voice BOOLEAN;
    v_cap_sms BOOLEAN;
    v_cap_mms BOOLEAN;
BEGIN
    SELECT * INTO v_op FROM public.provider_number_operations WHERE id = p_operation_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'OPERATION_NOT_FOUND: Operation ID % does not exist.', p_operation_id;
    END IF;

    -- Extract authoritative provider capabilities stored in regulatory_provisioning_context or default safely
    v_cap_voice := COALESCE((v_op.regulatory_provisioning_context->'capabilities'->>'voice')::boolean, true);
    v_cap_sms := COALESCE((v_op.regulatory_provisioning_context->'capabilities'->>'sms')::boolean, true);
    v_cap_mms := COALESCE((v_op.regulatory_provisioning_context->'capabilities'->>'mms')::boolean, false);

    -- 1. Ensure phone_numbers record exists idempotently with authoritative capabilities
    INSERT INTO public.phone_numbers (
        organization_id, phone_number, country_code, number_type, status, acquisition_source, active,
        capabilities_voice, capabilities_sms, capabilities_mms
    ) VALUES (
        v_op.organization_id, v_op.phone_number_e164, v_op.country_code, v_op.number_type, 'active', 'provider_purchase', true,
        v_cap_voice, v_cap_sms, v_cap_mms
    )
    ON CONFLICT (phone_number) DO UPDATE SET 
        status = 'active', 
        active = true,
        capabilities_voice = v_cap_voice,
        capabilities_sms = v_cap_sms,
        capabilities_mms = v_cap_mms
    RETURNING id INTO v_phone_id;

    -- 2. Ensure number_provider_mappings record exists idempotently
    INSERT INTO public.number_provider_mappings (
        phone_number_id, provider, provider_resource_id, provider_status
    ) VALUES (
        v_phone_id, v_op.provider, p_provider_resource_id, p_provider_status
    )
    ON CONFLICT (provider, provider_resource_id) DO UPDATE SET provider_status = p_provider_status;

    -- 3. Update operation to succeeded
    UPDATE public.provider_number_operations
    SET status = 'succeeded',
        provider_resource_id = p_provider_resource_id,
        provider_status = p_provider_status,
        completed_at = NOW(),
        last_reconciled_at = NOW()
    WHERE id = p_operation_id
    RETURNING * INTO v_op;

    RETURN v_op;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reconcile_provider_number_purchase_v2(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_provider_number_purchase_v2(UUID, TEXT, TEXT) TO service_role;
