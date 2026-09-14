-- Phase 9.8 Migration: Server-Side Agent Call Reservations & Atomic Routing RPCs

-- 1. Create agent_call_reservations table
CREATE TABLE IF NOT EXISTS public.agent_call_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE UNIQUE,
    call_id UUID REFERENCES public.calls(id) ON DELETE CASCADE,
    reservation_type TEXT NOT NULL CHECK (reservation_type IN ('ring_all', 'round_robin', 'outbound')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- Indexes for fast query lookup
CREATE INDEX IF NOT EXISTS idx_agent_reservations_org_expires
ON public.agent_call_reservations (organization_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_agent_reservations_call_id
ON public.agent_call_reservations (call_id);

-- Enable RLS
ALTER TABLE public.agent_call_reservations ENABLE ROW LEVEL SECURITY;

-- Service role full access policy
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'agent_call_reservations' AND policyname = 'Service role full access on agent_call_reservations'
    ) THEN
        CREATE POLICY "Service role full access on agent_call_reservations"
        ON public.agent_call_reservations
        FOR ALL
        TO service_role
        USING (true)
        WITH CHECK (true);
    END IF;
END $$;

-- Authenticated users can view reservations in their organization
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'agent_call_reservations' AND policyname = 'Users can view reservations in their organization'
    ) THEN
        CREATE POLICY "Users can view reservations in their organization"
        ON public.agent_call_reservations
        FOR SELECT
        TO authenticated
        USING (
            organization_id IN (
                SELECT organization_id FROM public.profiles WHERE id = auth.uid()
            )
        );
    END IF;
END $$;

-- 2. Atomic Function: Cleanup Expired Reservations
CREATE OR REPLACE FUNCTION public.cleanup_expired_reservations()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM public.agent_call_reservations
    WHERE expires_at <= NOW();
END;
$$;

-- 3. Atomic RPC: Reserve Next Round Robin Agent
CREATE OR REPLACE FUNCTION public.reserve_next_round_robin_agent(
    p_organization_id UUID,
    p_call_id UUID,
    p_ttl_seconds INT DEFAULT 45
)
RETURNS TABLE (
    id UUID,
    full_name TEXT,
    twilio_identity TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_last_routed_user_id UUID;
    v_selected_id UUID;
    v_selected_name TEXT;
    v_selected_identity TEXT;
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- 1. Lock the organization row for update to serialize Round Robin routing in this organization
    SELECT o.last_routed_user_id INTO v_last_routed_user_id
    FROM public.organizations o
    WHERE o.id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- 2. Validate p_call_id belongs to p_organization_id if provided
    IF p_call_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.calls c WHERE c.id = p_call_id AND c.organization_id = p_organization_id
        ) THEN
            RETURN;
        END IF;
    END IF;

    -- 3. Cleanup expired reservations
    DELETE FROM public.agent_call_reservations WHERE expires_at <= NOW();

    -- 4. Compute expiration time for new reservation (default 45 seconds)
    v_expires_at := NOW() + (p_ttl_seconds || ' seconds')::INTERVAL;

    -- 5. Find all eligible free agents in this organization:
    --    - profile.active = true
    --    - availability_status = 'available'
    --    - NOT in active calls (status IN ('initiated', 'ringing', 'in-progress', 'queued') and user_id IS NOT NULL)
    --    - NOT in active reservations
    WITH eligible_agents AS (
        SELECT p.id AS agent_id, p.full_name AS agent_name, p.twilio_identity AS agent_identity
        FROM public.profiles p
        WHERE p.organization_id = p_organization_id
          AND p.active = TRUE
          AND p.availability_status = 'available'
          AND p.id NOT IN (
              SELECT c.user_id
              FROM public.calls c
              WHERE c.organization_id = p_organization_id
                AND c.status IN ('initiated', 'ringing', 'in-progress', 'queued')
                AND c.user_id IS NOT NULL
          )
          AND p.id NOT IN (
              SELECT r.user_id
              FROM public.agent_call_reservations r
              WHERE r.organization_id = p_organization_id
                AND r.expires_at > NOW()
          )
        ORDER BY p.id ASC
    ),
    agent_array AS (
        SELECT ARRAY_AGG(ea.agent_id ORDER BY ea.agent_id ASC) AS ids
        FROM eligible_agents ea
    )
    SELECT ea.agent_id, ea.agent_name, ea.agent_identity
    INTO v_selected_id, v_selected_name, v_selected_identity
    FROM eligible_agents ea, agent_array aa
    WHERE (
        CASE 
            WHEN v_last_routed_user_id IS NOT NULL AND v_last_routed_user_id = ANY(aa.ids) THEN
                ea.agent_id = aa.ids[((ARRAY_POSITION(aa.ids, v_last_routed_user_id) % ARRAY_LENGTH(aa.ids, 1)) + 1)]
            ELSE
                ea.agent_id = aa.ids[1]
        END
    )
    LIMIT 1;

    -- 6. If no eligible agent found, return empty
    IF v_selected_id IS NULL THEN
        RETURN;
    END IF;

    -- 7. Insert reservation atomically with ON CONFLICT safety
    BEGIN
        INSERT INTO public.agent_call_reservations (
            organization_id,
            user_id,
            call_id,
            reservation_type,
            expires_at
        ) VALUES (
            p_organization_id,
            v_selected_id,
            p_call_id,
            'round_robin',
            v_expires_at
        );
    EXCEPTION
        WHEN unique_violation THEN
            -- If concurrent conflict occurs, return empty gracefully
            RETURN;
    END;

    -- 8. Update organization's last_routed_user_id
    UPDATE public.organizations
    SET last_routed_user_id = v_selected_id,
        updated_at = NOW()
    WHERE public.organizations.id = p_organization_id;

    -- 9. Return selected agent record
    id := v_selected_id;
    full_name := v_selected_name;
    twilio_identity := v_selected_identity;
    RETURN NEXT;
