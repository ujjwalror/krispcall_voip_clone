-- Phase 9.Y Migration: Unsaved Caller Ownership & Agent Reassignment
-- Date: 2026-09-17

-- 1. Create public.caller_assignments table
CREATE TABLE IF NOT EXISTS public.caller_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    phone_number TEXT NOT NULL,
    assigned_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    assignment_source TEXT NOT NULL DEFAULT 'auto_answered' CHECK (
        assignment_source IN ('auto_answered', 'manual')
    ),
    assigned_by_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_caller_assignments_org_phone UNIQUE (organization_id, phone_number)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_caller_assignments_lookup 
ON public.caller_assignments (organization_id, phone_number);

CREATE INDEX IF NOT EXISTS idx_caller_assignments_user 
ON public.caller_assignments (assigned_user_id);

-- Standard updated_at trigger using existing project function
DROP TRIGGER IF EXISTS update_caller_assignments_updated_at ON public.caller_assignments;
CREATE TRIGGER update_caller_assignments_updated_at
    BEFORE UPDATE ON public.caller_assignments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 2. Database validation trigger on caller_assignments
CREATE OR REPLACE FUNCTION public.validate_caller_assignment()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.assigned_user_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = NEW.assigned_user_id
              AND p.organization_id = NEW.organization_id
              AND p.active = TRUE
              AND p.role IN ('manager', 'agent')
        ) THEN
            RAISE EXCEPTION 'assigned_user_id must be an active manager or agent within the same organization';
        END IF;
    END IF;

    IF NEW.assigned_by_user_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = NEW.assigned_by_user_id
              AND p.organization_id = NEW.organization_id
        ) THEN
            RAISE EXCEPTION 'assigned_by_user_id must belong to the same organization';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS check_caller_assignment_boundaries ON public.caller_assignments;
CREATE TRIGGER check_caller_assignment_boundaries
    BEFORE INSERT OR UPDATE ON public.caller_assignments
    FOR EACH ROW EXECUTE FUNCTION public.validate_caller_assignment();

REVOKE ALL ON FUNCTION public.validate_caller_assignment() FROM PUBLIC, authenticated;

-- 3. RLS Configuration for caller_assignments
ALTER TABLE public.caller_assignments ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'caller_assignments' AND policyname = 'Service role full access on caller_assignments'
    ) THEN
        CREATE POLICY "Service role full access on caller_assignments"
        ON public.caller_assignments FOR ALL
        TO service_role
        USING (true)
        WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'caller_assignments' AND policyname = 'Users can view caller assignments in their organization'
    ) THEN
        CREATE POLICY "Users can view caller assignments in their organization"
        ON public.caller_assignments FOR SELECT
        TO authenticated
        USING (
            organization_id IN (
                SELECT organization_id FROM public.profiles WHERE id = auth.uid()
            )
        );
    END IF;
END $$;

