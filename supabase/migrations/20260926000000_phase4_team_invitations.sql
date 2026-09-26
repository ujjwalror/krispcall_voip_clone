-- ====================================================================
-- PHASE 4.1 MIGRATION: PUBLIC SAAS TEAM INVITATIONS & SEATS FOUNDATION
-- Date: 2026-09-26
-- Forward-only database schema update for Phase 4 Team Invitations (Hardened)
-- ====================================================================

-- 1. Create public.organization_invitations Table
CREATE TABLE IF NOT EXISTS public.organization_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'agent')),
    invited_by_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    token_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'cancelled', 'expired')),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (pg_catalog.now() + INTERVAL '7 days'),
    accepted_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- 2. Indexes for Performance & Constraints (Case-insensitive email unique index for pending invites)
CREATE INDEX IF NOT EXISTS idx_org_invitations_org_email ON public.organization_invitations(organization_id, email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invitations_token_hash ON public.organization_invitations(token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_pending_invitation ON public.organization_invitations(organization_id, pg_catalog.lower(email)) WHERE status = 'pending';

-- 3. Enable RLS on public.organization_invitations
ALTER TABLE public.organization_invitations ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Owners and Admins can view invitations for their organization via Client SDK
CREATE POLICY "Owners and Admins view organization invitations"
    ON public.organization_invitations FOR SELECT
    TO authenticated
    USING (
        organization_id = public.get_auth_organization_id()
        AND EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

-- Note: Direct client SDK INSERT/UPDATE/DELETE on organization_invitations is denied by default.
-- All invitation creations & cancellations are processed through trusted API routes (/api/invitations/*)
-- using Service Role Client for maximum server-authoritative security.

-- 4. Secure Atomic Database Function: Accept Organization Invitation
CREATE OR REPLACE FUNCTION public.accept_organization_invitation(
    p_token_hash TEXT,
    p_full_name TEXT DEFAULT NULL
)
RETURNS TABLE (
    organization_id UUID,
    profile_id UUID,
    role TEXT,
    extension TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID;
    v_email TEXT;
    v_user_meta_name TEXT;
    v_invitation RECORD;
    v_full_name TEXT;
    v_clean_name TEXT;
    v_base_identity TEXT;
    v_twilio_identity TEXT;
    v_suffix INT;
    v_next_ext INT;
    v_extension_str TEXT;
BEGIN
    -- 1. Derive authenticated user session
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized. Authenticated session required to accept invitation.';
    END IF;

    -- 2. Derive user email securely from auth.users database table
    SELECT u.email, (u.raw_user_meta_data->>'full_name') INTO v_email, v_user_meta_name
    FROM auth.users u
    WHERE u.id = v_user_id;

    IF v_email IS NULL OR pg_catalog.btrim(v_email) = '' THEN
        RAISE EXCEPTION 'Authenticated email address not found.';
    END IF;

    -- 3. Check if user already has an active profile in any organization
    IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user_id) THEN
        RAISE EXCEPTION 'You already belong to a workspace organization.';
    END IF;

    -- 4. Fetch and lock invitation record by pre-hashed SHA-256 token
    SELECT * INTO v_invitation
    FROM public.organization_invitations
    WHERE token_hash = pg_catalog.btrim(p_token_hash)
    FOR UPDATE;

    IF v_invitation.id IS NULL THEN
        RAISE EXCEPTION 'Invalid invitation token.';
    END IF;

    IF v_invitation.status <> 'pending' THEN
        RAISE EXCEPTION 'Invitation is no longer pending (current status: %).', v_invitation.status;
    END IF;

    IF v_invitation.expires_at <= pg_catalog.now() THEN
        RAISE EXCEPTION 'Invitation has expired. Please request a new invitation.';
    END IF;

    -- 5. Verify authenticated email matches invited email (case-insensitive)
    IF pg_catalog.lower(pg_catalog.btrim(v_email)) <> pg_catalog.lower(pg_catalog.btrim(v_invitation.email)) THEN
        RAISE EXCEPTION 'Your signed-in email (%) does not match the invitation email (%).', v_email, v_invitation.email;
    END IF;

    -- 6. Ensure target organization is active
    IF NOT EXISTS (
        SELECT 1 FROM public.organizations 
        WHERE id = v_invitation.organization_id AND status = 'active'
    ) THEN
        RAISE EXCEPTION 'Target organization is suspended or deactivated.';
    END IF;

    -- 7. Resolve full name
    v_full_name := pg_catalog.btrim(COALESCE(p_full_name, v_user_meta_name, pg_catalog.split_part(v_email, '@', 1), 'Team Member'));
    IF pg_catalog.length(v_full_name) < 2 THEN
        v_full_name := 'Team Member';
    END IF;

    -- 8. Safely generate database-side unique Twilio identity (Format: agent_jane_doe)
    v_clean_name := pg_catalog.lower(pg_catalog.regexp_replace(v_full_name, '[^a-zA-Z0-9]+', '_', 'g'));
    v_clean_name := pg_catalog.btrim(v_clean_name, '_');
    IF v_clean_name IS NULL OR v_clean_name = '' THEN
        v_clean_name := 'member';
    END IF;

    v_base_identity := 'agent_' || v_clean_name;
    v_twilio_identity := v_base_identity;
    v_suffix := 2;

    WHILE EXISTS (SELECT 1 FROM public.profiles WHERE twilio_identity = v_twilio_identity) LOOP
        v_twilio_identity := v_base_identity || '_' || v_suffix;
        v_suffix := v_suffix + 1;
    END LOOP;

    -- 9. Auto-assign next available numeric extension >= 101 for this organization
    SELECT COALESCE(
        MAX(CAST(NULLIF(pg_catalog.regexp_replace(p.extension, '[^0-9]', '', 'g'), '') AS INT)),
        100
    ) + 1 INTO v_next_ext
    FROM public.profiles AS p
    WHERE p.organization_id = v_invitation.organization_id;

    IF v_next_ext < 101 THEN
        v_next_ext := 101;
    END IF;

    WHILE EXISTS (
        SELECT 1 FROM public.profiles AS p
        WHERE p.organization_id = v_invitation.organization_id AND p.extension = CAST(v_next_ext AS TEXT)
    ) LOOP
        v_next_ext := v_next_ext + 1;
    END LOOP;

    v_extension_str := CAST(v_next_ext AS TEXT);

    -- 10. Update invitation status to accepted
    UPDATE public.organization_invitations
    SET status = 'accepted',
        accepted_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    WHERE id = v_invitation.id;

    -- 11. Create public.profiles record for invited user
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
        v_invitation.organization_id,
        v_full_name,
        pg_catalog.lower(pg_catalog.btrim(v_email)),
        v_invitation.role,
        v_extension_str,
        TRUE,
        'offline',
        v_twilio_identity
    );

    RETURN QUERY
    SELECT v_invitation.organization_id, v_user_id, v_invitation.role, v_extension_str;
END;
$$;

-- 5. Permissions: Revoke PUBLIC / anon, Grant ONLY to authenticated
REVOKE ALL ON FUNCTION public.accept_organization_invitation(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_organization_invitation(TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.accept_organization_invitation(TEXT, TEXT) TO authenticated;