END;
$$;

-- 4. Atomic RPC: Reserve Ring All Agents
CREATE OR REPLACE FUNCTION public.reserve_ring_all_agents(
    p_organization_id UUID,
    p_call_id UUID,
    p_ttl_seconds INT DEFAULT 45
)
RETURNS TABLE (
    id UUID,
    full_name TEXT,
    twilio_identity TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- 1. Validate p_call_id belongs to p_organization_id if provided
    IF p_call_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.calls c WHERE c.id = p_call_id AND c.organization_id = p_organization_id
        ) THEN
            RETURN;
        END IF;
    END IF;

    -- 2. Cleanup expired reservations
    DELETE FROM public.agent_call_reservations WHERE expires_at <= NOW();

    v_expires_at := NOW() + (p_ttl_seconds || ' seconds')::INTERVAL;

    -- 3. Find and atomically reserve all eligible agents in organization using ON CONFLICT DO NOTHING
    RETURN QUERY
    WITH eligible_agents AS (
        SELECT p.id AS agent_id, p.full_name AS agent_name, p.twilio_identity AS agent_identity
        FROM public.profiles p
        WHERE p.organization_id = p_organization_id
          AND p.active = TRUE
          AND p.availability_status = 'available'
          AND p.id NOT IN (
              SELECT c.user_id
              FROM public.calls c
              WHERE c.organization_id = p_organization_id
                AND c.status IN ('initiated', 'ringing', 'in-progress', 'queued')
                AND c.user_id IS NOT NULL
          )
          AND p.id NOT IN (
              SELECT r.user_id
              FROM public.agent_call_reservations r
              WHERE r.organization_id = p_organization_id
                AND r.expires_at > NOW()
          )
        ORDER BY p.id ASC
    ),
    inserted_reservations AS (
        INSERT INTO public.agent_call_reservations (
            organization_id,
            user_id,
            call_id,
            reservation_type,
            expires_at
        )
        SELECT 
            p_organization_id,
            ea.agent_id,
            p_call_id,
            'ring_all',
            v_expires_at
        FROM eligible_agents ea
        ON CONFLICT (user_id) DO NOTHING
        RETURNING user_id
    )
    SELECT ea.agent_id, ea.agent_name, ea.agent_identity
    FROM eligible_agents ea
    JOIN inserted_reservations ir ON ea.agent_id = ir.user_id;
END;
$$;