-- 4. SECURITY DEFINER Atomic Contact Conversion RPC: convert_lead_to_contact
CREATE OR REPLACE FUNCTION public.convert_lead_to_contact(
    p_organization_id UUID,
    p_first_name TEXT,
    p_last_name TEXT,
    p_full_name TEXT,
    p_phone TEXT,
    p_email TEXT,
    p_company TEXT,
    p_notes TEXT,
    p_is_blocked BOOLEAN,
    p_created_by UUID,
    p_explicit_assigned_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    organization_id UUID,
    first_name TEXT,
    last_name TEXT,
    full_name TEXT,
    company TEXT,
    phone TEXT,
    email TEXT,
    notes TEXT,
    is_blocked BOOLEAN,
    created_by UUID,
    assigned_user_id UUID,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_normalized_phone TEXT;
    v_inherited_assigned_user_id UUID := NULL;
    v_final_assigned_user_id UUID := NULL;
    v_new_contact RECORD;
    v_lock_key INT;
BEGIN
    -- 1. Validate mandatory inputs
    IF p_organization_id IS NULL OR p_phone IS NULL OR p_full_name IS NULL THEN
        RAISE EXCEPTION 'organization_id, phone, and full_name are required';
    END IF;

    v_normalized_phone := TRIM(p_phone);

    -- 2. Acquire deterministic advisory transaction lock on (organization_id, phone_number)
    v_lock_key := hashtext(p_organization_id::text || ':' || v_normalized_phone);
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- 3. Lock and check if an unsaved caller assignment exists
    SELECT ca.assigned_user_id INTO v_inherited_assigned_user_id
    FROM public.caller_assignments ca
    WHERE ca.organization_id = p_organization_id
      AND ca.phone_number = v_normalized_phone;

    -- 4. Determine final assigned_user_id
    IF p_explicit_assigned_user_id IS NOT NULL THEN
        v_final_assigned_user_id := p_explicit_assigned_user_id;
    ELSE
        v_final_assigned_user_id := v_inherited_assigned_user_id;
    END IF;

    -- 5. Validate non-null final assigned user if present
    IF v_final_assigned_user_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = v_final_assigned_user_id
              AND p.organization_id = p_organization_id
              AND p.active = TRUE
              AND p.role IN ('manager', 'agent')
        ) THEN
            RAISE EXCEPTION 'Invalid assigned_user_id. Must be an active manager or agent within the same organization';
        END IF;
    END IF;

    -- 6. Insert Contact
    INSERT INTO public.contacts (
        organization_id,
        first_name,
        last_name,
        full_name,
        phone,
        email,
        company,
        notes,
        is_blocked,
        created_by,
        assigned_user_id
    ) VALUES (
        p_organization_id,
        p_first_name,
        p_last_name,
        p_full_name,
        v_normalized_phone,
        p_email,
        p_company,
        p_notes,
        p_is_blocked,
        p_created_by,
        v_final_assigned_user_id
    )
    RETURNING * INTO v_new_contact;

    -- 7. ONLY after successful Contact creation, delete caller_assignments row
    DELETE FROM public.caller_assignments ca
    WHERE ca.organization_id = p_organization_id
      AND ca.phone_number = v_normalized_phone;

    -- Return newly created Contact record
    id := v_new_contact.id;
    organization_id := v_new_contact.organization_id;
    first_name := v_new_contact.first_name;
    last_name := v_new_contact.last_name;
    full_name := v_new_contact.full_name;
    company := v_new_contact.company;
    phone := v_new_contact.phone;
    email := v_new_contact.email;
    notes := v_new_contact.notes;
    is_blocked := v_new_contact.is_blocked;
    created_by := v_new_contact.created_by;
    assigned_user_id := v_new_contact.assigned_user_id;
    created_at := v_new_contact.created_at;
    updated_at := v_new_contact.updated_at;
    RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.convert_lead_to_contact(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, UUID, UUID) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.convert_lead_to_contact(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, UUID, UUID) TO service_role;

