-- Phase 9.8 Corrective Migration: Admin Inbound Routing Exclusion & Defensive Occupancy Protection

-- 1. Corrected RPC: Reserve Next Round Robin Agent
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
    -- 1. Lock organization row for update to serialize Round Robin routing
    SELECT o.last_routed_user_id INTO v_last_routed_user_id
    FROM public.organizations o
    WHERE o.id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- 2. Validate p_call_id if provided
    IF p_call_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.calls c WHERE c.id = p_call_id AND c.organization_id = p_organization_id
        ) THEN
            RETURN;
        END IF;
    END IF;

    -- 3. Cleanup expired reservations
    DELETE FROM public.agent_call_reservations WHERE expires_at <= NOW();

    v_expires_at := NOW() + (p_ttl_seconds || ' seconds')::INTERVAL;

    -- 4. Find eligible agents:
    --    - role IN ('agent', 'manager') -> EXCLUDES ADMIN FROM INBOUND ROUTING
    --    - active = true
    --    - availability_status = 'available'
    --    - NOT occupied by active call:
    --        * ended_at IS NULL
    --        * status = 'in-progress' (no max age limit for connected calls)
    --        * OR status IN ('initiated', 'ringing', 'queued') AND created_at > (NOW() - INTERVAL '15 minutes')
    --    - NOT occupied by active non-expired reservation
    WITH eligible_agents AS (
        SELECT p.id AS agent_id, p.full_name AS agent_name, p.twilio_identity AS agent_identity
        FROM public.profiles p
        WHERE p.organization_id = p_organization_id
          AND p.active = TRUE
          AND p.availability_status = 'available'
          AND p.role IN ('agent', 'manager')
          AND p.id NOT IN (
              SELECT c.user_id
              FROM public.calls c
              WHERE c.organization_id = p_organization_id
                AND c.user_id IS NOT NULL
                AND c.ended_at IS NULL
                AND (
                    c.status = 'in-progress'
                    OR (c.status IN ('initiated', 'ringing', 'queued') AND c.created_at > (NOW() - INTERVAL '15 minutes'))
                )
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

    IF v_selected_id IS NULL THEN
        RETURN;
    END IF;

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
            RETURN;
    END;

    UPDATE public.organizations
    SET last_routed_user_id = v_selected_id,
        updated_at = NOW()
    WHERE public.organizations.id = p_organization_id;

    id := v_selected_id;
    full_name := v_selected_name;
    twilio_identity := v_selected_identity;
    RETURN NEXT;
END;
$$;

-- 2. Corrected RPC: Reserve Ring All Agents
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
    IF p_call_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.calls c WHERE c.id = p_call_id AND c.organization_id = p_organization_id
        ) THEN
            RETURN;
        END IF;
    END IF;

    DELETE FROM public.agent_call_reservations WHERE expires_at <= NOW();

    v_expires_at := NOW() + (p_ttl_seconds || ' seconds')::INTERVAL;

    RETURN QUERY
    WITH eligible_agents AS (
        SELECT p.id AS agent_id, p.full_name AS agent_name, p.twilio_identity AS agent_identity
        FROM public.profiles p
        WHERE p.organization_id = p_organization_id
          AND p.active = TRUE
          AND p.availability_status = 'available'
          AND p.role IN ('agent', 'manager')
          AND p.id NOT IN (
              SELECT c.user_id
              FROM public.calls c
              WHERE c.organization_id = p_organization_id
                AND c.user_id IS NOT NULL
                AND c.ended_at IS NULL
                AND (
                    c.status = 'in-progress'
                    OR (c.status IN ('initiated', 'ringing', 'queued') AND c.created_at > (NOW() - INTERVAL '15 minutes'))
                )
          )
          AND p.id NOT IN (
              SELECT r.user_id
              FROM public.agent_call_reservations r
              WHERE r.organization_id = p_organization_id
                AND r.expires_at > NOW()
          )
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
