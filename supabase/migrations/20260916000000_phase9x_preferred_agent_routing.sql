-- Phase 9.X Migration: Preferred / Assigned Agent Inbound Routing
-- Date: 2026-09-16
-- Relational Schema & Security Definer RPC for Preferred Agent Routing

-- 1. Add prefer_assigned_agent column to public.organizations
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'prefer_assigned_agent'
    ) THEN
        ALTER TABLE public.organizations ADD COLUMN prefer_assigned_agent BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END $$;

-- 2. Add assigned_user_id column to public.contacts
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'assigned_user_id'
    ) THEN
        ALTER TABLE public.contacts ADD COLUMN assigned_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Index for efficient assigned_user_id lookup
CREATE INDEX IF NOT EXISTS idx_contacts_assigned_user_id ON public.contacts(assigned_user_id);

-- 3. Safely update reservation_type CHECK constraint on public.agent_call_reservations to allow 'preferred_agent'
-- Specifically targets ONLY check constraints (contype = 'c') evaluating reservation_type
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'public'
          AND rel.relname = 'agent_call_reservations'
          AND con.contype = 'c'
          AND pg_get_constraintdef(con.oid) LIKE '%reservation_type%'
    LOOP
        EXECUTE 'ALTER TABLE public.agent_call_reservations DROP CONSTRAINT IF EXISTS ' || quote_ident(r.conname);
    END LOOP;
END $$;

ALTER TABLE public.agent_call_reservations
    ADD CONSTRAINT agent_call_reservations_reservation_type_check
    CHECK (reservation_type IN ('ring_all', 'round_robin', 'outbound', 'preferred_agent'));

-- 4. Database-level trigger to enforce same-organization & role boundaries for contact assignments
CREATE OR REPLACE FUNCTION public.validate_contact_assigned_user()
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
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS check_contact_assigned_user ON public.contacts;
CREATE TRIGGER check_contact_assigned_user
    BEFORE INSERT OR UPDATE ON public.contacts
    FOR EACH ROW EXECUTE FUNCTION public.validate_contact_assigned_user();

-- 5. RPC Function: Reserve Preferred Agent
CREATE OR REPLACE FUNCTION public.reserve_preferred_agent(
    p_organization_id UUID,
    p_call_id UUID,
    p_preferred_user_id UUID,
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
    -- 1. Validate parameters
    IF p_preferred_user_id IS NULL OR p_organization_id IS NULL THEN
        RETURN;
    END IF;

    IF p_call_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.calls c WHERE c.id = p_call_id AND c.organization_id = p_organization_id
        ) THEN
            RETURN;
        END IF;
    END IF;

    -- 2. Clean up expired reservations
    DELETE FROM public.agent_call_reservations WHERE expires_at <= NOW();

    v_expires_at := NOW() + (p_ttl_seconds || ' seconds')::INTERVAL;

    -- 3. Check preferred agent eligibility and atomically reserve
    RETURN QUERY
    WITH eligible_preferred_agent AS (
        SELECT p.id AS agent_id, p.full_name AS agent_name, p.twilio_identity AS agent_identity
        FROM public.profiles p
        WHERE p.id = p_preferred_user_id
          AND p.organization_id = p_organization_id
          AND p.active = TRUE
          AND p.availability_status = 'available'
          AND p.role IN ('agent', 'manager') -- EXCLUDES ADMIN
          AND p.twilio_identity IS NOT NULL
          AND BTRIM(p.twilio_identity) <> ''
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
    inserted_reservation AS (
        INSERT INTO public.agent_call_reservations (
            organization_id,
            user_id,
            call_id,
            reservation_type,
            expires_at
        )
        SELECT 
            p_organization_id,
            epa.agent_id,
            p_call_id,
            'preferred_agent',
            v_expires_at
        FROM eligible_preferred_agent epa
        ON CONFLICT (user_id) DO NOTHING
        RETURNING user_id
    )
    SELECT epa.agent_id, epa.agent_name, epa.agent_identity
    FROM eligible_preferred_agent epa
    JOIN inserted_reservation ir ON epa.agent_id = ir.user_id;
END;
$$;

-- 6. RPC Permission Security Grants: Revoke execution from PUBLIC/authenticated, grant to service_role ONLY
REVOKE ALL ON FUNCTION public.reserve_preferred_agent(UUID, UUID, UUID, INT) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_preferred_agent(UUID, UUID, UUID, INT) TO service_role;
