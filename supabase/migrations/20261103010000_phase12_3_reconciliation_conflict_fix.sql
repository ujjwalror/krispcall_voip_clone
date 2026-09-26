-- ====================================================================
-- MIGRATION: PHASE 12.3 OWNERSHIP RECONCILIATION CONFLICT TARGET FIX
-- Date: 2026-11-03
-- Fixes ON CONFLICT specification in reconcile_provider_number_purchase_v2
-- to match deployed partial unique index idx_phone_numbers_active_ownership
-- (WHERE status IN ('active', 'inactive', 'suspended')).
-- Enforces cross-tenant ownership protection and preserves durable capabilities.
-- DO NOT EXECUTE REMOTELY AUTOMATICALLY — Subject to manual user review.
-- ====================================================================

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
    v_existing_phone public.phone_numbers;
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

    -- Cross-tenant ownership safety check: reject if active ownership belongs to a different organization
    SELECT * INTO v_existing_phone
    FROM public.phone_numbers
    WHERE phone_number = v_op.phone_number_e164
      AND status IN ('active', 'inactive', 'suspended');

    IF FOUND THEN
        IF v_existing_phone.organization_id <> v_op.organization_id THEN
            RAISE EXCEPTION 'OWNERSHIP_CONFLICT: Phone number % is already actively owned by organization %.', 
                v_op.phone_number_e164, v_existing_phone.organization_id 
                USING ERRCODE = '23505';
        END IF;
    END IF;

    -- 1. Ensure phone_numbers record exists idempotently with authoritative capabilities matching partial unique index
    INSERT INTO public.phone_numbers (
        organization_id, phone_number, country_code, number_type, status, acquisition_source, active,
        capabilities_voice, capabilities_sms, capabilities_mms
    ) VALUES (
        v_op.organization_id, v_op.phone_number_e164, v_op.country_code, v_op.number_type, 'active', 'provider_purchase', true,
        v_cap_voice, v_cap_sms, v_cap_mms
    )
    ON CONFLICT (phone_number) WHERE status IN ('active', 'inactive', 'suspended') DO UPDATE SET 
        status = 'active', 
        active = true,
        capabilities_voice = v_cap_voice,
        capabilities_sms = v_cap_sms,
        capabilities_mms = v_cap_mms
    RETURNING id INTO v_phone_id;

    IF v_phone_id IS NULL THEN
        SELECT id INTO v_phone_id 
        FROM public.phone_numbers 
        WHERE phone_number = v_op.phone_number_e164 
          AND status IN ('active', 'inactive', 'suspended');
    END IF;

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

-- Security hardening: REVOKE from PUBLIC/anon/authenticated, GRANT to service_role only
REVOKE EXECUTE ON FUNCTION public.reconcile_provider_number_purchase_v2(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_provider_number_purchase_v2(UUID, TEXT, TEXT) TO service_role;