-- 5. Atomic RPC: Claim Inbound Call Answer & Release Reservations
CREATE OR REPLACE FUNCTION public.claim_inbound_call_answer(
    p_call_id UUID,
    p_user_id UUID,
    p_organization_id UUID
)
RETURNS TABLE (
    success BOOLEAN,
    already_answered BOOLEAN,
    error_message TEXT,
    call_id UUID,
    answered_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_call RECORD;
    v_now TIMESTAMPTZ := NOW();
    v_user_active_call UUID;
    v_reservation RECORD;
BEGIN
    -- 1. Validate answering profile belongs to p_organization_id and is active
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = p_user_id
          AND p.organization_id = p_organization_id
          AND p.active = TRUE
    ) THEN
        success := FALSE;
        already_answered := FALSE;
        error_message := 'Forbidden. Answering user profile unconfigured or inactive.';
        call_id := p_call_id;
        answered_at := NULL;
        RETURN NEXT;
        RETURN;
    END IF;

    -- 2. Check if user is already on another active call
    SELECT c.id INTO v_user_active_call
    FROM public.calls c
    WHERE c.organization_id = p_organization_id
      AND c.status IN ('initiated', 'ringing', 'in-progress', 'queued')
      AND c.user_id = p_user_id
      AND c.id <> p_call_id
    LIMIT 1;

    IF v_user_active_call IS NOT NULL THEN
        success := FALSE;
        already_answered := FALSE;
        error_message := 'You are already handling another active call.';
        call_id := p_call_id;
        answered_at := NULL;
        RETURN NEXT;
        RETURN;
    END IF;

    -- 3. Fetch target call row with row lock
    SELECT c.id, c.organization_id, c.direction, c.status, c.user_id, c.answered_at
    INTO v_call
    FROM public.calls c
    WHERE c.id = p_call_id
    FOR UPDATE;

    IF NOT FOUND THEN
        success := FALSE;
        already_answered := FALSE;
        error_message := 'Call record not found.';
        call_id := p_call_id;
        answered_at := NULL;
        RETURN NEXT;
        RETURN;
    END IF;

    IF v_call.organization_id <> p_organization_id THEN
        success := FALSE;
        already_answered := FALSE;
        error_message := 'Forbidden. Call belongs to another organization.';
        call_id := p_call_id;
        answered_at := NULL;
        RETURN NEXT;
        RETURN;
    END IF;

    IF v_call.direction <> 'inbound' THEN
        success := FALSE;
        already_answered := FALSE;
        error_message := 'Invalid call direction for answer endpoint.';
        call_id := p_call_id;
        answered_at := NULL;
        RETURN NEXT;
        RETURN;
    END IF;

    -- If already answered by someone else
    IF v_call.user_id IS NOT NULL AND v_call.user_id <> p_user_id THEN
        success := FALSE;
        already_answered := TRUE;
        error_message := 'Call already answered by another agent.';
        call_id := p_call_id;
        answered_at := v_call.answered_at;
        RETURN NEXT;
        RETURN;
    END IF;

    -- If already answered by THIS agent (idempotent success)
    IF v_call.user_id = p_user_id THEN
        success := TRUE;
        already_answered := TRUE;
        error_message := NULL;
        call_id := p_call_id;
        answered_at := v_call.answered_at;
        RETURN NEXT;
        RETURN;
    END IF;

    -- 4. Validate that an active/unexpired reservation exists for (user_id = p_user_id, call_id = p_call_id)
    SELECT r.id INTO v_reservation
    FROM public.agent_call_reservations r
    WHERE r.user_id = p_user_id
      AND r.call_id = p_call_id
      AND r.organization_id = p_organization_id
      AND r.expires_at > v_now;

    IF NOT FOUND THEN
        success := FALSE;
        already_answered := FALSE;
        error_message := 'Forbidden. Call was not reserved for or routed to this agent.';
        call_id := p_call_id;
        answered_at := NULL;
        RETURN NEXT;
        RETURN;
    END IF;

    -- 5. Claim call ownership atomically
    UPDATE public.calls
    SET status = 'in-progress',
        answered_at = v_now,
        user_id = p_user_id,
        updated_at = v_now
    WHERE public.calls.id = p_call_id
      AND public.calls.user_id IS NULL;

    -- 6. Release ALL reservations for this call (frees losing agents in Ring All)
    DELETE FROM public.agent_call_reservations
    WHERE public.agent_call_reservations.call_id = p_call_id;

    -- Delete any other reservation for the winning user
    DELETE FROM public.agent_call_reservations
    WHERE public.agent_call_reservations.user_id = p_user_id;

    success := TRUE;
    already_answered := FALSE;
    error_message := NULL;
    call_id := p_call_id;
    answered_at := v_now;
    RETURN NEXT;
END;
$$;

-- 6. Strictly revoke public/authenticated access to Security Definer functions and grant to service_role ONLY
REVOKE ALL ON FUNCTION public.cleanup_expired_reservations() FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.reserve_next_round_robin_agent(UUID, UUID, INT) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.reserve_ring_all_agents(UUID, UUID, INT) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.claim_inbound_call_answer(UUID, UUID, UUID) FROM PUBLIC, authenticated;

GRANT EXECUTE ON FUNCTION public.cleanup_expired_reservations() TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_next_round_robin_agent(UUID, UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_ring_all_agents(UUID, UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_inbound_call_answer(UUID, UUID, UUID) TO service_role;
