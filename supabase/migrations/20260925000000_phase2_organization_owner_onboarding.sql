-- ====================================================================
-- PHASE 2 MIGRATION: PUBLIC SAAS ORGANIZATION STATUS, OWNER ROLE & ONBOARDING
-- Date: 2026-09-25
-- Forward-only database schema update for Public SaaS Foundation Phase 2
-- ====================================================================

-- 1. Add status column to public.organizations with active default and check constraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'status'
    ) THEN
        ALTER TABLE public.organizations ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE table_schema = 'public' AND table_name = 'organizations' AND constraint_name = 'organizations_status_check'
    ) THEN
        ALTER TABLE public.organizations ADD CONSTRAINT organizations_status_check CHECK (status IN ('active', 'suspended', 'deactivated'));
    END IF;
END $$;

-- 2. Update role check constraint on public.profiles to allow ('owner', 'admin', 'manager', 'agent')
DO $$
BEGIN
    ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('owner', 'admin', 'manager', 'agent'));
END $$;

-- 3. Secure Atomic Database Function: Create Organization with Owner Profile
-- Strictly derives authenticated user identity (auth.uid() and auth.users.email) database-side with empty search_path.
CREATE OR REPLACE FUNCTION public.create_organization_with_owner(
    p_org_name TEXT,
    p_org_slug TEXT,
    p_full_name TEXT
)
RETURNS TABLE (
    organization_id UUID,
    profile_id UUID,
    slug TEXT,
    role TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID;
    v_email TEXT;
    v_org_id UUID;
    v_clean_name TEXT;
    v_base_identity TEXT;
    v_twilio_identity TEXT;
    v_suffix INT;
BEGIN
    -- 1. Derive & validate authenticated user session
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized. Authenticated user session required for onboarding.';
    END IF;

    -- 2. Derive user email securely from auth.users database table
    SELECT u.email INTO v_email
    FROM auth.users u
    WHERE u.id = v_user_id;

    IF v_email IS NULL OR pg_catalog.btrim(v_email) = '' THEN
        RAISE EXCEPTION 'Authenticated user email address not found.';
    END IF;

    -- 3. Ensure user profile does not already exist
    IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user_id) THEN
        RAISE EXCEPTION 'User profile already exists for this account.';
    END IF;

    -- 4. Validate organization name input
    IF p_org_name IS NULL OR pg_catalog.length(pg_catalog.btrim(p_org_name)) < 2 OR pg_catalog.length(pg_catalog.btrim(p_org_name)) > 100 THEN
        RAISE EXCEPTION 'Organization name must be between 2 and 100 characters long.';
    END IF;

    -- 5. Validate full name input
    IF p_full_name IS NULL OR pg_catalog.length(pg_catalog.btrim(p_full_name)) < 2 OR pg_catalog.length(pg_catalog.btrim(p_full_name)) > 100 THEN
        RAISE EXCEPTION 'Full name must be between 2 and 100 characters long.';
    END IF;

    -- 6. Validate workspace URL slug format (2-50 lowercase alphanumeric characters or hyphens, starting/ending with alphanumeric)
    IF p_org_slug IS NULL
       OR pg_catalog.length(pg_catalog.btrim(p_org_slug)) < 2
       OR pg_catalog.length(pg_catalog.btrim(p_org_slug)) > 50
       OR pg_catalog.btrim(p_org_slug) !~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'
    THEN
        RAISE EXCEPTION 'Invalid workspace slug. Must be 2-50 lowercase alphanumeric characters or hyphens, starting and ending with a letter or digit.';
    END IF;

    -- 7. Ensure organization slug is unique
    IF EXISTS (SELECT 1 FROM public.organizations WHERE slug = pg_catalog.btrim(p_org_slug)) THEN
        RAISE EXCEPTION 'Organization workspace URL slug "%" is already taken.', pg_catalog.btrim(p_org_slug);
    END IF;

    -- 8. Safely generate database-side unique Twilio identity (Format: owner_john_doe)
    v_clean_name := pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(p_full_name), '[^a-zA-Z0-9]+', '_', 'g'));
    v_clean_name := pg_catalog.btrim(v_clean_name, '_');
    IF v_clean_name IS NULL OR v_clean_name = '' THEN
        v_clean_name := 'user';
    END IF;

    v_base_identity := 'owner_' || v_clean_name;
    v_twilio_identity := v_base_identity;
    v_suffix := 2;

    WHILE EXISTS (SELECT 1 FROM public.profiles WHERE twilio_identity = v_twilio_identity) LOOP
        v_twilio_identity := v_base_identity || '_' || v_suffix;
        v_suffix := v_suffix + 1;
    END LOOP;

    -- 9. Insert Organization (status = 'active')
    INSERT INTO public.organizations (name, slug, status)
    VALUES (pg_catalog.btrim(p_org_name), pg_catalog.btrim(p_org_slug), 'active')
    RETURNING id INTO v_org_id;

    -- 10. Insert Owner Profile (role = 'owner', active = true, extension = NULL)
    INSERT INTO public.profiles (
        id,
        organization_id,
        full_name,
        email,
        role,
        extension,
        active,
        availability_status,
        twilio_identity
    )
    VALUES (
        v_user_id,
        v_org_id,
        pg_catalog.btrim(p_full_name),
        v_email,
        'owner',
        NULL, -- Owner is not an inbound call routing agent; extension remains NULL initially
        TRUE,
        'offline',
        v_twilio_identity
    );

    RETURN QUERY
    SELECT v_org_id, v_user_id, pg_catalog.btrim(p_org_slug), 'owner'::TEXT;
END;
$$;

-- 4. Restrict EXECUTE Permissions: Revoke PUBLIC / anon, Grant ONLY to authenticated
REVOKE ALL ON FUNCTION public.create_organization_with_owner(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_organization_with_owner(TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_organization_with_owner(TEXT, TEXT, TEXT) TO authenticated;
