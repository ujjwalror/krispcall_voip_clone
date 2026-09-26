-- ====================================================================
-- MIGRATION: PHASE 7.3 BUSINESS NUMBER MANAGEMENT RPC
-- Date: 2026-10-04
-- Provides an atomic PostgreSQL RPC function to set a workspace primary phone number.
-- ====================================================================

CREATE OR REPLACE FUNCTION public.set_primary_phone_number(p_phone_number_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user_id UUID;
    v_org_id UUID;
    v_role TEXT;
    v_target_phone RECORD;
BEGIN
    -- 1. Authenticate calling user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized. Authenticated session required.';
    END IF;

    -- 2. Fetch calling user profile & role
    SELECT organization_id, role INTO v_org_id, v_role
    FROM public.profiles
    WHERE id = v_user_id;

    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'Forbidden. User organization assignment not found.';
    END IF;

    -- 3. Enforce Role Authority (Owner & Admin only)
    IF v_role NOT IN ('owner', 'admin') THEN
        RAISE EXCEPTION 'Forbidden. Only organization Owners and Admins can change primary business number settings.';
    END IF;

    -- 4. Fetch & validate target phone number within tenant boundary
    SELECT * INTO v_target_phone
    FROM public.phone_numbers
    WHERE id = p_phone_number_id AND organization_id = v_org_id;

    IF v_target_phone IS NULL THEN
        RAISE EXCEPTION 'Not Found. Phone number record not found or does not belong to your organization.';
    END IF;

    -- 5. Enforce Status & Active Protections
    IF v_target_phone.active IS NOT TRUE OR v_target_phone.status != 'active' THEN
        RAISE EXCEPTION 'Bad Request. Only active business numbers can be designated as primary.';
    END IF;

    -- 6. Atomic Transaction: Clear previous primary flags for organization and set target number as primary
    UPDATE public.phone_numbers
    SET is_primary = FALSE,
        updated_at = NOW()
    WHERE organization_id = v_org_id AND is_primary = TRUE;

    UPDATE public.phone_numbers
    SET is_primary = TRUE,
        updated_at = NOW()
    WHERE id = p_phone_number_id AND organization_id = v_org_id;

    RETURN jsonb_build_object(
        'success', true,
        'phone_number_id', p_phone_number_id,
        'organization_id', v_org_id
    );
END;
$$;

-- Explicitly revoke PUBLIC execute permission and grant only to authenticated role
REVOKE ALL ON FUNCTION public.set_primary_phone_number(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_primary_phone_number(UUID) TO authenticated;