-- 5. SECURITY DEFINER Atomic Auto-Answer Ownership RPC: try_auto_assign_caller
CREATE OR REPLACE FUNCTION public.try_auto_assign_caller(
    p_organization_id UUID,
    p_phone TEXT,
    p_assigned_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_normalized_phone TEXT;
    v_lock_key INT;
BEGIN
    IF p_organization_id IS NULL OR p_phone IS NULL OR p_assigned_user_id IS NULL THEN
        RETURN FALSE;
    END IF;

    v_normalized_phone := TRIM(p_phone);

    -- 1. Acquire deterministic advisory transaction lock on (organization_id, phone_number)
    v_lock_key := hashtext(p_organization_id::text || ':' || v_normalized_phone);
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- 2. Verify no saved Contact exists for this phone number
    IF EXISTS (
        SELECT 1 FROM public.contacts c
        WHERE c.organization_id = p_organization_id
          AND c.phone = v_normalized_phone
          AND c.archived_at IS NULL
    ) THEN
        RETURN FALSE;
    END IF;

    -- 3. Insert caller_assignment (ON CONFLICT DO NOTHING)
    INSERT INTO public.caller_assignments (
        organization_id,
        phone_number,
        assigned_user_id,
        assignment_source,
        assigned_by_user_id
    ) VALUES (
        p_organization_id,
        v_normalized_phone,
        p_assigned_user_id,
        'auto_answered',
        p_assigned_user_id
    )
    ON CONFLICT (organization_id, phone_number) DO NOTHING;

    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.try_auto_assign_caller(UUID, TEXT, UUID) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.try_auto_assign_caller(UUID, TEXT, UUID) TO service_role;

-- 6. SECURITY DEFINER Atomic Manual Caller Assignment RPC: manually_assign_caller
-- Cleanup obsolete 5-argument function signature if present
DROP FUNCTION IF EXISTS public.manually_assign_caller(UUID, TEXT, UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.manually_assign_caller(UUID, TEXT, UUID, UUID);

CREATE OR REPLACE FUNCTION public.manually_assign_caller(
    p_organization_id UUID,
    p_phone TEXT,
    p_assigned_user_id UUID,
    p_assigned_by_user_id UUID
)
RETURNS TABLE (
    is_contact BOOLEAN,
    contact_id UUID,
    assigned_user_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_normalized_phone TEXT;
    v_lock_key INT;
    v_actor_role TEXT;
    v_existing_contact_id UUID;
    v_existing_assigned_user_id UUID;
    v_existing_assignment_user_id UUID;
BEGIN
    -- 1. Validate mandatory inputs
    IF p_organization_id IS NULL OR p_phone IS NULL OR p_assigned_by_user_id IS NULL THEN
        RAISE EXCEPTION 'organization_id, phone, and assigned_by_user_id are required';
    END IF;

    -- 2. Derivation & verification of actor profile, organization, active status, and role directly from public.profiles
    SELECT p.role INTO v_actor_role
    FROM public.profiles p
    WHERE p.id = p_assigned_by_user_id
      AND p.organization_id = p_organization_id
      AND p.active = TRUE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Forbidden. Invalid, inactive, or cross-organization actor';
    END IF;

    IF v_actor_role NOT IN ('admin', 'manager', 'agent') THEN
        RAISE EXCEPTION 'Forbidden. Actor role is unauthorized for caller assignment operations';
    END IF;

    v_normalized_phone := TRIM(p_phone);

    -- 3. Acquire deterministic advisory transaction lock on (organization_id, phone_number)
    v_lock_key := hashtext(p_organization_id::text || ':' || v_normalized_phone);
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- 4. Validate target assigned user if non-null
    IF p_assigned_user_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = p_assigned_user_id
              AND p.organization_id = p_organization_id
              AND p.active = TRUE
              AND p.role IN ('manager', 'agent')
        ) THEN
            RAISE EXCEPTION 'Target user must be an active manager or agent within the same organization';
        END IF;
    END IF;

    -- 5. Check for saved Contact first
    SELECT c.id, c.assigned_user_id INTO v_existing_contact_id, v_existing_assigned_user_id
    FROM public.contacts c
    WHERE c.organization_id = p_organization_id
      AND c.phone = v_normalized_phone
      AND c.archived_at IS NULL;

    IF v_existing_contact_id IS NOT NULL THEN
        -- Permission check using database-authoritative v_actor_role
        IF v_actor_role = 'agent' THEN
            IF v_existing_assigned_user_id IS NULL OR v_existing_assigned_user_id <> p_assigned_by_user_id THEN
                RAISE EXCEPTION 'Agents can only reassign contacts currently assigned to themselves';
            END IF;
        END IF;

        UPDATE public.contacts
        SET assigned_user_id = p_assigned_user_id,
            updated_at = NOW()
        WHERE id = v_existing_contact_id;

        is_contact := TRUE;
        contact_id := v_existing_contact_id;
        assigned_user_id := p_assigned_user_id;
        RETURN NEXT;
        RETURN;
    END IF;

    -- 6. Check existing caller_assignment for permission check
    SELECT ca.assigned_user_id INTO v_existing_assignment_user_id
    FROM public.caller_assignments ca
    WHERE ca.organization_id = p_organization_id
      AND ca.phone_number = v_normalized_phone;

    IF v_actor_role = 'agent' THEN
        IF v_existing_assignment_user_id IS NULL OR v_existing_assignment_user_id <> p_assigned_by_user_id THEN
            RAISE EXCEPTION 'Agents can only reassign callers currently assigned to themselves';
        END IF;
    END IF;

    -- 7. Upsert into caller_assignments (ON CONFLICT DO UPDATE)
    INSERT INTO public.caller_assignments (
        organization_id,
        phone_number,
        assigned_user_id,
        assignment_source,
        assigned_by_user_id,
        updated_at
    ) VALUES (
        p_organization_id,
        v_normalized_phone,
        p_assigned_user_id,
        'manual',
        p_assigned_by_user_id,
        NOW()
    )
    ON CONFLICT (organization_id, phone_number) DO UPDATE
    SET assigned_user_id = EXCLUDED.assigned_user_id,
        assignment_source = 'manual',
        assigned_by_user_id = EXCLUDED.assigned_by_user_id,
        updated_at = NOW();

    is_contact := FALSE;
    contact_id := NULL;
    assigned_user_id := p_assigned_user_id;
    RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.manually_assign_caller(UUID, TEXT, UUID, UUID) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.manually_assign_caller(UUID, TEXT, UUID, UUID) TO service_role;
