-- ====================================================================
-- PUBLIC SAAS PHASE 19F.2A.1 — INVITATION INTENDED NUMBER & SEAT SAFETY
-- Date: 2027-03-25
-- Adds intended_phone_number_id column to public.organization_invitations
-- Adds create_organization_invitation RPC with subscription row lock
-- Updates accept_organization_invitation RPC for post-acceptance auto-assignment
-- ====================================================================

-- 1. Add intended_phone_number_id column to organization_invitations if not exists
ALTER TABLE public.organization_invitations
ADD COLUMN IF NOT EXISTS intended_phone_number_id UUID REFERENCES public.phone_numbers(id) ON DELETE SET NULL;

-- 2. Performance Index for intended_phone_number_id lookups
CREATE INDEX IF NOT EXISTS idx_org_invitations_intended_phone
ON public.organization_invitations(intended_phone_number_id)
WHERE intended_phone_number_id IS NOT NULL;

-- 3. Atomic Database Function: Create Organization Invitation with Subscription Lock
CREATE OR REPLACE FUNCTION public.create_organization_invitation(
    p_organization_id UUID,
    p_email TEXT,
    p_role TEXT,
    p_invited_by_user_id UUID,
    p_token_hash TEXT,
    p_expires_at TIMESTAMPTZ,
    p_intended_phone_number_id UUID DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    organization_id UUID,
    email TEXT,
    role TEXT,
    status TEXT,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ,
    intended_phone_number_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ;
    v_clean_email TEXT;
    v_validated_phone_id UUID := NULL;
    
    -- Subscription & Entitlement variables
    v_sub_id UUID;
    v_plan_id UUID;
    v_sub_status TEXT;
    v_trial_ends_at TIMESTAMPTZ;
    v_current_period_end TIMESTAMPTZ;
    v_is_trial_valid BOOLEAN;
    v_is_canceled_period_valid BOOLEAN;
    v_is_subscription_active BOOLEAN;
    
    v_override_enabled BOOLEAN;
    v_override_num_val NUMERIC;
    v_plan_enabled BOOLEAN;
    v_plan_num_val NUMERIC;
    v_effective_max_seats BIGINT;
    v_active_seat_count BIGINT;
    v_pending_invite_count BIGINT;
    v_used_or_reserved BIGINT;
    v_has_override BOOLEAN := FALSE;
    v_new_invite RECORD;
BEGIN
    v_now := pg_catalog.now();
    v_clean_email := pg_catalog.lower(pg_catalog.btrim(p_email));

    IF v_clean_email IS NULL OR v_clean_email = '' OR v_clean_email NOT LIKE '%@%' THEN
        RAISE EXCEPTION 'invalid_email: Valid email address is required.';
    END IF;

    IF p_role NOT IN ('admin', 'manager', 'agent') THEN
        RAISE EXCEPTION 'invalid_role: Role must be admin, manager, or agent.';
    END IF;

    -- Verify target organization is active
    IF NOT EXISTS (
        SELECT 1 FROM public.organizations AS o
        WHERE o.id = p_organization_id AND o.status = 'active'
    ) THEN
        RAISE EXCEPTION 'organization_inactive: Target organization is suspended or deactivated.';
    END IF;

    -- Validate optional intended_phone_number_id (tenant safety)
    IF p_intended_phone_number_id IS NOT NULL THEN
        SELECT pn.id INTO v_validated_phone_id
        FROM public.phone_numbers AS pn
        WHERE pn.id = p_intended_phone_number_id
          AND pn.organization_id = p_organization_id
          AND pn.active = TRUE
          AND pn.status = 'active';
          
        IF v_validated_phone_id IS NULL THEN
            RAISE EXCEPTION 'invalid_intended_number: Specified intended phone number is invalid, inactive, or belongs to another organization.';
        END IF;
    END IF;

    -- Reject if user is already an active member of this organization
    IF EXISTS (
        SELECT 1 FROM public.profiles AS p
        WHERE p.organization_id = p_organization_id AND pg_catalog.lower(p.email) = v_clean_email AND p.active = TRUE
    ) THEN
        RAISE EXCEPTION 'already_member: User "%" is already an active member of this workspace.', v_clean_email;
    END IF;

    -- Lock organization subscription row to serialize invitation creation & acceptance
    SELECT s.id, s.plan_id, s.status, s.trial_ends_at, s.current_period_end
    INTO v_sub_id, v_plan_id, v_sub_status, v_trial_ends_at, v_current_period_end
    FROM public.organization_subscriptions AS s
    WHERE s.organization_id = p_organization_id
    FOR UPDATE;

    IF v_sub_id IS NULL THEN
        RAISE EXCEPTION 'subscription_missing: Target organization has no active subscription row.';
    END IF;

    -- Evaluate subscription active state
    v_is_trial_valid := TRUE;
    IF v_sub_status = 'trialing' AND v_trial_ends_at IS NOT NULL THEN
        IF v_trial_ends_at <= v_now THEN
            v_is_trial_valid := FALSE;
        END IF;
    END IF;

    v_is_canceled_period_valid := TRUE;
    IF v_sub_status = 'canceled' AND v_current_period_end IS NOT NULL THEN
        IF v_current_period_end <= v_now THEN
            v_is_canceled_period_valid := FALSE;
        END IF;
    END IF;

    v_is_subscription_active := (
        (v_sub_status = 'active') OR
        (v_sub_status = 'trialing' AND v_is_trial_valid) OR
        (v_sub_status = 'canceled' AND v_is_canceled_period_valid) OR
        (v_sub_status = 'past_due')
    );

    IF NOT v_is_subscription_active THEN
        RAISE EXCEPTION 'subscription_inactive: Subscription status (%) does not authorize new member invitations.', v_sub_status;
    END IF;

    -- Resolve effective team.seats.max entitlement
    v_effective_max_seats := NULL;

    SELECT o.enabled, o.numeric_value
    INTO v_override_enabled, v_override_num_val
    FROM public.organization_entitlement_overrides AS o
    WHERE o.organization_id = p_organization_id
      AND o.feature_code = 'team.seats.max'
      AND (o.expires_at IS NULL OR o.expires_at > v_now);

    IF FOUND THEN
        v_has_override := TRUE;
        IF v_override_enabled IS TRUE
           AND v_override_num_val IS NOT NULL
           AND v_override_num_val >= 0
           AND v_override_num_val = pg_catalog.trunc(v_override_num_val)
           AND v_override_num_val <= 2147483647 THEN
            v_effective_max_seats := v_override_num_val::BIGINT;
        ELSE
            RAISE EXCEPTION 'seat_limit_reached: Active organization seat entitlement override is disabled or malformed.';
        END IF;
    END IF;

    IF NOT v_has_override THEN
        SELECT pe.enabled, pe.numeric_value
        INTO v_plan_enabled, v_plan_num_val
        FROM public.plan_entitlements AS pe
        WHERE pe.plan_id = v_plan_id
          AND pe.feature_code = 'team.seats.max';

        IF FOUND
           AND v_plan_enabled IS TRUE
           AND v_plan_num_val IS NOT NULL
           AND v_plan_num_val >= 0
           AND v_plan_num_val = pg_catalog.trunc(v_plan_num_val)
           AND v_plan_num_val <= 2147483647 THEN
            v_effective_max_seats := v_plan_num_val::BIGINT;
        END IF;
    END IF;

    IF v_effective_max_seats IS NULL THEN
        RAISE EXCEPTION 'seat_limit_reached: Entitlement team.seats.max is missing or unconfigured for target organization.';
    END IF;

    -- Count active profiles
    SELECT COUNT(*)::BIGINT INTO v_active_seat_count
    FROM public.profiles AS p
    WHERE p.organization_id = p_organization_id
      AND p.active = TRUE;

    -- Count valid pending invitations
    SELECT COUNT(*)::BIGINT INTO v_pending_invite_count
    FROM public.organization_invitations AS i
    WHERE i.organization_id = p_organization_id
      AND i.status = 'pending'
      AND i.expires_at > v_now;

    v_used_or_reserved := v_active_seat_count + v_pending_invite_count;

    IF v_used_or_reserved >= v_effective_max_seats THEN
        RAISE EXCEPTION 'seat_limit_reached: Your workspace has reached its member limit (% of % seats used or reserved). Remove an unused member or upgrade your plan to invite another person.', v_used_or_reserved, v_effective_max_seats;
    END IF;

    -- Reject duplicate pending invitation
    IF EXISTS (
        SELECT 1 FROM public.organization_invitations AS i
        WHERE i.organization_id = p_organization_id
          AND pg_catalog.lower(i.email) = v_clean_email
          AND i.status = 'pending'
          AND i.expires_at > v_now
    ) THEN
        RAISE EXCEPTION 'duplicate_invitation: A pending invitation has already been sent to "%".', v_clean_email;
    END IF;

    -- Insert invitation
    INSERT INTO public.organization_invitations (
        organization_id,
        email,
        role,
        invited_by_user_id,
        token_hash,
        status,
        expires_at,
        intended_phone_number_id
    )
    VALUES (
        p_organization_id,
        v_clean_email,
        p_role,
        p_invited_by_user_id,
        pg_catalog.btrim(p_token_hash),
        'pending',
        p_expires_at,
        v_validated_phone_id
    )
    RETURNING
        organization_invitations.id,
        organization_invitations.organization_id,
        organization_invitations.email,
        organization_invitations.role,
        organization_invitations.status,
        organization_invitations.expires_at,
        organization_invitations.created_at,
        organization_invitations.intended_phone_number_id
    INTO v_new_invite;

    RETURN QUERY
    SELECT
        v_new_invite.id,
        v_new_invite.organization_id,
        v_new_invite.email,
        v_new_invite.role,
        v_new_invite.status,
        v_new_invite.expires_at,
        v_new_invite.created_at,
        v_new_invite.intended_phone_number_id;
END;
$$;

-- 4. Update public.accept_organization_invitation RPC function
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
    
    -- Entitlement Enforcement variables
    v_sub_id UUID;
    v_plan_id UUID;
    v_sub_status TEXT;
    v_trial_ends_at TIMESTAMPTZ;
    v_current_period_end TIMESTAMPTZ;
    v_now TIMESTAMPTZ;
    v_is_trial_valid BOOLEAN;
    v_is_canceled_period_valid BOOLEAN;
    v_is_subscription_active BOOLEAN;
    
    v_override_enabled BOOLEAN;
    v_override_num_val NUMERIC;
    v_plan_enabled BOOLEAN;
    v_plan_num_val NUMERIC;
    v_effective_max_seats BIGINT;
    v_active_seat_count BIGINT;
    v_has_override BOOLEAN := FALSE;
BEGIN
    -- 1. Derive authenticated user session
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized. Authenticated session required to accept invitation.';
    END IF;

    -- 2. Derive user email securely from auth.users database table
    SELECT u.email, (u.raw_user_meta_data->>'full_name') INTO v_email, v_user_meta_name
    FROM auth.users AS u
    WHERE u.id = v_user_id;

    IF v_email IS NULL OR pg_catalog.btrim(v_email) = '' THEN
        RAISE EXCEPTION 'Authenticated email address not found.';
    END IF;

    -- 3. Check if user already has an active profile in any organization
    IF EXISTS (SELECT 1 FROM public.profiles AS p WHERE p.id = v_user_id) THEN
        RAISE EXCEPTION 'You already belong to a workspace organization.';
    END IF;

    -- 4. Fetch and lock invitation record by pre-hashed SHA-256 token
    SELECT i.* INTO v_invitation
    FROM public.organization_invitations AS i
    WHERE i.token_hash = pg_catalog.btrim(p_token_hash)
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
        SELECT 1 FROM public.organizations AS o
        WHERE o.id = v_invitation.organization_id AND o.status = 'active'
    ) THEN
        RAISE EXCEPTION 'Target organization is suspended or deactivated.';
    END IF;

    -- 7. Lock target organization's subscription row to serialize seat activations
    v_now := pg_catalog.now();
    SELECT s.id, s.plan_id, s.status, s.trial_ends_at, s.current_period_end
    INTO v_sub_id, v_plan_id, v_sub_status, v_trial_ends_at, v_current_period_end
    FROM public.organization_subscriptions AS s
    WHERE s.organization_id = v_invitation.organization_id
    FOR UPDATE;

    IF v_sub_id IS NULL THEN
        RAISE EXCEPTION 'subscription_missing: Target organization has no active subscription row.';
    END IF;

    -- 8. Evaluate subscription active state
    v_is_trial_valid := TRUE;
    IF v_sub_status = 'trialing' AND v_trial_ends_at IS NOT NULL THEN
        IF v_trial_ends_at <= v_now THEN
            v_is_trial_valid := FALSE;
        END IF;
    END IF;

    v_is_canceled_period_valid := TRUE;
    IF v_sub_status = 'canceled' AND v_current_period_end IS NOT NULL THEN
        IF v_current_period_end <= v_now THEN
            v_is_canceled_period_valid := FALSE;
        END IF;
    END IF;

    v_is_subscription_active := (
        (v_sub_status = 'active') OR
        (v_sub_status = 'trialing' AND v_is_trial_valid) OR
        (v_sub_status = 'canceled' AND v_is_canceled_period_valid) OR
        (v_sub_status = 'past_due')
    );

    IF NOT v_is_subscription_active THEN
        RAISE EXCEPTION 'subscription_inactive: Subscription status (%) does not authorize new member activations.', v_sub_status;
    END IF;

    -- 9. Resolve effective team.seats.max entitlement
    v_effective_max_seats := NULL;

    SELECT o.enabled, o.numeric_value
    INTO v_override_enabled, v_override_num_val
    FROM public.organization_entitlement_overrides AS o
    WHERE o.organization_id = v_invitation.organization_id
      AND o.feature_code = 'team.seats.max'
      AND (o.expires_at IS NULL OR o.expires_at > v_now);

    IF FOUND THEN
        v_has_override := TRUE;
        IF v_override_enabled IS TRUE
           AND v_override_num_val IS NOT NULL
           AND v_override_num_val >= 0
           AND v_override_num_val = pg_catalog.trunc(v_override_num_val)
           AND v_override_num_val <= 2147483647 THEN
            v_effective_max_seats := v_override_num_val::BIGINT;
        ELSE
            RAISE EXCEPTION 'seat_limit_reached: Active organization seat entitlement override is disabled or malformed.';
        END IF;
    END IF;

    IF NOT v_has_override THEN
        SELECT pe.enabled, pe.numeric_value
        INTO v_plan_enabled, v_plan_num_val
        FROM public.plan_entitlements AS pe
        WHERE pe.plan_id = v_plan_id
          AND pe.feature_code = 'team.seats.max';

        IF FOUND
           AND v_plan_enabled IS TRUE
           AND v_plan_num_val IS NOT NULL
           AND v_plan_num_val >= 0
           AND v_plan_num_val = pg_catalog.trunc(v_plan_num_val)
           AND v_plan_num_val <= 2147483647 THEN
            v_effective_max_seats := v_plan_num_val::BIGINT;
        END IF;
    END IF;

    IF v_effective_max_seats IS NULL THEN
        RAISE EXCEPTION 'seat_limit_reached: Entitlement team.seats.max is missing or unconfigured for target organization.';
    END IF;

    -- 10. Count current active seats (active profiles)
    SELECT COUNT(*)::BIGINT INTO v_active_seat_count
    FROM public.profiles AS p
    WHERE p.organization_id = v_invitation.organization_id
      AND p.active = TRUE;

    IF v_active_seat_count >= v_effective_max_seats THEN
        RAISE EXCEPTION 'seat_limit_reached: Your workspace has reached its member limit (%). Remove an unused member or upgrade your plan to invite another person.', v_effective_max_seats;
    END IF;

    -- 11. Resolve full name
    v_full_name := pg_catalog.btrim(COALESCE(p_full_name, v_user_meta_name, pg_catalog.split_part(v_email, '@', 1), 'Team Member'));
    IF pg_catalog.length(v_full_name) < 2 THEN
        v_full_name := 'Team Member';
    END IF;

    -- 12. Generate twilio identity
    v_clean_name := pg_catalog.lower(pg_catalog.regexp_replace(v_full_name, '[^a-zA-Z0-9]+', '_', 'g'));
    v_clean_name := pg_catalog.btrim(v_clean_name, '_');
    IF v_clean_name IS NULL OR v_clean_name = '' THEN
        v_clean_name := 'member';
    END IF;

    v_base_identity := 'agent_' || v_clean_name;
    v_twilio_identity := v_base_identity;
    v_suffix := 2;

    WHILE EXISTS (SELECT 1 FROM public.profiles AS p WHERE p.twilio_identity = v_twilio_identity) LOOP
        v_twilio_identity := v_base_identity || '_' || v_suffix;
        v_suffix := v_suffix + 1;
    END LOOP;

    -- 13. Auto-assign extension
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

    -- 14. Update invitation status to accepted
    UPDATE public.organization_invitations AS i
    SET status = 'accepted',
        accepted_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    WHERE i.id = v_invitation.id;

    -- 15. Create profile record
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

    -- 16. Post-acceptance intended number assignment (if specified and valid)
    IF v_invitation.intended_phone_number_id IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM public.phone_numbers
            WHERE id = v_invitation.intended_phone_number_id
              AND organization_id = v_invitation.organization_id
              AND active = TRUE
              AND status = 'active'
        ) THEN
            INSERT INTO public.user_phone_assignments (
                organization_id,
                user_id,
                phone_number_id
            )
            VALUES (
                v_invitation.organization_id,
                v_user_id,
                v_invitation.intended_phone_number_id
            )
            ON CONFLICT (user_id, phone_number_id) DO NOTHING;
        END IF;
    END IF;

    RETURN QUERY
    SELECT v_invitation.organization_id, v_user_id, v_invitation.role, v_extension_str;
END;
$$;

-- Permissions: Revoke PUBLIC / anon, Grant ONLY to authenticated
REVOKE ALL ON FUNCTION public.create_organization_invitation(UUID, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_organization_invitation(UUID, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_organization_invitation(UUID, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.accept_organization_invitation(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_organization_invitation(TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.accept_organization_invitation(TEXT, TEXT) TO authenticated;
